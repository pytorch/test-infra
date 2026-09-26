import * as core from '@actions/core'
import * as path from 'path'
import { spawn } from 'child_process'
import * as k8s from '@kubernetes/client-node'
import tar from 'tar-fs'
import * as stream from 'stream'
import { createHash } from 'crypto'
import type { ContainerInfo, Registry } from 'hooklib'
import {
  getSecretName,
  JOB_CONTAINER_NAME,
  RunnerInstanceLabel
} from '../hooks/constants'
import {
  PodPhase,
  mergePodSpecWithOptions,
  mergeObjectMeta,
  fixArgs,
  listDirAllCommand,
  sleep,
  EXTERNALS_VOLUME_NAME,
  GITHUB_VOLUME_NAME,
  WORK_VOLUME
} from './utils'
import * as shlex from 'shlex'

const kc = new k8s.KubeConfig()

kc.loadFromDefault()

const k8sApi = kc.makeApiClient(k8s.CoreV1Api)
const k8sBatchV1Api = kc.makeApiClient(k8s.BatchV1Api)
const k8sAuthorizationV1Api = kc.makeApiClient(k8s.AuthorizationV1Api)

const DEFAULT_WAIT_FOR_POD_TIME_SECONDS = 10 * 60 // 10 min

const ENV_WAIT_FOR_NODE_TAINTS = 'ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS'
const ENV_WAIT_FOR_NODE_TAINTS_TIMEOUT =
  'ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS_TIMEOUT_SECONDS'
const DEFAULT_WAIT_FOR_NODE_TAINTS_TIMEOUT_SECONDS = 300

// Workspace copy verification: disabled by default to reduce runner pod memory
// pressure. The verification loop runs `find -exec stat` across all workspace
// files, accumulates the output as a JS string, and retries — each retry
// re-running the full scan. For large repos this causes OOM kills in the
// 512Mi runner pod. The verification is best-effort anyway (silently continues
// after exhausting retries), so disabling it loses no hard guarantees.
//
// WARNING: If re-enabling verification, ensure NODE_OPTIONS --max-old-space-size
// is >= 256 MB, otherwise the `find` output accumulation will crash V8 with a
// FATAL ERROR for large workspaces (e.g. pytorch/pytorch).
const COPY_VERIFY_ENABLED =
  (process.env.ACTIONS_RUNNER_COPY_VERIFY_ENABLED || 'false').toLowerCase() ===
  'true'
const COPY_VERIFY_RETRIES = parseInt(
  process.env.ACTIONS_RUNNER_COPY_VERIFY_RETRIES || '3',
  10
)

// ---------------------------------------------------------------------------
// Exec & WebSocket back-pressure constants.
//
// EXEC_TIMEOUT_MS              — per-attempt timeout for cp{To,From}Pod tar
//                                streams. Sized off measured copies: the cost
//                                scales with the workspace's file count, and a
//                                workspace holding two full pytorch action
//                                trees (~47k files) takes ~108s on an idle
//                                node. The previous 120s left no headroom, so
//                                node contention timed out every attempt —
//                                and since each retry restarts the copy from
//                                zero, those jobs never converged.
// EXEC_POD_STEP_TIMEOUT_MS     — per-call timeout for execPodStep /
//                                execPodStepOutput. Without this, a settled
//                                WebSocket that never delivers a status
//                                callback hangs forever (the existing retry
//                                wrappers cannot bail out of an unsettled
//                                Promise).
// WS_BACKPRESSURE_HIGH_WATER   — when ws.bufferedAmount exceeds this, pause
//                                the source stream (tar.pack) so we stop
//                                feeding the WebSocket. The kc library's
//                                WebSocket handler does NOT honour
//                                bufferedAmount and queues unboundedly,
//                                causing 1 GiB cgroup OOM on slow extraction.
// WS_BACKPRESSURE_LOW_WATER    — resume the source once buffered drops below
//                                this. Hysteresis avoids thrashing.
// WS_BACKPRESSURE_POLL_MS      — poll interval. 50 ms is a balance between
//                                overhead (~20 timer wakeups/sec) and how
//                                much extra data we let queue between checks
//                                — at typical 100 MB/s producer rate, ~5 MB
//                                may slip past per poll, well under HIGH.
// ERR_STREAM_MAX_BYTES         — cap the per-call stderr capture buffer. The
//                                underlying BufferSink grows without bound; a
//                                misbehaving container that floods stderr
//                                could OOM the runner.
// ---------------------------------------------------------------------------
const EXEC_TIMEOUT_MS = 300_000
const EXEC_POD_STEP_TIMEOUT_MS = 60_000
const WS_BACKPRESSURE_HIGH_WATER = 200 * 1024 * 1024 // 200 MiB
const WS_BACKPRESSURE_LOW_WATER = 50 * 1024 * 1024 // 50 MiB
const WS_BACKPRESSURE_POLL_MS = 50
const ERR_STREAM_MAX_BYTES = 64 * 1024

// Per kc issue #2532, ws.close() does NOT kill the remote command — only
// ws.terminate() (socket destroy) does. Wrap with try/catch for the
// already-torn-down case.
function safeTerminateWs(ws: WebSocket | null): void {
  if (!ws) return
  try {
    ;(ws as unknown as { terminate(): void }).terminate()
  } catch {
    // already torn down
  }
}

/**
 * A Writable that collects everything written to it in memory and can return
 * it as a string. Replaces the previous `stream-buffers` WritableStreamBuffer
 * dependency, whose internal buffer growth used the deprecated `Buffer()`
 * constructor (Node DEP0005). See actions/runner-container-hooks#261.
 *
 * Chunks are kept as-is and concatenated lazily on read, so there is no
 * preallocated backing buffer and no resize logic.
 */
export class BufferSink extends stream.Writable {
  private readonly chunks: Buffer[] = []
  _write(
    chunk: Buffer | string,
    encoding: string,
    cb: (err?: Error | null) => void
  ): void {
    this.chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as any)
    )
    cb()
  }
  getContentsAsString(encoding = 'utf8'): string {
    return this.chunks.length
      ? Buffer.concat(this.chunks).toString(encoding as any)
      : ''
  }
}

/**
 * A Writable that caps how much data it actually buffers. Once the cap is
 * reached, additional writes are silently dropped (the count is still tracked
 * so the upstream `getContentsAsString()` reflects the truncated content).
 *
 * Used for stderr capture in execCp{To,From}Pod where a misbehaving container
 * can flood stderr without bound and OOM the runner pod.
 */
export class CappedWritable extends stream.Writable {
  private readonly buffer: BufferSink
  private bytesWritten = 0
  private truncated = false
  constructor(private readonly maxBytes: number) {
    super()
    this.buffer = new BufferSink()
  }
  _write(
    chunk: Buffer | string,
    encoding: string,
    cb: (err?: Error | null) => void
  ): void {
    // Node's Writable always passes Buffer for object-mode-off + non-string
    // upstream writers (which is our case — kc pipes raw Buffers from the
    // WebSocket). Coerce defensively for the (theoretical) string path,
    // wrapping the conversion so a bad encoding cannot escape as an
    // uncaught throw into our process.on('uncaughtException') handler.
    let buf: Buffer
    if (Buffer.isBuffer(chunk)) {
      buf = chunk
    } else {
      try {
        buf = Buffer.from(chunk, encoding as any)
      } catch (err) {
        cb(err as Error)
        return
      }
    }
    const remaining = this.maxBytes - this.bytesWritten
    if (remaining <= 0) {
      // Drop entirely. Mark truncation once for diagnostics.
      if (!this.truncated) {
        this.truncated = true
      }
      cb()
      return
    }
    const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf
    this.bytesWritten += slice.length
    if (slice.length < buf.length) {
      this.truncated = true
    }
    this.buffer.write(slice, cb)
  }
  size(): number {
    return this.bytesWritten
  }
  getContentsAsString(encoding = 'utf8'): string {
    const contents = this.buffer.getContentsAsString(encoding) || ''
    return this.truncated
      ? `${contents}\n[... truncated at ${this.maxBytes} bytes]`
      : contents
  }
}

/**
 * Wait for configurable startup taints to be removed from the runner's node.
 *
 * Reads ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS (comma-separated taint keys) and
 * polls the node until none of those taints remain. This prevents the
 * Karpenter-scheduler deadlock where workflow pods are created before startup
 * taints (e.g. git-cache-not-ready) have cleared.
 *
 * Non-fatal if runner pod or node lookup fails. Returns immediately if the
 * env var is unset.
 */
export async function waitForNodeTaintsRemoval(): Promise<void> {
  const taintKeysRaw = process.env[ENV_WAIT_FOR_NODE_TAINTS]
  if (!taintKeysRaw || taintKeysRaw.trim() === '') {
    return
  }

  const taintKeys = taintKeysRaw
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0)
  if (taintKeys.length === 0) {
    return
  }

  const timeoutStr = process.env[ENV_WAIT_FOR_NODE_TAINTS_TIMEOUT]
  const timeoutSeconds = timeoutStr
    ? parseInt(timeoutStr, 10)
    : DEFAULT_WAIT_FOR_NODE_TAINTS_TIMEOUT_SECONDS
  const effectiveTimeout =
    !timeoutSeconds || timeoutSeconds <= 0
      ? DEFAULT_WAIT_FOR_NODE_TAINTS_TIMEOUT_SECONDS
      : timeoutSeconds

  const runnerPodName = process.env.ACTIONS_RUNNER_POD_NAME
  if (!runnerPodName) {
    core.warning('ACTIONS_RUNNER_POD_NAME not set, skipping node taint wait')
    return
  }

  let nodeName: string | undefined
  try {
    const runnerPod = await k8sApi.readNamespacedPod({
      name: runnerPodName,
      namespace: namespace()
    })
    nodeName = runnerPod.spec?.nodeName
  } catch (err) {
    core.warning(`Could not look up runner pod for node taint wait: ${err}`)
    return
  }

  if (!nodeName) {
    core.warning(
      'Runner pod has no nodeName assigned, skipping node taint wait'
    )
    return
  }

  const pollIntervalMs = 5000
  let elapsed = 0

  core.info(
    `Waiting for node ${nodeName} taints to clear: [${taintKeys.join(', ')}] (timeout: ${effectiveTimeout}s)`
  )

  while (elapsed < effectiveTimeout) {
    try {
      const node = await k8sApi.readNode({ name: nodeName })
      const activeTaints = (node.spec?.taints || [])
        .filter(t => taintKeys.includes(t.key))
        .map(t => t.key)

      if (activeTaints.length === 0) {
        core.info(
          `All configured taints cleared on node ${nodeName} after ${elapsed}s`
        )
        return
      }

      core.info(
        `Node ${nodeName} still has taints: [${activeTaints.join(', ')}] (${elapsed}s/${effectiveTimeout}s)`
      )
    } catch (err) {
      core.warning(`Failed to read node ${nodeName}: ${err}`)
    }

    await sleep(pollIntervalMs)
    elapsed += pollIntervalMs / 1000
  }

  throw new Error(
    `Timed out after ${effectiveTimeout}s waiting for node ${nodeName} taints to clear: [${taintKeys.join(', ')}]`
  )
}

export const requiredPermissions = [
  {
    group: '',
    verbs: ['get', 'list', 'create', 'delete'],
    resource: 'pods',
    subresource: ''
  },
  {
    group: '',
    verbs: ['get', 'create'],
    resource: 'pods',
    subresource: 'exec'
  },
  {
    group: '',
    verbs: ['get', 'list', 'watch'],
    resource: 'pods',
    subresource: 'log'
  },
  {
    group: '',
    verbs: ['create', 'delete', 'get', 'list'],
    resource: 'secrets',
    subresource: ''
  }
]

export async function createJobPod(
  name: string,
  jobContainer?: k8s.V1Container,
  services?: k8s.V1Container[],
  registry?: Registry,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Pod> {
  const containers: k8s.V1Container[] = []
  if (jobContainer) {
    containers.push(jobContainer)
  }
  if (services?.length) {
    containers.push(...services)
  }

  const appPod = new k8s.V1Pod()

  appPod.apiVersion = 'v1'
  appPod.kind = 'Pod'

  appPod.metadata = new k8s.V1ObjectMeta()
  appPod.metadata.name = name

  const instanceLabel = new RunnerInstanceLabel()
  appPod.metadata.labels = {
    [instanceLabel.key]: instanceLabel.value
  }
  appPod.metadata.annotations = {}

  appPod.spec = new k8s.V1PodSpec()
  appPod.spec.containers = containers
  appPod.spec.securityContext = {
    fsGroup: 1001
  }

  // Extract working directory from GITHUB_WORKSPACE
  // GITHUB_WORKSPACE is like /__w/repo-name/repo-name
  const githubWorkspace = process.env.GITHUB_WORKSPACE
  const workingDirPath = githubWorkspace?.split('/').slice(-2).join('/') ?? ''

  const initCommands = [
    'mkdir -p /mnt/externals',
    'mkdir -p /mnt/work',
    'mkdir -p /mnt/github',
    'mv /home/runner/externals/* /mnt/externals/'
  ]

  if (workingDirPath) {
    initCommands.push(`mkdir -p /mnt/work/${workingDirPath}`)
  }

  appPod.spec.initContainers = [
    {
      name: 'fs-init',
      image:
        process.env.ACTIONS_RUNNER_IMAGE ||
        'ghcr.io/actions/actions-runner:latest',
      command: ['sh', '-c', initCommands.join(' && ')],
      securityContext: {
        runAsGroup: 1001,
        runAsUser: 1001
      },
      volumeMounts: [
        {
          name: EXTERNALS_VOLUME_NAME,
          mountPath: '/mnt/externals'
        },
        {
          name: WORK_VOLUME,
          mountPath: '/mnt/work'
        },
        {
          name: GITHUB_VOLUME_NAME,
          mountPath: '/mnt/github'
        }
      ]
    }
  ]

  appPod.spec.restartPolicy = 'Never'

  appPod.spec.volumes = [
    {
      name: EXTERNALS_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: GITHUB_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: WORK_VOLUME,
      emptyDir: {}
    }
  ]

  if (registry) {
    const secret = await createDockerSecret(registry)
    if (!secret?.metadata?.name) {
      throw new Error(`created secret does not have secret.metadata.name`)
    }
    const secretReference = new k8s.V1LocalObjectReference()
    secretReference.name = secret.metadata.name
    appPod.spec.imagePullSecrets = [secretReference]
  }

  if (extension?.metadata) {
    mergeObjectMeta(appPod, extension.metadata)
  }

  if (extension?.spec) {
    mergePodSpecWithOptions(appPod.spec, extension.spec)
  }

  return await k8sApi.createNamespacedPod({
    namespace: namespace(),
    body: appPod
  })
}

export async function createContainerStepPod(
  name: string,
  container: k8s.V1Container,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Pod> {
  const appPod = new k8s.V1Pod()

  appPod.apiVersion = 'v1'
  appPod.kind = 'Pod'

  appPod.metadata = new k8s.V1ObjectMeta()
  appPod.metadata.name = name

  const instanceLabel = new RunnerInstanceLabel()
  appPod.metadata.labels = {
    [instanceLabel.key]: instanceLabel.value
  }
  appPod.metadata.annotations = {}

  appPod.spec = new k8s.V1PodSpec()
  appPod.spec.containers = [container]

  appPod.spec.restartPolicy = 'Never'

  appPod.spec.volumes = [
    {
      name: EXTERNALS_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: GITHUB_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: WORK_VOLUME,
      emptyDir: {}
    }
  ]

  if (extension?.metadata) {
    mergeObjectMeta(appPod, extension.metadata)
  }

  if (extension?.spec) {
    mergePodSpecWithOptions(appPod.spec, extension.spec)
  }

  return await k8sApi.createNamespacedPod({
    namespace: namespace(),
    body: appPod
  })
}

export async function deletePod(name: string): Promise<void> {
  await k8sApi.deleteNamespacedPod({
    name,
    namespace: namespace(),
    gracePeriodSeconds: 0
  })
}

/**
 * Extract the numeric exit code from a K8s exec V1Status response.
 * The exit code is buried in `details.causes` with `reason: "ExitCode"`.
 * Returns null if no exit code is found (infrastructure error, not a process exit).
 */
export function extractExitCode(resp: k8s.V1Status): number | null {
  if (!resp?.details?.causes) return null
  const cause = resp.details.causes.find(c => c.reason === 'ExitCode')
  if (!cause?.message) return null
  const code = parseInt(cause.message, 10)
  return Number.isNaN(code) ? null : code
}

export async function execPodStepWithRetry(
  command: string[],
  podName: string,
  containerName: string,
  description: string,
  maxAttempts = 6,
  initialDelayMs = 1000
): Promise<number> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await execPodStep(command, podName, containerName)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < maxAttempts) {
        const delay = initialDelayMs * Math.pow(3, attempt - 1)
        core.debug(
          `execPodStepWithRetry(${description}): attempt ${attempt}/${maxAttempts} failed (${lastError.message}), retrying in ${delay}ms`
        )
        await sleep(delay)
      }
    }
  }
  throw new Error(
    `execPodStepWithRetry(${description}) failed after ${maxAttempts} attempts: ${lastError?.message}`
  )
}

export async function execPodStepOutputWithRetry(
  command: string[],
  podName: string,
  containerName: string,
  description: string,
  options: {
    retryOnNonZeroExit?: boolean
    maxAttempts?: number
    initialDelayMs?: number
  } = {}
): Promise<{ exitCode: number; stdout: string }> {
  const {
    retryOnNonZeroExit = false,
    maxAttempts = 6,
    initialDelayMs = 1000
  } = options
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await execPodStepOutput(command, podName, containerName)
      if (!retryOnNonZeroExit || result.exitCode === 0) {
        return result
      }
      lastError = new Error(
        `non-zero exit code ${result.exitCode} (stdout: ${result.stdout || 'none'})`
      )
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < maxAttempts) {
      const delay = initialDelayMs * Math.pow(3, attempt - 1)
      core.debug(
        `execPodStepOutputWithRetry(${description}): attempt ${attempt}/${maxAttempts} failed (${lastError?.message}), retrying in ${delay}ms`
      )
      await sleep(delay)
    }
  }
  throw new Error(
    `execPodStepOutputWithRetry(${description}) failed after ${maxAttempts} attempts: ${lastError?.message}`
  )
}

export async function execPodStep(
  command: string[],
  podName: string,
  containerName: string,
  stdin?: stream.Readable,
  timeoutMs?: number
): Promise<number> {
  const exec = new k8s.Exec(kc)
  const effectiveTimeout = timeoutMs ?? EXEC_POD_STEP_TIMEOUT_MS

  command = fixArgs(command)
  let wsRef: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<number>(function (resolve, reject) {
      let settled = false
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        safeTerminateWs(wsRef)
        reject(new Error(`execPodStep timed out after ${effectiveTimeout}ms`))
      }, effectiveTimeout)
      exec
        .exec(
          namespace(),
          podName,
          containerName,
          command,
          process.stdout,
          process.stderr,
          stdin ?? null,
          false /* tty */,
          resp => {
            if (settled) return
            settled = true
            core.debug(`execPodStep response: ${JSON.stringify(resp)}`)
            if (resp.status === 'Success') {
              resolve(0)
            } else {
              core.debug(
                JSON.stringify({
                  message: resp?.message,
                  details: resp?.details
                })
              )
              // Extract exit code from the Failure response. K8s returns exit
              // codes in details.causes with reason "ExitCode". If found,
              // resolve with the code (not reject) so callers can propagate
              // it. Only reject for true infrastructure errors (no exit
              // code).
              const exitCode = extractExitCode(resp)
              if (exitCode !== null) {
                resolve(exitCode)
              } else {
                reject(new Error(resp?.message || 'execPodStep failed'))
              }
            }
          }
        )
        .then(ws => {
          wsRef = ws
          // Handle WebSocket disconnect without a status callback.
          // This happens when the container is killed (e.g. cgroup OOM) —
          // the WebSocket drops before K8s can send a status response.
          if (ws) {
            ws.on('close', () => {
              if (!settled) {
                settled = true
                reject(
                  new Error(
                    'execPodStep: WebSocket closed without status response — container may have been killed'
                  )
                )
              }
            })
            ws.on('error', (err: Error) => {
              if (!settled) {
                settled = true
                reject(
                  new Error(
                    `execPodStep: WebSocket error without status response: ${err.message}`
                  )
                )
              }
            })
          }
        })
        .catch(e => {
          if (!settled) {
            settled = true
            reject(e)
          }
        })
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function execPodStepOutput(
  command: string[],
  podName: string,
  containerName: string,
  timeoutMs?: number
): Promise<{ exitCode: number; stdout: string }> {
  const exec = new k8s.Exec(kc)
  const stdoutBuffer = new BufferSink()
  const effectiveTimeout = timeoutMs ?? EXEC_POD_STEP_TIMEOUT_MS

  command = fixArgs(command)
  let wsRef: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<{ exitCode: number; stdout: string }>(function (
      resolve,
      reject
    ) {
      let settled = false
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        safeTerminateWs(wsRef)
        reject(
          new Error(`execPodStepOutput timed out after ${effectiveTimeout}ms`)
        )
      }, effectiveTimeout)
      exec
        .exec(
          namespace(),
          podName,
          containerName,
          command,
          stdoutBuffer,
          process.stderr,
          null,
          false /* tty */,
          resp => {
            if (settled) return
            settled = true
            const stdout = (
              stdoutBuffer.getContentsAsString('utf8') || ''
            ).trim()
            if (resp.status === 'Success') {
              resolve({ exitCode: 0, stdout })
            } else {
              const exitCode = extractExitCode(resp)
              if (exitCode !== null) {
                resolve({ exitCode, stdout })
              } else {
                reject(new Error(resp?.message || 'execPodStepOutput failed'))
              }
            }
          }
        )
        .then(ws => {
          wsRef = ws
          if (ws) {
            ws.on('close', () => {
              if (!settled) {
                settled = true
                reject(
                  new Error(
                    'execPodStepOutput: WebSocket closed without status response — container may have been killed'
                  )
                )
              }
            })
            ws.on('error', (err: Error) => {
              if (!settled) {
                settled = true
                reject(
                  new Error(
                    `execPodStepOutput: WebSocket error without status response: ${err.message}`
                  )
                )
              }
            })
          }
        })
        .catch(e => {
          if (!settled) {
            settled = true
            reject(e)
          }
        })
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function execCalculateOutputHashSorted(
  podName: string,
  containerName: string,
  command: string[]
): Promise<string> {
  const exec = new k8s.Exec(kc)

  let output = ''
  const outputWriter = new stream.Writable({
    write(chunk, _enc, cb) {
      try {
        output += chunk.toString('utf8')
        cb()
      } catch (e) {
        cb(e as Error)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    exec
      .exec(
        namespace(),
        podName,
        containerName,
        command,
        outputWriter, // capture stdout
        process.stderr,
        null,
        false /* tty */,
        resp => {
          core.debug(`internalExecOutput response: ${JSON.stringify(resp)}`)
          if (resp.status === 'Success') {
            resolve()
          } else {
            core.debug(
              JSON.stringify({
                message: resp?.message,
                details: resp?.details
              })
            )
            reject(new Error(resp?.message || 'internalExecOutput failed'))
          }
        }
      )
      .catch(e => reject(e))
  })

  outputWriter.end()

  // Sort lines for consistent ordering across platforms
  const sortedOutput =
    output
      .split('\n')
      .filter(line => line.length > 0)
      .sort()
      .join('\n') + '\n'

  const hash = createHash('sha256')
  hash.update(sortedOutput)
  return hash.digest('hex')
}

export async function localCalculateOutputHashSorted(
  commands: string[]
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(commands[0], commands.slice(1), {
      stdio: ['ignore', 'pipe', 'ignore']
    })

    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code: number) => {
      if (code === 0) {
        // Sort lines for consistent ordering across distributions/platforms
        const sortedOutput =
          output
            .split('\n')
            .filter(line => line.length > 0)
            .sort()
            .join('\n') + '\n'

        const hash = createHash('sha256')
        hash.update(sortedOutput)
        resolve(hash.digest('hex'))
      } else {
        reject(new Error(`child process exited with code ${code}`))
      }
    })
  })
}

export async function execCpToPod(
  podName: string,
  runnerPath: string,
  containerPath: string
): Promise<void> {
  core.debug(`Copying ${runnerPath} to pod ${podName} at ${containerPath}`)

  let attempt = 0
  while (true) {
    try {
      const exec = new k8s.Exec(kc)
      // Use tar to extract with --no-same-owner to avoid ownership issues.
      // Then use find to fix permissions. The -m flag helps but we also need to fix permissions after.
      const command = [
        'sh',
        '-c',
        `tar xf - --no-same-owner -C ${shlex.quote(containerPath)} 2>/dev/null; ` +
          `find ${shlex.quote(containerPath)} -type f -exec chmod u+rw {} \\; 2>/dev/null; ` +
          `find ${shlex.quote(containerPath)} -type d -exec chmod u+rwx {} \\; 2>/dev/null`
      ]
      const readStream = tar.pack(runnerPath)
      const errStream = new CappedWritable(ERR_STREAM_MAX_BYTES)
      let wsRef: WebSocket | null = null
      let execTimer: ReturnType<typeof setTimeout>
      let backpressureMonitor: ReturnType<typeof setInterval> | undefined
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            let settled = false
            exec
              .exec(
                namespace(),
                podName,
                JOB_CONTAINER_NAME,
                command,
                null,
                errStream,
                readStream,
                false,
                async status => {
                  if (settled) return
                  settled = true
                  // Only reject when k8s reported a non-Success status. A
                  // non-empty errStream on Success is just stderr noise (e.g.
                  // `tar: Removing leading '/'`) — it must not trigger the
                  // 30-attempt retry storm.
                  if (status.status !== 'Success') {
                    const errDetail = errStream.size()
                      ? errStream.getContentsAsString()
                      : ''
                    reject(
                      new Error(
                        `Error from execCpToPod - status: ${status.status}, details: \n ${errDetail}`
                      )
                    )
                    return
                  }
                  if (errStream.size()) {
                    // Debug-level: tar emits routine warnings to stderr on
                    // every successful copy (e.g. "tar: Removing leading '/'
                    // from member names"), so logging at warning would flood
                    // Loki/Grafana on every prepare_job. Devs can enable
                    // debug logging if they need to inspect this content.
                    core.debug(
                      `execCpToPod stderr (status=Success): ${errStream.getContentsAsString()}`
                    )
                  }
                  resolve(status)
                }
              )
              .then(ws => {
                wsRef = ws
                if (ws) {
                  // Pause/resume the source (tar.pack) when ws.bufferedAmount
                  // crosses the high/low water marks. The kc WebSocket
                  // handler (web-socket-handler.js:52-68) does
                  // `stdin.on('data', d => ws.send(d))` with NO callback /
                  // NO bufferedAmount check / NO pause — so under cluster
                  // back-pressure it queues bytes unboundedly in
                  // ws._sender._queue, OOM-killing the runner pod.
                  //
                  // Pausing a Readable that has a 'data' listener stops
                  // 'data' events per Node's stream contract — kc's
                  // listener simply doesn't fire while paused. The library
                  // bug becomes irrelevant.
                  backpressureMonitor = setInterval(() => {
                    // Guard against in-flight ticks racing with the finally
                    // block: clearInterval + readStream.destroy() can land
                    // between the timer wakeup and our pause/resume call. A
                    // pause/resume on a destroyed stream throws, and our
                    // process.on('uncaughtException') handler would turn that
                    // into process.exit(1) — exactly the silent-kill we
                    // hardened against.
                    if (readStream.destroyed) return
                    const buffered =
                      (wsRef as unknown as { bufferedAmount?: number })
                        ?.bufferedAmount ?? 0
                    try {
                      if (
                        buffered > WS_BACKPRESSURE_HIGH_WATER &&
                        !readStream.isPaused()
                      ) {
                        core.debug(
                          `execCpToPod: pausing source (ws buffered=${buffered})`
                        )
                        readStream.pause()
                      } else if (
                        buffered < WS_BACKPRESSURE_LOW_WATER &&
                        readStream.isPaused()
                      ) {
                        core.debug(
                          `execCpToPod: resuming source (ws buffered=${buffered})`
                        )
                        readStream.resume()
                      }
                    } catch (err) {
                      // Defense-in-depth: even with the destroyed guard, the
                      // stream may transition between the check and the call.
                      core.debug(
                        `execCpToPod: backpressure poll caught ${err instanceof Error ? err.message : String(err)}`
                      )
                    }
                  }, WS_BACKPRESSURE_POLL_MS)
                  backpressureMonitor.unref()
                  ws.on('close', () => {
                    if (!settled) {
                      settled = true
                      reject(
                        new Error(
                          'execCpToPod: WebSocket closed without status response'
                        )
                      )
                    }
                  })
                  ws.on('error', (err: Error) => {
                    if (!settled) {
                      settled = true
                      reject(
                        new Error(
                          `execCpToPod: WebSocket error: ${err.message}`
                        )
                      )
                    }
                  })
                }
              })
              .catch(e => {
                if (!settled) {
                  settled = true
                  reject(e)
                }
              })
          }),
          new Promise((_, reject) => {
            execTimer = setTimeout(() => {
              reject(
                new Error(
                  `execCpToPod: exec timed out after ${EXEC_TIMEOUT_MS}ms`
                )
              )
            }, EXEC_TIMEOUT_MS)
          })
        ])
      } finally {
        clearTimeout(execTimer!)
        if (backpressureMonitor) clearInterval(backpressureMonitor)
        safeTerminateWs(wsRef)
        readStream.destroy()
      }
      break
    } catch (error) {
      attempt++
      const msg = `cpToPod: Attempt ${attempt}/30 failed: ${error instanceof Error ? error.message : String(error)}`
      if (attempt >= 3) {
        core.warning(msg)
      } else {
        core.debug(msg)
      }
      if (attempt >= 30) {
        throw new Error(
          `cpToPod failed after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      await sleep(1000)
    }
  }

  // Workspace copy verification: disabled by default to avoid OOM in memory-constrained
  // runner pods (512Mi shared by .NET + Node.js). The verification runs `find -exec stat`
  // across all workspace files, accumulates the output as a JS string, and retries —
  // each retry re-runs the full scan on both sides. This is best-effort (silently
  // continues after exhausting retries) and is the biggest memory spike contributor.
  // WARNING: If re-enabling, ensure NODE_OPTIONS --max-old-space-size >= 256 or
  // V8 will crash (FATAL ERROR) instead of graceful OOM on large workspaces.
  if (COPY_VERIFY_ENABLED) {
    const delay = 1000
    for (let i = 0; i < COPY_VERIFY_RETRIES; i++) {
      try {
        const want = await localCalculateOutputHashSorted([
          'sh',
          '-c',
          listDirAllCommand(runnerPath)
        ])

        const got = await execCalculateOutputHashSorted(
          podName,
          JOB_CONTAINER_NAME,
          ['sh', '-c', listDirAllCommand(containerPath)]
        )

        if (got !== want) {
          core.debug(
            `The hash of the directory does not match the expected value; want='${want}' got='${got}'`
          )
          await sleep(delay)
          continue
        }

        break
      } catch (error) {
        core.debug(`Attempt ${i + 1} failed: ${error}`)
        await sleep(delay)
      }
    }
  }
}

export async function execCpFromPod(
  podName: string,
  containerPath: string,
  parentRunnerPath: string
): Promise<void> {
  const targetRunnerPath = `${parentRunnerPath}/${path.basename(containerPath)}`
  core.debug(
    `Copying from pod ${podName} ${containerPath} to ${targetRunnerPath}`
  )

  let attempt = 0
  while (true) {
    try {
      // make temporary directory
      const exec = new k8s.Exec(kc)
      const containerPaths = containerPath.split('/')
      const dirname = containerPaths.pop() as string
      const command = [
        'tar',
        'cf',
        '-',
        '-C',
        containerPaths.join('/') || '/',
        dirname
      ]
      // No source-side back-pressure throttle here — unlike execCpToPod, the
      // data flow is WebSocket -> kc -> writerStream (tar.extract). We can't
      // pause an inbound WebSocket from a consumer, and kc's
      // handleStandardStreams ignores stdout.write()'s return value (no
      // drain wait). The receive-side risk in practice is much smaller:
      // local fs writes are typically faster than the EKS network path, so
      // sustained backlog is rare. If receive-side OOM ever shows up, the
      // fix needs to live inside kc (honour drain) or as a TransformStream
      // wrapper around writerStream that buffers to disk past a threshold.
      const writerStream = tar.extract(parentRunnerPath)
      const errStream = new CappedWritable(ERR_STREAM_MAX_BYTES)
      let wsRef: WebSocket | null = null
      let execTimer: ReturnType<typeof setTimeout>
      let execSucceeded = false
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            let settled = false
            exec
              .exec(
                namespace(),
                podName,
                JOB_CONTAINER_NAME,
                command,
                writerStream,
                errStream,
                null,
                false,
                async status => {
                  if (settled) return
                  settled = true
                  // Only reject when k8s reported a non-Success status. A
                  // non-empty errStream on Success is just stderr noise and
                  // must not trigger the 30-attempt retry storm.
                  if (status.status !== 'Success') {
                    const errDetail = errStream.size()
                      ? errStream.getContentsAsString()
                      : ''
                    reject(
                      new Error(
                        `Error from cpFromPod - status: ${status.status}, details: \n ${errDetail}`
                      )
                    )
                    return
                  }
                  if (errStream.size()) {
                    // Debug-level: tar emits routine warnings to stderr on
                    // every successful copy, so logging at warning would
                    // flood Loki/Grafana on every prepare_job. Devs can
                    // enable debug logging if they need to inspect this
                    // content.
                    core.debug(
                      `execCpFromPod stderr (status=Success): ${errStream.getContentsAsString()}`
                    )
                  }
                  resolve(status)
                }
              )
              .then(ws => {
                wsRef = ws
                if (ws) {
                  ws.on('close', () => {
                    if (!settled) {
                      settled = true
                      reject(
                        new Error(
                          'execCpFromPod: WebSocket closed without status response'
                        )
                      )
                    }
                  })
                  ws.on('error', (err: Error) => {
                    if (!settled) {
                      settled = true
                      reject(
                        new Error(
                          `execCpFromPod: WebSocket error: ${err.message}`
                        )
                      )
                    }
                  })
                }
              })
              .catch(e => {
                if (!settled) {
                  settled = true
                  reject(e)
                }
              })
          }),
          new Promise((_, reject) => {
            execTimer = setTimeout(() => {
              reject(
                new Error(
                  `execCpFromPod: exec timed out after ${EXEC_TIMEOUT_MS}ms`
                )
              )
            }, EXEC_TIMEOUT_MS)
          })
        ])
        execSucceeded = true
      } finally {
        clearTimeout(execTimer!)
        if (!execSucceeded) {
          safeTerminateWs(wsRef)
          writerStream.destroy()
        }
      }

      // Wait for the tar extraction stream to finish writing all data
      // to disk. The K8s exec status callback fires when the remote
      // command exits, but stdout data may still be in transit through
      // the WebSocket pipeline. Without this, callers that immediately
      // access the extracted files can hit ENOENT race conditions.
      if (!writerStream.writableFinished) {
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const done = (err?: Error | null): void => {
            if (settled) return
            settled = true
            cleanupFn()
            clearTimeout(timer)
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          }
          const cleanupFn = stream.finished(writerStream, err => {
            done(err)
          })
          const timer = setTimeout(() => {
            writerStream.destroy()
            done(new Error('tar extract stream drain timed out after 90s'))
          }, 90000)
        })
      }

      safeTerminateWs(wsRef)

      break
    } catch (error) {
      attempt++
      const msg = `cpFromPod: Attempt ${attempt}/30 failed: ${error instanceof Error ? error.message : String(error)}`
      if (attempt >= 3) {
        core.warning(msg)
      } else {
        core.debug(msg)
      }
      if (attempt >= 30) {
        throw new Error(
          `execCpFromPod failed after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      await sleep(1000)
    }
  }

  // Workspace copy verification: see comment in execCpToPod for rationale.
  if (COPY_VERIFY_ENABLED) {
    const delay = 1000
    for (let i = 0; i < COPY_VERIFY_RETRIES; i++) {
      try {
        const want = await execCalculateOutputHashSorted(
          podName,
          JOB_CONTAINER_NAME,
          ['sh', '-c', listDirAllCommand(containerPath)]
        )

        const got = await localCalculateOutputHashSorted([
          'sh',
          '-c',
          listDirAllCommand(targetRunnerPath)
        ])

        if (got !== want) {
          core.debug(
            `The hash of the directory does not match the expected value; want='${want}' got='${got}'`
          )
          await sleep(delay)
          continue
        }

        break
      } catch (error) {
        core.debug(`Attempt ${i + 1} failed: ${error}`)
        await sleep(delay)
      }
    }
  }
}

export async function waitForJobToComplete(jobName: string): Promise<void> {
  const backOffManager = new BackOffManager()
  while (true) {
    try {
      if (await isJobSucceeded(jobName)) {
        return
      }
    } catch (error) {
      throw new Error(
        `job ${jobName} has failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    await backOffManager.backOff()
  }
}

export async function createDockerSecret(
  registry: Registry
): Promise<k8s.V1Secret> {
  const authContent = {
    auths: {
      [registry.serverUrl || 'https://index.docker.io/v1/']: {
        username: registry.username,
        password: registry.password,
        auth: Buffer.from(`${registry.username}:${registry.password}`).toString(
          'base64'
        )
      }
    }
  }

  const runnerInstanceLabel = new RunnerInstanceLabel()

  const secretName = getSecretName()
  const secret = new k8s.V1Secret()
  secret.immutable = true
  secret.apiVersion = 'v1'
  secret.metadata = new k8s.V1ObjectMeta()
  secret.metadata.name = secretName
  secret.metadata.namespace = namespace()
  secret.metadata.labels = {
    [runnerInstanceLabel.key]: runnerInstanceLabel.value
  }
  secret.type = 'kubernetes.io/dockerconfigjson'
  secret.kind = 'Secret'
  secret.data = {
    '.dockerconfigjson': Buffer.from(JSON.stringify(authContent)).toString(
      'base64'
    )
  }

  return await k8sApi.createNamespacedSecret({
    namespace: namespace(),
    body: secret
  })
}

export async function createSecretForEnvs(envs: {
  [key: string]: string
}): Promise<string> {
  const runnerInstanceLabel = new RunnerInstanceLabel()

  const secret = new k8s.V1Secret()
  const secretName = getSecretName()
  secret.immutable = true
  secret.apiVersion = 'v1'
  secret.metadata = new k8s.V1ObjectMeta()
  secret.metadata.name = secretName

  secret.metadata.labels = {
    [runnerInstanceLabel.key]: runnerInstanceLabel.value
  }
  secret.kind = 'Secret'
  secret.data = {}
  for (const [key, value] of Object.entries(envs)) {
    secret.data[key] = Buffer.from(value).toString('base64')
  }

  await k8sApi.createNamespacedSecret({
    namespace: namespace(),
    body: secret
  })
  return secretName
}

export async function deleteSecret(name: string): Promise<void> {
  await k8sApi.deleteNamespacedSecret({
    name,
    namespace: namespace()
  })
}

export async function pruneSecrets(): Promise<void> {
  const secretList = await k8sApi.listNamespacedSecret({
    namespace: namespace(),
    labelSelector: new RunnerInstanceLabel().toString()
  })
  if (!secretList.items.length) {
    return
  }

  await Promise.all(
    secretList.items.map(
      async secret =>
        secret.metadata?.name && (await deleteSecret(secret.metadata.name))
    )
  )
}

// Best-effort: describe WHY a pod is unhealthy. Reads the pod-level
// reason/message (set by the kubelet for admission rejections like
// TopologyAffinityError / UnexpectedAdmissionError) and any container
// terminated/waiting reasons. Returns a bare detail string (no phase prefix —
// the caller's catch adds that), or '' when nothing useful is available.
// Never throws — on a read failure it returns a short note instead.
async function describePodUnhealth(podName: string): Promise<string> {
  try {
    const pod = await getPodByName(podName)
    const parts: string[] = []
    if (pod.status?.reason) {
      parts.push(`reason=${pod.status.reason}`)
    }
    if (pod.status?.message) {
      parts.push(`message=${pod.status.message}`)
    }
    const containerDetail = [
      ...(pod.status?.initContainerStatuses ?? []),
      ...(pod.status?.containerStatuses ?? [])
    ]
      .map(cs => {
        const terminated = cs.state?.terminated
        const waiting = cs.state?.waiting
        if (terminated) {
          const bits = [
            terminated.reason,
            terminated.message,
            `exitCode=${terminated.exitCode}`
          ].filter(Boolean)
          return `${cs.name}: ${bits.join(' ')}`
        }
        if (waiting) {
          const bits = [waiting.reason, waiting.message]
          // For CrashLoopBackOff the current state is `waiting`, but the
          // reason the container crashed lives in the previous termination.
          const lastTerminated = cs.lastState?.terminated
          if (lastTerminated) {
            bits.push(
              `lastState=${[
                lastTerminated.reason,
                `exitCode=${lastTerminated.exitCode}`
              ]
                .filter(Boolean)
                .join(' ')}`
            )
          }
          return `${cs.name}: ${bits.filter(Boolean).join(' ')}`
        }
        return undefined
      })
      .filter(Boolean)
      .join('; ')
    if (containerDetail) {
      parts.push(`containers=[${containerDetail}]`)
    }
    return parts.length
      ? parts.join(', ')
      : '(no additional pod status details)'
  } catch (err) {
    return `(failed to read pod status: ${
      err instanceof Error ? err.message : String(err)
    })`
  }
}

export async function waitForPodPhases(
  podName: string,
  awaitingPhases: Set<PodPhase>,
  backOffPhases: Set<PodPhase>,
  maxTimeSeconds = DEFAULT_WAIT_FOR_POD_TIME_SECONDS
): Promise<void> {
  const backOffManager = new BackOffManager(maxTimeSeconds)
  const startTime = Date.now()
  let phase: PodPhase = PodPhase.UNKNOWN
  let lastLogTime = 0
  try {
    while (true) {
      phase = await getPodPhase(podName)
      if (awaitingPhases.has(phase)) {
        return
      }

      if (!backOffPhases.has(phase)) {
        throw new Error(await describePodUnhealth(podName))
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000)
      if (Date.now() - lastLogTime >= 10_000) {
        lastLogTime = Date.now()
        try {
          const pod = await getPodByName(podName)
          const conditions = pod.status?.conditions
            ?.map(c => `${c.type}=${c.status}`)
            .join(', ')
          const containerWaiting = pod.status?.containerStatuses
            ?.filter(cs => cs.state?.waiting)
            ?.map(cs => `${cs.name}: ${cs.state!.waiting!.reason}`)
            ?.join('; ')
          core.info(
            `Pod ${podName}: phase=${phase}, conditions=[${conditions || 'none'}], waiting=[${containerWaiting || 'none'}] (${elapsed}s/${maxTimeSeconds}s)`
          )
        } catch {
          core.info(
            `Pod ${podName}: phase=${phase} (${elapsed}s/${maxTimeSeconds}s)`
          )
        }
      }

      await backOffManager.backOff()
    }
  } catch (error) {
    throw new Error(
      `Pod ${podName} is unhealthy with phase status ${phase}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function getPrepareJobTimeoutSeconds(): number {
  const envTimeoutSeconds =
    process.env['ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS']

  if (!envTimeoutSeconds) {
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  const timeoutSeconds = parseInt(envTimeoutSeconds, 10)
  if (!timeoutSeconds || timeoutSeconds <= 0) {
    core.warning(
      `Prepare job timeout is invalid ("${timeoutSeconds}"): use an int > 0`
    )
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  return timeoutSeconds
}

async function getPodPhase(name: string): Promise<PodPhase> {
  const podPhaseLookup = new Set<string>([
    PodPhase.PENDING,
    PodPhase.RUNNING,
    PodPhase.SUCCEEDED,
    PodPhase.FAILED,
    PodPhase.UNKNOWN
  ])
  const pod = await k8sApi.readNamespacedPod({
    name,
    namespace: namespace()
  })

  if (!pod.status?.phase || !podPhaseLookup.has(pod.status.phase)) {
    return PodPhase.UNKNOWN
  }
  return pod.status?.phase as PodPhase
}

async function isJobSucceeded(name: string): Promise<boolean> {
  const job = await k8sBatchV1Api.readNamespacedJob({
    name,
    namespace: namespace()
  })
  if (job.status?.failed) {
    throw new Error(`job ${name} has failed`)
  }
  return !!job.status?.succeeded
}

export async function getPodLogs(
  podName: string,
  containerName: string
): Promise<void> {
  const log = new k8s.Log(kc)
  const logStream = new stream.PassThrough()
  logStream.on('data', chunk => {
    // use write rather than console.log to prevent double line feed
    process.stdout.write(chunk)
  })

  logStream.on('error', err => {
    process.stderr.write(err.message)
  })

  await log.log(namespace(), podName, containerName, logStream, {
    follow: true,
    pretty: false,
    timestamps: false
  })
  await new Promise(resolve => logStream.on('end', () => resolve(null)))
}

export async function prunePods(): Promise<void> {
  const podList = await k8sApi.listNamespacedPod({
    namespace: namespace(),
    labelSelector: new RunnerInstanceLabel().toString()
  })
  if (!podList.items.length) {
    return
  }

  await Promise.all(
    podList.items.map(
      async pod => pod.metadata?.name && (await deletePod(pod.metadata.name))
    )
  )
}

export async function getPodStatus(
  name: string
): Promise<k8s.V1PodStatus | undefined> {
  const pod = await k8sApi.readNamespacedPod({
    name,
    namespace: namespace()
  })
  return pod.status
}

export async function isAuthPermissionsOK(): Promise<boolean> {
  const sar = new k8s.V1SelfSubjectAccessReview()
  const asyncs: Promise<k8s.V1SelfSubjectAccessReview>[] = []
  for (const resource of requiredPermissions) {
    for (const verb of resource.verbs) {
      sar.spec = new k8s.V1SelfSubjectAccessReviewSpec()
      sar.spec.resourceAttributes = new k8s.V1ResourceAttributes()
      sar.spec.resourceAttributes.verb = verb
      sar.spec.resourceAttributes.namespace = namespace()
      sar.spec.resourceAttributes.group = resource.group
      sar.spec.resourceAttributes.resource = resource.resource
      sar.spec.resourceAttributes.subresource = resource.subresource
      asyncs.push(
        k8sAuthorizationV1Api.createSelfSubjectAccessReview({ body: sar })
      )
    }
  }
  const responses = await Promise.all(asyncs)
  return responses.every(resp => resp.status?.allowed)
}

export async function isPodContainerAlpine(
  podName: string,
  containerName: string
): Promise<boolean> {
  const exitCode = await execPodStepWithRetry(
    [
      'sh',
      '-c',
      `[ $(cat /etc/*release* | grep -i -e "^ID=*alpine*" -c) != 0 ] || exit 1`
    ],
    podName,
    containerName,
    'detect alpine'
  )
  return exitCode === 0
}

export function namespace(): string {
  if (process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']) {
    return process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  }

  const context = kc.getContexts().find(ctx => ctx.namespace)
  if (!context?.namespace) {
    throw new Error(
      'Failed to determine namespace, falling back to `default`. Namespace should be set in context, or in env variable "ACTIONS_RUNNER_KUBERNETES_NAMESPACE"'
    )
  }
  return context.namespace
}

class BackOffManager {
  private backOffSeconds = 1
  totalTime = 0
  constructor(private throwAfterSeconds?: number) {
    if (!throwAfterSeconds || throwAfterSeconds < 0) {
      this.throwAfterSeconds = undefined
    }
  }

  async backOff(): Promise<void> {
    await new Promise(resolve =>
      setTimeout(resolve, this.backOffSeconds * 1000)
    )
    this.totalTime += this.backOffSeconds
    if (this.throwAfterSeconds && this.throwAfterSeconds < this.totalTime) {
      throw new Error('backoff timeout')
    }
    if (this.backOffSeconds < 20) {
      this.backOffSeconds *= 2
    }
    if (this.backOffSeconds > 20) {
      this.backOffSeconds = 20
    }
  }
}

export function containerPorts(
  container: ContainerInfo
): k8s.V1ContainerPort[] {
  const ports: k8s.V1ContainerPort[] = []
  if (!container.portMappings?.length) {
    return ports
  }
  for (const portDefinition of container.portMappings) {
    const portProtoSplit = portDefinition.split('/')
    if (portProtoSplit.length > 2) {
      throw new Error(`Unexpected port format: ${portDefinition}`)
    }

    const port = new k8s.V1ContainerPort()
    port.protocol =
      portProtoSplit.length === 2 ? portProtoSplit[1].toUpperCase() : 'TCP'

    const portSplit = portProtoSplit[0].split(':')
    if (portSplit.length > 2) {
      throw new Error('ports should have at most one ":" separator')
    }

    const parsePort = (p: string): number => {
      const num = Number(p)
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        throw new Error(`invalid container port: ${p}`)
      }
      return num
    }

    if (portSplit.length === 1) {
      port.containerPort = parsePort(portSplit[0])
    } else {
      port.hostPort = parsePort(portSplit[0])
      port.containerPort = parsePort(portSplit[1])
    }

    ports.push(port)
  }
  return ports
}

export async function getPodByName(name: string): Promise<k8s.V1Pod> {
  return await k8sApi.readNamespacedPod({
    name,
    namespace: namespace()
  })
}
