// Tests for execPodStep / execPodStepOutput per-call timeout (Agent A change #3).
// Contract: each call is wrapped in Promise.race against a 60s setTimeout.
// On timeout, ws.terminate() is called and the promise rejects with
// `Error('execPodStep timed out after 60000ms')` (or matching message).

// --------------------------------------------------------------------------
// Module mocks — declared before importing the module under test.
// --------------------------------------------------------------------------

const mockExec = {
  exec: jest.fn()
}

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node')
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      getContexts: jest.fn().mockReturnValue([{ namespace: 'arc-runners' }]),
      makeApiClient: jest.fn().mockReturnValue({})
    })),
    Exec: jest.fn().mockImplementation(() => mockExec)
  }
})

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/k8s/utils', () => {
  const actual = jest.requireActual('../src/k8s/utils')
  return {
    ...actual,
    sleep: jest.fn().mockResolvedValue(undefined)
  }
})

import { execPodStep, execPodStepOutput } from '../src/k8s'

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

interface FakeWs {
  bufferedAmount: number
  terminate: jest.Mock
  close: jest.Mock
  on: jest.Mock
  emit: (event: string, ...args: any[]) => void
}

function makeFakeWs(): FakeWs {
  const listeners: Record<string, Function[]> = {}
  const ws: any = {
    bufferedAmount: 0,
    terminate: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event: string, cb: Function) => {
      ;(listeners[event] = listeners[event] || []).push(cb)
    }),
    emit(event: string, ...args: any[]) {
      for (const cb of listeners[event] || []) cb(...args)
    }
  }
  return ws as FakeWs
}

// EXEC_POD_STEP_TIMEOUT_MS as defined by the contract
const EXEC_POD_STEP_TIMEOUT_MS = 60_000

// --------------------------------------------------------------------------
// Tests — execPodStep
// --------------------------------------------------------------------------

describe('execPodStep per-call timeout', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'arc-runners'
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = originalEnv
  })

  it('rejects after EXEC_POD_STEP_TIMEOUT_MS with a timeout-shaped Error', async () => {
    const fakeWs = makeFakeWs()
    // Never settle — exec hangs forever.
    mockExec.exec.mockImplementation(async () => fakeWs)

    const promise = execPodStep(['/bin/sh', '-c', 'sleep 9999'], 'pod', 'cnt')

    // Race the promise so it can attach handlers before the timer fires.
    const result = expect(promise).rejects.toThrow(/timed out after 60000ms/i)

    // Advance past the timeout.
    await jest.advanceTimersByTimeAsync(EXEC_POD_STEP_TIMEOUT_MS + 1000)

    await result
  })

  it('calls ws.terminate() (NOT ws.close()) when the timeout fires', async () => {
    const fakeWs = makeFakeWs()
    mockExec.exec.mockImplementation(async () => fakeWs)

    const promise = execPodStep(
      ['/bin/sh', '-c', 'sleep 9999'],
      'pod',
      'cnt'
    ).catch(() => {
      // expected — timeout
    })

    await jest.advanceTimersByTimeAsync(EXEC_POD_STEP_TIMEOUT_MS + 1000)
    await promise

    expect(fakeWs.terminate).toHaveBeenCalled()
    expect(fakeWs.close).not.toHaveBeenCalled()
  })

  it('clears the timer on successful completion (no spurious timeout)', async () => {
    const fakeWs = makeFakeWs()
    let statusCb: ((s: any) => void) | undefined

    mockExec.exec.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        _stderr,
        _stdin,
        _tty,
        cb
      ) => {
        statusCb = cb
        return fakeWs
      }
    )

    const promise = execPodStep(['/bin/echo', 'hi'], 'pod', 'cnt')

    // Allow the .then() handler to register so statusCb is wired.
    await Promise.resolve()
    await Promise.resolve()

    statusCb?.({ status: 'Success' })
    const exitCode = await promise

    expect(exitCode).toBe(0)

    // Advance well past the timeout — terminate must NOT have been called
    // because the timer was cleared on success.
    fakeWs.terminate.mockClear()
    await jest.advanceTimersByTimeAsync(EXEC_POD_STEP_TIMEOUT_MS * 2)
    expect(fakeWs.terminate).not.toHaveBeenCalled()
  })
})

// --------------------------------------------------------------------------
// Tests — execPodStepOutput
// --------------------------------------------------------------------------

describe('execPodStepOutput per-call timeout', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'arc-runners'
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = originalEnv
  })

  it('rejects after EXEC_POD_STEP_TIMEOUT_MS with a timeout-shaped Error', async () => {
    const fakeWs = makeFakeWs()
    mockExec.exec.mockImplementation(async () => fakeWs)

    const promise = execPodStepOutput(
      ['/bin/sh', '-c', 'sleep 9999'],
      'pod',
      'cnt'
    )

    const result = expect(promise).rejects.toThrow(/timed out after 60000ms/i)

    await jest.advanceTimersByTimeAsync(EXEC_POD_STEP_TIMEOUT_MS + 1000)
    await result
  })

  it('calls ws.terminate() (NOT ws.close()) when the timeout fires', async () => {
    const fakeWs = makeFakeWs()
    mockExec.exec.mockImplementation(async () => fakeWs)

    const promise = execPodStepOutput(
      ['/bin/sh', '-c', 'sleep 9999'],
      'pod',
      'cnt'
    ).catch(() => {
      // expected — timeout
    })

    await jest.advanceTimersByTimeAsync(EXEC_POD_STEP_TIMEOUT_MS + 1000)
    await promise

    expect(fakeWs.terminate).toHaveBeenCalled()
    expect(fakeWs.close).not.toHaveBeenCalled()
  })

  it('clears the timer on successful completion (no spurious timeout)', async () => {
    const fakeWs = makeFakeWs()
    let statusCb: ((s: any) => void) | undefined

    mockExec.exec.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        _stderr,
        _stdin,
        _tty,
        cb
      ) => {
        statusCb = cb
        return fakeWs
      }
    )

    const promise = execPodStepOutput(['/bin/echo', 'hi'], 'pod', 'cnt')

    await Promise.resolve()
    await Promise.resolve()

    statusCb?.({ status: 'Success' })
    const result = await promise
    expect(result.exitCode).toBe(0)

    fakeWs.terminate.mockClear()
    await jest.advanceTimersByTimeAsync(EXEC_POD_STEP_TIMEOUT_MS * 2)
    expect(fakeWs.terminate).not.toHaveBeenCalled()
  })
})
