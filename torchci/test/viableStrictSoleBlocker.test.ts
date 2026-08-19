import { readFileSync } from "fs";
import path from "path";

// The "Sole viable/strict blockers" table folds shards in ClickHouse
// (clickhouse_queries/viable_strict_sole_blocker/query.sql), so the folding
// behavior can't be exercised by importing a TS function. These tests instead
// (1) mirror the exact regex to lock in the intended transformation, and
// (2) statically assert query.sql still uses that fold + the intended filters,
// so a change to one without the other is caught.

const QUERY_SQL = path.resolve(
  __dirname,
  "..",
  "clickhouse_queries",
  "viable_strict_sole_blocker",
  "query.sql"
);

// Mirrors: replaceRegexpOne(j.name, ', [0-9]+, [0-9]+.*\)$', ')')
// ClickHouse replaceRegexpOne replaces the FIRST match; a non-global JS replace
// does the same. The full folded name is `${workflow} / ${foldShard(j.name)}`.
const foldShard = (name: string) => name.replace(/, \d+, \d+.*\)$/, ")");

describe("viable/strict sole blocker shard fold (mirrors query.sql)", () => {
  test("strips the shard suffix but keeps the config, at any nesting depth", () => {
    // 2-component name
    expect(
      foldShard(
        "linux-jammy-py3.10-gcc11 / test (default, 1, 3, linux.4xlarge)"
      )
    ).toBe("linux-jammy-py3.10-gcc11 / test (default)");

    // nested (3-component): the config is the LAST group; the earlier "(3.11)"
    // matrix instance is preserved, not dropped.
    expect(
      foldShard(
        "dynamo-unittest / dynamo-test (3.11) / test (dynamo_wrapped, 6, 7, mt-l-x86iavx512-8-64)"
      )
    ).toBe("dynamo-unittest / dynamo-test (3.11) / test (dynamo_wrapped)");

    // dynamo_core vs dynamo_wrapped stay DISTINCT (the note #2 bug)
    expect(
      foldShard(
        "dynamo-unittest / dynamo-test (3.11) / test (dynamo_core, 1, 1, mt-l-x86iavx512-8-64)"
      )
    ).toBe("dynamo-unittest / dynamo-test (3.11) / test (dynamo_core)");
  });

  test("all shards of one config collapse to the same folded name", () => {
    const a = foldShard("m / test (default, 1, 5, linux.4xlarge)");
    const b = foldShard("m / test (default, 3, 5, linux.4xlarge)");
    expect(a).toBe(b);
    expect(a).toBe("m / test (default)");
  });

  test("leaves names without a shard suffix untouched", () => {
    expect(foldShard("linux-jammy-py3.10-gcc11 / build")).toBe(
      "linux-jammy-py3.10-gcc11 / build"
    );
    expect(foldShard("m / test (default)")).toBe("m / test (default)"); // already folded
    expect(foldShard("pylint")).toBe("pylint"); // slashless lint job
    // multi-dimension configs use commas that aren't ", <int>, <int>", so they
    // are preserved distinct (executorch-shaped jobs).
    expect(foldShard("test-backend-linux (qnn, models)")).toBe(
      "test-backend-linux (qnn, models)"
    );
    expect(foldShard("run (mv3, cortex-m7)")).toBe("run (mv3, cortex-m7)");
  });

  test("a trailing marker after the shard fields is also stripped (why unstable/rerun are filtered pre-fold, to avoid colliding with the real gating job)", () => {
    expect(foldShard("test (default, 1, 10, linux.rocm.gpu, unstable)")).toBe(
      "test (default)"
    );
    expect(
      foldShard("test (default, 5, 8, linux.rocm.gpu, rerun_disabled_tests)")
    ).toBe("test (default)");
  });
});

describe("viable/strict sole blocker query.sql stays in sync with the fold + filters", () => {
  const sql = readFileSync(QUERY_SQL, "utf8");

  test("uses the shard-strip regex fold, not the old segment-slicing fold", () => {
    // substrings, to stay robust to the SQL backslash escaping of the regex
    expect(sql).toContain("replaceRegexpOne(j.name");
    expect(sql).toContain(", [0-9]+, [0-9]+");
    // old fold assumed exactly two " / " components
    expect(sql).not.toContain("splitByString(' / ', j.name), 2)");
  });

  test("matches gating workflows in full, mirroring the gate's re.fullmatch", () => {
    // Anchored at both ends (test-infra #8438). A bare prefix would also match
    // sandbox/experiment workflows and linters that share the prefix but do
    // not gate. Assert the whole predicate, not just the pattern: the pattern
    // is all-lowercase only because lower() runs first, so dropping lower() as
    // redundant-looking would silently un-gate the "Lint" workflow.
    expect(sql).toContain(
      "match(lower(j.workflow_name), '^(pull|trunk|lint|docs-build)$')"
    );

    // Mirrors match(lower(j.workflow_name), ...): case-fold, then full-match.
    const gates = (workflowName: string) =>
      /^(pull|trunk|lint|docs-build)$/.test(workflowName.toLowerCase());

    // Workflow names as they are actually spelled on main -- note "Lint",
    // which a case-sensitive mirror would wrongly reject.
    for (const wf of ["pull", "trunk", "Lint", "docs-build"]) {
      expect(gates(wf)).toBe(true);
    }
    for (const wf of [
      "trunk-ci-sandbox",
      "trunk-tagging",
      "pull-test-sandbox",
      "Linter",
      "Lintrunner",
    ]) {
      expect(gates(wf)).toBe(false);
    }
  });

  test("keeps the gate's job filters + the fold-collision filters, drops the over-filters", () => {
    // gate parity
    expect(sql).toContain("j.name != 'ciflow_should_run'");
    expect(sql).toContain("j.name != 'generate-test-matrix'");
    // kept: their trailing marker would fold onto the real gating job
    expect(sql).toContain("j.name NOT LIKE '%unstable%'");
    expect(sql).toContain("j.name NOT LIKE '%rerun_disabled_tests%'");
    // dropped: the gate gates on these; they fold to distinct names
    expect(sql).not.toContain("j.name NOT LIKE '%filter%'");
    expect(sql).not.toContain("j.name LIKE '%/%'");
  });
});
