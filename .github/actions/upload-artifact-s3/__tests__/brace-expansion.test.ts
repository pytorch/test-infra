import {describe, expect, it} from '@jest/globals'
import {braceExpand} from 'minimatch'

// Regression tests for GHSA-f886-m6hf-6m8v / CVE-2026-33750 in brace-expansion.
//
// minimatch is a direct runtime dep of this action and pulls in
// brace-expansion 2.x. The vendored copy bundled into dist/upload/index.js
// (via @actions/glob -> minimatch -> brace-expansion 1.x) carries the
// same patches; check-dist guards lockfile/dist drift.
//
// Vulnerable versions: brace-expansion <=1.1.13 (1.x) and <=2.0.1 (2.x).
// Patched versions:    1.1.14 / 2.1.0.
//
// On vulnerable versions both inputs below either hung indefinitely
// (zero-step numeric range) or quadratically backtracked the post-brace
// regex (dense-comma post). On patched versions both return promptly with
// the asserted output.

const TIME_BUDGET_MS = 1000

describe('brace-expansion (GHSA-f886-m6hf-6m8v) regression', () => {
  it('zero-step numeric range expands to a finite, deterministic list', () => {
    // Vulnerable versions infinite-looped on `{N..M..0}` because the step
    // was used as-is. Patch clamps via Math.max(Math.abs(step), 1) so the
    // step degrades to 1 and the range expands deterministically.
    const start = Date.now()
    const out = braceExpand('{1..3..0}')
    expect(Date.now() - start).toBeLessThan(TIME_BUDGET_MS)
    expect(out).toEqual(['1', '2', '3'])
  })

  it('dense-comma malformed input does not exhibit ReDoS', () => {
    // Vulnerable versions matched the post-brace tail against /,.*\}/,
    // which quadratically backtracks on a long run of commas with no
    // closing brace. Patch tightens the regex to /,(?!,).*\}/. With no
    // closing brace anywhere the input is malformed and brace-expansion
    // returns it unchanged; we assert that to lock in correctness as
    // well as termination.
    const dense = ','.repeat(10_000)
    const input = `{a}${dense}`
    const start = Date.now()
    const out = braceExpand(input)
    expect(Date.now() - start).toBeLessThan(TIME_BUDGET_MS)
    expect(out).toEqual([input])
  })
})
