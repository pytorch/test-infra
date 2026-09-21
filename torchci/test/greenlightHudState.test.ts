import { readFileSync } from "fs";
import {
  buildGreenlightCommitParams,
  buildStateBySha,
  buildStatusByTrunkSha,
  GreenlightPrStateRow,
  isGreenlightApproved,
  isGreenlightRejected,
  normalizeSha,
  selectMessageView,
  selectStateForSha,
  shouldShowGreenlightStatus,
  supersedes,
} from "lib/greenlight/greenlightHudState";
// The namespace, not the bindings: the throw-path tests below spy on it, and a
// destructured import would leave the route holding the real functions.
import * as greenlightOutline from "lib/greenlight/greenlightOutline";
import {
  GREENLIGHT_MESSAGE_CAP,
  GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_FAILED,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_REVERTED,
} from "lib/greenlight/greenlightRender";
import { ZERO_WIDTH_SPACE } from "lib/greenlight/greenlightSweep";
import { CommitData } from "lib/types";
import path from "path";
import { format } from "util";

function row(overrides: Partial<GreenlightPrStateRow>): GreenlightPrStateRow {
  return {
    pr_number: 1,
    status: GREENLIGHT_STATUS_LAND,
    reason: "clean",
    message: "looks fine",
    head_sha: "a".repeat(40),
    merge_commit_sha: "",
    eval_job: "",
    run_id: 1,
    version: "2026-09-01 00:00:00.000",
    ...overrides,
  };
}

describe("isGreenlightApproved", () => {
  test("only LAND counts as approved", () => {
    expect(isGreenlightApproved(GREENLIGHT_STATUS_LAND)).toBe(true);
    for (const status of [
      GREENLIGHT_STATUS_NO_LAND,
      GREENLIGHT_STATUS_AI_REVIEW_STARTED,
      GREENLIGHT_STATUS_CANCELLED,
      GREENLIGHT_STATUS_REVERTED,
    ]) {
      expect(isGreenlightApproved(status)).toBe(false);
    }
  });

  test("absent, empty and unknown statuses are not approved", () => {
    expect(isGreenlightApproved(undefined)).toBe(false);
    expect(isGreenlightApproved(null)).toBe(false);
    expect(isGreenlightApproved("")).toBe(false);
    expect(isGreenlightApproved("SOMETHING_NEW")).toBe(false);
  });

  test("tolerates the surrounding whitespace a ClickHouse String can carry", () => {
    expect(isGreenlightApproved(` ${GREENLIGHT_STATUS_LAND} `)).toBe(true);
  });
});

describe("isGreenlightRejected", () => {
  test("only NO_LAND counts as a refusal", () => {
    expect(isGreenlightRejected(GREENLIGHT_STATUS_NO_LAND)).toBe(true);
    // Every other non-LAND status is an absence of a verdict, not a refusal:
    // the review never finished (dispatched / started), never reached one
    // (cancelled / failed), or the PR was excluded rather than judged
    // (reverted). Counting any of them here would put a red lamp on a commit
    // Green Light never declined.
    for (const status of [
      GREENLIGHT_STATUS_LAND,
      GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
      GREENLIGHT_STATUS_AI_REVIEW_STARTED,
      GREENLIGHT_STATUS_CANCELLED,
      GREENLIGHT_STATUS_FAILED,
      GREENLIGHT_STATUS_REVERTED,
    ]) {
      expect(isGreenlightRejected(status)).toBe(false);
    }
  });

  test("absent, empty and unknown statuses are not rejections", () => {
    expect(isGreenlightRejected(undefined)).toBe(false);
    expect(isGreenlightRejected(null)).toBe(false);
    expect(isGreenlightRejected("")).toBe(false);
    expect(isGreenlightRejected("SOMETHING_NEW")).toBe(false);
  });

  test("tolerates the surrounding whitespace a ClickHouse String can carry", () => {
    expect(isGreenlightRejected(` ${GREENLIGHT_STATUS_NO_LAND} `)).toBe(true);
  });
});

describe("shouldShowGreenlightStatus", () => {
  test("approvals show whether or not refusals are opted into", () => {
    expect(shouldShowGreenlightStatus(GREENLIGHT_STATUS_LAND, false)).toBe(
      true
    );
    expect(shouldShowGreenlightStatus(GREENLIGHT_STATUS_LAND, true)).toBe(true);
  });

  test("a refusal is hidden by default and shown once opted into", () => {
    expect(shouldShowGreenlightStatus(GREENLIGHT_STATUS_NO_LAND, false)).toBe(
      false
    );
    expect(shouldShowGreenlightStatus(GREENLIGHT_STATUS_NO_LAND, true)).toBe(
      true
    );
  });

  test("opting into refusals does not surface the non-verdict statuses", () => {
    // The toggle is about refusals only. An in-flight or abandoned review says
    // nothing about the commit, so it stays off the HUD either way.
    for (const status of [
      GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
      GREENLIGHT_STATUS_AI_REVIEW_STARTED,
      GREENLIGHT_STATUS_CANCELLED,
      GREENLIGHT_STATUS_FAILED,
      GREENLIGHT_STATUS_REVERTED,
      "SOMETHING_NEW",
    ]) {
      expect(shouldShowGreenlightStatus(status, true)).toBe(false);
      expect(shouldShowGreenlightStatus(status, false)).toBe(false);
    }
  });

  test("a commit with no recorded status is never marked", () => {
    expect(shouldShowGreenlightStatus(undefined, true)).toBe(false);
    expect(shouldShowGreenlightStatus(null, true)).toBe(false);
    expect(shouldShowGreenlightStatus("", true)).toBe(false);
  });
});

describe("supersedes", () => {
  test("a higher run_id wins even with an older version", () => {
    const newer = { run_id: 9, version: "2026-01-01 00:00:00.000" };
    const older = { run_id: 8, version: "2026-09-01 00:00:00.000" };
    expect(supersedes(newer, older)).toBe(true);
    expect(supersedes(older, newer)).toBe(false);
  });

  test("version breaks a run_id tie", () => {
    const later = { run_id: 9, version: "2026-09-02 00:00:00.000" };
    const earlier = { run_id: 9, version: "2026-09-01 00:00:00.000" };
    expect(supersedes(later, earlier)).toBe(true);
    expect(supersedes(earlier, later)).toBe(false);
  });

  test("a row does not supersede itself", () => {
    const only = { run_id: 9, version: "2026-09-01 00:00:00.000" };
    expect(supersedes(only, only)).toBe(false);
  });
});

describe("buildStatusByTrunkSha", () => {
  const TRUNK_A = "1".repeat(40);
  const TRUNK_B = "2".repeat(40);

  test("keys each commit's status by its own trunk sha", () => {
    const bySha = buildStatusByTrunkSha([
      { sha: TRUNK_A, status: GREENLIGHT_STATUS_LAND },
      { sha: TRUNK_B, status: GREENLIGHT_STATUS_NO_LAND },
    ]);
    expect(bySha.get(TRUNK_A)).toBe(GREENLIGHT_STATUS_LAND);
    expect(bySha.get(TRUNK_B)).toBe(GREENLIGHT_STATUS_NO_LAND);
  });

  test("two landings of one PR keep their own verdicts", () => {
    // The regression this whole keying exists for: a PR that lands, is
    // reverted, is changed and lands again. Keyed by PR, both commits would
    // take the later verdict and the first would carry an approval that was
    // never about it.
    const bySha = buildStatusByTrunkSha([
      { sha: TRUNK_A, status: GREENLIGHT_STATUS_NO_LAND },
      { sha: TRUNK_B, status: GREENLIGHT_STATUS_LAND },
    ]);
    expect(bySha.get(TRUNK_A)).toBe(GREENLIGHT_STATUS_NO_LAND);
    expect(bySha.get(TRUNK_B)).toBe(GREENLIGHT_STATUS_LAND);
  });

  test("lookups are case-insensitive on the sha", () => {
    const bySha = buildStatusByTrunkSha([
      { sha: TRUNK_A.toUpperCase(), status: GREENLIGHT_STATUS_LAND },
    ]);
    expect(bySha.get(TRUNK_A)).toBe(GREENLIGHT_STATUS_LAND);
  });

  test("drops rows with no sha", () => {
    expect(
      buildStatusByTrunkSha([
        { sha: "", status: GREENLIGHT_STATUS_LAND },
        { sha: "   ", status: GREENLIGHT_STATUS_LAND },
      ]).size
    ).toBe(0);
  });

  test("undefined and empty input give an empty map", () => {
    expect(buildStatusByTrunkSha(undefined).size).toBe(0);
    expect(buildStatusByTrunkSha([]).size).toBe(0);
  });
});

describe("buildGreenlightCommitParams", () => {
  const TRUNK_A = "1".repeat(40);
  const TRUNK_B = "2".repeat(40);
  const TRUNK_C = "3".repeat(40);

  function commit(
    sha: string,
    prNum: number | null,
    time: string
  ): Pick<CommitData, "sha" | "prNum" | "time"> {
    return { sha, prNum, time };
  }

  test("emits the three arrays aligned by position", () => {
    expect(
      buildGreenlightCommitParams([
        commit(TRUNK_A, 100, "2026-09-20T16:31:19Z"),
        commit(TRUNK_B, 200, "2026-09-20T16:31:20Z"),
      ])
    ).toEqual({
      shas: [TRUNK_A, TRUNK_B],
      prNumbers: [100, 200],
      committedAts: ["2026-09-20T16:31:19Z", "2026-09-20T16:31:20Z"],
    });
  });

  test("dropping a row drops its whole triple, not just its sha", () => {
    // The failure this guards is silent: three independent passes would leave
    // the arrays a different length, and the query zips by position, so every
    // commit after the gap would be resolved against the next one's PR.
    const params = buildGreenlightCommitParams([
      commit(TRUNK_A, 100, "2026-09-20T16:31:19Z"),
      commit(TRUNK_B, null, "2026-09-20T16:31:20Z"),
      commit(TRUNK_C, 300, "2026-09-20T16:31:21Z"),
    ]);
    expect(params).toEqual({
      shas: [TRUNK_A, TRUNK_C],
      prNumbers: [100, 300],
      committedAts: ["2026-09-20T16:31:19Z", "2026-09-20T16:31:21Z"],
    });
  });

  test("a non-positive PR number is not a PR number", () => {
    expect(
      buildGreenlightCommitParams([
        commit(TRUNK_A, 0, "2026-09-20T16:31:19Z"),
        commit(TRUNK_B, -1, "2026-09-20T16:31:20Z"),
      ]).shas
    ).toEqual([]);
  });

  test("two landings of one PR stay separate rows with their own times", () => {
    // Nothing collapses on PR number: the second landing's later timestamp is
    // the only thing that tells the query which head each commit was cut from.
    const params = buildGreenlightCommitParams([
      commit(TRUNK_A, 100, "2026-09-18T01:00:00Z"),
      commit(TRUNK_B, 100, "2026-09-20T01:00:00Z"),
    ]);
    expect(params.prNumbers).toEqual([100, 100]);
    expect(params.committedAts).toEqual([
      "2026-09-18T01:00:00Z",
      "2026-09-20T01:00:00Z",
    ]);
  });

  test("undefined and empty input give three empty arrays", () => {
    const empty = { shas: [], prNumbers: [], committedAts: [] };
    expect(buildGreenlightCommitParams(undefined)).toEqual(empty);
    expect(buildGreenlightCommitParams([])).toEqual(empty);
  });
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const TRUNK_A = "d".repeat(40);

describe("normalizeSha", () => {
  test("folds case and trims, and maps absent input to empty", () => {
    expect(normalizeSha(`  ${SHA_A.toUpperCase()} `)).toBe(SHA_A);
    expect(normalizeSha(undefined)).toBe("");
    expect(normalizeSha(null)).toBe("");
  });
});

describe("buildStateBySha", () => {
  test("keys each reviewed commit's row by its head sha", () => {
    const bySha = buildStateBySha([
      row({ head_sha: SHA_A, status: GREENLIGHT_STATUS_NO_LAND }),
      row({ head_sha: SHA_B, status: GREENLIGHT_STATUS_LAND }),
    ]);
    expect(bySha.get(SHA_A)?.status).toBe(GREENLIGHT_STATUS_NO_LAND);
    expect(bySha.get(SHA_B)?.status).toBe(GREENLIGHT_STATUS_LAND);
  });

  test("a sha reviewed twice keeps the later run", () => {
    const bySha = buildStateBySha([
      row({ head_sha: SHA_A, status: GREENLIGHT_STATUS_NO_LAND, run_id: 4 }),
      row({ head_sha: SHA_A, status: GREENLIGHT_STATUS_LAND, run_id: 7 }),
    ]);
    expect(bySha.get(SHA_A)?.status).toBe(GREENLIGHT_STATUS_LAND);
  });

  test("lookups are case-insensitive on the sha", () => {
    const bySha = buildStateBySha([row({ head_sha: SHA_A.toUpperCase() })]);
    expect(bySha.get(SHA_A)).toBeDefined();
  });

  test("drops rows with no head sha", () => {
    expect(buildStateBySha([row({ head_sha: "" })]).size).toBe(0);
    expect(buildStateBySha([row({ head_sha: "   " })]).size).toBe(0);
  });
});

describe("selectStateForSha", () => {
  const rows = [
    row({
      head_sha: SHA_A,
      merge_commit_sha: TRUNK_A,
      status: GREENLIGHT_STATUS_LAND,
    }),
    row({
      head_sha: SHA_B,
      merge_commit_sha: "",
      status: GREENLIGHT_STATUS_NO_LAND,
    }),
  ];

  test("matches a reviewed head, which is what the PR picker selects", () => {
    expect(selectStateForSha(rows, SHA_A)).toEqual(rows[0]);
    expect(selectStateForSha(rows, SHA_B)).toEqual(rows[1]);
  });

  test("matches the trunk commit that reviewed head landed as", () => {
    // Mergebot rebases, so a commit page never sees the reviewed sha.
    expect(selectStateForSha(rows, TRUNK_A)).toEqual(rows[0]);
  });

  test("a commit that was never reviewed gets nothing, not the PR verdict", () => {
    // Most picker entries are ordinary commits that were never a review head;
    // showing them another commit's approval would say something untrue.
    expect(selectStateForSha(rows, SHA_C)).toBeUndefined();
  });

  test("an unrelated sha gets nothing, so a forged PR reference resolves to nothing", () => {
    expect(selectStateForSha(rows, "f".repeat(40))).toBeUndefined();
  });

  test("never matches on an empty merge_commit_sha", () => {
    expect(selectStateForSha(rows, "")).toBeUndefined();
    expect(selectStateForSha(rows, undefined)).toBeUndefined();
  });

  test("matching is case-insensitive on both shas", () => {
    expect(selectStateForSha(rows, SHA_A.toUpperCase())).toEqual(rows[0]);
    expect(selectStateForSha(rows, TRUNK_A.toUpperCase())).toEqual(rows[0]);
  });

  test("undefined when the PR has no recorded state at all", () => {
    expect(selectStateForSha(undefined, SHA_A)).toBeUndefined();
    expect(selectStateForSha([], SHA_A)).toBeUndefined();
  });
});

const OUTLINE_TOPIC = "torch/_inductor/lowering.py touched";
const OUTLINE_DETAIL = "guarded by `is_fbcode()`";
const OUTLINE_SECOND_TOPIC = "second topic";
const OUTLINE_MESSAGE = `- ${OUTLINE_TOPIC}\n  - ${OUTLINE_DETAIL}\n- ${OUTLINE_SECOND_TOPIC}`;
// Every leaf of that message with its bullet marker stripped. A redaction check
// that named one phrase would pass on a log holding all the others.
const OUTLINE_LEAVES = OUTLINE_MESSAGE.split("\n").map((line) =>
  line.replace(/^\s*-\s*/, "")
);

// A message the classifier accepts -- two bullets, both with a body -- whose
// every body flattens to nothing, so the parse yields no topic to render.
const BLANK_OUTLINE = `- ${ZERO_WIDTH_SPACE}\n- ${ZERO_WIDTH_SPACE}`;

// Over the cap with only two bullets, so `truncated` can only have been set by
// the message length: a third bullet would set it through the topic clamp
// instead and prove nothing about which string the parser read.
const OVER_CAP_OUTLINE = `- ${OUTLINE_SECOND_TOPIC}\n- ${"x".repeat(
  GREENLIGHT_MESSAGE_CAP
)}`;
const AT_CAP_OUTLINE = greenlightOutline.capCodePoints(
  OVER_CAP_OUTLINE,
  GREENLIGHT_MESSAGE_CAP
);

// The union is what makes the panel's two branches exhaustive, so narrowing it
// here rather than asserting on `kind` keeps a wrong branch a type error.
function outlineView(
  message: string | undefined | null
): greenlightOutline.ParsedOutline {
  const view = selectMessageView(message);
  if (view.kind !== "outline") {
    throw new Error(`expected an outline view, got ${view.kind}`);
  }
  return view.outline;
}

function textView(message: string | undefined | null): string {
  const view = selectMessageView(message);
  if (view.kind !== "text") {
    throw new Error(`expected a text view, got ${view.kind}`);
  }
  return view.text;
}

// What a console sink prints for the calls a console.error spy recorded.
// JSON.stringify cannot stand in for it: Error.message and Error.stack are
// non-enumerable, so it renders every logged error as `{}` and a redaction
// check built on it passes whatever the error carries.
function loggedText(spy: jest.SpyInstance): string {
  return spy.mock.calls.map((call) => format(...call)).join("\n");
}

describe("selectMessageView", () => {
  test("a bullet outline routes to the parsed list", () => {
    const outline = outlineView(OUTLINE_MESSAGE);

    expect(outline.truncated).toBe(false);
    expect(outline.topics).toHaveLength(2);
    expect(outline.topics[0].text).toEqual([
      { text: OUTLINE_TOPIC, code: false },
    ]);
    // The trailing empty segment is why the renderer skips empty text: a leaf
    // ending in a code span always parses to one.
    expect(outline.topics[0].details).toEqual([
      [
        { text: "guarded by ", code: false },
        { text: "is_fbcode()", code: true },
        { text: "", code: false },
      ],
    ]);
    expect(outline.topics[0].detailsTruncated).toBe(false);
    expect(outline.topics[1].details).toEqual([]);
  });

  test("reads the `message` column the panel hands it", () => {
    const state = selectStateForSha(
      [row({ head_sha: SHA_A, message: OUTLINE_MESSAGE })],
      SHA_A
    );
    expect(selectMessageView(state?.message).kind).toBe("outline");
  });

  test("prose routes to text, which is what every pre-outline row is", () => {
    expect(textView("looks fine to me")).toBe("looks fine to me");
    // One bullet-shaped line in a paragraph is not an outline.
    expect(textView("a paragraph\n- with one bullet")).toBe(
      "a paragraph\n- with one bullet"
    );
  });

  test("an absent, empty or blank message routes to text", () => {
    expect(textView(undefined)).toBe("");
    expect(textView(null)).toBe("");
    expect(textView("")).toBe("");
    expect(textView("   ")).toBe("   ");
  });

  test("a message that is not a string at all routes to empty text", () => {
    // The row is a cast over an untyped saved query, so the column's declared
    // type is an assertion. The coercion is on the type rather than on what
    // React happens to accept: a number and an array render, a plain object is
    // not a valid child and takes the commit page down with it, and the panel
    // has no business telling those apart.
    expect(textView({} as unknown as string)).toBe("");
    expect(textView(7 as unknown as string)).toBe("");
    expect(textView(["- one", "- two"] as unknown as string)).toBe("");
  });

  test("an outline whose every leaf flattens away routes to text", () => {
    // Not the empty list: the panel would show an empty <ul> where the fence
    // shows the reader the characters that are actually in the row.
    expect(textView(BLANK_OUTLINE)).toBe(BLANK_OUTLINE);
  });

  test("the parser reads the uncapped message, so an over-cap outline marks the cut", () => {
    expect(OVER_CAP_OUTLINE.length).toBeGreaterThan(GREENLIGHT_MESSAGE_CAP);
    expect(outlineView(OVER_CAP_OUTLINE).topics).toHaveLength(2);
    expect(outlineView(OVER_CAP_OUTLINE).truncated).toBe(true);

    // The same message pre-cut to the cap loses the marker, which is the whole
    // reason the cap is applied to the text branch alone.
    expect(AT_CAP_OUTLINE.length).toBe(GREENLIGHT_MESSAGE_CAP);
    expect(outlineView(AT_CAP_OUTLINE).truncated).toBe(false);
  });

  test("the text branch is capped, since `message` is an unbounded String", () => {
    const long = "x".repeat(GREENLIGHT_MESSAGE_CAP + 500);
    expect(textView(long)).toBe("x".repeat(GREENLIGHT_MESSAGE_CAP));

    // Counted in code points, not UTF-16 units: a cap that split a surrogate
    // pair would hand the panel half a character.
    const astral = "\u{1F600}".repeat(GREENLIGHT_MESSAGE_CAP);
    expect(Array.from(textView(astral))).toHaveLength(GREENLIGHT_MESSAGE_CAP);
  });

  test("a parse that throws routes to text without logging the message", () => {
    const thrown = new Error("parse read a message it could not handle");
    const parse = jest
      .spyOn(greenlightOutline, "parseOutline")
      .mockImplementation(() => {
        throw thrown;
      });
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(textView(OUTLINE_MESSAGE)).toBe(OUTLINE_MESSAGE);
      expect(parse).toHaveBeenCalledWith(OUTLINE_MESSAGE);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("outline parse threw"),
        thrown
      );
      // None of the model's text: `message` is PR-influenceable, and a console
      // is not where it gets replayed unbounded.
      const printed = loggedText(logged);
      for (const leaf of OUTLINE_LEAVES) {
        expect(printed).not.toContain(leaf);
      }
    } finally {
      parse.mockRestore();
      logged.mockRestore();
    }
  });

  test("a classifier that throws routes to text too", () => {
    // Choosing the branch reads the same untrusted text parsing it does, so it
    // sits inside the same guard rather than outside it.
    const thrown = new Error("classifier read a message it could not handle");
    const classify = jest
      .spyOn(greenlightOutline, "isOutline")
      .mockImplementation(() => {
        throw thrown;
      });
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(textView(OUTLINE_MESSAGE)).toBe(OUTLINE_MESSAGE);
      expect(classify).toHaveBeenCalledWith(OUTLINE_MESSAGE);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("outline parse threw"),
        thrown
      );
      const printed = loggedText(logged);
      for (const leaf of OUTLINE_LEAVES) {
        expect(printed).not.toContain(leaf);
      }
    } finally {
      classify.mockRestore();
      logged.mockRestore();
    }
  });
});

// The helpers above are handed rows the HUD fetches by query name, so nothing here runs
// the SQL and the only place its text can be pinned is the file itself.
//
// Comments are stripped because each header names both `shadow` and `LIMIT 1 BY` while
// explaining why they sit in that order, and these assertions are about the statement.
//
// Every CTE in these files has its own WHERE / ORDER BY / LIMIT 1 BY, so a bare indexOf
// would land in whichever one is written first. The slice below is the `reviewed` CTE and
// nothing else, which is what makes the ordering assertions about the CTE that reads
// misc.greenlight_pr_state rather than about declaration order.
//
// It closes on `reviewed`'s own bracket rather than on the name of whichever CTE follows.
// One of these files declares five more between `reviewed` and `landed`, and a slice run
// to the next name would pull their clauses inside these indexOf assertions and stretch
// the "exactly one mention of shadow" pin across statements it says nothing about --
// passing today, and failing with a misleading message the day one of them says `shadow`.
function reviewedCte(queryName: string): string {
  const sql = readFileSync(
    path.resolve(__dirname, "..", "clickhouse_queries", queryName, "query.sql"),
    "utf-8"
  ).replace(/--.*$/gm, "");

  const start = sql.indexOf("reviewed AS");
  const open = sql.indexOf("(", start);
  if (start < 0 || open < 0) {
    throw new Error(`${queryName}: expected a \`reviewed\` CTE`);
  }
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") {
      depth += 1;
    } else if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return sql.slice(start, i + 1);
      }
    }
  }
  throw new Error(`${queryName}: \`reviewed\` CTE is never closed`);
}

describe.each([
  ["greenlight_trunk_commit_states"],
  ["greenlight_pr_state_history"],
])("%s query.sql, reviewed CTE", (queryName) => {
  const cte = reviewedCte(queryName);

  test("excludes shadow rows, whose evaluation carries no authority", () => {
    expect(cte).toContain("AND shadow = false");
  });

  test("filters in WHERE, ahead of the LIMIT 1 BY collapse", () => {
    const where = cte.indexOf("WHERE");
    const shadow = cte.indexOf("shadow");
    const order = cte.indexOf("ORDER BY");
    const limit = cte.indexOf("LIMIT 1 BY");

    expect(where).toBeGreaterThan(-1);
    expect(shadow).toBeGreaterThan(where);
    expect(shadow).toBeLessThan(order);
    expect(order).toBeLessThan(limit);
    // run_id climbs with every dispatch, so a shadow row written after a real verdict
    // outranks it: filtering only after the collapse would let that row win LIMIT 1 BY
    // and then be dropped, hiding the genuine verdict instead of falling back to it. A
    // second mention placed after the collapse satisfies every check above, so pin that
    // there is exactly one.
    expect(cte.lastIndexOf("shadow")).toBe(shadow);
  });
});

// Every landing mergebot recorded is also reachable through default.merges, so a
// regression in the fallback shows up as a missing mark on the stack members that
// merges never recorded -- silent, and invisible to any test that only fetches rows.
// These pin the statement instead.
describe("greenlight_trunk_commit_states query.sql, head resolution", () => {
  const sql = readFileSync(
    path.resolve(
      __dirname,
      "..",
      "clickhouse_queries",
      "greenlight_trunk_commit_states",
      "query.sql"
    ),
    "utf-8"
  ).replace(/--.*$/gm, "");

  test("resolves a head the merge record never mentions", () => {
    // A ghstack stack lands as one push and mergebot writes a single merges row, so
    // every member below the one that carried the command has no merge_commit_sha to
    // join on. default.push is where those heads are recoverable at all.
    expect(sql).toContain("FROM default.push");
    expect(sql).toMatch(/branch_heads AS\s*\(/);
  });

  test("mergebot's own record stays ahead of the temporal fallback", () => {
    // merges names the merged head outright; the push scan infers it from ordering.
    // Reversed, a push landing between review and merge would outrank the fact.
    const coalesced = sql.slice(sql.indexOf("coalesce("));
    expect(coalesced.indexOf("mh.head_sha")).toBeGreaterThan(-1);
    expect(coalesced.indexOf("mh.head_sha")).toBeLessThan(
      coalesced.indexOf("b.head_sha")
    );
  });

  test("the fallback reads each commit's own timestamp", () => {
    // Anchoring on anything shared across the PR -- its merge time, the newest
    // commit on the page -- gives both landings of a re-landed PR the same head,
    // which is the bug the per-commit keying exists to avoid.
    expect(sql).toContain("b.pushed_at < c.committed_at");
  });

  // Where merges also resolves, it wins and a wrong branch head is harmless.
  // For the commits only the branch fallback can resolve there is no second
  // source to check it against, and picking the wrong push puts this commit's
  // mark on a different revision of the same PR. Pushes to one head ref, against
  // a landing at 12:00:
  //
  //   09:00  aaa  reviewed, then superseded
  //   11:30  bbb  the revision that landed
  //   12:00  ccc  the landing push itself
  //   14:00  ddd  the next revision, pushed after the landing
  //
  // bbb is the only correct answer. Nothing in the repo runs a saved query, so
  // the two properties of the statement that decide it are pinned instead.
  test("a push at or after the landing is never selected", () => {
    const landed = sql.slice(sql.indexOf("landed AS"));
    // Exactly one comparison between the two, and it is strict: `<=` takes ccc,
    // and dropping the bound entirely takes ddd.
    expect(landed.match(/b\.pushed_at\s*<=?\s*c\.committed_at/g)).toEqual([
      "b.pushed_at < c.committed_at",
    ]);
  });

  test("among the pushes that qualify, the last one wins", () => {
    // argMax on pushed_at is what takes bbb over aaa. argMin, or maximising on
    // anything else, silently returns a stale head that still carries a verdict.
    expect(sql).toMatch(/argMaxIf\(\s*b\.head_sha,\s*b\.pushed_at,/);
  });

  test("the head ref is taken from the PR, and only when it lives in this repo", () => {
    expect(sql).toContain("concat('refs/heads/', head.ref)");
    expect(sql).toContain("head.repo.full_name = {repo: String}");
  });

  test("never reads pull_request.head.sha", () => {
    // default.pull_request collapses with no version column, so the surviving row
    // carries whichever head the PR has now. On a reverted and re-pushed PR that is
    // a SHA no commit on the page was ever cut from, and it resolves silently.
    expect(sql).not.toContain("head.sha");
  });
});
