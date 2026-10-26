// The listing hook: how it walks the API's cursor chain, what it shows while
// a page is on its way, what it keeps and what it drops. The API is a fetch
// stub whose requests are answered by hand, one at a time.

import type { TestHealthEntry, TestListPage } from "lib/api/tests/types";
import { noFacetValues } from "lib/tests/facets";
import { DEFAULT_TESTS_SORT, TestsQuery } from "lib/tests/table";
import {
  RETRY_DELAYS_MS,
  TestsListing,
  useTestsListing,
} from "lib/tests/useTestsListing";
import { act, create, ReactTestRenderer } from "react-test-renderer";

const query: TestsQuery = {
  sort: DEFAULT_TESTS_SORT,
  window: "12h",
  ranOn: ["main"],
  languages: [],
  filters: noFacetValues(),
  search: "",
};

// A page of entries with the given test ids; the hook reads only the
// entries' number, the next link, the refresh time and the query's duration.
function page(
  ids: string[],
  next: string | null = null,
  queryDurationMs = 1
): TestListPage {
  return {
    tests: ids.map((id) => ({ test: { id } } as unknown as TestHealthEntry)),
    pagination: {
      next: next === null ? null : { cursor: next, url: `?cursor=${next}` },
      previous: null,
    },
    refreshed_at: "2026-10-25T12:00:00Z",
    query_duration_ms: queryDurationMs,
  };
}

interface Request {
  url: URL;
  aborted: () => boolean;
  answer: (_page: TestListPage) => Promise<void>;
  fail: (_status: number, _body: unknown) => Promise<void>;
  // The connection fails: fetch rejects with a TypeError.
  drop: () => Promise<void>;
}

// A fetch that records each request and lets the test answer it. An aborted
// request rejects as fetch would.
function stubFetch(): Request[] {
  const requests: Request[] = [];
  global.fetch = jest.fn(
    (input: string | URL | globalThis.Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal ?? null;
        signal?.addEventListener("abort", () =>
          reject(new DOMException("The request was aborted", "AbortError"))
        );
        const settle = (response: Response) => async () => {
          await act(async () => {
            resolve(response);
          });
        };
        requests.push({
          url: new URL(String(input), "http://hud"),
          aborted: () => signal?.aborted ?? false,
          answer: (body) =>
            settle(new Response(JSON.stringify(body), { status: 200 }))(),
          fail: (status, body) =>
            settle(new Response(JSON.stringify(body), { status }))(),
          drop: async () => {
            await act(async () => {
              reject(new TypeError("Failed to fetch"));
            });
          },
        });
      })
  ) as unknown as typeof fetch;
  return requests;
}

interface HarnessProps {
  repo: string | undefined;
  query: TestsQuery | undefined;
  pending?: boolean;
}

// Renders the hook and keeps its latest result where the test can read it.
function mount(props: HarnessProps) {
  let listing!: TestsListing;
  function Harness(current: HarnessProps) {
    listing = useTestsListing(current);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness {...props} />);
  });
  return {
    get listing() {
      return listing;
    },
    update(next: HarnessProps) {
      act(() => {
        renderer.update(<Harness {...next} />);
      });
    },
    turn(model: { page: number; pageSize: number }) {
      act(() => {
        listing.onPaginationModelChange(model);
      });
    },
  };
}

const ids = (listing: TestsListing) =>
  listing.entries.map((entry) => entry.test.id);

describe("useTestsListing", () => {
  let requests: Request[];
  beforeEach(() => {
    requests = stubFetch();
  });

  test("asks for the first page and shows it when it arrives", async () => {
    const hook = mount({ repo: "pytorch/pytorch", query });
    expect(hook.listing.loading).toBe(true);
    expect(hook.listing.entries).toEqual([]);
    expect(hook.listing.rowCount).toBe(-1);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.pathname).toBe("/api/tests");
    expect(requests[0].url.searchParams.get("limit")).toBe("25");
    expect(requests[0].url.searchParams.has("cursor")).toBe(false);

    await requests[0].answer(page(["1", "2"], "c2"));
    expect(hook.listing.loading).toBe(false);
    expect(ids(hook.listing)).toEqual(["1", "2"]);
    expect(hook.listing.refreshedAt).toBe("2026-10-25T12:00:00Z");
    expect(hook.listing.paginationModel).toEqual({ page: 0, pageSize: 25 });
    // Another page follows, so the count is unknown and next is enabled.
    expect(hook.listing.rowCount).toBe(-1);
    expect(hook.listing.hasNextPage).toBe(true);
  });

  test("times each page from asking for it to its arrival, says nothing while a page is on its way, and keeps a cached page's time", async () => {
    // The hook's clock, moved by hand.
    let now = 1000;
    const clock = jest.spyOn(performance, "now").mockImplementation(() => now);
    const hook = mount({ repo: "pytorch/pytorch", query });
    expect(hook.listing.timing).toBeNull();
    now += 5214;
    await requests[0].answer(page(["1", "2"], "c2", 4890));
    expect(hook.listing.timing).toEqual({
      elapsedMs: 5214,
      queryDurationMs: 4890,
    });

    hook.turn({ page: 1, pageSize: 25 });
    expect(hook.listing.timing).toBeNull();
    now += 300;
    await requests[1].answer(page(["3"], null, 250));
    expect(hook.listing.timing).toEqual({
      elapsedMs: 300,
      queryDurationMs: 250,
    });

    // The first page again, from the cache: what its request took.
    hook.turn({ page: 0, pageSize: 25 });
    expect(requests).toHaveLength(2);
    expect(hook.listing.timing).toEqual({
      elapsedMs: 5214,
      queryDurationMs: 4890,
    });
    clock.mockRestore();
  });

  test("fetches nothing until the repository and the query are known", () => {
    const hook = mount({ repo: undefined, query });
    expect(requests).toHaveLength(0);
    expect(hook.listing.loading).toBe(true);
    hook.update({ repo: "pytorch/pytorch", query: undefined });
    expect(requests).toHaveLength(0);
    hook.update({ repo: "pytorch/pytorch", query });
    expect(requests).toHaveLength(1);
  });

  test("turns pages by cursor, keeping the rows shown while the next loads, and counts exactly at the end", async () => {
    const hook = mount({ repo: "pytorch/pytorch", query });
    await requests[0].answer(page(["1", "2"], "c2"));

    hook.turn({ page: 1, pageSize: 25 });
    expect(requests).toHaveLength(2);
    expect(requests[1].url.searchParams.get("cursor")).toBe("c2");
    // The first page stays under the progress bar.
    expect(hook.listing.loading).toBe(true);
    expect(ids(hook.listing)).toEqual(["1", "2"]);
    expect(hook.listing.paginationModel.page).toBe(1);

    await requests[1].answer(page(["3"]));
    expect(hook.listing.loading).toBe(false);
    expect(ids(hook.listing)).toEqual(["3"]);
    // The last page: 25 on the first page and 1 here.
    expect(hook.listing.rowCount).toBe(26);
    expect(hook.listing.hasNextPage).toBe(false);
  });

  test("returns to a visited page from its cache, without a request", async () => {
    const hook = mount({ repo: "pytorch/pytorch", query });
    await requests[0].answer(page(["1", "2"], "c2"));
    hook.turn({ page: 1, pageSize: 25 });
    await requests[1].answer(page(["3"]));

    hook.turn({ page: 0, pageSize: 25 });
    expect(requests).toHaveLength(2);
    expect(hook.listing.loading).toBe(false);
    expect(ids(hook.listing)).toEqual(["1", "2"]);
    expect(hook.listing.paginationModel.page).toBe(0);
    expect(hook.listing.hasNextPage).toBe(true);
  });

  test("ignores a page turn while a page is loading", async () => {
    const hook = mount({ repo: "pytorch/pytorch", query });
    hook.turn({ page: 1, pageSize: 25 });
    expect(requests).toHaveLength(1);
    expect(hook.listing.paginationModel.page).toBe(0);
  });

  test("starts a new query from its first page, with nothing shown, and abandons the request on its way", async () => {
    const hook = mount({ repo: "pytorch/pytorch", query });
    await requests[0].answer(page(["1", "2"], "c2"));
    hook.turn({ page: 1, pageSize: 25 });
    expect(requests[1].aborted()).toBe(false);

    const narrower = { ...query, search: "conv" };
    hook.update({ repo: "pytorch/pytorch", query: narrower });
    // The page-two request is dropped and the new query starts over.
    expect(requests[1].aborted()).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[2].url.searchParams.get("search")).toBe("conv");
    expect(requests[2].url.searchParams.has("cursor")).toBe(false);
    expect(hook.listing.paginationModel.page).toBe(0);
    // The old rows no longer answer the query: the skeleton shows instead.
    expect(hook.listing.loading).toBe(true);
    expect(hook.listing.entries).toEqual([]);
    // The refresh time does not depend on the query, so the caption keeps it.
    expect(hook.listing.refreshedAt).toBe("2026-10-25T12:00:00Z");
    // The load time is the new page's, once it arrives.
    expect(hook.listing.timing).toBeNull();

    await requests[2].answer(page(["9"]));
    expect(ids(hook.listing)).toEqual(["9"]);
    expect(hook.listing.rowCount).toBe(1);
  });

  test("fetches nothing while a search is being typed, and drops the request it had", async () => {
    const hook = mount({ repo: "pytorch/pytorch", query });
    hook.update({ repo: "pytorch/pytorch", query, pending: true });
    expect(requests[0].aborted()).toBe(true);
    expect(requests).toHaveLength(1);
    expect(hook.listing.loading).toBe(true);
    expect(hook.listing.entries).toEqual([]);

    const typed = { ...query, search: "nn" };
    hook.update({ repo: "pytorch/pytorch", query: typed, pending: false });
    expect(requests).toHaveLength(2);
    expect(requests[1].url.searchParams.get("search")).toBe("nn");
  });

  test("shows the API's error, empties the rows and counts none", async () => {
    const hook = mount({ repo: "pytorch/pytorch", query });
    await requests[0].fail(400, { error: "repo must be owner/name" });
    expect(hook.listing.loading).toBe(false);
    expect(hook.listing.entries).toEqual([]);
    expect(hook.listing.error).toMatchObject({
      status: 400,
      info: "repo must be owner/name",
    });
    expect(hook.listing.rowCount).toBe(0);
    expect(hook.listing.hasNextPage).toBe(false);
    expect(hook.listing.timing).toBeNull();
  });

  test("starts over at the first page with a new page size", async () => {
    const hook = mount({ repo: "pytorch/pytorch", query });
    await requests[0].answer(page(["1", "2"], "c2"));
    hook.turn({ page: 1, pageSize: 25 });
    await requests[1].answer(page(["3"], "c3"));

    hook.turn({ page: 1, pageSize: 50 });
    expect(requests).toHaveLength(3);
    expect(requests[2].url.searchParams.get("limit")).toBe("50");
    expect(requests[2].url.searchParams.has("cursor")).toBe(false);
    expect(hook.listing.paginationModel).toEqual({ page: 0, pageSize: 50 });
  });

  describe("asking again after a failure", () => {
    beforeEach(() => {
      // Only the clock: Response bodies are read through microtasks and
      // nextTick, which must keep running for a stubbed answer to arrive.
      jest.useFakeTimers({
        doNotFake: ["nextTick", "queueMicrotask", "setImmediate"],
      });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    // Lets the given time pass, and any request due by then go out.
    const elapse = async (milliseconds: number) => {
      await act(async () => {
        jest.advanceTimersByTime(milliseconds);
      });
    };
    const serverFailure = { error: "query failed" };

    test("asks again after the server fails, keeping the loading state, and shows the page that then arrives", async () => {
      const hook = mount({ repo: "pytorch/pytorch", query });
      await requests[0].fail(500, serverFailure);
      expect(requests).toHaveLength(1);
      expect(hook.listing.loading).toBe(true);
      expect(hook.listing.error).toBeUndefined();
      expect(hook.listing.rowCount).toBe(-1);

      await elapse(RETRY_DELAYS_MS[0] - 1);
      expect(requests).toHaveLength(1);
      await elapse(1);
      expect(requests).toHaveLength(2);
      expect(requests[1].url.href).toBe(requests[0].url.href);

      await requests[1].answer(page(["1"]));
      expect(hook.listing.loading).toBe(false);
      expect(ids(hook.listing)).toEqual(["1"]);
      // The page's time counts from the first attempt, the wait included.
      expect(hook.listing.timing?.elapsedMs).toBe(RETRY_DELAYS_MS[0]);
    });

    test("asks again when the connection fails", async () => {
      const hook = mount({ repo: "pytorch/pytorch", query });
      await requests[0].drop();
      expect(hook.listing.error).toBeUndefined();
      await elapse(RETRY_DELAYS_MS[0]);
      expect(requests).toHaveLength(2);
      await requests[1].answer(page(["1"]));
      expect(ids(hook.listing)).toEqual(["1"]);
    });

    test("shows the last error once the retries are spent, and asks no more", async () => {
      const hook = mount({ repo: "pytorch/pytorch", query });
      await requests[0].fail(500, serverFailure);
      await elapse(RETRY_DELAYS_MS[0]);
      await requests[1].fail(503, { error: "unavailable" });
      await elapse(RETRY_DELAYS_MS[1] - 1);
      expect(requests).toHaveLength(2);
      await elapse(1);
      expect(requests).toHaveLength(3);
      expect(hook.listing.loading).toBe(true);

      await requests[2].fail(500, { error: "query failed again" });
      expect(hook.listing.loading).toBe(false);
      expect(hook.listing.error).toMatchObject({
        status: 500,
        info: "query failed again",
      });
      expect(hook.listing.entries).toEqual([]);
      expect(hook.listing.rowCount).toBe(0);
      await elapse(60_000);
      expect(requests).toHaveLength(3);
    });

    test("does not ask again when the API rejects the request itself", async () => {
      const hook = mount({ repo: "pytorch/pytorch", query });
      await requests[0].fail(400, {
        error: "cursor was issued for a different request",
      });
      expect(hook.listing.loading).toBe(false);
      expect(hook.listing.error).toMatchObject({ status: 400 });
      await elapse(60_000);
      expect(requests).toHaveLength(1);
    });

    test("does not ask again for a request abandoned while it waits", async () => {
      const hook = mount({ repo: "pytorch/pytorch", query });
      await requests[0].fail(500, serverFailure);
      hook.update({ repo: "pytorch/pytorch", query, pending: true });
      await elapse(60_000);
      expect(requests).toHaveLength(1);
      expect(hook.listing.error).toBeUndefined();
      expect(hook.listing.loading).toBe(true);
    });

    test("retry() asks for the failed page again, showing the loading state meanwhile", async () => {
      const hook = mount({ repo: "pytorch/pytorch", query });
      await requests[0].fail(500, serverFailure);
      await elapse(RETRY_DELAYS_MS[0]);
      await requests[1].fail(500, serverFailure);
      await elapse(RETRY_DELAYS_MS[1]);
      await requests[2].fail(500, serverFailure);
      expect(hook.listing.error).toBeDefined();

      act(() => {
        hook.listing.retry();
      });
      expect(requests).toHaveLength(4);
      expect(requests[3].url.href).toBe(requests[0].url.href);
      expect(hook.listing.loading).toBe(true);
      expect(hook.listing.error).toBeUndefined();
      expect(hook.listing.entries).toEqual([]);

      await requests[3].answer(page(["1", "2"]));
      expect(hook.listing.loading).toBe(false);
      expect(ids(hook.listing)).toEqual(["1", "2"]);
    });

    test("retry() does nothing while no failure is shown", async () => {
      const hook = mount({ repo: "pytorch/pytorch", query });
      act(() => {
        hook.listing.retry();
      });
      expect(requests).toHaveLength(1);
      await requests[0].answer(page(["1"]));
      act(() => {
        hook.listing.retry();
      });
      expect(requests).toHaveLength(1);
      expect(ids(hook.listing)).toEqual(["1"]);
    });
  });
});
