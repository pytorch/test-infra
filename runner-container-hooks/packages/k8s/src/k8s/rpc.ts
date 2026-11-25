import * as core from '@actions/core'
import * as crypto from 'crypto'
import { Readable } from 'stream'
import { sleep } from './utils'
import { execPodStep, execPodStepOutput, getPodByName } from './index'
import { RPC_SERVER_AMD64, RPC_SERVER_ARM64 } from './rpc-server-script'

interface RpcStatusResponse {
  // null when no job has run yet (server is in initial 'idle' state). The
  // Python server sets _job_id = None at startup and only assigns a value
  // when /exec accepts a job.
  id: string | null
  // 'starting'/'killing' are transient server-side states (job being launched
  // or torn down); the poll loop treats them like 'running' and keeps waiting.
  status: 'idle' | 'starting' | 'running' | 'killing' | 'completed' | 'failed'
  exit_code: number | null
}

const HEALTH_POLL_INTERVAL_MS = 1000
const HEALTH_TIMEOUT_MS = 30000
const HEARTBEAT_INTERVAL_MS = 3000
const MAX_DEPLOY_ATTEMPTS = 3
const HEARTBEAT_GRACE_MS = 60000
const LOG_POLL_INTERVAL_MS = 200
const FETCH_TIMEOUT_MS = 10000
const KILL_TIMEOUT_MS = 5000
const DIAGNOSTIC_TIMEOUT_MS = 15000
const DIAGNOSTIC_EXEC_TIMEOUT_MS = 10000

function rpcUrl(podIp: string, port: number, path: string): string {
  const host = podIp.includes(':') ? `[${podIp}]` : podIp
  return `http://${host}:${port}${path}`
}

async function healthCheck(podIp: string, port: number): Promise<boolean> {
  // Health-check from the hook side via outbound HTTP. Avoids depending on
  // any in-pod tool (curl/wget/nc/python) — the binary listens on the pod IP
  // and the hook process can reach it directly.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const resp = await fetch(rpcUrl(podIp, port, '/health'), {
      signal: controller.signal
    })
    return resp.ok
  } catch {
    return false
  } finally {
    // Always clear the timer — on the throw/abort path the success-only
    // clearTimeout was skipped, leaking a pending timer across polls.
    clearTimeout(timer)
  }
}

export async function deployRpcServer(
  podName: string,
  containerName: string,
  token: string
): Promise<{ podIp: string; port: number }> {
  const pod = await getPodByName(podName)
  const podIp = pod.status?.podIP
  if (!podIp) {
    throw new Error(`Pod ${podName} has no IP address`)
  }

  // Pick the right static binary for the pod's architecture. The binary is
  // musl-linked so it runs on glibc, musl (Alpine), distroless and scratch
  // alike — no python3/node/libc required in the image.
  let arch: string
  try {
    const { stdout } = await execPodStepOutput(
      ['uname', '-m'],
      podName,
      containerName
    )
    arch = stdout.trim()
  } catch (err) {
    throw new Error(
      `RPC: failed to detect pod arch (${err instanceof Error ? err.message : err})`
    )
  }

  let binaryB64: string
  if (arch === 'x86_64' || arch === 'amd64') {
    binaryB64 = RPC_SERVER_AMD64
  } else if (arch === 'aarch64' || arch === 'arm64') {
    binaryB64 = RPC_SERVER_ARM64
  } else {
    throw new Error(
      `RPC: unsupported pod arch "${arch}" — only x86_64/amd64 and aarch64/arm64 are supported`
    )
  }

  // rpc-server-script.ts ships with empty placeholders that CI overwrites with
  // the real base64 during the build (prebuild -> build-rpc-server.sh +
  // embed-rpc-server.js). If the package is consumed without that step, the
  // blob is "" and we'd otherwise deploy a 0-byte /tmp/rpc-server that fails to
  // exec — surfacing much later as a baffling "could not parse listening port"
  // / health-check timeout. Fail fast with an actionable message instead.
  if (!binaryB64) {
    throw new Error(
      `RPC: no embedded ${arch} server binary — run packages/k8s/scripts/build-rpc-server.sh ` +
        `then scripts/embed-rpc-server.js (CI does this via the k8s package prebuild)`
    )
  }

  // Stream the base64 blob over the exec's stdin and decode it in-pod, rather
  // than inlining it as a shell argument. The blob is ~830 KB; passing it as
  // argv (`echo '<base64>'`) blows past Linux's MAX_ARG_STRLEN (128 KiB per
  // single argument), so the kernel fails to exec `sh` with "argument list too
  // long" — and the failing exec then hangs the websocket until the 60s
  // per-call timeout, six times over. stdin has no such size limit.
  let wrote = false
  let lastWriteErr: unknown
  for (let attempt = 1; attempt <= MAX_DEPLOY_ATTEMPTS; attempt++) {
    try {
      // Fresh stream per attempt — a Readable can only be consumed once.
      const stdin = Readable.from([Buffer.from(binaryB64)])
      const exitCode = await execPodStep(
        ['sh', '-c', 'base64 -d > /tmp/rpc-server && chmod +x /tmp/rpc-server'],
        podName,
        containerName,
        stdin
      )
      if (exitCode === 0) {
        wrote = true
        break
      }
      lastWriteErr = new Error(`base64 decode exited ${exitCode}`)
    } catch (err) {
      lastWriteErr = err
    }
    if (attempt < MAX_DEPLOY_ATTEMPTS) {
      await sleep(1000 * attempt)
    }
  }
  if (!wrote) {
    throw new Error(
      `RPC server binary write failed (${lastWriteErr instanceof Error ? lastWriteErr.message : lastWriteErr})`
    )
  }

  const attemptErrors: string[] = []

  for (let attempt = 1; attempt <= MAX_DEPLOY_ATTEMPTS; attempt++) {
    core.debug(
      `Starting RPC server (attempt ${attempt}/${MAX_DEPLOY_ATTEMPTS})`
    )

    // Kill any server left over from a previous failed attempt.
    try {
      await execPodStep(
        ['sh', '-c', `pkill -f '/tmp/rpc-server' 2>/dev/null; true`],
        podName,
        containerName
      )
    } catch (err) {
      core.info(
        `RPC cleanup failed (attempt ${attempt}/${MAX_DEPLOY_ATTEMPTS}): ${err instanceof Error ? err.message : err}`
      )
    }

    // Start the server with --port 0 (OS picks a free port) and --daemonize:
    // it prints "RPC server listening on [::]:PORT" to stdout, then forks into
    // the background and detaches its stdio so this exec returns. We read the
    // port straight from that line — no port file, no polling.
    let port: number
    try {
      const { exitCode, stdout } = await execPodStepOutput(
        ['/tmp/rpc-server', '--port', '0', '--token', token, '--daemonize'],
        podName,
        containerName
      )
      // Match the full announcement line (multiline-anchored) rather than a
      // bare "[::]:NNNN" substring, so unrelated stdout noise can't be
      // mistaken for the port line.
      const match = stdout.match(/^RPC server listening on \[::\]:(\d+)$/m)
      const parsed = match ? parseInt(match[1], 10) : NaN
      if (exitCode !== 0 || isNaN(parsed) || parsed <= 0) {
        throw new Error(
          `could not parse listening port from server output (exit ${exitCode}): ${stdout || '(empty)'}`
        )
      }
      port = parsed
      core.debug(`RPC server reported port ${port}`)
    } catch (err) {
      const msg = `attempt ${attempt}: server start failed: ${err instanceof Error ? err.message : err}`
      core.warning(msg)
      attemptErrors.push(msg)
      continue
    }

    const startTime = Date.now()
    let healthy = false
    while (Date.now() - startTime < HEALTH_TIMEOUT_MS) {
      if (await healthCheck(podIp, port)) {
        core.debug(`RPC server healthy after ${Date.now() - startTime}ms`)
        healthy = true
        break
      }
      await sleep(HEALTH_POLL_INTERVAL_MS)
    }

    if (healthy) {
      return { podIp, port }
    }

    let serverLog = ''
    try {
      const logResult = await execPodStepOutput(
        [
          'sh',
          '-c',
          'tail -20 /tmp/rpc-server.log 2>/dev/null || echo "(no log)"'
        ],
        podName,
        containerName
      )
      serverLog = logResult.stdout
    } catch {
      // best effort
    }
    const msg = `attempt ${attempt}: health check timed out on port ${port}${serverLog ? `. Server log:\n${serverLog}` : ''}`
    core.warning(msg)
    attemptErrors.push(msg)
  }

  throw new Error(
    `RPC server failed after ${MAX_DEPLOY_ATTEMPTS} attempts:\n${attemptErrors.join('\n')}`
  )
}

interface PodFailureDiagnostic {
  cause:
    | 'container-oom'
    | 'pod-evicted'
    | 'node-failure'
    | 'rpc-process-died'
    | 'unknown'
  exitCode: number
  message: string
}

async function diagnosePodFailure(
  podName: string,
  containerName: string
): Promise<PodFailureDiagnostic> {
  const pod = await getPodByName(podName)
  const phase = pod.status?.phase
  const podReason = pod.status?.reason
  const podMessage = pod.status?.message

  const containerStatus = pod.status?.containerStatuses?.find(
    cs => cs.name === containerName
  )

  // Container terminated — check reason (OOMKilled, Error, etc.)
  const terminated = containerStatus?.state?.terminated
  if (terminated) {
    if (terminated.reason === 'OOMKilled') {
      // Force 137 — some CRI runtimes report exitCode 0 for OOMKilled
      const oomExitCode = terminated.exitCode || 137
      return {
        cause: 'container-oom',
        exitCode: oomExitCode,
        message: `Container "${containerName}" was OOMKilled (exit code ${oomExitCode}). The process exceeded the container memory limit.`
      }
    }
    return {
      cause: 'unknown',
      exitCode: terminated.exitCode ?? -1,
      message: `Container "${containerName}" terminated: ${terminated.reason ?? 'unknown reason'} (exit code ${terminated.exitCode ?? -1})${terminated.message ? `. ${terminated.message}` : ''}`
    }
  }

  // Pod-level failure (eviction, preemption, etc.)
  if (phase === 'Failed') {
    if (podReason === 'Evicted') {
      return {
        cause: 'pod-evicted',
        exitCode: -1,
        message: `Pod was evicted${podMessage ? `: ${podMessage}` : ''}`
      }
    }
    return {
      cause: 'unknown',
      exitCode: -1,
      message: `Pod failed: ${podReason ?? 'unknown reason'}${podMessage ? `. ${podMessage}` : ''}`
    }
  }

  // Pod phase Unknown — typically node failure
  if (phase === 'Unknown') {
    return {
      cause: 'node-failure',
      exitCode: -1,
      message: `Pod is in Unknown phase — possible node failure${podMessage ? `. ${podMessage}` : ''}`
    }
  }

  // Container still running — RPC server process likely crashed inside it
  if (phase === 'Running' && containerStatus?.state?.running) {
    let serverLog = ''
    try {
      let execTimer: ReturnType<typeof setTimeout>
      const result = await Promise.race([
        execPodStepOutput(
          [
            'sh',
            '-c',
            'tail -20 /tmp/rpc-server.log 2>/dev/null || echo "(no server log)"'
          ],
          podName,
          containerName
        ),
        new Promise<never>((_, reject) => {
          execTimer = setTimeout(
            () => reject(new Error('diagnostic exec timeout')),
            DIAGNOSTIC_EXEC_TIMEOUT_MS
          )
        })
      ]).finally(() => clearTimeout(execTimer))
      serverLog = result.stdout
    } catch {
      // Diagnostic exec failed — proceed without server log
    }
    return {
      cause: 'rpc-process-died',
      exitCode: -1,
      message: `RPC server process died while container is still running (likely process-level OOM or crash)${serverLog ? `\nServer log:\n${serverLog}` : ''}`
    }
  }

  return {
    cause: 'unknown',
    exitCode: -1,
    message: `Pod in unexpected state: phase=${phase}, reason=${podReason}${podMessage ? `. ${podMessage}` : ''}`
  }
}

export async function rpcPodStep(
  podIp: string,
  port: number,
  scriptPath: string,
  token: string,
  podName: string,
  containerName: string
): Promise<number> {
  const id = crypto.randomUUID()
  const headers = { 'X-Auth-Token': token, 'Content-Type': 'application/json' }

  // Retry /exec on network errors and 5xx; throw immediately on 4xx
  const maxExecAttempts = 3
  const execRetryDelayMs = 1000
  for (let attempt = 1; attempt <= maxExecAttempts; attempt++) {
    let execResp: Response
    try {
      execResp = await fetch(rpcUrl(podIp, port, '/exec'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ id, path: scriptPath }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
    } catch (fetchErr) {
      if (attempt < maxExecAttempts) {
        core.debug(
          `RPC /exec network error (attempt ${attempt}/${maxExecAttempts}): ${fetchErr}`
        )
        await sleep(execRetryDelayMs)
        continue
      }
      throw new Error(
        `RPC /exec network error after ${maxExecAttempts} attempts: ${fetchErr}`
      )
    }

    if (execResp.ok) {
      break
    }

    if (execResp.status >= 400 && execResp.status < 500) {
      const body = await execResp.text().catch(() => '')

      if (
        execResp.status === 409 &&
        body.includes('A job is already running')
      ) {
        // The RPC server still has a prior job in 'running' state. This
        // almost always means the prior step was cancelled by GitHub Actions
        // (matrix fail-fast, manual cancel, workflow concurrency override,
        // or run-level cancellation) but the in-pod subprocess kept running
        // — the cancel signal only reached the hook process. Subsequent
        // post-cleanup steps cannot start until that prior subprocess exits.
        // The hook's SIGTERM/SIGINT handler is supposed to /kill it; seeing
        // 409 here means that path didn't fire (e.g. SIGKILL, hook crash).
        let stuckCtx = ''
        try {
          const statusResp = await fetch(rpcUrl(podIp, port, '/status'), {
            headers: { 'X-Auth-Token': token },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
          })
          if (statusResp.ok) {
            const s = (await statusResp.json()) as RpcStatusResponse
            stuckCtx = ` (prior job id=${s.id ?? '?'}, status=${s.status ?? '?'})`
          }
        } catch {
          // Best-effort diagnostic; ignore failures
        }
        throw new Error(
          `Step cannot start: workflow pod still has a prior step in flight${stuckCtx}. ` +
            `This is the expected state after GitHub Actions cancels a step ` +
            `(matrix fail-fast, manual cancel, or workflow concurrency override) ` +
            `while its subprocess was still running inside the pod. Check earlier ` +
            `in the job log (or the workflow-run page) for the actual cancellation.`
        )
      }

      throw new Error(`RPC /exec failed (${execResp.status}): ${body}`)
    }

    if (attempt < maxExecAttempts) {
      core.debug(
        `RPC /exec server error ${execResp.status} (attempt ${attempt}/${maxExecAttempts}), retrying`
      )
      await sleep(execRetryDelayMs)
      continue
    }

    const body = await execResp.text().catch(() => '')
    throw new Error(
      `RPC /exec failed after ${maxExecAttempts} attempts (${execResp.status}): ${body}`
    )
  }

  let lastSuccessfulHeartbeat = Date.now()
  const heartbeatInterval = setInterval(async () => {
    try {
      const resp = await fetch(rpcUrl(podIp, port, '/heartbeat'), {
        method: 'POST',
        headers: { 'X-Auth-Token': token },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (resp.ok) {
        lastSuccessfulHeartbeat = Date.now()
      } else if (Date.now() - lastSuccessfulHeartbeat > HEARTBEAT_GRACE_MS) {
        clearInterval(heartbeatInterval)
      }
    } catch {
      if (Date.now() - lastSuccessfulHeartbeat > HEARTBEAT_GRACE_MS) {
        clearInterval(heartbeatInterval)
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  let stdoutOffset = 0
  let stderrOffset = 0
  let exitCode = -1

  try {
    while (true) {
      if (Date.now() - lastSuccessfulHeartbeat > HEARTBEAT_GRACE_MS) {
        let diagnosticMsg =
          'RPC heartbeat failed for 60s — infrastructure failure'
        try {
          let diagTimer: ReturnType<typeof setTimeout>
          const diagnostic = await Promise.race([
            diagnosePodFailure(podName, containerName),
            new Promise<never>((_, reject) => {
              diagTimer = setTimeout(
                () => reject(new Error('diagnostic timed out')),
                DIAGNOSTIC_TIMEOUT_MS
              )
            })
          ]).finally(() => clearTimeout(diagTimer))
          diagnosticMsg = diagnostic.message
          core.error(`Step failed: ${diagnostic.message}`)
        } catch (diagErr) {
          core.debug(`Pod failure diagnosis failed: ${diagErr}`)
          core.error(diagnosticMsg)
        }
        throw new Error(diagnosticMsg)
      }

      // Log streaming — stdout and stderr in parallel
      try {
        const [stdoutData, stderrData] = await Promise.all([
          fetchLogStream(podIp, port, token, 'stdout', stdoutOffset),
          fetchLogStream(podIp, port, token, 'stderr', stderrOffset)
        ])
        if (stdoutData.byteLength > 0) {
          process.stdout.write(Buffer.from(stdoutData))
          stdoutOffset += stdoutData.byteLength
        }
        if (stderrData.byteLength > 0) {
          process.stderr.write(Buffer.from(stderrData))
          stderrOffset += stderrData.byteLength
        }
      } catch {
        core.debug('log fetch failed, will retry')
      }

      // Status polling
      try {
        const statusResp = await fetch(rpcUrl(podIp, port, '/status'), {
          headers: { 'X-Auth-Token': token },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        })
        if (statusResp.ok) {
          const status = (await statusResp.json()) as RpcStatusResponse
          if (status.status === 'completed' || status.status === 'failed') {
            exitCode = status.exit_code ?? -1
            break
          }
        }
      } catch {
        core.debug('status fetch failed, will retry')
      }

      await sleep(LOG_POLL_INTERVAL_MS)
    }

    // Final log flush — drain all remaining data from both streams
    try {
      let flushing = true
      while (flushing) {
        const [stdoutData, stderrData] = await Promise.all([
          fetchLogStream(podIp, port, token, 'stdout', stdoutOffset),
          fetchLogStream(podIp, port, token, 'stderr', stderrOffset)
        ])
        flushing = false
        if (stdoutData.byteLength > 0) {
          process.stdout.write(Buffer.from(stdoutData))
          stdoutOffset += stdoutData.byteLength
          flushing = true
        }
        if (stderrData.byteLength > 0) {
          process.stderr.write(Buffer.from(stderrData))
          stderrOffset += stderrData.byteLength
          flushing = true
        }
      }
    } catch {
      core.debug('final log flush failed')
    }

    return exitCode
  } finally {
    clearInterval(heartbeatInterval)
  }
}

/**
 * Tell the in-pod RPC server to terminate the currently running job.
 *
 * Called from the hook's SIGTERM/SIGINT handler when GitHub Actions cancels
 * the step. Without this, the user's subprocess (e.g. pytest) keeps running
 * in the workflow pod and post-cleanup steps fail with 409 "A job is already
 * running" until something else (heartbeat watchdog, pod eviction) kills it.
 *
 * Always best-effort: never throws, swallows network errors, and uses a tight
 * timeout because the process is about to exit.
 */
export async function killRpcJob(
  podIp: string,
  port: number,
  token: string
): Promise<void> {
  try {
    await fetch(rpcUrl(podIp, port, '/kill'), {
      method: 'POST',
      headers: { 'X-Auth-Token': token },
      signal: AbortSignal.timeout(KILL_TIMEOUT_MS)
    })
  } catch (err) {
    core.debug(`Failed to send /kill on cancellation: ${err}`)
  }
}

async function fetchLogStream(
  podIp: string,
  port: number,
  token: string,
  stream: 'stdout' | 'stderr',
  offset: number
): Promise<ArrayBuffer> {
  const resp = await fetch(
    rpcUrl(podIp, port, `/logs?stream=${stream}&offset=${offset}`),
    {
      headers: { 'X-Auth-Token': token },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    }
  )
  if (!resp.ok) {
    return new ArrayBuffer(0)
  }
  return resp.arrayBuffer()
}
