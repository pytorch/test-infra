import { ADVISOR_PENDING_ALT_ATTR } from "lib/advisor/advisorBadge";
import {
  defangGreenlightMessage,
  GREENLIGHT_INCOMPLETE_HEADLINE,
  GREENLIGHT_LAND_HEADLINE,
  GREENLIGHT_MESSAGE_CAP,
  GREENLIGHT_MESSAGE_WRAP_WIDTH,
  GREENLIGHT_NO_LAND_HEADLINE,
  GREENLIGHT_OUTDATED_HEADLINE_PREFIX,
  GREENLIGHT_PENDING_ALT_ATTR,
  GREENLIGHT_REVERTED_BODY,
  GREENLIGHT_REVERTED_HEADLINE,
  GREENLIGHT_REVIEWING_HEADLINE,
  GreenlightState,
  INLINE_BREAKERS_RE,
  renderGreenlightSection,
  SHORT_SHA_LENGTH,
  SWEEP_PREDICATE_MIN_LENGTH,
  SWEEP_SENTINELS,
  ZERO_WIDTH_SPACE,
} from "lib/greenlight/greenlightRender";
import { GREENLIGHT_IN_PROGRESS_STALE_MS } from "lib/greenlight/greenlightStaleness";

const JOB_URL = "https://github.com/pytorch/test-infra/actions/runs/42";
// The shape ClickHouse returns for a DateTime64(3) under
// date_time_output_format='iso': ISO-like, UTC, no zone designator.
const VERSION = "2026-08-24T12:00:00.000000";
// Straddle the staleness cutoff by a minute on each side. Tight on purpose: the
// UTC test below needs any nonzero host offset to push both to the wrong side.
const FRESH_NOW = new Date("2026-08-24T12:59:00Z");
const STALE_NOW = new Date("2026-08-24T13:01:00Z");
const REVIEWED_SHA = "abc1234567890abc1234567890abc1234567890a";
const OTHER_SHA = "def4567890def4567890def4567890def4567890";
// The scan writes DISPATCHED and the reviewer upgrades it to STARTED; both are
// live reviews and must render identically.
const IN_FLIGHT_STATUSES = ["AI_REVIEW_STARTED", "AI_REVIEW_DISPATCHED"];
const TERMINAL_STATUSES = ["LAND", "NO_LAND", "CANCELLED", "FAILED"];
// The shortest text the sweep's third predicate, the regex `\d Pending`, matches.
const SHORTEST_PENDING_MATCH = "0 Pending";
// One payload per sweep predicate, each the shortest text that trips it: what an
// attacker has to smuggle whole into the raw comment body to pin the PR.
const SWEEP_TARGETS = [...SWEEP_SENTINELS, SHORTEST_PENDING_MATCH];
// Characters to break a target with. A deletion splices the text on either side
// of it together, so a target broken by exactly one deleted character re-forms
// the instant that deletion runs -- and if anything deletes after the defuse,
// what it re-forms is live. Which characters get deleted is not fixed:
// INLINE_BREAKERS_RE can widen, and inlineCode is shared with shortSha and could
// be hardened against markup, so probe the whole of ASCII and the invisibles such
// a pass reaches for, deleted today or not.
const DELETION_PROBES = [
  ...Array.from({ length: 0x80 }, (_, code) => String.fromCharCode(code)),
  "\u00a0",
  "\u061c",
  "\u200b",
  "\u200e",
  "\u2028",
  "\u2029",
  "\ufeff",
];
// What the renderer deletes today, read off the class rather than spelled out, so
// widening it carries the tests below with it.
const INLINE_BREAKERS = DELETION_PROBES.filter(
  (char) => char.replace(INLINE_BREAKERS_RE, "") === ""
);

function state(overrides: Partial<GreenlightState> = {}): GreenlightState {
  return {
    prNumber: 123,
    status: "LAND",
    reason: "clean",
    message: "Looks good.",
    headSha: REVIEWED_SHA,
    evalJob: JOB_URL,
    version: VERSION,
    ...overrides,
  };
}

// The lines between the fences defangGreenlightMessage emits, taken either from
// its own output or from a whole rendered section.
function fencedLines(rendered: string): string[] {
  const lines = rendered.split("\n");
  const open = lines.findIndex((line) => /^`{3,}$/.test(line));
  // Without this a fenceless render slices to garbage and every caller's
  // assertion quietly passes against it.
  expect(open).toBeGreaterThanOrEqual(0);
  return lines.slice(open + 1, lines.lastIndexOf(lines[open]));
}

// The section renders closed, so this line is the whole of what a reader sees
// before expanding it.
function summaryLine(rendered: string): string {
  const match = rendered.match(/<summary>(.*)<\/summary>/);
  expect(match).not.toBeNull();
  return match![1];
}

// What the reader sees: the zero-width spaces the defanging inserts are invisible
// and so must not count against the wrap column.
function visibleWidth(text: string): number {
  return Array.from(text.split(ZERO_WIDTH_SPACE).join("")).length;
}

// Default the PR's current head to the reviewed commit, so only the tests that
// care about a superseded verdict have to mention a second sha.
function render(
  s: GreenlightState,
  now: Date,
  currentHeadSha: string = s.headSha
): string {
  return renderGreenlightSection(s, now, currentHeadSha);
}

// Everything getPRsNeedingCommentRefresh would still match in a finished render:
// the sweep reads the raw body, so a survivor here pins the PR into every sweep
// for as long as the comment stands.
function liveSweepPredicates(rendered: string): string[] {
  return [
    ...SWEEP_SENTINELS.filter((sentinel) => rendered.includes(sentinel)),
    ...(rendered.match(/\d Pending/g) ?? []),
  ];
}

// The two model-authored fields, which reach the comment body by different paths:
// the message through the cap, the fence and the wrap, the reason through an
// inline code span. A payload that must not survive has to be tried against both.
const PAYLOAD_FIELDS: Record<string, (payload: string) => GreenlightState> = {
  message: (payload) => state({ status: "LAND", message: payload }),
  reason: (payload) => state({ status: "LAND", reason: payload }),
};

// Every live predicate one payload leaves behind, tagged with the field it went
// in through so a failure names the path that leaked and the payload that did it.
function sweepLeaks(payload: string): string[] {
  const leaks: string[] = [];
  for (const [field, build] of Object.entries(PAYLOAD_FIELDS)) {
    for (const live of liveSweepPredicates(render(build(payload), FRESH_NOW))) {
      leaks.push(
        `${field}=${JSON.stringify(payload)} left ${JSON.stringify(live)}`
      );
    }
  }
  return leaks;
}

describe("defangGreenlightMessage", () => {
  it("caps the message at 4000 characters", () => {
    const out = defangGreenlightMessage("x".repeat(5000));

    expect(out.split("x").length - 1).toBe(GREENLIGHT_MESSAGE_CAP);
  });

  it("caps on code points, never splitting a surrogate pair", () => {
    const out = defangGreenlightMessage("😀".repeat(5000));

    expect(Array.from(out).filter((c) => c === "😀").length).toBe(
      GREENLIGHT_MESSAGE_CAP
    );
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("inserts a zero-width space after every @", () => {
    const out = defangGreenlightMessage("ping @pytorchbot and @octocat");

    expect(out).not.toContain("@pytorchbot");
    expect(out).not.toContain("@octocat");
    expect(out).toContain(`@${ZERO_WIDTH_SPACE}pytorchbot`);
    expect(out).toContain(`@${ZERO_WIDTH_SPACE}octocat`);
    expect(out.split(ZERO_WIDTH_SPACE).length - 1).toBe(2);
  });

  it("uses a three-backtick fence when the text has no backticks", () => {
    const out = defangGreenlightMessage("plain text");

    expect(out).toBe("```\nplain text\n```");
  });

  it("uses a fence longer than the longest backtick run in the text", () => {
    const out = defangGreenlightMessage("a ``` b ````` c ``");

    expect(out.split("\n")[0]).toBe("`".repeat(6));
    expect(out).toContain("a ``` b ````` c ``");
  });

  it("fences an empty message", () => {
    expect(defangGreenlightMessage("")).toBe("```\n\n```");
  });

  it("fences text that is nothing but backticks", () => {
    expect(defangGreenlightMessage("````")).toBe("`````\n````\n`````");
  });

  it("preserves a trailing newline inside the fence", () => {
    expect(defangGreenlightMessage("abc\n")).toBe("```\nabc\n\n```");
  });
});

// GitHub does not soft-wrap inside a code fence, so an unwrapped verdict renders
// as one line behind a horizontal scrollbar.
describe("defangGreenlightMessage wrapping", () => {
  const PARAGRAPH = "lorem ipsum dolor sit amet consectetur ".repeat(8).trim();

  it("wraps a long paragraph to the column on word boundaries", () => {
    const lines = fencedLines(defangGreenlightMessage(PARAGRAPH));

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(
        GREENLIGHT_MESSAGE_WRAP_WIDTH
      );
    }
    // Reconstructing the source by re-joining on the single spaces the breaks
    // replaced proves no word was split and no character other than those spaces
    // was dropped.
    expect(lines.join(" ")).toBe(PARAGRAPH);
  });

  it("leaves a message already inside the column byte-for-byte alone", () => {
    const narrow = "Looks good.\n\n  Second thought, still short.\n";

    expect(defangGreenlightMessage(narrow)).toBe(`\`\`\`\n${narrow}\n\`\`\``);
  });

  it("wraps each line on its own instead of reflowing them together", () => {
    const lines = fencedLines(
      defangGreenlightMessage(`short one\n\n${PARAGRAPH}\n\nshort two`)
    );

    expect(lines[0]).toBe("short one");
    expect(lines[1]).toBe("");
    expect(lines[lines.length - 1]).toBe("short two");
    expect(lines[lines.length - 2]).toBe("");
    expect(lines.filter((line) => line === "")).toHaveLength(2);
  });

  // A break deletes the whitespace run it lands on, so a defuse seam that counted
  // as whitespace would be dropped wherever a line wrapped across it, and only the
  // newline the break leaves in its place would keep the halves of a marker apart.
  // Which invisible character this is decides that, and not by any rule the wrap
  // can state: U+200B escapes `\s` by being categorised Cf rather than Zs, while
  // U+FEFF is Cf too and matches anyway, named in the whitespace production itself.
  it("relies on its zero-width space not being whitespace to JavaScript", () => {
    expect(/\s/.test(ZERO_WIDTH_SPACE)).toBe(false);
  });

  // Counting them would wrap a line short by however many @-mentions and defused
  // sentinels it happened to contain -- invisibly, and differently per line.
  it("does not count the zero-width spaces it inserts toward the column", () => {
    const mentions = "@aa ".repeat(10).trim();
    const filler = "b".repeat(
      GREENLIGHT_MESSAGE_WRAP_WIDTH - mentions.length - 1
    );
    const line = `${mentions} ${filler}`;
    expect(line).toHaveLength(GREENLIGHT_MESSAGE_WRAP_WIDTH);

    const lines = fencedLines(defangGreenlightMessage(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`@${ZERO_WIDTH_SPACE}aa`);
    expect(lines[0].length).toBeGreaterThan(GREENLIGHT_MESSAGE_WRAP_WIDTH);
  });

  // Chopping a URL or a sha makes it silently wrong when pasted somewhere else,
  // which is worse than the scrollbar one over-wide line leaves behind.
  it("puts a token wider than the column on its own line, intact", () => {
    const url = `https://github.com/pytorch/pytorch/actions/runs/${"1".repeat(
      60
    )}`;

    const lines = fencedLines(
      defangGreenlightMessage(`see ${url} for the details`)
    );

    expect(visibleWidth(url)).toBeGreaterThan(GREENLIGHT_MESSAGE_WRAP_WIDTH);
    expect(lines).toEqual(["see", url, "for the details"]);
  });

  // The only load-bearing boundary in the wrap: the whole-line check above it is
  // a pure fast path, so `<=` here is the one place an off-by-one can hide.
  it("fills to exactly the column before breaking", () => {
    const head = `${Array(15).fill("abcd").join(" ")} eeeee`;
    expect(head).toHaveLength(GREENLIGHT_MESSAGE_WRAP_WIDTH);

    expect(fencedLines(defangGreenlightMessage(`${head} zzzz`))).toEqual([
      head,
      "zzzz",
    ]);
  });

  it("swallows the whole whitespace run a break replaces", () => {
    const head = "x".repeat(70);
    const tail = "y".repeat(20);

    const out = defangGreenlightMessage(`${head}${" ".repeat(9)}${tail}`);

    expect(fencedLines(out)).toEqual([head, tail]);
  });

  it("keeps an indented over-wide token with its indent, on one line", () => {
    const token = "z".repeat(GREENLIGHT_MESSAGE_WRAP_WIDTH + 20);

    const lines = fencedLines(defangGreenlightMessage(`    ${token} tail`));

    expect(lines).toEqual([`    ${token}`, "tail"]);
  });

  it("keeps a trailing whitespace run on the line it belongs to", () => {
    const body = "x".repeat(GREENLIGHT_MESSAGE_WRAP_WIDTH - 5);
    const line = `${body}${" ".repeat(11)}`;
    expect(visibleWidth(line)).toBeGreaterThan(GREENLIGHT_MESSAGE_WRAP_WIDTH);

    expect(fencedLines(defangGreenlightMessage(line))).toEqual([line]);
  });

  // The cap runs first so it buys 4000 characters of the model's own text. A
  // break swallows one of the two spaces below, so wrapping first would shrink
  // the text and let more words through under the same budget.
  it("spends the cap on the model's characters, not on the wrap's", () => {
    const unit = "word  ";

    const out = defangGreenlightMessage(unit.repeat(1200));

    expect(out.split("word").length - 1).toBe(
      Math.ceil(GREENLIGHT_MESSAGE_CAP / unit.length)
    );
    expect(fencedLines(out).length).toBeGreaterThan(1);
  });

  // A break can move a backtick run to the start of a line, where a run at least
  // as long as the opening fence would close the block early. Breaks land only on
  // whitespace, so the run itself survives intact and the fence stays longer than
  // every run in the text.
  it("cannot wrap a backtick run into a line that closes the fence", () => {
    const out = defangGreenlightMessage(`${"pad ".repeat(20)}\`\`\` tail`);
    const fence = out.split("\n")[0];
    const lines = fencedLines(out);

    expect(fence).toBe("````");
    expect(lines[lines.length - 1]).toBe("``` tail");
    for (const line of lines) {
      expect(line).not.toMatch(/^`{4,}/);
    }
  });
});

describe("renderGreenlightSection statuses", () => {
  it("renders LAND with headline, message, reason, sha and job link", () => {
    const out = render(state(), FRESH_NOW);

    expect(out).toContain("<details><summary><b>GREEN LIGHT</b>");
    expect(out).toContain(GREENLIGHT_LAND_HEADLINE);
    expect(out).toContain("Looks good.");
    expect(out).toContain("reason: `clean`");
    expect(out).toContain("Reviewed commit: `abc1234`");
    expect(out).toContain(`[Inference job](${JOB_URL})`);
    expect(out).toContain("</p></details>");
  });

  // The message is model prose that runs to dozens of wrapped lines. Left
  // expanded it pushes the failure lists Dr.CI's comment exists for down past a
  // screenful, so everything but the headline stays behind the fold.
  it("renders collapsed, with only the headline above the fold", () => {
    const out = render(state(), FRESH_NOW);

    expect(summaryLine(out)).toContain(GREENLIGHT_LAND_HEADLINE);
    expect(summaryLine(out)).not.toContain("Looks good.");
    expect(summaryLine(out)).not.toContain("reason:");
    expect(summaryLine(out)).not.toContain("Reviewed commit:");
    expect(summaryLine(out)).not.toContain("[Inference job]");
  });

  it("renders NO_LAND with its own headline and the same scaffold", () => {
    const out = render(
      state({ status: "NO_LAND", reason: "scope_too_large" }),
      FRESH_NOW
    );

    expect(out).toContain(GREENLIGHT_NO_LAND_HEADLINE);
    expect(out).not.toContain(GREENLIGHT_LAND_HEADLINE);
    expect(out).toContain("reason: `scope_too_large`");
  });

  it("renders both fresh in-flight statuses as in progress", () => {
    for (const status of IN_FLIGHT_STATUSES) {
      const out = render(state({ status }), FRESH_NOW);

      expect(out).toContain(GREENLIGHT_REVIEWING_HEADLINE);
      expect(out).toContain("Green Light is reviewing this PR.");
      expect(out).toContain("Reviewed commit: `abc1234`");
    }
  });

  it("renders CANCELLED and FAILED as incomplete with the lowercased status", () => {
    const cancelled = render(state({ status: "CANCELLED" }), FRESH_NOW);
    const failed = render(state({ status: "FAILED" }), FRESH_NOW);

    expect(cancelled).toContain(GREENLIGHT_INCOMPLETE_HEADLINE);
    expect(cancelled).toContain("reason: `cancelled`");
    expect(failed).toContain(GREENLIGHT_INCOMPLETE_HEADLINE);
    expect(failed).toContain("reason: `failed`");
  });

  // The scan writes this row with no reason, message or job of its own, so the
  // blank-field handling the retry statuses get applies here too: a rendered
  // `reason: ``` or an empty fence would be noise the reader has to expand to.
  it("renders REVERTED with its own headline and body, and no blank fields", () => {
    const out = render(
      state({ status: "REVERTED", reason: "", message: "", evalJob: "" }),
      FRESH_NOW
    );

    expect(summaryLine(out)).toContain(GREENLIGHT_REVERTED_HEADLINE);
    expect(out).toContain(GREENLIGHT_REVERTED_BODY);
    expect(out).not.toContain(GREENLIGHT_LAND_HEADLINE);
    expect(out).not.toContain(GREENLIGHT_INCOMPLETE_HEADLINE);
    expect(out).not.toContain("reason:");
    expect(out).not.toContain("```");
    // The row says nothing about a dismissal having happened, and is written for
    // PRs Green Light never approved, so the body may not assert one.
    expect(GREENLIGHT_REVERTED_BODY).not.toMatch(/dismiss/i);
  });

  it("returns empty for statuses it cannot render", () => {
    expect(render(state({ status: "" }), FRESH_NOW)).toBe("");
    expect(render(state({ status: "SOMETHING_NEW" }), FRESH_NOW)).toBe("");
  });

  it("omits the job link when evalJob is empty or unsafe, keeping the rest", () => {
    const empty = render(state({ evalJob: "" }), FRESH_NOW);
    const unsafe = render(
      state({ evalJob: "https://evil/x) [click](javascript:alert(1)" }),
      FRESH_NOW
    );

    expect(empty).not.toContain("[Inference job]");
    expect(empty).toContain("reason: `clean`");
    expect(unsafe).not.toContain("[Inference job]");
    expect(unsafe).not.toContain("javascript:");
  });

  it("links only a github.com job URL, not a well-formed offsite one", () => {
    const offsite = [
      "https://evil.example.com/x",
      "https://user:pw@github.com/x",
      "https://github.com.evil.example/x",
      "https://github.com@evil.example/x",
      "https://notgithub.com/x",
    ];

    for (const evalJob of offsite) {
      expect(render(state({ evalJob }), FRESH_NOW)).not.toContain(
        "[Inference job]"
      );
    }
    expect(render(state(), FRESH_NOW)).toContain(`[Inference job](${JOB_URL})`);
  });

  it("renders an empty message as a bare fence, keeping reason and sha", () => {
    const out = render(state({ message: "" }), FRESH_NOW);

    expect(out).toContain("```\n\n```");
    expect(out).toContain("reason: `clean`");
    expect(out).toContain("Reviewed commit: `abc1234`");
  });

  it("omits the reviewed commit line when headSha is empty", () => {
    const out = render(state({ headSha: "" }), FRESH_NOW);

    expect(out).not.toContain("Reviewed commit:");
    expect(out).toContain("reason: `clean`");
  });
});

describe("renderGreenlightSection staleness cutoff", () => {
  it("is in progress just under the cutoff and incomplete at it", () => {
    const versionMs = Date.parse("2026-08-24T12:00:00Z");
    const justUnder = new Date(versionMs + GREENLIGHT_IN_PROGRESS_STALE_MS - 1);
    const exactly = new Date(versionMs + GREENLIGHT_IN_PROGRESS_STALE_MS);

    for (const status of IN_FLIGHT_STATUSES) {
      expect(render(state({ status }), justUnder)).toContain(
        GREENLIGHT_REVIEWING_HEADLINE
      );
      expect(render(state({ status }), exactly)).toContain(
        GREENLIGHT_INCOMPLETE_HEADLINE
      );
    }
  });

  // Both directions together pin the zone-less version string to UTC: reading it
  // as host-local time makes the fresh case stale on a UTC+N host and the stale
  // case fresh on a UTC-N host, so this pair fails on any nonzero host offset.
  it("reads the zone-less ClickHouse version as UTC, not host-local", () => {
    const fresh = render(state({ status: "AI_REVIEW_STARTED" }), FRESH_NOW);
    const stale = render(state({ status: "AI_REVIEW_STARTED" }), STALE_NOW);

    expect(fresh).toContain(GREENLIGHT_REVIEWING_HEADLINE);
    expect(stale).toContain(GREENLIGHT_INCOMPLETE_HEADLINE);
  });

  it("also accepts the space-separated ClickHouse form", () => {
    const out = render(
      state({
        status: "AI_REVIEW_STARTED",
        version: "2026-08-24 12:00:00.000",
      }),
      FRESH_NOW
    );

    expect(out).toContain(GREENLIGHT_REVIEWING_HEADLINE);
  });

  it("treats a missing or unparseable version as stalled", () => {
    for (const version of ["", "   ", "not-a-date"]) {
      const out = render(
        state({ status: "AI_REVIEW_STARTED", version }),
        FRESH_NOW
      );
      expect(out).toContain(GREENLIGHT_INCOMPLETE_HEADLINE);
      expect(out).toContain("reason: `stalled`");
    }
  });

  // Date.UTC normalizes even 9999-99-99 into a real (far future) instant, so
  // these parse rather than falling into the unparseable branch above.
  it("treats a version far in the future as stalled, never as a live review", () => {
    for (const version of [
      "9999-99-99T99:99:99",
      "2099-01-01T00:00:00.000000",
    ]) {
      const out = render(
        state({ status: "AI_REVIEW_STARTED", version }),
        FRESH_NOW
      );

      expect(out).toContain(GREENLIGHT_INCOMPLETE_HEADLINE);
      expect(out).toContain("reason: `stalled`");
      expect(out).not.toContain(GREENLIGHT_PENDING_ALT_ATTR);
    }
  });

  it("still reads as live when a clock skew puts the version just ahead of now", () => {
    const skewed = new Date(Date.parse("2026-08-24T12:00:00Z") - 5_000);

    expect(render(state({ status: "AI_REVIEW_STARTED" }), skewed)).toContain(
      GREENLIGHT_REVIEWING_HEADLINE
    );
  });

  it("stalled renders carry no live message or sentinel", () => {
    for (const status of IN_FLIGHT_STATUSES) {
      const out = render(state({ status }), STALE_NOW);

      expect(out).toContain(GREENLIGHT_INCOMPLETE_HEADLINE);
      expect(out).not.toContain("Green Light is reviewing this PR.");
      expect(out).not.toContain(GREENLIGHT_PENDING_ALT_ATTR);
    }
  });
});

describe("renderGreenlightSection pending sentinel", () => {
  it("emits the sentinel for every live in-flight status, and no other", () => {
    for (const status of IN_FLIGHT_STATUSES) {
      expect(render(state({ status }), FRESH_NOW)).toContain(
        GREENLIGHT_PENDING_ALT_ATTR
      );
    }
    for (const status of [...TERMINAL_STATUSES, "REVERTED"]) {
      expect(render(state({ status }), FRESH_NOW)).not.toContain(
        GREENLIGHT_PENDING_ALT_ATTR
      );
    }
  });

  it("places the sentinel outside the fenced region", () => {
    const out = render(state({ status: "AI_REVIEW_STARTED" }), FRESH_NOW);

    expect(out.indexOf(GREENLIGHT_PENDING_ALT_ATTR)).toBeLessThan(
      out.indexOf("<details")
    );
    expect(out).not.toContain("```");
  });

  // The reviewed-commit line is the one rendered value that never reaches the
  // defuse. Nothing about a sha makes that safe -- head_sha is a ClickHouse String
  // like any other -- only its length: seven characters cannot spell the shortest
  // text any sweep predicate matches. Raise the truncation that far and the line
  // becomes a defuse-free path into the raw comment body.
  it("truncates the rendered sha too short to spell a sweep predicate", () => {
    expect(SHORTEST_PENDING_MATCH).toMatch(/\d Pending/);
    expect(SWEEP_PREDICATE_MIN_LENGTH).toBeLessThanOrEqual(
      SHORTEST_PENDING_MATCH.length
    );
    for (const sentinel of SWEEP_SENTINELS) {
      expect(SWEEP_PREDICATE_MIN_LENGTH).toBeLessThanOrEqual(sentinel.length);
    }

    expect(SHORT_SHA_LENGTH).toBeLessThan(SWEEP_PREDICATE_MIN_LENGTH);
  });

  it("strips either forged sentinel out of a terminal message", () => {
    for (const status of ["LAND", "NO_LAND"]) {
      for (const sentinel of SWEEP_SENTINELS) {
        const out = render(
          state({
            status,
            message: `harmless <!-- greenlight ${sentinel} --> text`,
          }),
          FRESH_NOW
        );

        expect(out).not.toContain(sentinel);
        expect(out).toContain("harmless");
        expect(out).toContain("text");
      }
    }
  });

  it("strips a nested forgery of either sentinel that reassembles after one pass", () => {
    const nested = [
      `alt="Green ${GREENLIGHT_PENDING_ALT_ATTR}Light: in progress"`,
      `alt="AI ${ADVISOR_PENDING_ALT_ATTR}verdict: pending"`,
    ];

    for (const message of nested) {
      const out = render(state({ status: "NO_LAND", message }), FRESH_NOW);

      for (const sentinel of SWEEP_SENTINELS) {
        expect(out).not.toContain(sentinel);
      }
    }
  });

  // Removing one sentinel closes the gap it left, so a forgery of another can be
  // hidden across it -- in either direction, and at any seam. The defuse makes one
  // pass in a fixed order, so a splice the second substitution produces is never
  // re-read by the first; what saves it is the zero-width space every substitution
  // leaves behind, and that has to hold whichever sentinel is nested in which.
  it("cannot splice one sentinel together by defusing another, either way round", () => {
    const leaks: string[] = [];
    for (const outer of SWEEP_SENTINELS) {
      for (const inner of SWEEP_SENTINELS) {
        for (let at = 0; at <= outer.length; at++) {
          leaks.push(
            ...sweepLeaks(`${outer.slice(0, at)}${inner}${outer.slice(at)}`)
          );
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  it("strips either forged sentinel out of the reason too", () => {
    for (const sentinel of SWEEP_SENTINELS) {
      const out = render(
        state({ status: "LAND", reason: `clean ${sentinel}` }),
        FRESH_NOW
      );

      expect(out).not.toContain(sentinel);
    }
  });

  // The reason goes through inlineCode, which DELETES backticks and newlines, and
  // a deletion splices the halves on either side together. A predicate broken by
  // exactly one deleted character is invisible to a defuse that runs before the
  // deletion and whole once it has run, so the defuse has to run last. Probing
  // characters the renderer keeps as well as the ones it drops is what makes this
  // still hold if the set it drops grows: inlineCode is shared with shortSha, and
  // hardening it against markup would delete `<` from a reason too.
  it("defuses a predicate that only forms once a deletion splices it", () => {
    const leaks: string[] = [];
    for (const probe of DELETION_PROBES) {
      for (const target of SWEEP_TARGETS) {
        for (let at = 0; at <= target.length; at++) {
          leaks.push(
            ...sweepLeaks(`${target.slice(0, at)}${probe}${target.slice(at)}`)
          );
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  // Those probes are worth only what they cover: a character added to
  // INLINE_BREAKERS_RE but missing from them would go untested, and it is exactly
  // a newly deleted character that reopens the splice.
  it("probes every character the renderer is known to delete", () => {
    const unprobed: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const char = String.fromCharCode(code);
      if (
        char.replace(INLINE_BREAKERS_RE, "") === "" &&
        !DELETION_PROBES.includes(char)
      ) {
        unprobed.push(JSON.stringify(char));
      }
    }

    expect(unprobed).toEqual([]);
    expect(INLINE_BREAKERS.length).toBeGreaterThan(0);
  });

  it("defuses a pending count in the reason that the strip splices together", () => {
    for (const breaker of INLINE_BREAKERS) {
      const out = render(
        state({ status: "NO_LAND", reason: `9 Pen${breaker}ding` }),
        FRESH_NOW
      );

      expect(out).not.toMatch(/\d Pending/);
      expect(out).not.toContain("Pending");
    }
  });

  it("defuses a pending job count, which the sweep matches by accident", () => {
    const out = render(
      state({ status: "LAND", message: "3 Pending checks were still running" }),
      FRESH_NOW
    );

    expect(out).not.toMatch(/\d Pending/);
    expect(out).toContain(`3 P${ZERO_WIDTH_SPACE}ending checks`);
  });

  it("defuses a pending count in the reason too", () => {
    const out = render(
      state({ status: "NO_LAND", reason: "8 Pending" }),
      FRESH_NOW
    );

    expect(out).not.toMatch(/\d Pending/);
  });

  it("defuses a pending count that only appears once a sentinel is stripped", () => {
    const out = render(
      state({
        status: "LAND",
        message: `9 Pen${GREENLIGHT_PENDING_ALT_ATTR}ding jobs`,
      }),
      FRESH_NOW
    );

    expect(out).not.toMatch(/\d Pending/);
    expect(out).not.toContain("Pending");
  });

  it("cannot be tricked into reassembling a pending count while defusing one", () => {
    const out = render(
      state({ status: "LAND", message: "7 PenPendingding" }),
      FRESH_NOW
    );

    expect(out).not.toMatch(/\d Pending/);
    expect(out).not.toContain("Pending");
  });

  // Deleting sentinels instead of substituting them needs a fixpoint loop, which
  // is quadratic: this payload took ~3.5s under one and ~0.5ms without. The
  // budget is deliberately far above the latter so only a return to the loop --
  // not a slow machine -- can trip it.
  it("defuses a deeply nested payload in one pass, not a quadratic loop", () => {
    let nested = "";
    for (let i = 0; i < 20_000; i++) {
      nested = `alt="Green ${nested}Light: in progress"`;
    }

    const started = Date.now();
    const out = render(state({ status: "LAND", message: nested }), FRESH_NOW);
    const elapsedMs = Date.now() - started;

    expect(out).not.toContain(GREENLIGHT_PENDING_ALT_ATTR);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  // Every sweep predicate is a single-line literal, and wrapping only ever puts a
  // newline where a space was -- it never inserts one, so it can neither rebuild a
  // stripped sentinel nor manufacture the space `\d Pending` needs.
  it("leaves every sweep predicate unmatched in a message long enough to wrap", () => {
    const message =
      `${"pad ".repeat(20)}${GREENLIGHT_PENDING_ALT_ATTR} between ` +
      `${ADVISOR_PENDING_ALT_ATTR} ${"tail ".repeat(20)}9 Pending checks`;

    const out = render(state({ status: "LAND", message }), FRESH_NOW);

    for (const sentinel of SWEEP_SENTINELS) {
      expect(out).not.toContain(sentinel);
    }
    expect(out).not.toMatch(/\d Pending/);
    expect(fencedLines(out).length).toBeGreaterThan(1);
  });

  it("keeps a message from breaking out of the fence to forge markup", () => {
    const out = render(
      state({
        status: "NO_LAND",
        message: "``` </p></details> ping @everyone",
      }),
      FRESH_NOW
    );

    // The forged markup stays sealed inside a fence longer than its own
    // backtick run, so it is literal text rather than a structural close.
    expect(out).toContain(
      `\`\`\`\`\n\`\`\` </p></details> ping @${ZERO_WIDTH_SPACE}everyone\n\`\`\`\``
    );
    expect(out.endsWith("</p></details>")).toBe(true);
    expect(out).not.toContain("@everyone");
  });
});

describe("renderGreenlightSection outdated verdict", () => {
  it("marks every status as outdated when the reviewed sha is not the head", () => {
    for (const status of [...TERMINAL_STATUSES, ...IN_FLIGHT_STATUSES]) {
      const out = renderGreenlightSection(
        state({ status }),
        FRESH_NOW,
        OTHER_SHA
      );

      expect(out).toContain(GREENLIGHT_OUTDATED_HEADLINE_PREFIX);
      expect(out).toContain(
        "Reviewed commit: `abc1234` (NOT the current head `def4567`)"
      );
    }
  });

  // The section is collapsed, so a marker anywhere but the summary is one the
  // reader has to expand the block to find -- which is the one thing it exists to
  // prevent.
  it("keeps the verdict headline in the summary, behind the outdated marker", () => {
    const out = renderGreenlightSection(state(), FRESH_NOW, OTHER_SHA);

    expect(summaryLine(out)).toContain(
      `${GREENLIGHT_OUTDATED_HEADLINE_PREFIX}${GREENLIGHT_LAND_HEADLINE}`
    );
  });

  // The one status the marker must never reach. A revert stands whatever is
  // pushed next, so calling it outdated once the author fixes the PR reads as an
  // invitation to wait for the re-review that greenlight will never run -- and
  // the reviewed-commit line, which says the same thing in longer form below the
  // fold, has to go with it.
  it("never marks REVERTED outdated, however far the head has moved on", () => {
    const out = renderGreenlightSection(
      state({ status: "REVERTED" }),
      FRESH_NOW,
      OTHER_SHA
    );

    expect(out).toContain(GREENLIGHT_REVERTED_HEADLINE);
    expect(out).not.toContain(GREENLIGHT_OUTDATED_HEADLINE_PREFIX);
    expect(out).not.toContain("Reviewed commit:");
    expect(out).not.toContain("NOT the current head");
  });

  it("leaves a verdict on the current head unmarked", () => {
    const out = renderGreenlightSection(state(), FRESH_NOW, REVIEWED_SHA);

    expect(out).not.toContain(GREENLIGHT_OUTDATED_HEADLINE_PREFIX);
    expect(out).toContain("Reviewed commit: `abc1234`");
    expect(out).not.toContain("NOT the current head");
  });

  it("compares case-insensitively and ignores surrounding whitespace", () => {
    const out = renderGreenlightSection(
      state(),
      FRESH_NOW,
      `  ${REVIEWED_SHA.toUpperCase()}  `
    );

    expect(out).not.toContain(GREENLIGHT_OUTDATED_HEADLINE_PREFIX);
  });

  it("compares the whole sha, not the seven-character display prefix", () => {
    const out = renderGreenlightSection(
      state(),
      FRESH_NOW,
      "abc1234fffffffffffffffffffffffffffffffff"
    );

    expect(out).toContain(GREENLIGHT_OUTDATED_HEADLINE_PREFIX);
  });

  it("stays unmarked when either sha is missing, since it cannot tell", () => {
    expect(renderGreenlightSection(state(), FRESH_NOW, "")).not.toContain(
      GREENLIGHT_OUTDATED_HEADLINE_PREFIX
    );
    expect(
      renderGreenlightSection(state({ headSha: "" }), FRESH_NOW, OTHER_SHA)
    ).not.toContain(GREENLIGHT_OUTDATED_HEADLINE_PREFIX);
  });
});
