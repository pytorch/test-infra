// Tests for execCpToPod backpressure throttle, ws.terminate cancel path,
// and errStream byte cap. These exercise the contract added in the safety
// hardening pass (Agent A's deliverables #1, #2, #4).

import * as stream from 'stream'

// --------------------------------------------------------------------------
// Module mocks — must come before importing the module under test.
// --------------------------------------------------------------------------

// exec(...) is set per-test; the constructor returned by jest.mock returns
// this object every time `new k8s.Exec(...)` is invoked.
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

// tar.pack(...) returns a Readable we control. The src/k8s code calls
// readStream.destroy() in the finally block — we make sure the returned
// stream tolerates that.
const mockTarPackStream: { current: stream.Readable | null } = { current: null }
jest.mock('tar-fs', () => ({
  pack: jest.fn(() => mockTarPackStream.current),
  extract: jest.fn()
}))

// sleep is awaited in the retry path — make it throw on call so the retry
// loop exits after exactly one iteration. Tests that need multiple
// iterations override this per-test.
jest.mock('../src/k8s/utils', () => {
  const actual = jest.requireActual('../src/k8s/utils')
  return {
    ...actual,
    sleep: jest.fn().mockImplementation(async () => {
      // Default: simulate "abort retries" by throwing — execCpToPod's outer
      // loop will propagate this to the test's `.catch(...)`.
      throw new Error('TEST_ABORT_RETRIES')
    })
  }
})

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn()
}))

import { execCpToPod } from '../src/k8s'

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

/**
 * Build a Readable that the prod code can consume / pause / resume / destroy.
 * Never emits 'end' on its own — tests advance fake timers to drive the
 * backpressure poller.
 */
function makeControllableReadable(): stream.Readable {
  const readable = new stream.Readable({
    read() {
      // do nothing — caller drives data via push() if needed
    }
  })
  jest.spyOn(readable, 'pause')
  jest.spyOn(readable, 'resume')
  return readable
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('execCpToPod backpressure throttle', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'arc-runners'

    // Reset the sleep mock to its abort-on-call default (cleared by
    // clearAllMocks above).
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const utils = require('../src/k8s/utils')
    utils.sleep.mockImplementation(async () => {
      throw new Error('TEST_ABORT_RETRIES')
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = originalEnv
  })

  it('pauses readStream when bufferedAmount exceeds HIGH water mark', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    mockTarPackStream.current = readStream

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

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst')

    // Allow microtasks to wire up the WebSocket .then() handler.
    await Promise.resolve()
    await Promise.resolve()

    // Drive bufferedAmount above the 200 MiB high water mark.
    fakeWs.bufferedAmount = 250 * 1024 * 1024

    // Advance past one polling tick (50ms).
    await jest.advanceTimersByTimeAsync(60)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(readStream.pause).toHaveBeenCalled()

    // Settle the exec successfully so the promise resolves.
    statusCb?.({ status: 'Success' })
    await jest.advanceTimersByTimeAsync(0)
    await promise
  })

  it('resumes readStream when bufferedAmount falls below LOW water mark', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    // Force a "paused" state we can verify resume() against.
    let paused = true
    jest.spyOn(readStream, 'isPaused').mockImplementation(() => paused)
    jest.spyOn(readStream, 'resume').mockImplementation(function (this: any) {
      paused = false
      return this
    })
    mockTarPackStream.current = readStream

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

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst')
    await Promise.resolve()
    await Promise.resolve()

    fakeWs.bufferedAmount = 10 * 1024 * 1024
    await jest.advanceTimersByTimeAsync(60)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(readStream.resume).toHaveBeenCalled()

    statusCb?.({ status: 'Success' })
    await jest.advanceTimersByTimeAsync(0)
    await promise
  })

  it('unrefs the polling interval handle so it does not keep the loop alive', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    mockTarPackStream.current = readStream

    const realSetInterval = global.setInterval
    const unrefSpy = jest.fn()
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockImplementation(((fn: any, ms: number, ...args: any[]) => {
        const handle: any = realSetInterval(fn, ms, ...args)
        const origUnref = handle.unref?.bind(handle)
        handle.unref = (): any => {
          unrefSpy()
          return origUnref ? origUnref() : handle
        }
        return handle
      }) as any)

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

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst')
    await Promise.resolve()
    await Promise.resolve()

    statusCb?.({ status: 'Success' })
    await jest.advanceTimersByTimeAsync(0)
    await promise

    expect(unrefSpy).toHaveBeenCalled()

    setIntervalSpy.mockRestore()
  })

  it('clears the polling interval on success', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    mockTarPackStream.current = readStream

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

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

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst')
    await Promise.resolve()
    await Promise.resolve()
    statusCb?.({ status: 'Success' })
    await jest.advanceTimersByTimeAsync(0)
    await promise

    expect(clearIntervalSpy).toHaveBeenCalled()
  })

  it('clears the polling interval on failure', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    mockTarPackStream.current = readStream

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

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

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst').catch(() => {
      // expected — sleep mock throws TEST_ABORT_RETRIES
    })

    // Wait for .then() to wire up the interval (so clearInterval can fire later).
    await Promise.resolve()
    await Promise.resolve()

    // Now simulate an exec failure via the WebSocket 'close' event. The prod
    // code rejects, the finally block runs (clearing the interval), the
    // catch block runs sleep() → throws TEST_ABORT_RETRIES → outer loop dies.
    statusCb?.({ status: 'Failure' })

    await jest.advanceTimersByTimeAsync(0)
    await promise

    expect(clearIntervalSpy).toHaveBeenCalled()
  })
})

describe('execCpToPod cancel path uses ws.terminate()', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'arc-runners'

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const utils = require('../src/k8s/utils')
    utils.sleep.mockImplementation(async () => {
      throw new Error('TEST_ABORT_RETRIES')
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = originalEnv
  })

  it('calls ws.terminate() (not ws.close()) when timing out / cancelling', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    mockTarPackStream.current = readStream

    // exec resolves with the ws (so wsRef gets set), but never settles via
    // the status callback. The EXEC_TIMEOUT_MS race timer should fire and
    // reject.
    mockExec.exec.mockImplementation(async () => fakeWs)

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst').catch(() => {
      // expected — race timer rejects, then sleep mock throws
    })

    // Wait for .then() to set wsRef on the closure.
    await Promise.resolve()
    await Promise.resolve()

    // Advance past the 300s exec timeout to trigger the timer.
    await jest.advanceTimersByTimeAsync(301_000)
    await promise

    // The new code must call terminate() in the finally block, NOT close().
    expect(fakeWs.terminate).toHaveBeenCalled()
    expect(fakeWs.close).not.toHaveBeenCalled()
  })
})

describe('execCpToPod errStream byte cap', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'arc-runners'

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const utils = require('../src/k8s/utils')
    utils.sleep.mockImplementation(async () => {
      throw new Error('TEST_ABORT_RETRIES')
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = originalEnv
  })

  it('caps errStream content at 64 KiB so subsequent writes are dropped', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    mockTarPackStream.current = readStream

    let capturedErrStream: any
    let statusCb: ((s: any) => void) | undefined

    mockExec.exec.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        errStream,
        _stdin,
        _tty,
        cb
      ) => {
        capturedErrStream = errStream
        statusCb = cb
        return fakeWs
      }
    )

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst').catch(() => {
      // failure expected — Failure status now rejects regardless of errStream
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(capturedErrStream).toBeDefined()
    // The errStream should be a CappedWritable (a Writable subclass with
    // .size() and .getContentsAsString() helpers per the prod implementation).
    expect(typeof capturedErrStream.size).toBe('function')
    expect(typeof capturedErrStream.getContentsAsString).toBe('function')

    // Pump 256 KiB — well over the 64 KiB cap.
    const chunk = Buffer.alloc(8 * 1024, 0x41) // 8 KiB of 'A'
    for (let i = 0; i < 32; i++) {
      capturedErrStream.write(chunk)
    }

    // The internal byte counter must not exceed the cap, regardless of
    // how the buffer-vs-truncation-marker is rendered in getContentsAsString.
    expect(capturedErrStream.size()).toBeLessThanOrEqual(64 * 1024)

    // Settle the exec so the test can finish quickly.
    statusCb?.({ status: 'Failure' })
    await jest.advanceTimersByTimeAsync(0)
    await promise
  })

  it('caps a single oversized chunk (>cap) at 64 KiB', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    mockTarPackStream.current = readStream

    let capturedErrStream: any
    let statusCb: ((s: any) => void) | undefined

    mockExec.exec.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        errStream,
        _stdin,
        _tty,
        cb
      ) => {
        capturedErrStream = errStream
        statusCb = cb
        return fakeWs
      }
    )

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst').catch(() => {
      // expected — Failure status causes reject
    })

    await Promise.resolve()
    await Promise.resolve()

    // One single chunk much larger than the cap — exercises the
    // `slice = buf.subarray(0, remaining)` branch on the very first write.
    capturedErrStream.write(Buffer.alloc(200 * 1024, 0x42))

    expect(capturedErrStream.size()).toBeLessThanOrEqual(64 * 1024)
    // Truncation marker should appear in the rendered output.
    const rendered = capturedErrStream.getContentsAsString('utf8')
    expect(rendered).toMatch(/truncated at \d+ bytes/)

    statusCb?.({ status: 'Failure' })
    await jest.advanceTimersByTimeAsync(0)
    await promise
  })
})

describe('execCpToPod settle policy on Success vs Failure', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'arc-runners'

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const utils = require('../src/k8s/utils')
    utils.sleep.mockImplementation(async () => {
      throw new Error('TEST_ABORT_RETRIES')
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = originalEnv
  })

  it('resolves (does NOT reject) when status is Success even with non-empty errStream', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    mockTarPackStream.current = readStream

    let capturedErrStream: any
    let statusCb: ((s: any) => void) | undefined

    mockExec.exec.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        errStream,
        _stdin,
        _tty,
        cb
      ) => {
        capturedErrStream = errStream
        statusCb = cb
        return fakeWs
      }
    )

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst')

    await Promise.resolve()
    await Promise.resolve()

    // Common harmless tar warning that previously caused a spurious reject.
    capturedErrStream.write(
      Buffer.from("tar: Removing leading '/' from member names\n")
    )

    statusCb?.({ status: 'Success' })
    await jest.advanceTimersByTimeAsync(0)

    // Must resolve, not throw.
    await expect(promise).resolves.toBeUndefined()

    // And core.debug must have been invoked with the stderr contents so
    // the signal is not silently dropped. Logged at debug (not warning)
    // because tar emits routine stderr on every successful copy and would
    // flood Loki/Grafana.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const core = require('@actions/core')
    expect(core.debug).toHaveBeenCalledWith(
      expect.stringContaining('execCpToPod stderr')
    )
  })

  it('includes errStream content in error message when status is Failure', async () => {
    const fakeWs = makeFakeWs()
    const readStream = makeControllableReadable()
    mockTarPackStream.current = readStream

    let capturedErrStream: any
    let statusCb: ((s: any) => void) | undefined

    mockExec.exec.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        errStream,
        _stdin,
        _tty,
        cb
      ) => {
        capturedErrStream = errStream
        statusCb = cb
        return fakeWs
      }
    )

    const promise = execCpToPod('my-pod', '/tmp/source', '/dst').catch(() => {
      // outer loop converts our reject + sleep mock throw into the final
      // error — we don't inspect that here. Instead we look at the per-attempt
      // log line which contains the *original* reject message.
    })

    await Promise.resolve()
    await Promise.resolve()

    capturedErrStream.write(Buffer.from('tar: cannot open: No space left'))

    statusCb?.({ status: 'Failure' })
    await jest.advanceTimersByTimeAsync(0)
    await promise

    // The first failed attempt is logged via core.debug as
    // `cpToPod: Attempt 1/30 failed: <original error message>`. That message
    // must include the Failure status and the errStream content per Fix 1.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const core = require('@actions/core')
    const debugCalls = (core.debug as jest.Mock).mock.calls
      .map(c => String(c[0]))
      .filter(s => s.includes('cpToPod: Attempt'))
    expect(debugCalls.length).toBeGreaterThan(0)
    const attemptLog = debugCalls[0]
    expect(attemptLog).toMatch(/status: Failure/)
    expect(attemptLog).toMatch(/cannot open: No space left/)
  })
})
