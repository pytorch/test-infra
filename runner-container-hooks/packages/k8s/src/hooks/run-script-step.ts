/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs'
import * as core from '@actions/core'
import { RunScriptStepArgs } from 'hooklib'
import { execCpFromPod, execCpToPod, execPodStepWithRetry } from '../k8s'
import { killRpcJob, rpcPodStep } from '../k8s/rpc'
import { registerCleanup, unregisterCleanup } from '../safety/process-handlers'
import { writeRunScript } from '../k8s/utils'
import { JOB_CONTAINER_NAME } from './constants'
import { dirname } from 'path'

export interface RunScriptStepState {
  jobPod: string
  rpcPodIp: string
  rpcPort: number
  rpcToken: string
}

export async function runScriptStep(
  args: RunScriptStepArgs,
  state: RunScriptStepState
): Promise<number> {
  // Write the entrypoint first. This will be later coppied to the workflow pod
  const { entryPoint, entryPointArgs, environmentVariables } = args
  const { containerPath, runnerPath } = writeRunScript(
    args.workingDirectory,
    entryPoint,
    entryPointArgs,
    args.prependPath,
    environmentVariables
  )

  const workdir = dirname(process.env.RUNNER_WORKSPACE as string)
  const runnerTemp = `${workdir}/_temp`
  const containerTemp = '/__w/_temp'
  const containerTempSrc = '/__w/_temp_pre'
  // Ensure base and staging dirs exist before copying
  const mkdirRc = await execPodStepWithRetry(
    [
      'sh',
      '-c',
      'mkdir -p /__w && mkdir -p /__w/_temp && mkdir -p /__w/_temp_pre'
    ],
    state.jobPod,
    JOB_CONTAINER_NAME,
    'mkdir temp dirs'
  )
  if (mkdirRc !== 0) {
    throw new Error(
      `Infrastructure command failed with exit code ${mkdirRc}: mkdir temp dirs`
    )
  }
  await execCpToPod(state.jobPod, runnerTemp, containerTempSrc)

  // Copy GitHub directories from temp to /github
  // Merge strategy:
  // - Overwrite files in _runner_file_commands
  // - Append files not already present elsewhere
  const mergeCommands = [
    'set -e',
    'mkdir -p /__w/_temp /__w/_temp_pre',
    'SRC=/__w/_temp_pre',
    'DST=/__w/_temp',
    // Overwrite _runner_file_commands
    'cp -a "$SRC/_runner_file_commands/." "$DST/_runner_file_commands"',
    `find "$SRC" -type f ! -path "*/_runner_file_commands/*" -exec sh -c '
    rel="\${1#$2/}"
    target="$3/$rel"
    mkdir -p "$(dirname "$target")"
    cp -a "$1" "$target"
  ' _ {} "$SRC" "$DST" \\;`,
    // Remove _temp_pre after merging
    'rm -rf /__w/_temp_pre'
  ]

  try {
    const mergeRc = await execPodStepWithRetry(
      ['sh', '-c', mergeCommands.join(' && ')],
      state.jobPod,
      JOB_CONTAINER_NAME,
      'merge temp dirs'
    )
    if (mergeRc !== 0) {
      throw new Error(
        `Infrastructure command failed with exit code ${mergeRc}: merge temp dirs`
      )
    }
  } catch (err) {
    core.debug(`Failed to merge temp directories: ${JSON.stringify(err)}`)
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to merge temp dirs: ${message}`)
  }

  // Execute the entrypoint script — propagate exit code to the caller
  // so the runner can mark the step as failed when the user's script fails.
  //
  // On cancellation (SIGTERM/SIGINT to the hook), forward /kill into the
  // pod so the in-pod subprocess exits with us. Without this, the subprocess
  // outlives the cancelled hook and the next post-cleanup step's /exec gets
  // 409 "A job is already running", spamming the log with misleading errors.
  const killOnCancel = async (): Promise<void> => {
    await killRpcJob(state.rpcPodIp, state.rpcPort, state.rpcToken)
  }
  registerCleanup(killOnCancel)
  let exitCode: number
  try {
    exitCode = await rpcPodStep(
      state.rpcPodIp,
      state.rpcPort,
      containerPath,
      state.rpcToken,
      state.jobPod,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    core.debug(`execPodStep failed: ${JSON.stringify(err)}`)
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to run script step: ${message}`)
  } finally {
    unregisterCleanup(killOnCancel)
    try {
      fs.rmSync(runnerPath, { force: true })
    } catch (removeErr) {
      core.debug(`Failed to remove file ${runnerPath}: ${removeErr}`)
    }
  }

  try {
    core.debug(
      `Copying from job pod '${state.jobPod}' ${containerTemp} to ${runnerTemp}`
    )
    await execCpFromPod(
      state.jobPod,
      `${containerTemp}/_runner_file_commands`,
      `${workdir}/_temp`
    )
  } catch (error) {
    core.warning('Failed to copy _temp from pod')
  }

  return exitCode
}
