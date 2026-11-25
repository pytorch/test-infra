import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import {
  cleanupJob,
  prepareJob,
  runContainerStep,
  runScriptStep
} from '../src/hooks'
import { killRpcJob } from '../src/k8s/rpc'
import { TestHelper } from './test-setup'
import { RunContainerStepArgs, RunScriptStepArgs } from 'hooklib'

jest.useRealTimers()

let testHelper: TestHelper

let prepareJobData: any

let prepareJobOutputFilePath: string
describe('e2e', () => {
  beforeEach(async () => {
    testHelper = new TestHelper()
    await testHelper.initialize()

    prepareJobData = testHelper.getPrepareJobDefinition()
    prepareJobOutputFilePath = testHelper.createFile('prepare-job-output.json')
  })
  afterEach(async () => {
    await testHelper.cleanup()
  })

  it('should prepare job, run script step, run container step then cleanup without errors', async () => {
    await expect(
      prepareJob(prepareJobData.args, prepareJobOutputFilePath)
    ).resolves.not.toThrow()

    const scriptStepData = testHelper.getRunScriptStepDefinition()

    const prepareJobOutputJson = fs.readFileSync(prepareJobOutputFilePath)
    const prepareJobOutputData = JSON.parse(prepareJobOutputJson.toString())

    await expect(
      runScriptStep(
        scriptStepData.args as RunScriptStepArgs,
        prepareJobOutputData.state
      )
    ).resolves.not.toThrow()

    const runContainerStepData = testHelper.getRunContainerStepDefinition()

    await expect(
      runContainerStep(runContainerStepData.args as RunContainerStepArgs)
    ).resolves.not.toThrow()

    await expect(cleanupJob()).resolves.not.toThrow()
  })

  // Regression test for the cancellation-forwarding behaviour.
  //
  // Without /kill in place, a runScriptStep that's killed mid-run (e.g. GHA
  // fail-fast cancellation) would leave the workflow pod's subprocess
  // running, and every subsequent /exec would 409 with
  // "A job is already running" until the heartbeat watchdog killed it 60s
  // later. With /kill in place, calling killRpcJob from the cleanup callback
  // resets the in-pod state immediately and the next runScriptStep proceeds.
  //
  // This test exercises the runtime contract end-to-end in a real kind pod:
  // start a long-sleeping script, kill it via the public killRpcJob entry,
  // confirm the runScriptStep returns with a non-zero exit code, then run a
  // second runScriptStep against the same pod/RPC server and confirm it
  // succeeds.
  it('killRpcJob cancels an in-flight runScriptStep and lets a follow-up step succeed', async () => {
    jest.setTimeout(120000)

    await expect(
      prepareJob(prepareJobData.args, prepareJobOutputFilePath)
    ).resolves.not.toThrow()

    const prepareJobOutputData = JSON.parse(
      fs.readFileSync(prepareJobOutputFilePath).toString()
    )
    const state = prepareJobOutputData.state as {
      jobPod: string
      rpcPodIp: string
      rpcPort: number
      rpcToken: string
    }
    expect(state.rpcPodIp).toBeTruthy()
    expect(state.rpcPort).toBeGreaterThan(0)
    expect(state.rpcToken).toBeTruthy()

    // Build a long-sleeping step. /bin/sleep is the binary so the runScript
    // wrapper passes "30" verbatim — no shell-quoting pitfalls.
    const longSleepArgs = {
      ...testHelper.getRunScriptStepDefinition().args,
      entryPoint: '/bin/sleep',
      entryPointArgs: ['30']
    } as RunScriptStepArgs

    // Kick off the sleep in the background. We don't await yet — instead
    // we race a kill against it after a short delay.
    const sleepPromise = runScriptStep(longSleepArgs, state).catch(
      (e: unknown) => e
    )

    // Give the wrapper enough time to /exec the sleep on the workflow pod
    // (mkdir + cp + exec round-trip is typically <2s in kind).
    await new Promise(r => setTimeout(r, 4000))

    await killRpcJob(state.rpcPodIp, state.rpcPort, state.rpcToken)

    const result = await sleepPromise

    // runScriptStep either resolves with a non-zero exit code (if the
    // wrapper saw the subprocess exit cleanly with the kill signal) or
    // rejects with an error message (if the polling loop noticed the
    // status became 'failed' between iterations). Both are acceptable —
    // what matters is that it did NOT return 0 and the pod state is clean.
    if (typeof result === 'number') {
      expect(result).not.toBe(0)
    } else {
      // It's an Error from the throw in run-script-step.ts catch block.
      expect(result).toBeInstanceOf(Error)
    }

    // The point of the patch: a second runScriptStep against the same pod
    // must succeed. Without /kill this would 409 forever.
    const followupArgs = testHelper.getRunScriptStepDefinition()
      .args as RunScriptStepArgs
    await expect(runScriptStep(followupArgs, state)).resolves.not.toThrow()

    await expect(cleanupJob()).resolves.not.toThrow()
  })

  // Stronger version of the test above: exercises the full SIGTERM path
  // (process.on('SIGTERM') -> handleSignal -> runCleanups -> killRpcJob)
  // by spawning the production-built hook binary (packages/k8s/dist/index.js)
  // as a real subprocess and sending it a real SIGTERM. Catches any wiring
  // regression that bypasses the cleanup-callback registry — something the
  // direct killRpcJob() call in the previous test cannot detect.
  //
  // Requires `npm run build-all` to have produced dist/index.js, which the
  // k8s-tests CI workflow already does as a prerequisite step.
  it('SIGTERM to the hook subprocess clears the workflow pod for the next /exec', async () => {
    jest.setTimeout(120000)

    const distEntry = path.resolve(__dirname, '../dist/index.js')
    if (!fs.existsSync(distEntry)) {
      throw new Error(
        `Expected built hook at ${distEntry}; run \`npm run build-all\` first.`
      )
    }

    // prepareJob sets up the workflow pod + RPC server.
    await expect(
      prepareJob(prepareJobData.args, prepareJobOutputFilePath)
    ).resolves.not.toThrow()
    const prepareJobOutputData = JSON.parse(
      fs.readFileSync(prepareJobOutputFilePath).toString()
    )
    const state = prepareJobOutputData.state

    // Build the hook input — a run_script_step that sleeps for 60s.
    // HookData.args is a union; narrow to RunScriptStepArgs so the
    // entryPoint/entryPointArgs writes type-check (TS2339 otherwise).
    const scriptStepArgs = testHelper.getRunScriptStepDefinition()
      .args as RunScriptStepArgs
    scriptStepArgs.entryPoint = '/bin/sleep'
    scriptStepArgs.entryPointArgs = ['60']
    const hookInput = JSON.stringify({
      command: 'run_script_step',
      args: scriptStepArgs,
      state
    })

    // Spawn the compiled hook with the test process's env (so it inherits
    // ACTIONS_RUNNER_POD_NAME, RUNNER_WORKSPACE, etc. set up by
    // TestHelper.initialize).
    const child = spawn('node', [distEntry], {
      env: process.env,
      stdio: ['pipe', 'inherit', 'inherit']
    })
    child.stdin.write(hookInput)
    child.stdin.end()

    // Wait long enough for the hook to (a) parse stdin, (b) reach
    // rpcPodStep, (c) issue /exec, (d) start polling /status. Empirically
    // ~3-5s in kind; we give a generous 6s.
    await new Promise(r => setTimeout(r, 6000))

    // The actual test — real SIGTERM to a real subprocess.
    child.kill('SIGTERM')

    const childExit = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
    // Either 143 (handler caught SIGTERM and process.exit(143)) or a non-
    // zero code from the rpcPodStep throw path. Must NOT be 0.
    expect(
      childExit.code === 143 ||
        (childExit.code !== null && childExit.code !== 0)
    ).toBe(true)

    // The killer test: with /kill forwarded into the pod, the next
    // runScriptStep against the same pod/RPC server must succeed. Without
    // the patch, /exec would 409 here ("A job is already running") because
    // the in-pod sleep is still alive.
    const followupArgs = testHelper.getRunScriptStepDefinition()
      .args as RunScriptStepArgs
    await expect(runScriptStep(followupArgs, state)).resolves.not.toThrow()

    await expect(cleanupJob()).resolves.not.toThrow()
  })
})
