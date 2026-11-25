// The figures hook of the tests page: when it asks GET /api/tests/summary,
// what it hands the band while the answer is on its way and after it fails,
// and when it asks again because the table has come to show a later health
// refresh than the figures were read at. The API is a fetch stub whose
// requests are answered by hand, and the clock is the test's.

import type { TestSummary } from "lib/api/tests/summary/types";
import { figuresBehind, useTestsSummary } from "lib/tests/useTestsSummary";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { SWRConfig } from "swr";

const REPO = "pytorch/pytorch";
// Three health refreshes, a quarter of an hour apart.
const FIRST = "2026-11-24T10:00:00Z";
const SECOND = "2026-11-24T10:15:00Z";
const THIRD = "2026-11-24T10:30:00Z";
const HOUR_MS = 60 * 60 * 1000;

// A summary read at the given refresh; the hook reads its refresh only.
function summaryAt(refreshedAt: string | null, unhealthy = 20): TestSummary {
  return {
    views: [
      {
        id: "unhealthy",
        kind: "count",
        window: "12h",
        count: unhealthy,
        duration_milliseconds: null,
        test: null,
        hud_url: null,
      },
    ],
    hud_url: null,
    refreshed_at: refreshedAt,
    query_duration_ms: 12,
  };
}

interface Request {
  url: string;
  answer: (_summary: TestSummary) => Promise<void>;
  fail: (_status: number) => Promise<void>;
}

// A fetch that records each request and lets the test answer it.
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
        requests.push({
          url: String(input),
          answer: (summary) => settle(200, summary),
          fail: (status) =>
            settle(status, {
              error: "Failed to summarize the tests",
              code: "internal_error",
            }),
        });
      })
  ) as unknown as typeof fetch;
  return requests;
}

type Props = Parameters<typeof useTestsSummary>[0];
const TWELVE_HOURS: Props["query"] = { window: "12h", languages: [] };

describe("figuresBehind", () => {
  test("is so only when the figures were read at an earlier refresh than the table's", () => {
    expect(figuresBehind(FIRST, SECOND)).toBe(true);
    expect(figuresBehind(SECOND, SECOND)).toBe(false);
    expect(figuresBehind(THIRD, SECOND)).toBe(false);
    // The same instant, spelled as the two endpoints may each spell it.
    expect(figuresBehind("2026-11-24T10:15:00.000Z", SECOND)).toBe(false);
  });

  test("is not so while either refresh is unknown", () => {
    // No summary yet, a summary of an empty health table, no page yet.
    expect(figuresBehind(undefined, SECOND)).toBe(false);
    expect(figuresBehind(null, SECOND)).toBe(false);
    expect(figuresBehind(FIRST, null)).toBe(false);
    expect(figuresBehind(undefined, null)).toBe(false);
  });
});

describe("useTestsSummary", () => {
  let renderer: ReactTestRenderer | undefined;
  let requests: Request[] = [];

  beforeEach(() => {
    // The timers are the test's, so SWR's own retries after a failure run
    // when the test says; what React and the fetch stub wait on is real.
    jest.useFakeTimers({
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
  function mount(props: Props) {
    let result!: ReturnType<typeof useTestsSummary>;
    function Harness(current: Props) {
      result = useTestsSummary(current);
      return null;
    }
    const tree = (current: Props) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <Harness {...current} />
      </SWRConfig>
    );
    act(() => {
      renderer = create(tree(props));
    });
    return {
      get result() {
        return result;
      },
      update(next: Props) {
        act(() => renderer!.update(tree(next)));
      },
    };
  }
  const pass = (milliseconds: number) =>
    act(async () => {
      jest.advanceTimersByTime(milliseconds);
    });
  const urls = () => requests.map((request) => request.url);

  test("asks nothing until the repository and the query are known, and holds the figures' places", () => {
    const hook = mount({
      repo: undefined,
      query: undefined,
      refreshedAt: null,
    });
    expect(hook.result).toMatchObject({ summary: undefined, loading: true });
    hook.update({ repo: REPO, query: undefined, refreshedAt: null });
    hook.update({ repo: undefined, query: TWELVE_HOURS, refreshedAt: null });
    expect(requests).toHaveLength(0);
    expect(hook.result.loading).toBe(true);
    expect(hook.result.error).toBeUndefined();
  });

  test("asks for the window and the languages, and hands on the answer", async () => {
    const hook = mount({
      repo: REPO,
      query: { window: "7d", languages: ["python", "cpp"] },
      refreshedAt: null,
    });
    expect(urls()).toEqual([
      "/api/tests/summary?repo=pytorch%2Fpytorch&window=7d&language=python&language=cpp",
    ]);
    expect(hook.result).toMatchObject({ summary: undefined, loading: true });

    await requests[0].answer(summaryAt(FIRST));
    expect(hook.result.summary).toEqual(summaryAt(FIRST));
    expect(hook.result.loading).toBe(false);
    expect(hook.result.error).toBeUndefined();
    // Asked once: the figures are not polled.
    await pass(HOUR_MS);
    expect(requests).toHaveLength(1);
  });

  test("asks once for what the reader chooses, whatever a view then sets", async () => {
    const hook = mount({ repo: REPO, query: TWELVE_HOURS, refreshedAt: null });
    await requests[0].answer(summaryAt(FIRST));
    // Choosing a view changes the query's sort, sources and filters, which
    // the figures do not depend on: the query is another object, the request
    // the same.
    const chosen = {
      window: "12h" as const,
      languages: [],
      sort: "-flaky_runs,-flaky_rate",
      ranOn: ["pull_request"],
    };
    hook.update({ repo: REPO, query: chosen, refreshedAt: null });
    expect(requests).toHaveLength(1);
    expect(hook.result.summary).toEqual(summaryAt(FIRST));
  });

  test("asks again for another window, and shows none of the first window's figures under it", async () => {
    const hook = mount({ repo: REPO, query: TWELVE_HOURS, refreshedAt: null });
    await requests[0].answer(summaryAt(FIRST, 20));

    hook.update({
      repo: REPO,
      query: { window: "7d", languages: [] },
      refreshedAt: null,
    });
    expect(urls()[1]).toBe(
      "/api/tests/summary?repo=pytorch%2Fpytorch&window=7d"
    );
    expect(hook.result).toMatchObject({ summary: undefined, loading: true });
    await requests[1].answer(summaryAt(FIRST, 86));
    expect(hook.result.summary?.views[0].count).toBe(86);

    // Back to the first window: its figures are shown at once, from the
    // cache, while SWR checks them.
    hook.update({ repo: REPO, query: TWELVE_HOURS, refreshedAt: null });
    expect(hook.result.summary?.views[0].count).toBe(20);
    expect(hook.result.loading).toBe(false);
  });

  test("asks again when the table shows a later refresh than the figures were read at", async () => {
    const hook = mount({ repo: REPO, query: TWELVE_HOURS, refreshedAt: null });
    await requests[0].answer(summaryAt(FIRST, 20));
    // The table's first page is of the same refresh: nothing to ask.
    hook.update({ repo: REPO, query: TWELVE_HOURS, refreshedAt: FIRST });
    expect(requests).toHaveLength(1);

    // The page stays open; the reader chooses a view, and the table's new
    // rows are of the next refresh.
    hook.update({ repo: REPO, query: TWELVE_HOURS, refreshedAt: SECOND });
    expect(urls()).toEqual([
      "/api/tests/summary?repo=pytorch%2Fpytorch&window=12h",
      "/api/tests/summary?repo=pytorch%2Fpytorch&window=12h",
    ]);
    // The figures shown stay until the new ones arrive, with no error.
    expect(hook.result.summary).toEqual(summaryAt(FIRST, 20));
    expect(hook.result.loading).toBe(false);
    expect(hook.result.error).toBeUndefined();

    await requests[1].answer(summaryAt(SECOND, 23));
    expect(hook.result.summary).toEqual(summaryAt(SECOND, 23));
    // Level with the table again: nothing more to ask.
    hook.update({ repo: REPO, query: TWELVE_HOURS, refreshedAt: SECOND });
    await pass(HOUR_MS);
    expect(requests).toHaveLength(2);
  });

  test("asks once for a refresh, even when the answer is still behind it", async () => {
    const hook = mount({ repo: REPO, query: TWELVE_HOURS, refreshedAt: FIRST });
    await requests[0].answer(summaryAt(FIRST));
    hook.update({ repo: REPO, query: TWELVE_HOURS, refreshedAt: SECOND });
    expect(requests).toHaveLength(2);
    // The summary's server has not seen the refresh the table's did.
    await requests[1].answer(summaryAt(FIRST));
    hook.update({ repo: REPO, query: TWELVE_HOURS, refreshedAt: SECOND });
    await pass(HOUR_MS);
    expect(requests).toHaveLength(2);

    // The next refresh the table shows is asked for in its turn.
    hook.update({ repo: REPO, query: TWELVE_HOURS, refreshedAt: THIRD });
    expect(requests).toHaveLength(3);
    await requests[2].answer(summaryAt(THIRD));
    expect(hook.result.summary?.refreshed_at).toBe(THIRD);
    expect(requests).toHaveLength(3);
  });

  test("does not ask again while the table is at the figures' refresh, before it, or between pages", async () => {
    const hook = mount({ repo: REPO, query: TWELVE_HOURS, refreshedAt: null });
    await requests[0].answer(summaryAt(SECOND));
    for (const refreshedAt of [null, FIRST, SECOND, null]) {
      hook.update({ repo: REPO, query: TWELVE_HOURS, refreshedAt });
    }
    expect(requests).toHaveLength(1);
  });

  test("a failure costs the figures and says so, and Retry asks again", async () => {
    const hook = mount({ repo: REPO, query: TWELVE_HOURS, refreshedAt: null });
    // The sign-in refused: the API's verdict, which would only repeat.
    await requests[0].fail(403);
    expect(hook.result.summary).toBeUndefined();
    expect(hook.result.loading).toBe(false);
    expect(hook.result.error).toMatchObject({
      status: 403,
      info: "Failed to summarize the tests",
    });
    await pass(HOUR_MS);
    expect(requests).toHaveLength(1);

    act(() => hook.result.retry());
    expect(requests).toHaveLength(2);
    // On its way: the error is put away.
    expect(hook.result.error).toBeUndefined();
    await requests[1].answer(summaryAt(FIRST));
    expect(hook.result.summary).toEqual(summaryAt(FIRST));
    expect(hook.result.error).toBeUndefined();
  });

  test("a failure of the server is asked about again on its own", async () => {
    const hook = mount({ repo: REPO, query: TWELVE_HOURS, refreshedAt: null });
    await requests[0].fail(500);
    expect(hook.result.error).toMatchObject({ status: 500 });
    expect(requests).toHaveLength(1);
    // SWR's first retry is some seconds on.
    await pass(60 * 1000);
    expect(requests).toHaveLength(2);
    await requests[1].answer(summaryAt(FIRST));
    expect(hook.result.summary).toEqual(summaryAt(FIRST));
    expect(hook.result.error).toBeUndefined();
  });
});
