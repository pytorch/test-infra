// The commit page's GreenLight hook: when it asks the API for a commit's
// verdict, when it asks again, and what it hands the header for each answer
// and for none. The API is a fetch stub whose requests are answered by hand,
// and the clock is the test's, so a minute passes when the test says so.

import type {
  CommitGreenlight,
  GreenlightVerdict,
  NoVerdictReason,
} from "lib/api/tests/commit/greenlight/types";
import { GREENLIGHT_IN_PROGRESS_STALE_MS } from "lib/greenlight/greenlightStaleness";
import { REVIEWING_REFRESH_MS } from "lib/tests/greenlight";
import { useCommitGreenlight } from "lib/tests/useCommitGreenlight";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { SWRConfig } from "swr";

const REPO = "pytorch/pytorch";
const SHA = "573c889f49603f0bd8d0033ef6a49e3016d863d3";
const OTHER_SHA = "841ef2a4d54042f2f2c8930627d799c94cba4ad0";
const NOW_MS = Date.parse("2026-11-10T17:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function verdictOf(overrides: Partial<GreenlightVerdict> = {}) {
  const verdict: GreenlightVerdict = {
    status: "NO_LAND",
    reason: "not_trivial",
    message: "- Triviality\n  - Four separate rewrites",
    pull_request_number: 204150,
    head_sha: SHA,
    updated_at: new Date(NOW_MS - 5 * MINUTE_MS).toISOString(),
    job_url: null,
    ...overrides,
  };
  return verdict;
}

// A review that began the given number of minutes before the test's clock
// was set.
function inFlight(minutesAgo: number): GreenlightVerdict {
  return verdictOf({
    status: "AI_REVIEW_STARTED",
    reason: "",
    message: "",
    updated_at: new Date(NOW_MS - minutesAgo * MINUTE_MS).toISOString(),
  });
}

interface Request {
  url: string;
  // The endpoint's answer: a verdict, or why there is none.
  answer: (_found: GreenlightVerdict | NoVerdictReason) => Promise<void>;
  fail: (_status: number) => Promise<void>;
}

// A fetch that records each request and lets the test answer it. Each
// answer carries its own duration, as the API's do.
function stubFetch(): Request[] {
  const requests: Request[] = [];
  global.fetch = jest.fn(
    (input: string | URL | globalThis.Request) =>
      new Promise<Response>((resolve) => {
        const settle = async (status: number, body: unknown) => {
          await act(async () => {
            resolve(new Response(JSON.stringify(body), { status }));
          });
        };
        const answered = (
          found: GreenlightVerdict | NoVerdictReason
        ): CommitGreenlight => ({
          verdict: typeof found === "string" ? null : found,
          no_verdict_reason: typeof found === "string" ? found : null,
          hud_url: `https://hud.pytorch.org/tests/${REPO}/commit/${SHA}`,
          query_duration_ms: 700 + requests.length,
        });
        requests.push({
          url: String(input),
          answer: (found) => settle(200, answered(found)),
          fail: (status) =>
            settle(status, { error: "Failed", code: "internal_error" }),
        });
      })
  ) as unknown as typeof fetch;
  return requests;
}

describe("useCommitGreenlight", () => {
  let renderer: ReactTestRenderer | undefined;
  let requests: Request[] = [];

  beforeEach(() => {
    // The clock and the timers are the test's; what React and the fetch
    // stub wait on between them is left real.
    jest.useFakeTimers({
      now: NOW_MS,
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    requests = stubFetch();
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    jest.useRealTimers();
  });

  // Renders the hook, under a cache of its own, and keeps its latest result
  // where the test can read it.
  function mount(repo: string | undefined, sha: string | undefined) {
    let result!: ReturnType<typeof useCommitGreenlight>;
    function Harness(props: { repo?: string; sha?: string }) {
      result = useCommitGreenlight(props.repo, props.sha);
      return null;
    }
    const tree = (
      nextRepo: string | undefined,
      nextSha: string | undefined
    ) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <Harness repo={nextRepo} sha={nextSha} />
      </SWRConfig>
    );
    act(() => {
      renderer = create(tree(repo, sha));
    });
    return {
      get state() {
        return result;
      },
      // The verdict's status, when the state is a verdict.
      get status() {
        return result?.kind === "verdict" ? result.verdict.status : undefined;
      },
      update(nextRepo: string | undefined, nextSha: string | undefined) {
        act(() => renderer!.update(tree(nextRepo, nextSha)));
      },
    };
  }
  const pass = (milliseconds: number) =>
    act(async () => {
      jest.advanceTimersByTime(milliseconds);
    });

  test("asks nothing, and has nothing to show, until the repository and the commit are known", () => {
    const hook = mount(undefined, undefined);
    hook.update(REPO, undefined);
    expect(requests).toHaveLength(0);
    expect(hook.state).toBeNull();
    hook.update(REPO, SHA);
    expect(requests.map((request) => request.url)).toEqual([
      `/api/tests/commit/${SHA}/greenlight?repo=pytorch%2Fpytorch`,
    ]);
    // Asked: the header holds the pill's place.
    expect(hook.state).toEqual({ kind: "loading" });
  });

  test("asks nothing for a repository GreenLight does not review, which gets no pill", async () => {
    const hook = mount("pytorch/vision", SHA);
    await pass(HOUR_MS);
    expect(requests).toHaveLength(0);
    expect(hook.state).toBeNull();
    // The repository's name is GitHub's, in whatever case.
    hook.update("PyTorch/PyTorch", SHA);
    expect(requests).toHaveLength(1);
  });

  test("a verdict is asked for once", async () => {
    const hook = mount(REPO, SHA);
    await requests[0].answer(verdictOf());
    expect(hook.state).toEqual({ kind: "verdict", verdict: verdictOf() });
    await pass(HOUR_MS);
    expect(requests).toHaveLength(1);
  });

  test.each([["not_reviewed"], ["no_pull_request"]] as const)(
    "a commit with no verdict (%s) is asked about once, and says why it has none",
    async (reason) => {
      const hook = mount(REPO, SHA);
      await requests[0].answer(reason);
      expect(hook.state).toEqual({ kind: "no_verdict", reason });
      await pass(HOUR_MS);
      expect(requests).toHaveLength(1);
    }
  );

  test("a commit HUD does not know gets no pill", async () => {
    const hook = mount(REPO, SHA);
    await requests[0].answer("unknown_commit");
    expect(hook.state).toBeNull();
  });

  test("a review in flight is asked about each minute, until its verdict lands", async () => {
    const hook = mount(REPO, SHA);
    await requests[0].answer(inFlight(5));
    expect(hook.status).toBe("AI_REVIEW_STARTED");

    await pass(REVIEWING_REFRESH_MS - 1);
    expect(requests).toHaveLength(1);
    await pass(1);
    expect(requests).toHaveLength(2);
    // Still in flight: asked again a minute after that answer.
    await requests[1].answer(inFlight(5));
    await pass(REVIEWING_REFRESH_MS);
    expect(requests).toHaveLength(3);
    expect(requests[2].url).toBe(requests[0].url);

    await requests[2].answer(verdictOf({ status: "LAND", reason: "clean" }));
    expect(hook.status).toBe("LAND");
    await pass(HOUR_MS);
    expect(requests).toHaveLength(3);
  });

  test("a review that stalled is no longer asked about", async () => {
    const hook = mount(REPO, SHA);
    // Two minutes short of the hour after which a review in flight is one
    // that did not complete.
    const started = GREENLIGHT_IN_PROGRESS_STALE_MS / MINUTE_MS - 2;
    await requests[0].answer(inFlight(started));
    await pass(MINUTE_MS);
    expect(requests).toHaveLength(2);
    await requests[1].answer(inFlight(started));
    await pass(MINUTE_MS);
    expect(requests).toHaveLength(3);
    // The hour is up as this answer arrives.
    await requests[2].answer(inFlight(started));
    expect(hook.status).toBe("AI_REVIEW_STARTED");
    await pass(HOUR_MS);
    expect(requests).toHaveLength(3);
  });

  test("a review found already stalled is asked about once", async () => {
    mount(REPO, SHA);
    await requests[0].answer(inFlight(90));
    await pass(HOUR_MS);
    expect(requests).toHaveLength(1);
  });

  test("another commit's verdict is never shown while its own is on its way", async () => {
    const hook = mount(REPO, SHA);
    await requests[0].answer(verdictOf());
    hook.update(REPO, OTHER_SHA);
    expect(hook.state).toEqual({ kind: "loading" });
    expect(requests[1].url).toBe(
      `/api/tests/commit/${OTHER_SHA}/greenlight?repo=pytorch%2Fpytorch`
    );
    await requests[1].answer(
      verdictOf({ status: "LAND", reason: "clean", head_sha: OTHER_SHA })
    );
    expect(hook.state).toMatchObject({
      kind: "verdict",
      verdict: { head_sha: OTHER_SHA },
    });
  });

  test("a review in flight on one commit does not keep another asked about", async () => {
    const hook = mount(REPO, SHA);
    await requests[0].answer(inFlight(5));
    hook.update(REPO, OTHER_SHA);
    await requests[1].answer("not_reviewed");
    await pass(HOUR_MS);
    expect(requests).toHaveLength(2);
  });

  test("a failure is said, and asked about again only when the reader asks", async () => {
    const hook = mount(REPO, SHA);
    // A refusal, which is not asked again by itself.
    await requests[0].fail(403);
    expect(hook.state).toMatchObject({
      kind: "unavailable",
      error: { status: 403, info: "Failed" },
    });
    await pass(HOUR_MS);
    expect(requests).toHaveLength(1);

    // The reader's Retry: asked again, the pill's place held meanwhile.
    const { state } = hook;
    await act(async () => {
      if (state?.kind === "unavailable") state.retry();
    });
    expect(requests).toHaveLength(2);
    expect(hook.state).toEqual({ kind: "loading" });
    await requests[1].answer(verdictOf());
    expect(hook.status).toBe("NO_LAND");
  });

  test("a refresh that fails leaves the verdict it had", async () => {
    const hook = mount(REPO, SHA);
    await requests[0].answer(inFlight(5));
    await pass(REVIEWING_REFRESH_MS);
    expect(requests).toHaveLength(2);
    await requests[1].fail(500);
    expect(hook.status).toBe("AI_REVIEW_STARTED");
  });
});
