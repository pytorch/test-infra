// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const MOCK_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const mockExecPodStep = jest.fn()
const mockExecPodStepOutput = jest.fn()
const mockGetPodByName = jest.fn()

jest.mock('../src/k8s', () => ({
  execPodStep: (...args) => mockExecPodStep(...args),
  execPodStepOutput: (...args) => mockExecPodStepOutput(...args),
  getPodByName: (...args) => mockGetPodByName(...args)
}))

jest.mock('../src/k8s/rpc-server-script', () => ({
  RPC_SERVER_AMD64: 'ZmFrZS1hbWQ2NA==',
  RPC_SERVER_ARM64: 'ZmFrZS1hcm02NA=='
}))

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

// Mock sleep to be instant in tests
jest.mock('../src/k8s/utils', () => ({
  sleep: jest.fn().mockResolvedValue(undefined)
}))

// Mock crypto.randomUUID — the property is non-configurable so jest.spyOn
// cannot redefine it. Use a module-level mock with passthrough for other methods.
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto')
  return {
    ...actual,
    randomUUID: jest.fn().mockReturnValue(MOCK_UUID)
  }
})

import * as stream from 'stream'
import { deployRpcServer, killRpcJob, rpcPodStep } from '../src/k8s/rpc'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Drain a Readable (the exec stdin carrying the base64 blob) to a string. */
async function readStreamToString(s: stream.Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of s) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString()
}

/** Build a minimal Response-like object that satisfies the fetch API. */
function fakeResponse(
  status: number,
  body?: unknown,
  opts?: { arrayBuffer?: ArrayBuffer }
): Response {
  const bodyStr = body !== undefined ? JSON.stringify(body) : ''
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `${status}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: jest.fn().mockResolvedValue(bodyStr),
    json: jest.fn().mockResolvedValue(body),
    arrayBuffer: jest
      .fn()
      .mockResolvedValue(
        opts?.arrayBuffer ?? new TextEncoder().encode(bodyStr).buffer
      ),
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'basic' as ResponseType,
    url: '',
    clone: jest.fn()
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deployRpcServer', () => {
  const DISCOVERED_PORT = 45678

  type StepResult = { exitCode: number; stdout: string }

  let realFetch: typeof fetch
  let mockFetch: jest.Mock

  /**
   * Route mocks by command content.
   *   execPodStep: binary write (base64 over stdin), pkill cleanup.
   *   execPodStepOutput: `uname -m` (arch), server start (prints port), log tail.
   *   global.fetch: /health probe.
   */
  function setupDefaultMocks(overrides?: {
    arch?: StepResult | Error
    write?: StepResult | Error
    start?: StepResult | Error
    log?: StepResult
    health?: 'ok' | 'fail-once-ok' | 'always-fail' | 'network-error'
  }): void {
    const defaults = {
      arch: { exitCode: 0, stdout: 'x86_64\n' } as StepResult | Error,
      write: { exitCode: 0, stdout: '' } as StepResult | Error,
      // The server prints its listening line, then daemonizes; the hook reads
      // the port from this stdout rather than from a file.
      start: {
        exitCode: 0,
        stdout: `RPC server listening on [::]:${DISCOVERED_PORT}`
      } as StepResult | Error,
      log: { exitCode: 0, stdout: '(no log)' },
      health: 'ok' as 'ok' | 'fail-once-ok' | 'always-fail' | 'network-error'
    }
    const cfg = { ...defaults, ...overrides }

    // The binary write streams the base64 over execPodStep's stdin (the blob
    // is too large for argv), so it's routed through mockExecPodStep.
    mockExecPodStep.mockImplementation(async (cmd: string[]) => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('base64 -d') && cmdStr.includes('/tmp/rpc-server')) {
        // Binary write. execPodStep resolves to an exit code (number).
        if (cfg.write instanceof Error) throw cfg.write
        return cfg.write.exitCode
      }
      // Other execPodStep calls in deploy (e.g. the pkill cleanup).
      return 0
    })

    mockExecPodStepOutput.mockImplementation(async (cmd: string[]) => {
      const cmdStr = cmd.join(' ')
      if (cmd[0] === 'uname') {
        if (cfg.arch instanceof Error) throw cfg.arch
        return cfg.arch
      }
      // Server start: runs the binary with --daemonize; it prints the port.
      if (cmd[0] === '/tmp/rpc-server') {
        if (cfg.start instanceof Error) throw cfg.start
        return cfg.start
      }
      if (cmdStr.includes('tail') && cmdStr.includes('rpc-server.log')) {
        return cfg.log
      }
      return cfg.log
    })

    let healthCallCount = 0
    mockFetch.mockImplementation(async () => {
      healthCallCount++
      switch (cfg.health) {
        case 'ok':
          return fakeResponse(200, { status: 'ok' })
        case 'fail-once-ok':
          return healthCallCount === 1
            ? fakeResponse(500)
            : fakeResponse(200, { status: 'ok' })
        case 'always-fail':
          return fakeResponse(500)
        case 'network-error':
          throw new Error('fetch failed')
      }
    })
  }

  beforeEach(() => {
    jest.clearAllMocks()

    realFetch = global.fetch
    mockFetch = jest.fn()
    global.fetch = mockFetch as unknown as typeof fetch

    mockGetPodByName.mockResolvedValue({
      status: { podIP: '10.0.0.1' }
    })
    mockExecPodStep.mockResolvedValue(0)
    setupDefaultMocks()
  })

  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
  })

  it('should detect arch via uname -m', async () => {
    await deployRpcServer('my-pod', 'my-container', 'tok-123')

    const unameCall = mockExecPodStepOutput.mock.calls.find(
      ([cmd]) => cmd[0] === 'uname' && cmd[1] === '-m'
    )
    expect(unameCall).toBeDefined()
    expect(unameCall[1]).toBe('my-pod')
    expect(unameCall[2]).toBe('my-container')
  })

  it('should throw if arch detection fails', async () => {
    setupDefaultMocks({ arch: new Error('exec into pod failed') })
    await expect(
      deployRpcServer('my-pod', 'my-container', 'tok-123')
    ).rejects.toThrow('RPC: failed to detect pod arch')
  })

  it('should throw on unsupported arch', async () => {
    setupDefaultMocks({ arch: { exitCode: 0, stdout: 'riscv64\n' } })
    await expect(
      deployRpcServer('my-pod', 'my-container', 'tok-123')
    ).rejects.toThrow('unsupported pod arch "riscv64"')
  })

  it('should select arm64 binary for aarch64 pod', async () => {
    setupDefaultMocks({ arch: { exitCode: 0, stdout: 'aarch64\n' } })
    await deployRpcServer('my-pod', 'my-container', 'tok-123')

    const writeCall = mockExecPodStep.mock.calls.find(([cmd]) =>
      cmd.join(' ').includes('base64 -d')
    )
    expect(writeCall).toBeDefined()
    expect(await readStreamToString(writeCall[3])).toBe('ZmFrZS1hcm02NA==')
  })

  it('should select amd64 binary for x86_64 pod', async () => {
    await deployRpcServer('my-pod', 'my-container', 'tok-123')

    const writeCall = mockExecPodStep.mock.calls.find(([cmd]) =>
      cmd.join(' ').includes('base64 -d')
    )
    expect(writeCall).toBeDefined()
    expect(await readStreamToString(writeCall[3])).toBe('ZmFrZS1hbWQ2NA==')
  })

  it('should throw if pod has no IP address', async () => {
    mockGetPodByName.mockResolvedValue({ status: {} })

    await expect(
      deployRpcServer('my-pod', 'my-container', 'tok-123')
    ).rejects.toThrow('Pod my-pod has no IP address')
  })

  it('should deploy the binary via base64 streamed over stdin', async () => {
    await deployRpcServer('my-pod', 'my-container', 'tok-123')

    const writeCall = mockExecPodStep.mock.calls.find(([cmd]) =>
      cmd.join(' ').includes('base64 -d')
    )
    expect(writeCall).toBeDefined()
    expect(writeCall[0][0]).toBe('sh')
    expect(writeCall[0][1]).toBe('-c')
    expect(writeCall[0][2]).toContain('base64 -d')
    expect(writeCall[0][2]).toContain('/tmp/rpc-server')
    expect(writeCall[0][2]).toContain('chmod +x')
    // The blob must NOT be inlined in argv (that would blow past MAX_ARG_STRLEN);
    // it's streamed over stdin (the 4th arg) instead.
    expect(writeCall[0][2]).not.toContain('ZmFrZS1hbWQ2NA==')
    expect(writeCall[3]).toBeDefined()
  })

  it('should throw if binary write fails', async () => {
    setupDefaultMocks({
      write: new Error('non-zero exit code 1 (stdout: Permission denied)')
    })

    await expect(
      deployRpcServer('my-pod', 'my-container', 'tok-123')
    ).rejects.toThrow('RPC server binary write failed')
  })

  it('should start the server with --port 0, --daemonize and the token', async () => {
    await deployRpcServer('my-pod', 'my-container', 'tok-123')

    const startCall = mockExecPodStepOutput.mock.calls.find(
      ([cmd]) => cmd[0] === '/tmp/rpc-server'
    )
    expect(startCall).toBeDefined()
    expect(startCall[0]).toEqual([
      '/tmp/rpc-server',
      '--port',
      '0',
      '--token',
      'tok-123',
      '--daemonize'
    ])
  })

  it('should continue to next attempt if server start fails', async () => {
    setupDefaultMocks()
    let startCallCount = 0
    mockExecPodStepOutput.mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'uname') {
        return { exitCode: 0, stdout: 'x86_64\n' }
      }
      if (cmd[0] === '/tmp/rpc-server') {
        startCallCount++
        if (startCallCount === 1) {
          throw new Error('exec into pod failed')
        }
        return {
          exitCode: 0,
          stdout: `RPC server listening on [::]:${DISCOVERED_PORT}`
        }
      }
      return { exitCode: 0, stdout: '(no log)' }
    })

    const result = await deployRpcServer('my-pod', 'my-container', 'tok-123')
    expect(result.port).toBe(DISCOVERED_PORT)
    expect(startCallCount).toBe(2)
  })

  it('should poll health until server is ready and return podIp and port', async () => {
    setupDefaultMocks({ health: 'fail-once-ok' })

    const result = await deployRpcServer('my-pod', 'my-container', 'tok-123')

    expect(result).toEqual({ podIp: '10.0.0.1', port: DISCOVERED_PORT })
  })

  it('should return on first health check success', async () => {
    const result = await deployRpcServer('my-pod', 'my-container', 'tok-123')

    expect(result).toEqual({ podIp: '10.0.0.1', port: DISCOVERED_PORT })
  })

  it('should retry if the start output has no parseable port on first attempt', async () => {
    const SECOND_PORT = 55555
    let startCallCount = 0

    setupDefaultMocks()
    mockExecPodStepOutput.mockImplementation(async (cmd: string[]) => {
      const cmdStr = cmd.join(' ')
      if (cmd[0] === 'uname') {
        return { exitCode: 0, stdout: 'x86_64\n' }
      }
      if (cmd[0] === '/tmp/rpc-server') {
        startCallCount++
        // First attempt: server produced no recognizable "[::]:PORT" line.
        if (startCallCount <= 1) {
          return { exitCode: 0, stdout: '' }
        }
        return {
          exitCode: 0,
          stdout: `RPC server listening on [::]:${SECOND_PORT}`
        }
      }
      if (cmdStr.includes('tail') && cmdStr.includes('rpc-server.log')) {
        return { exitCode: 0, stdout: '(no log)' }
      }
      return { exitCode: 0, stdout: '(no log)' }
    })

    const result = await deployRpcServer('my-pod', 'my-container', 'tok-123')

    expect(result.podIp).toBe('10.0.0.1')
    expect(result.port).toBe(SECOND_PORT)
  })

  it('should throw after max deploy attempts exhausted with diagnostics', async () => {
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0
    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    setupDefaultMocks({ health: 'always-fail' })
    mockFetch.mockImplementation(async () => {
      timeOffset += 31000
      return fakeResponse(500)
    })

    await expect(
      deployRpcServer('my-pod', 'my-container', 'tok-123')
    ).rejects.toThrow('RPC server failed after 3 attempts')
  })

  it('should include per-attempt diagnostics in final error', async () => {
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0
    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    setupDefaultMocks({
      log: { exitCode: 0, stdout: 'Traceback: ImportError' },
      health: 'always-fail'
    })
    mockFetch.mockImplementation(async () => {
      timeOffset += 31000
      return fakeResponse(500)
    })

    try {
      await deployRpcServer('my-pod', 'my-container', 'tok-123')
      fail('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('attempt 1:')
      expect(msg).toContain('attempt 2:')
      expect(msg).toContain('attempt 3:')
      expect(msg).toContain('health check timed out')
    }
  })

  it('should handle health check network errors', async () => {
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0
    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    setupDefaultMocks({ health: 'network-error' })
    mockFetch.mockImplementation(async () => {
      timeOffset += 31000
      throw new Error('fetch failed')
    })

    await expect(
      deployRpcServer('my-pod', 'my-container', 'tok-123')
    ).rejects.toThrow('RPC server failed after 3 attempts')
  })

  it('should include details in arch detection error message', async () => {
    setupDefaultMocks({
      arch: new Error('non-zero exit code 1 (stdout: pod not running)')
    })

    await expect(
      deployRpcServer('my-pod', 'my-container', 'tok-123')
    ).rejects.toThrow('pod not running')
  })

  it('should include details in binary write error message', async () => {
    setupDefaultMocks({
      write: new Error('non-zero exit code 1 (stdout: Read-only file system)')
    })

    await expect(
      deployRpcServer('my-pod', 'my-container', 'tok-123')
    ).rejects.toThrow('Read-only file system')
  })
})

describe('rpcPodStep', () => {
  const POD_IP = '10.0.0.1'
  const PORT = 8080
  const SCRIPT_PATH = '/__w/_temp/run.sh'
  const TOKEN = 'test-token-abc'
  const POD_NAME = 'test-pod'
  const CONTAINER_NAME = 'job'

  let fetchMock: jest.Mock
  let stdoutWriteSpy: jest.SpyInstance
  let stderrWriteSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    fetchMock = jest.fn()
    global.fetch = fetchMock

    // Default: getPodByName returns a pod in Unknown state (for diagnostics)
    mockGetPodByName.mockResolvedValue({
      status: { phase: 'Running', podIP: POD_IP }
    })

    // Suppress actual stdout/stderr writes during tests
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    stderrWriteSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  /**
   * Helper: set up fetchMock to handle the standard /exec -> /logs -> /status
   * flow in a single pass. Returns the exit code provided.
   */
  function setupSimpleExecFlow(exitCode: number, status = 'completed'): void {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()

      // /exec POST
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(
          fakeResponse(200, { id: MOCK_UUID, status: 'running' })
        )
      }

      // /logs GET
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }

      // /status GET
      if (urlStr.includes('/status')) {
        return Promise.resolve(
          fakeResponse(200, { id: MOCK_UUID, status, exit_code: exitCode })
        )
      }

      // /heartbeat POST
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }

      return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`))
    })
  }

  it('should send POST /exec with correct body and auth token', async () => {
    setupSimpleExecFlow(0)

    await rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)

    // Find the /exec call
    const execCall = fetchMock.mock.calls.find(
      ([url, opts]) => url.includes('/exec') && opts?.method === 'POST'
    )
    expect(execCall).toBeDefined()

    const [url, opts] = execCall
    expect(url).toBe(`http://${POD_IP}:${PORT}/exec`)
    expect(opts.headers['X-Auth-Token']).toBe(TOKEN)
    expect(opts.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(opts.body)
    expect(body.id).toBe(MOCK_UUID)
    expect(body.path).toBe(SCRIPT_PATH)
  })

  it('should poll /status until completed and return exit code 0', async () => {
    setupSimpleExecFlow(0, 'completed')

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)
  })

  it('should return exit code on failure (non-zero)', async () => {
    setupSimpleExecFlow(1, 'failed')

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(1)
  })

  it('should return exit code 137 for killed process', async () => {
    setupSimpleExecFlow(137, 'failed')

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(137)
  })

  it('should return -1 when exit_code is null', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        return Promise.resolve(
          fakeResponse(200, {
            id: 'test',
            status: 'completed',
            exit_code: null
          })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(-1)
  })

  it('should stream stdout via GET /logs?stream=stdout', async () => {
    const stdoutData = new TextEncoder().encode('hello stdout\n')
    let statusCallCount = 0

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stdout')) {
        // Return data on first call, empty on subsequent
        if (statusCallCount === 0) {
          return Promise.resolve(
            fakeResponse(200, null, {
              arrayBuffer: stdoutData.buffer.slice(
                stdoutData.byteOffset,
                stdoutData.byteOffset + stdoutData.byteLength
              )
            })
          )
        }
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stderr')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        if (statusCallCount >= 2) {
          return Promise.resolve(
            fakeResponse(200, { status: 'completed', exit_code: 0 })
          )
        }
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    await rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)

    // Verify stdout was fetched with correct query params
    const stdoutCalls = fetchMock.mock.calls.filter(
      ([url]) =>
        url.includes('/logs') &&
        url.includes('stream=stdout') &&
        url.includes('offset=')
    )
    expect(stdoutCalls.length).toBeGreaterThanOrEqual(1)

    // Verify process.stdout.write was called with the log data
    expect(stdoutWriteSpy).toHaveBeenCalled()
  })

  it('should stream stderr via GET /logs?stream=stderr', async () => {
    const stderrData = new TextEncoder().encode('error output\n')
    let statusCallCount = 0

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stdout')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stderr')) {
        if (statusCallCount === 0) {
          return Promise.resolve(
            fakeResponse(200, null, {
              arrayBuffer: stderrData.buffer.slice(
                stderrData.byteOffset,
                stderrData.byteOffset + stderrData.byteLength
              )
            })
          )
        }
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        if (statusCallCount >= 2) {
          return Promise.resolve(
            fakeResponse(200, { status: 'completed', exit_code: 0 })
          )
        }
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    await rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)

    const stderrCalls = fetchMock.mock.calls.filter(
      ([url]) => url.includes('/logs') && url.includes('stream=stderr')
    )
    expect(stderrCalls.length).toBeGreaterThanOrEqual(1)

    expect(stderrWriteSpy).toHaveBeenCalled()
  })

  it('should track offset correctly with large log responses', async () => {
    const chunk1 = new TextEncoder().encode('first chunk data\n')
    const chunk2 = new TextEncoder().encode('second chunk data\n')
    let stdoutCallIdx = 0
    let statusCallCount = 0

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stdout')) {
        stdoutCallIdx++
        if (stdoutCallIdx === 1) {
          // First call: offset=0, return chunk1
          expect(urlStr).toContain('offset=0')
          return Promise.resolve(
            fakeResponse(200, null, {
              arrayBuffer: chunk1.buffer.slice(
                chunk1.byteOffset,
                chunk1.byteOffset + chunk1.byteLength
              )
            })
          )
        } else if (stdoutCallIdx === 2) {
          // Second call: offset should be chunk1.byteLength
          expect(urlStr).toContain(`offset=${chunk1.byteLength}`)
          return Promise.resolve(
            fakeResponse(200, null, {
              arrayBuffer: chunk2.buffer.slice(
                chunk2.byteOffset,
                chunk2.byteOffset + chunk2.byteLength
              )
            })
          )
        }
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stderr')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        if (statusCallCount >= 3) {
          return Promise.resolve(
            fakeResponse(200, { status: 'completed', exit_code: 0 })
          )
        }
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)
    // stdout was written at least twice (chunk1 and chunk2)
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('should handle empty log responses', async () => {
    setupSimpleExecFlow(0)

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)
  })

  it('should retry /exec on network error up to 3 times then throw', async () => {
    const netErr = new Error('ECONNREFUSED')
    fetchMock
      .mockRejectedValueOnce(netErr)
      .mockRejectedValueOnce(netErr)
      .mockRejectedValueOnce(netErr)

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('RPC /exec network error after 3 attempts')
  })

  it('should succeed if /exec network error recovers on retry', async () => {
    const netErr = new Error('ECONNREFUSED')

    let execCallCount = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        // Fail first, succeed second
        execCallCount++
        if (execCallCount === 1) {
          return Promise.reject(netErr)
        }
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        return Promise.resolve(
          fakeResponse(200, { status: 'completed', exit_code: 0 })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)
  })

  it('should retry /exec on 5xx up to 3 times then throw', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(500, 'internal error'))
      .mockResolvedValueOnce(fakeResponse(502, 'bad gateway'))
      .mockResolvedValueOnce(fakeResponse(503, 'service unavailable'))

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('RPC /exec failed after 3 attempts')
  })

  it('should succeed if /exec 5xx recovers on retry', async () => {
    let execCallCount = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        execCallCount++
        if (execCallCount === 1) {
          return Promise.resolve(fakeResponse(500, 'error'))
        }
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        return Promise.resolve(
          fakeResponse(200, { status: 'completed', exit_code: 0 })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)
  })

  it('should throw immediately on /exec 4xx without retry', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(400, 'bad request'))

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('RPC /exec failed (400)')

    // Only one /exec call should have been made (no retries)
    const execCalls = fetchMock.mock.calls.filter(
      ([url, opts]) => url.includes('/exec') && opts?.method === 'POST'
    )
    expect(execCalls).toHaveLength(1)
  })

  it('should throw immediately on /exec 403', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(403, 'forbidden'))

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('RPC /exec failed (403)')
  })

  it('should surface cancellation-state context on /exec 409 "A job is already running"', async () => {
    // 409 with the canonical body → hook fetches /status for diagnostic
    // context, then throws a cancellation-aware error.
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse(409, { error: 'A job is already running' })
      )
      .mockResolvedValueOnce(
        fakeResponse(200, {
          id: 'prior-uuid',
          status: 'running',
          exit_code: null
        })
      )

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow(
      /Step cannot start: workflow pod still has a prior step in flight[\s\S]*id=prior-uuid[\s\S]*status=running[\s\S]*cancels a step/
    )
  })

  it('should fall through to generic 409 message when body does not match', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(409, 'some other 409 reason'))

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('RPC /exec failed (409)')
  })

  it('should send heartbeats during execution', async () => {
    // setInterval fires heartbeats every 3000ms in the source code.
    // We need the main polling loop to stay alive long enough for a heartbeat
    // to fire. We use fake timers and make sleep return a real timer-based
    // promise so that advanceTimersByTimeAsync progresses both setInterval
    // and sleep.
    jest.useFakeTimers()

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { sleep: mockSleep } = require('../src/k8s/utils') as {
      sleep: jest.Mock
    }
    mockSleep.mockImplementation(
      async (ms: number) => new Promise(r => setTimeout(r, ms))
    )

    let statusCallCount = 0

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        // Keep running for several polls so heartbeat interval fires
        if (statusCallCount >= 20) {
          return Promise.resolve(
            fakeResponse(200, { status: 'completed', exit_code: 0 })
          )
        }
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const promise = rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    // Advance fake clock in small steps to let both sleep and setInterval fire.
    // LOG_POLL_INTERVAL_MS = 200, HEARTBEAT_INTERVAL_MS = 3000
    // 20 polls * 200ms = 4000ms total, which is >3000 so heartbeat fires.
    for (let i = 0; i < 50; i++) {
      await jest.advanceTimersByTimeAsync(200)
    }

    const exitCode = await promise

    expect(exitCode).toBe(0)

    // Check that heartbeat calls were made
    const heartbeatCalls = fetchMock.mock.calls.filter(
      ([url, opts]) => url.includes('/heartbeat') && opts?.method === 'POST'
    )
    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1)

    // Verify heartbeat uses correct auth header
    expect(heartbeatCalls[0][1].headers['X-Auth-Token']).toBe(TOKEN)

    // Restore sleep mock to instant for other tests
    mockSleep.mockResolvedValue(undefined)
    jest.useRealTimers()
  })

  it('should clear heartbeat interval after completion', async () => {
    jest.useFakeTimers()

    setupSimpleExecFlow(0)

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

    const promise = rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )
    await jest.advanceTimersByTimeAsync(500)
    await promise

    expect(clearIntervalSpy).toHaveBeenCalled()

    jest.useRealTimers()
  })

  it('should throw on heartbeat timeout with OOM diagnostic', async () => {
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0

    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    // Pod shows OOMKilled container
    mockGetPodByName.mockResolvedValue({
      status: {
        phase: 'Failed',
        podIP: POD_IP,
        containerStatuses: [
          {
            name: CONTAINER_NAME,
            state: {
              terminated: { reason: 'OOMKilled', exitCode: 137 }
            }
          }
        ]
      }
    })

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        timeOffset += 61000
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.reject(new Error('connection refused'))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('OOMKilled')
  })

  it('should throw on heartbeat timeout with eviction diagnostic', async () => {
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0

    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    mockGetPodByName.mockResolvedValue({
      status: {
        phase: 'Failed',
        reason: 'Evicted',
        message: 'The node was low on resource: memory.',
        podIP: POD_IP
      }
    })

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        timeOffset += 61000
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.reject(new Error('connection refused'))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('Pod was evicted')
  })

  it('should throw on heartbeat timeout with node-failure diagnostic', async () => {
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0

    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    mockGetPodByName.mockResolvedValue({
      status: {
        phase: 'Unknown',
        message: 'Node lost contact',
        podIP: POD_IP
      }
    })

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        timeOffset += 61000
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.reject(new Error('connection refused'))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('possible node failure')
  })

  it('should fall back to generic message when diagnostics fail', async () => {
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0

    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    // getPodByName throws — K8s API unreachable
    mockGetPodByName.mockRejectedValue(new Error('API server unreachable'))

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        timeOffset += 61000
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.reject(new Error('connection refused'))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('RPC heartbeat failed for 60s')
  })

  it('should detect RPC process death when container is still running', async () => {
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0

    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    // Pod is still Running but RPC server died
    mockGetPodByName.mockResolvedValue({
      status: {
        phase: 'Running',
        podIP: POD_IP,
        containerStatuses: [
          {
            name: CONTAINER_NAME,
            state: { running: { startedAt: '2025-01-01T00:00:00Z' } }
          }
        ]
      }
    })

    // execPodStepOutput returns the server log
    mockExecPodStepOutput.mockResolvedValue({
      exitCode: 0,
      stdout: 'Killed'
    })

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        timeOffset += 61000
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.reject(new Error('connection refused'))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('RPC server process died')
  })

  it('should handle /status fetch failures gracefully (retry)', async () => {
    let statusCallCount = 0

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        if (statusCallCount === 1) {
          // First status call fails
          return Promise.reject(new Error('timeout'))
        }
        // Second call succeeds with completion
        return Promise.resolve(
          fakeResponse(200, { status: 'completed', exit_code: 0 })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)
    expect(statusCallCount).toBe(2)
  })

  it('should handle /logs fetch failures gracefully (continue polling)', async () => {
    let logsCallCount = 0

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        logsCallCount++
        if (logsCallCount <= 2) {
          // First two log fetches fail
          return Promise.reject(new Error('network error'))
        }
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        if (logsCallCount >= 3) {
          return Promise.resolve(
            fakeResponse(200, { status: 'completed', exit_code: 0 })
          )
        }
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    // Should complete despite log fetch failures
    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)
  })

  it('should do a final log flush after status becomes completed', async () => {
    const finalStdout = new TextEncoder().encode('final output\n')
    let statusCallCount = 0
    let postCompletionLogFetch = false

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stdout')) {
        if (statusCallCount >= 1 && !postCompletionLogFetch) {
          // This is the final flush — return remaining data
          postCompletionLogFetch = true
          return Promise.resolve(
            fakeResponse(200, null, {
              arrayBuffer: finalStdout.buffer.slice(
                finalStdout.byteOffset,
                finalStdout.byteOffset + finalStdout.byteLength
              )
            })
          )
        }
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stderr')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        return Promise.resolve(
          fakeResponse(200, { status: 'completed', exit_code: 0 })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)

    // After status shows completed, there should be log fetches for final flush
    const allLogCalls = fetchMock.mock.calls.filter(([url]) =>
      url.includes('/logs')
    )
    // At minimum: during-poll logs + final flush = 4 calls (2 streams x 2 phases)
    expect(allLogCalls.length).toBeGreaterThanOrEqual(4)
  })

  it('should handle non-200 /logs response (return empty)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        // Server returns 404 for logs
        return Promise.resolve(
          fakeResponse(404, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        return Promise.resolve(
          fakeResponse(200, { status: 'completed', exit_code: 0 })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)
  })

  it('should pass abort signal with timeout to fetch calls', async () => {
    setupSimpleExecFlow(0)

    await rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)

    // Verify all fetch calls include a signal
    for (const [, opts] of fetchMock.mock.calls) {
      if (opts) {
        expect(opts.signal).toBeDefined()
      }
    }
  })

  it('should include exec error body text in thrown error message', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(422, 'Unprocessable: missing required field "id"')
    )

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('RPC /exec failed (422)')
  })

  it('should handle /exec response where text() throws', async () => {
    const badResp = {
      ok: false,
      status: 400,
      statusText: '400',
      headers: new Headers(),
      text: jest.fn().mockRejectedValue(new Error('stream consumed')),
      json: jest.fn().mockRejectedValue(new Error('stream consumed')),
      arrayBuffer: jest.fn(),
      body: null,
      bodyUsed: true,
      redirected: false,
      type: 'basic' as ResponseType,
      url: '',
      clone: jest.fn()
    } as unknown as Response

    fetchMock.mockResolvedValueOnce(badResp)

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('RPC /exec failed (400)')
  })

  // -------------------------------------------------------------------
  // Scenario tests — long-running, cancellation, OOM, sudden pod death
  // -------------------------------------------------------------------

  it('should stream stdout and stderr over many poll cycles (long-running script)', async () => {
    // Simulates a process running for many poll iterations, producing
    // new stdout/stderr chunks periodically, with heartbeats succeeding.
    const totalPolls = 30
    let statusCallCount = 0
    let stdoutCallCount = 0
    let stderrCallCount = 0

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stdout')) {
        stdoutCallCount++
        // Produce a chunk every 5 polls
        if (stdoutCallCount % 5 === 0 && statusCallCount < totalPolls) {
          const chunk = new TextEncoder().encode(
            `stdout line ${stdoutCallCount}\n`
          )
          return Promise.resolve(
            fakeResponse(200, null, {
              arrayBuffer: chunk.buffer.slice(
                chunk.byteOffset,
                chunk.byteOffset + chunk.byteLength
              )
            })
          )
        }
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stderr')) {
        stderrCallCount++
        // Produce stderr every 7 polls
        if (stderrCallCount % 7 === 0 && statusCallCount < totalPolls) {
          const chunk = new TextEncoder().encode(
            `stderr warning ${stderrCallCount}\n`
          )
          return Promise.resolve(
            fakeResponse(200, null, {
              arrayBuffer: chunk.buffer.slice(
                chunk.byteOffset,
                chunk.byteOffset + chunk.byteLength
              )
            })
          )
        }
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        if (statusCallCount >= totalPolls) {
          return Promise.resolve(
            fakeResponse(200, { status: 'completed', exit_code: 0 })
          )
        }
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(0)
    // Verify multiple stdout and stderr writes occurred
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(stderrWriteSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('should handle process killed mid-execution (cancelled job)', async () => {
    // Process runs for several polls producing logs, then is killed externally.
    // Status changes from running to failed with exit code 143 (SIGTERM).
    let statusCallCount = 0
    const killAfterPolls = 5

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stdout')) {
        if (statusCallCount < killAfterPolls) {
          const chunk = new TextEncoder().encode('running...\n')
          return Promise.resolve(
            fakeResponse(200, null, {
              arrayBuffer: chunk.buffer.slice(
                chunk.byteOffset,
                chunk.byteOffset + chunk.byteLength
              )
            })
          )
        }
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stderr')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        if (statusCallCount > killAfterPolls) {
          // Process was killed — SIGTERM = exit code 143 (128 + 15)
          return Promise.resolve(
            fakeResponse(200, { status: 'failed', exit_code: 143 })
          )
        }
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(143)
    // Some stdout was produced before the kill
    expect(stdoutWriteSpy).toHaveBeenCalled()
  })

  it('should handle OOM kill on the script (exit code 137 with log streaming)', async () => {
    // Script runs, producing logs, then is OOM killed. The RPC server
    // catches the exit and reports status: failed, exit_code: 137.
    let statusCallCount = 0
    const oomAfterPolls = 8

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stdout')) {
        if (statusCallCount <= oomAfterPolls) {
          const chunk = new TextEncoder().encode('allocating memory...\n')
          return Promise.resolve(
            fakeResponse(200, null, {
              arrayBuffer: chunk.buffer.slice(
                chunk.byteOffset,
                chunk.byteOffset + chunk.byteLength
              )
            })
          )
        }
        // After OOM, no more output
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/logs') && urlStr.includes('stream=stderr')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        if (statusCallCount > oomAfterPolls) {
          // SIGKILL from OOM killer: 128 + 9 = 137
          return Promise.resolve(
            fakeResponse(200, { status: 'failed', exit_code: 137 })
          )
        }
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    const exitCode = await rpcPodStep(
      POD_IP,
      PORT,
      SCRIPT_PATH,
      TOKEN,
      POD_NAME,
      CONTAINER_NAME
    )

    expect(exitCode).toBe(137)
    expect(stdoutWriteSpy).toHaveBeenCalled()
  })

  it('should handle OOM kill on workflow pod (all fetches fail, then diagnostic)', async () => {
    // Pod OOM: after some successful polls, ALL fetches start failing.
    // Heartbeat grace period elapses, then diagnostic reveals OOMKilled.
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0
    let statusCallCount = 0
    const oomAfterPolls = 3

    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    mockGetPodByName.mockResolvedValue({
      status: {
        phase: 'Failed',
        podIP: POD_IP,
        containerStatuses: [
          {
            name: CONTAINER_NAME,
            state: {
              terminated: { reason: 'OOMKilled', exitCode: 137 }
            }
          }
        ]
      }
    })

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }

      // After OOM, all fetches fail (server is gone)
      if (statusCallCount >= oomAfterPolls) {
        if (urlStr.includes('/status')) {
          // Advance time to trigger heartbeat grace expiry
          timeOffset += 25000
          return Promise.reject(new Error('ECONNREFUSED'))
        }
        if (urlStr.includes('/heartbeat')) {
          return Promise.reject(new Error('ECONNREFUSED'))
        }
        if (urlStr.includes('/logs')) {
          return Promise.reject(new Error('ECONNREFUSED'))
        }
      }

      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        statusCallCount++
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.resolve(fakeResponse(200, { status: 'ok' }))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('OOMKilled')
  })

  it('should handle workflow pod sudden death with generic termination', async () => {
    // Pod dies for a non-OOM reason (e.g., preemption, crash).
    // All fetches fail, heartbeat times out, diagnostic shows terminated
    // with reason: Error.
    const realDateNow = Date.now
    const startTime = realDateNow()
    let timeOffset = 0

    jest.spyOn(Date, 'now').mockImplementation(() => startTime + timeOffset)

    mockGetPodByName.mockResolvedValue({
      status: {
        phase: 'Failed',
        podIP: POD_IP,
        containerStatuses: [
          {
            name: CONTAINER_NAME,
            state: {
              terminated: {
                reason: 'Error',
                exitCode: 1,
                message: 'container exited unexpectedly'
              }
            }
          }
        ]
      }
    })

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        return Promise.resolve(fakeResponse(200, { status: 'running' }))
      }
      if (urlStr.includes('/logs')) {
        return Promise.resolve(
          fakeResponse(200, null, { arrayBuffer: new ArrayBuffer(0) })
        )
      }
      if (urlStr.includes('/status')) {
        timeOffset += 61000
        return Promise.resolve(
          fakeResponse(200, { status: 'running', exit_code: null })
        )
      }
      if (urlStr.includes('/heartbeat')) {
        return Promise.reject(new Error('connection refused'))
      }
      return Promise.reject(new Error(`Unexpected: ${urlStr}`))
    })

    await expect(
      rpcPodStep(POD_IP, PORT, SCRIPT_PATH, TOKEN, POD_NAME, CONTAINER_NAME)
    ).rejects.toThrow('container exited unexpectedly')
  })
})

// ---------------------------------------------------------------------------
// killRpcJob
// ---------------------------------------------------------------------------

describe('killRpcJob', () => {
  const POD_IP = '10.0.0.1'
  const PORT = 8080
  const TOKEN = 'test-token-abc'

  let fetchMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    fetchMock = jest.fn()
    global.fetch = fetchMock as any
  })

  it('POSTs /kill with the auth token', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, { id: 'x', status: 'failed', exit_code: -1 })
    )

    await killRpcJob(POD_IP, PORT, TOKEN)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/kill')
    expect(opts.method).toBe('POST')
    expect(opts.headers['X-Auth-Token']).toBe(TOKEN)
  })

  it('swallows network errors (best-effort)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'))

    // Must not throw — caller is about to exit and can't handle errors.
    await expect(killRpcJob(POD_IP, PORT, TOKEN)).resolves.toBeUndefined()
  })

  it('swallows non-2xx responses (best-effort)', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(500, 'oops'))

    await expect(killRpcJob(POD_IP, PORT, TOKEN)).resolves.toBeUndefined()
  })
})
