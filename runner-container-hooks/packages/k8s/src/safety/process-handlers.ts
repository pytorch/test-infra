import * as core from '@actions/core'

const CLEANUP_TIMEOUT_MS = 5000

type CleanupFn = () => Promise<void> | void

let installed = false
let shuttingDown = false
let cleanupCallbacks: CleanupFn[] = []

function fatal(msg: string): void {
  core.error(msg)
  process.stderr.write(`\n[runner-container-hooks] FATAL: ${msg}\n`)
}

/**
 * Register a function to run before the process exits in response to
 * SIGTERM/SIGINT. Useful for state that lives outside this process —
 * e.g. forwarding the cancel into the workflow pod's RPC server so the
 * in-pod subprocess doesn't outlive us and block post-cleanup steps.
 *
 * Callbacks must be quick (bounded fetches, no blocking I/O); the handler
 * gives them at most CLEANUP_TIMEOUT_MS before exiting anyway.
 */
export function registerCleanup(fn: CleanupFn): void {
  cleanupCallbacks.push(fn)
}

export function unregisterCleanup(fn: CleanupFn): void {
  cleanupCallbacks = cleanupCallbacks.filter(c => c !== fn)
}

async function runCleanups(): Promise<void> {
  const callbacks = cleanupCallbacks.slice()
  cleanupCallbacks = []
  await Promise.allSettled(
    callbacks.map(async fn => {
      try {
        await fn()
      } catch (err) {
        process.stderr.write(
          `[runner-container-hooks] cleanup callback failed: ${err instanceof Error ? err.message : err}\n`
        )
      }
    })
  )
}

async function handleSignal(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  // Idempotent: re-signaling shouldn't restart cleanup.
  if (shuttingDown) return
  shuttingDown = true
  fatal(`received ${signal}`)
  // Explicit timeout handle so we can clearTimeout when runCleanups wins
  // the race. Without this the setTimeout keeps the event loop alive for
  // up to CLEANUP_TIMEOUT_MS — fine in production (process.exit() runs
  // immediately after) but it leaks in tests that spy on process.exit.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    runCleanups(),
    new Promise<void>(resolve => {
      timeoutHandle = setTimeout(resolve, CLEANUP_TIMEOUT_MS)
    })
  ])
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  // 130 for SIGINT, 143 for SIGTERM — the standard 128+signum convention.
  // Surfaces the cause to the OSDC wrapper (and to anyone reading the log).
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

export function installProcessHandlers(): void {
  if (installed) return
  installed = true

  process.on('SIGTERM', () => {
    void handleSignal('SIGTERM')
  })

  process.on('SIGINT', () => {
    void handleSignal('SIGINT')
  })

  process.on('uncaughtException', err => {
    const msg = err instanceof Error ? err.stack || err.message : String(err)
    fatal(`uncaughtException: ${msg}`)
    process.exit(1)
  })

  process.on('unhandledRejection', reason => {
    const msg =
      reason instanceof Error ? reason.stack || reason.message : String(reason)
    fatal(`unhandledRejection: ${msg}`)
    process.exit(1)
  })
}

// Exposed for tests so they can reset module-scoped state between cases
// without using `require.cache` tricks.
export function _resetForTests(): void {
  installed = false
  shuttingDown = false
  cleanupCallbacks = []
}
