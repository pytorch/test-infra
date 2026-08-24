import { ADVISOR_PENDING_ALT_ATTR } from "lib/advisor/advisorBadge";
import {
  defangGreenlightMessage,
  GREENLIGHT_IN_PROGRESS_STALE_MS,
  GREENLIGHT_INCOMPLETE_HEADLINE,
  GREENLIGHT_LAND_HEADLINE,
  GREENLIGHT_MESSAGE_CAP,
  GREENLIGHT_NO_LAND_HEADLINE,
  GREENLIGHT_OUTDATED_HEADLINE_PREFIX,
  GREENLIGHT_PENDING_ALT_ATTR,
  GREENLIGHT_REVIEWING_HEADLINE,
  GreenlightState,
  renderGreenlightSection,
} from "lib/greenlight/greenlightRender";

const ZERO_WIDTH_SPACE = "\u200b";
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
// Both raw-body sentinels getPRsNeedingCommentRefresh pins a PR on, either of
// which a model-authored message can spell out literally.
const SWEEP_SENTINELS = [GREENLIGHT_PENDING_ALT_ATTR, ADVISOR_PENDING_ALT_ATTR];

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

// Default the PR's current head to the reviewed commit, so only the tests that
// care about a superseded verdict have to mention a second sha.
function render(
  s: GreenlightState,
  now: Date,
  currentHeadSha: string = s.headSha
): string {
  return renderGreenlightSection(s, now, currentHeadSha);
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

describe("renderGreenlightSection statuses", () => {
  it("renders LAND with headline, message, reason, sha and job link", () => {
    const out = render(state(), FRESH_NOW);

    expect(out).toContain("<details open><summary><b>GREEN LIGHT</b>");
    expect(out).toContain(GREENLIGHT_LAND_HEADLINE);
    expect(out).toContain("Looks good.");
    expect(out).toContain("reason: `clean`");
    expect(out).toContain("Reviewed commit: `abc1234`");
    expect(out).toContain(`[Inference job](${JOB_URL})`);
    expect(out).toContain("</p></details>");
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
    for (const status of ["LAND", "NO_LAND", "CANCELLED", "FAILED"]) {
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

  // Removing one sentinel closes the gap it left, so a forgery of the other can
  // be hidden across it -- the strip has to keep going until no sentinel of any
  // kind remains, not just re-run for each in turn.
  it("strips an advisor sentinel spliced together by removing a greenlight one", () => {
    const out = render(
      state({
        status: "LAND",
        message: `alt="AI ver${GREENLIGHT_PENDING_ALT_ATTR}dict: pending"`,
      }),
      FRESH_NOW
    );

    for (const sentinel of SWEEP_SENTINELS) {
      expect(out).not.toContain(sentinel);
    }
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

  it("keeps the verdict headline, behind the outdated marker", () => {
    const out = renderGreenlightSection(state(), FRESH_NOW, OTHER_SHA);

    expect(out).toContain(
      `${GREENLIGHT_OUTDATED_HEADLINE_PREFIX}${GREENLIGHT_LAND_HEADLINE}`
    );
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
