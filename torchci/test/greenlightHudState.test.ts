import { readFileSync } from "fs";
import {
  buildStateBySha,
  buildStatusByTrunkSha,
  GreenlightPrStateRow,
  isGreenlightApproved,
  normalizeSha,
  selectMessageView,
  selectStateForSha,
  supersedes,
} from "lib/greenlight/greenlightHudState";
// The namespace, not the bindings: the throw-path tests below spy on it, and a
// destructured import would leave the route holding the real functions.
import * as greenlightOutline from "lib/greenlight/greenlightOutline";
import {
  GREENLIGHT_MESSAGE_CAP,
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_REVERTED,
} from "lib/greenlight/greenlightRender";
import { ZERO_WIDTH_SPACE } from "lib/greenlight/greenlightSweep";
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
// Both files declare a second CTE with its own WHERE / ORDER BY / LIMIT 1 BY, so a bare
// indexOf would land in whichever one is written first. Slicing to `reviewed` is what
// makes the ordering assertions about the CTE that reads misc.greenlight_pr_state rather
// than about declaration order.
function reviewedCte(queryName: string): string {
  const sql = readFileSync(
    path.resolve(__dirname, "..", "clickhouse_queries", queryName, "query.sql"),
    "utf-8"
  ).replace(/--.*$/gm, "");

  const start = sql.indexOf("reviewed AS");
  const end = sql.indexOf("landed AS");
  if (start < 0 || end <= start) {
    throw new Error(
      `${queryName}: expected a \`reviewed\` CTE declared ahead of \`landed\``
    );
  }
  return sql.slice(start, end);
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
