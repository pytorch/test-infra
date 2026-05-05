import {describe, expect, it} from '@jest/globals'
import {braceExpand} from 'minimatch'

// Regression tests for GHSA-f886-m6hf-6m8v / CVE-2026-33750 in brace-expansion.
//
// brace-expansion is reachable from this action at runtime via
//   @actions/glob -> minimatch -> brace-expansion
// and is bundled into dist/upload/index.js by @vercel/ncc. We exercise it
// here via minimatch.braceExpand, which is the same entrypoint @actions/glob
// uses internally when expanding a pattern.
//
// Vulnerable versions: brace-expansion <=1.1.13 (1.x) and <=2.0.1 (2.x).
// Patched versions:    1.1.14 / 2.1.0.
//
// On vulnerable versions both inputs below either hung indefinitely
// (zero-step numeric range) or exhibited catastrophic regex backtracking
// (dense-comma post). On patched versions both return promptly.

const TIME_BUDGET_MS = 1000

describe('brace-expansion (GHSA-f886-m6hf-6m8v) regression', () => {
  it('zero-step numeric range terminates with a finite result', () => {
    // Vulnerable versions infinite-looped on `{N..M..0}` because the step
    // was used as-is. Patch clamps via Math.max(Math.abs(step), 1).
    const start = Date.now()
    const out = braceExpand('{1..3..0}')
    expect(Date.now() - start).toBeLessThan(TIME_BUDGET_MS)
    expect(out.length).toBeGreaterThan(0)
  })

  it('dense-comma malformed input does not exhibit ReDoS', () => {
    // Vulnerable versions matched the post-brace tail against /,.*\}/, which
    // catastrophically backtracks on a long run of commas with no closing
    // brace. Patch tightens the regex to /,(?!,).*\}/.
    const dense = ','.repeat(60)
    const start = Date.now()
    braceExpand(`{a}${dense}`)
    expect(Date.now() - start).toBeLessThan(TIME_BUDGET_MS)
  })
})
