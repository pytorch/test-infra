// Regression tests for BufferSink / CappedWritable, the in-repo replacement
// for the `stream-buffers` WritableStreamBuffer dependency.
//
// The dependency was dropped because its internal buffer growth used the
// deprecated `Buffer()` constructor, emitting Node DEP0005 once per
// containerized step. See actions/runner-container-hooks#261.
//
// These tests assert (1) the capture/encoding/truncation behavior is
// preserved and (2) no Buffer() DeprecationWarning fires while exercising
// the replacement.

// --------------------------------------------------------------------------
// Module mocks — declared before importing the module under test. Importing
// src/k8s runs top-level KubeConfig setup, so stub the client like the other
// k8s unit tests do.
// --------------------------------------------------------------------------
jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node')
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      getContexts: jest.fn().mockReturnValue([{ namespace: 'arc-runners' }]),
      makeApiClient: jest.fn().mockReturnValue({})
    })),
    Exec: jest.fn().mockImplementation(() => ({ exec: jest.fn() }))
  }
})

import { finished } from 'stream/promises'
import { BufferSink, CappedWritable } from '../src/k8s'

async function writeAll(
  w: BufferSink | CappedWritable,
  chunks: (Buffer | string)[]
): Promise<void> {
  for (const c of chunks) {
    await new Promise<void>((resolve, reject) =>
      w.write(c, err => (err ? reject(err) : resolve()))
    )
  }
  w.end()
  await finished(w)
}

describe('BufferSink', () => {
  it('concatenates Buffer chunks in write order', async () => {
    const sink = new BufferSink()
    await writeAll(sink, [Buffer.from('foo'), Buffer.from('bar')])
    expect(sink.getContentsAsString()).toBe('foobar')
  })

  it('returns empty string when nothing was written', () => {
    expect(new BufferSink().getContentsAsString()).toBe('')
  })

  it('decodes string chunks using the write encoding', async () => {
    const sink = new BufferSink()
    // 'zg==' is base64 for the single byte 0xCE.
    await writeAll(sink, [Buffer.from('zg==', 'base64')])
    expect(sink.getContentsAsString('hex')).toBe('ce')
  })

  it('reassembles a multi-byte UTF-8 sequence split across chunks', async () => {
    // The euro sign U+20AC is 0xE2 0x82 0xAC. Splitting it across two writes
    // would corrupt output if each chunk were decoded independently; lazy
    // concat-then-decode must keep it intact.
    const euro = Buffer.from('€', 'utf8')
    const sink = new BufferSink()
    await writeAll(sink, [euro.subarray(0, 1), euro.subarray(1)])
    expect(sink.getContentsAsString('utf8')).toBe('€')
  })
})

describe('CappedWritable', () => {
  it('keeps content under the cap verbatim', async () => {
    const w = new CappedWritable(1024)
    await writeAll(w, [Buffer.from('hello')])
    expect(w.size()).toBe(5)
    expect(w.getContentsAsString()).toBe('hello')
  })

  it('truncates at maxBytes and appends a marker', async () => {
    const w = new CappedWritable(4)
    await writeAll(w, [Buffer.from('abcdefgh')])
    expect(w.size()).toBe(4)
    expect(w.getContentsAsString()).toBe('abcd\n[... truncated at 4 bytes]')
  })
})

describe('no deprecated Buffer() usage', () => {
  it('does not emit a DEP0005 DeprecationWarning while capturing output', async () => {
    const warnings: string[] = []
    const onWarning = (w: Error & { code?: string }): void => {
      warnings.push(w.code || w.message)
    }
    process.on('warning', onWarning)
    try {
      const sink = new BufferSink()
      await writeAll(sink, [Buffer.from('x'.repeat(100_000))])
      const capped = new CappedWritable(64 * 1024)
      await writeAll(capped, [Buffer.from('y'.repeat(100_000))])
      // Let any queued process warnings flush.
      await new Promise(r => setImmediate(r))
    } finally {
      process.off('warning', onWarning)
    }
    expect(warnings).not.toContain('DEP0005')
  })
})
