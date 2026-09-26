// Tests for installProcessHandlers (Agent B's deliverable).
//
// Contract:
//   - Exports installProcessHandlers(): void from src/safety/process-handlers
//   - Registers SIGTERM, uncaughtException, unhandledRejection handlers
//   - Idempotent: second call doesn't re-register
//   - SIGTERM exits with code 143
//   - uncaughtException + unhandledRejection: exit 1, prints msg via core.error
//     and to process.stderr.write with FATAL line literal:
//        \n[runner-container-hooks] FATAL: ${msg}\n
//   - unhandledRejection accepts non-Error reasons via String(reason)

// --------------------------------------------------------------------------
// Module mocks
// --------------------------------------------------------------------------

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn()
}))

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

interface CapturedHandler {
  event: string
  cb: (...args: any[]) => void
}

/**
 * Replace process.on with a spy that captures all installed handlers.
 * The original process.on is preserved so we can restore it cleanly.
 */
function captureProcessOn(): {
  captured: CapturedHandler[]
  restore: () => void
} {
  const captured: CapturedHandler[] = []
  const original = process.on.bind(process)
  const spy = jest
    .spyOn(process, 'on')
    .mockImplementation((event: any, cb: any) => {
      captured.push({ event: String(event), cb })
      return process
    })
  return {
    captured,
    restore: () => {
      spy.mockRestore()
      process.on = original
    }
  }
}

/**
 * Acquire the (mocked) core module. Always returns the same instance Jest
 * is using for the current module graph.
 */
function getCore(): { error: jest.Mock } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@actions/core')
}

/**
 * Re-acquire installProcessHandlers via require so we can pair calls with
 * jest.isolateModules / jest.resetModules where needed.
 */
function getInstall(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require('../../src/safety/process-handlers').installProcessHandlers
}

/**
 * Re-acquire the full process-handlers module, including registerCleanup /
 * unregisterCleanup. Used by tests that need to manipulate the cleanup
 * registry after install.
 */
function getMod(): {
  installProcessHandlers: () => void
  registerCleanup: (fn: () => Promise<void> | void) => void
  unregisterCleanup: (fn: () => Promise<void> | void) => void
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../src/safety/process-handlers')
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('installProcessHandlers', () => {
  let exitSpy: jest.SpyInstance
  let stderrSpy: jest.SpyInstance

  beforeEach(() => {
    // Reset the module-scoped `installed` flag in process-handlers so each
    // test starts with a clean slate.
    jest.resetModules()
    jest.clearAllMocks()

    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any)

    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    stderrSpy.mockRestore()
    jest.restoreAllMocks()
  })

  it('registers a SIGTERM handler', () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      expect(captured.find(h => h.event === 'SIGTERM')).toBeDefined()
    } finally {
      restore()
    }
  })

  it('registers an uncaughtException handler', () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      expect(captured.find(h => h.event === 'uncaughtException')).toBeDefined()
    } finally {
      restore()
    }
  })

  it('registers an unhandledRejection handler', () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      expect(captured.find(h => h.event === 'unhandledRejection')).toBeDefined()
    } finally {
      restore()
    }
  })

  it('is idempotent — second call does not re-register handlers', () => {
    const { captured, restore } = captureProcessOn()
    try {
      const install = getInstall()
      install()
      const firstCount = captured.length
      install()
      const secondCount = captured.length
      expect(secondCount).toBe(firstCount)
    } finally {
      restore()
    }
  })

  it('SIGTERM handler exits with code 143', async () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      const sigterm = captured.find(h => h.event === 'SIGTERM')
      expect(sigterm).toBeDefined()
      sigterm!.cb()
      // handler is async (awaits cleanup callbacks); let microtasks settle.
      await new Promise(resolve => setImmediate(resolve))
      expect(exitSpy).toHaveBeenCalledWith(143)
    } finally {
      restore()
    }
  })

  it('SIGINT handler exits with code 130', async () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      const sigint = captured.find(h => h.event === 'SIGINT')
      expect(sigint).toBeDefined()
      sigint!.cb()
      await new Promise(resolve => setImmediate(resolve))
      expect(exitSpy).toHaveBeenCalledWith(130)
    } finally {
      restore()
    }
  })

  it('SIGTERM handler runs registered cleanup callbacks before exit', async () => {
    const { captured, restore } = captureProcessOn()
    try {
      const mod = getMod()
      mod.installProcessHandlers()
      const sigterm = captured.find(h => h.event === 'SIGTERM')
      expect(sigterm).toBeDefined()

      const cleanup = jest.fn().mockResolvedValue(undefined)
      mod.registerCleanup(cleanup)

      sigterm!.cb()
      await new Promise(resolve => setImmediate(resolve))

      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(exitSpy).toHaveBeenCalledWith(143)
    } finally {
      restore()
    }
  })

  it('SIGTERM handler does not re-run cleanup callbacks on re-signal', async () => {
    const { captured, restore } = captureProcessOn()
    try {
      const mod = getMod()
      mod.installProcessHandlers()
      const sigterm = captured.find(h => h.event === 'SIGTERM')

      const cleanup = jest.fn().mockResolvedValue(undefined)
      mod.registerCleanup(cleanup)

      sigterm!.cb()
      sigterm!.cb()
      await new Promise(resolve => setImmediate(resolve))

      expect(cleanup).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('SIGTERM handler tolerates cleanup callback errors and still exits', async () => {
    const { captured, restore } = captureProcessOn()
    try {
      const mod = getMod()
      mod.installProcessHandlers()
      const sigterm = captured.find(h => h.event === 'SIGTERM')

      const cleanup = jest.fn().mockRejectedValue(new Error('cleanup-bad'))
      mod.registerCleanup(cleanup)

      sigterm!.cb()
      await new Promise(resolve => setImmediate(resolve))

      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(exitSpy).toHaveBeenCalledWith(143)
    } finally {
      restore()
    }
  })

  it('unregisterCleanup removes the callback', async () => {
    const { captured, restore } = captureProcessOn()
    try {
      const mod = getMod()
      mod.installProcessHandlers()
      const sigterm = captured.find(h => h.event === 'SIGTERM')

      const cleanup = jest.fn().mockResolvedValue(undefined)
      mod.registerCleanup(cleanup)
      mod.unregisterCleanup(cleanup)

      sigterm!.cb()
      await new Promise(resolve => setImmediate(resolve))

      expect(cleanup).not.toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalledWith(143)
    } finally {
      restore()
    }
  })

  it('uncaughtException handler with Error prints stack and exits 1', () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      const handler = captured.find(h => h.event === 'uncaughtException')
      expect(handler).toBeDefined()

      const err = new Error('kaboom')
      handler!.cb(err)

      const core = getCore()
      const called = core.error.mock.calls.flat().join('\n')
      expect(called).toMatch(/kaboom/)
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      restore()
    }
  })

  it('uncaughtException handler with Error.message-only (no stack) prints message', () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      const handler = captured.find(h => h.event === 'uncaughtException')
      expect(handler).toBeDefined()

      const err = new Error('only-message')
      ;(err as any).stack = undefined
      handler!.cb(err)

      const core = getCore()
      const called = core.error.mock.calls.flat().join('\n')
      expect(called).toMatch(/only-message/)
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      restore()
    }
  })

  it('unhandledRejection handler with Error prints stack and exits 1', () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      const handler = captured.find(h => h.event === 'unhandledRejection')
      expect(handler).toBeDefined()

      const err = new Error('rejected-thing')
      handler!.cb(err)

      const core = getCore()
      const called = core.error.mock.calls.flat().join('\n')
      expect(called).toMatch(/rejected-thing/)
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      restore()
    }
  })

  it('unhandledRejection handler with non-Error string prints String(reason) and exits 1', () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      const handler = captured.find(h => h.event === 'unhandledRejection')
      expect(handler).toBeDefined()

      handler!.cb('plain-string-reason')

      const core = getCore()
      const called = core.error.mock.calls.flat().join('\n')
      expect(called).toMatch(/plain-string-reason/)
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      restore()
    }
  })

  it('unhandledRejection handler with non-Error undefined prints "undefined" and exits 1', () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      const handler = captured.find(h => h.event === 'unhandledRejection')
      expect(handler).toBeDefined()

      handler!.cb(undefined)

      const core = getCore()
      const called = core.error.mock.calls.flat().join('\n')
      expect(called).toMatch(/undefined/)
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      restore()
    }
  })

  it('FATAL line literal matches the existing top-level catch format', () => {
    const { captured, restore } = captureProcessOn()
    try {
      getInstall()()
      const handler = captured.find(h => h.event === 'uncaughtException')
      expect(handler).toBeDefined()

      const err = new Error('fatal-format-check')
      handler!.cb(err)

      const allStderr = stderrSpy.mock.calls
        .map(args => String(args[0]))
        .join('')
      expect(allStderr).toMatch(
        /\n\[runner-container-hooks\] FATAL: .*fatal-format-check[\s\S]*\n/
      )
    } finally {
      restore()
    }
  })
})
