import * as core from '@actions/core'
import * as k8s from '@kubernetes/client-node'
import {
  JobContainerInfo,
  ContextPorts,
  PrepareJobArgs,
  writeToResponseFile,
  ServiceContainerInfo
} from 'hooklib'
import {
  containerPorts,
  createJobPod,
  isPodContainerAlpine,
  prunePods,
  waitForPodPhases,
  getPrepareJobTimeoutSeconds,
  execCpToPod,
  execPodStepWithRetry,
  waitForNodeTaintsRemoval
} from '../k8s'
import {
  CONTAINER_VOLUMES,
  DEFAULT_CONTAINER_ENTRY_POINT,
  DEFAULT_CONTAINER_ENTRY_POINT_ARGS,
  generateContainerName,
  mergeContainerWithOptions,
  readExtensionFromFile,
  PodPhase,
  fixArgs,
  prepareJobScript
} from '../k8s/utils'
import {
  CONTAINER_EXTENSION_PREFIX,
  getJobPodName,
  JOB_CONTAINER_NAME
} from './constants'
import * as crypto from 'crypto'
import { dirname } from 'path'
import { deployRpcServer } from '../k8s/rpc'
import { sleep } from '../k8s/utils'

export async function prepareJob(
  args: PrepareJobArgs,
  responseFile: string
): Promise<void> {
  if (!args.container) {
    throw new Error('Job Container is required.')
  }

  core.info(`[prepare_job] workflow image: ${args.container.image}`)
  for (const service of args.services || []) {
    core.info(
      `[prepare_job] service ${service.contextName} image: ${service.image}`
    )
  }

  await prunePods()

  const extension = readExtensionFromFile()

  let container: k8s.V1Container | undefined = undefined
  if (args.container?.image) {
    container = createContainerSpec(
      args.container,
      JOB_CONTAINER_NAME,
      true,
      extension
    )
  }

  let services: k8s.V1Container[] = []
  if (args.services?.length) {
    services = args.services.map(service => {
      return createContainerSpec(
        service,
        generateContainerName(service.image),
        false,
        extension
      )
    })
  }

  if (!container && !services?.length) {
    throw new Error('No containers exist, skipping hook invocation')
  }

  const t0 = Date.now()
  const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`

  await waitForNodeTaintsRemoval()
  core.info(`[prepare_job] taint wait complete (${elapsed()})`)

  let createdPod: k8s.V1Pod | undefined = undefined
  try {
    createdPod = await createJobPod(
      getJobPodName(),
      container,
      services,
      args.container.registry,
      extension
    )
  } catch (err) {
    await prunePods()
    core.debug(`createPod failed: ${JSON.stringify(err)}`)
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to create job pod: ${message}`)
  }

  if (!createdPod?.metadata?.name) {
    throw new Error('created pod should have metadata.name')
  }
  core.info(`[prepare_job] pod created (${elapsed()})`)
  core.debug(
    `Job pod created, waiting for it to come online ${createdPod?.metadata?.name}`
  )

  const runnerWorkspace = dirname(process.env.RUNNER_WORKSPACE as string)

  let prepareScript: { containerPath: string; runnerPath: string } | undefined
  if (args.container?.userMountVolumes?.length) {
    prepareScript = prepareJobScript(args.container.userMountVolumes || [])
  }

  try {
    await waitForPodPhases(
      createdPod.metadata.name,
      new Set([PodPhase.RUNNING]),
      new Set([PodPhase.PENDING]),
      getPrepareJobTimeoutSeconds()
    )
  } catch (err) {
    await prunePods()
    throw new Error(`pod failed to come online with error: ${err}`)
  }
  core.info(`[prepare_job] pod running (${elapsed()})`)

  await execCpToPod(createdPod.metadata.name, runnerWorkspace, '/__w')

  if (prepareScript) {
    const prepareRc = await execPodStepWithRetry(
      ['sh', '-e', prepareScript.containerPath],
      createdPod.metadata.name,
      JOB_CONTAINER_NAME,
      'prepare-job script'
    )
    if (prepareRc !== 0) {
      throw new Error(`prepare-job script failed with exit code ${prepareRc}`)
    }

    const promises: Promise<void>[] = []
    for (const vol of args?.container?.userMountVolumes || []) {
      promises.push(
        execCpToPod(
          createdPod.metadata.name,
          vol.sourceVolumePath,
          vol.targetVolumePath
        )
      )
    }
    await Promise.all(promises)
  }

  core.info(`[prepare_job] workspace copied (${elapsed()})`)
  core.debug('Job pod is ready for traffic')

  let isAlpine = false
  try {
    isAlpine = await isPodContainerAlpine(
      createdPod.metadata.name,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    core.warning(
      `Alpine detection failed, defaulting to non-Alpine: ${err instanceof Error ? err.message : err}`
    )
  }
  core.debug(`Setting isAlpine to ${isAlpine}`)

  const rpcToken = crypto.randomUUID()
  const maxRpcAttempts = 3
  const rpcRetryDelayMs = 3000
  let rpcPodIp: string | undefined
  let rpcPort: number | undefined
  for (let attempt = 1; attempt <= maxRpcAttempts; attempt++) {
    try {
      const result = await deployRpcServer(
        createdPod.metadata.name,
        JOB_CONTAINER_NAME,
        rpcToken
      )
      rpcPodIp = result.podIp
      rpcPort = result.port
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt < maxRpcAttempts) {
        core.warning(
          `deployRpcServer failed (attempt ${attempt}/${maxRpcAttempts}): ${msg}, retrying in ${rpcRetryDelayMs}ms`
        )
        await sleep(rpcRetryDelayMs)
      } else {
        throw new Error(
          `deployRpcServer failed after ${maxRpcAttempts} attempts: ${msg}`
        )
      }
    }
  }
  core.info(
    `[prepare_job] RPC server ready at ${rpcPodIp}:${rpcPort} (${elapsed()})`
  )

  generateResponseFile(responseFile, args, createdPod, isAlpine, {
    rpcPodIp: rpcPodIp!,
    rpcPort: rpcPort!,
    rpcToken
  })
}

function generateResponseFile(
  responseFile: string,
  args: PrepareJobArgs,
  appPod: k8s.V1Pod,
  isAlpine: boolean,
  rpcState: { rpcPodIp: string; rpcPort: number; rpcToken: string }
): void {
  if (!appPod.metadata?.name) {
    throw new Error('app pod must have metadata.name specified')
  }
  const response = {
    state: {
      jobPod: appPod.metadata.name,
      ...rpcState
    },
    context: {},
    isAlpine
  }

  const mainContainer = appPod.spec?.containers?.find(
    c => c.name === JOB_CONTAINER_NAME
  )
  if (mainContainer) {
    const mainContainerContextPorts: ContextPorts = {}
    if (mainContainer?.ports) {
      for (const port of mainContainer.ports) {
        mainContainerContextPorts[port.containerPort] =
          mainContainerContextPorts.hostPort
      }
    }

    response.context['container'] = {
      image: mainContainer.image,
      ports: mainContainerContextPorts
    }
  }

  if (args.services?.length) {
    const serviceContainerNames =
      args.services?.map(s => generateContainerName(s.image)) || []

    response.context['services'] = appPod?.spec?.containers
      ?.filter(c => serviceContainerNames.includes(c.name))
      .map(c => {
        const ctxPorts: ContextPorts = {}
        if (c.ports?.length) {
          for (const port of c.ports) {
            if (port.containerPort && port.hostPort) {
              ctxPorts[port.containerPort.toString()] = port.hostPort.toString()
            }
          }
        }

        return {
          image: c.image,
          ports: ctxPorts
        }
      })
  }

  writeToResponseFile(responseFile, JSON.stringify(response))
}

export function createContainerSpec(
  container: JobContainerInfo | ServiceContainerInfo,
  name: string,
  jobContainer = false,
  extension?: k8s.V1PodTemplateSpec
): k8s.V1Container {
  if (!container.entryPoint && jobContainer) {
    container.entryPoint = DEFAULT_CONTAINER_ENTRY_POINT
    container.entryPointArgs = DEFAULT_CONTAINER_ENTRY_POINT_ARGS
  }

  const podContainer = {
    name,
    image: container.image,
    ports: containerPorts(container)
  } as k8s.V1Container
  if (container['workingDirectory']) {
    podContainer.workingDir = container['workingDirectory']
  }

  if (container.entryPoint) {
    podContainer.command = [container.entryPoint]
  }

  if (container.entryPointArgs && container.entryPointArgs.length > 0) {
    podContainer.args = fixArgs(container.entryPointArgs)
  }

  podContainer.env = []
  for (const [key, value] of Object.entries(
    container['environmentVariables'] || {}
  )) {
    if (value && key !== 'HOME') {
      podContainer.env.push({ name: key, value })
    }
  }

  podContainer.env.push({
    name: 'GITHUB_ACTIONS',
    value: 'true'
  })

  if (!('CI' in (container['environmentVariables'] || {}))) {
    podContainer.env.push({
      name: 'CI',
      value: 'true'
    })
  }

  podContainer.volumeMounts = CONTAINER_VOLUMES

  if (!extension) {
    return podContainer
  }

  const from = extension.spec?.containers?.find(
    c => c.name === CONTAINER_EXTENSION_PREFIX + name
  )

  if (from) {
    mergeContainerWithOptions(podContainer, from)
  }

  return podContainer
}
