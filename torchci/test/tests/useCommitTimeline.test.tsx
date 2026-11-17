// The commit page's timeline hook: what it asks the jobs endpoint for, and
// the timeline it hands the page as each answer arrives or fails. The API is
// a fetch stub whose requests are answered by hand.

import { useCommitTimeline } from "lib/tests/useCommitJobs";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { SWRConfig } from "swr";
import { COMMIT_JOBS, COMMIT_TESTS } from "./timelineFixtures";

const REPO = "pytorch/pytorch";
const SHA = "573c889f49603f0bd8d0033ef6a49e3016d863d3";
const urlOf = (field: string) =>
  `/api/tests/commit/${SHA}/jobs?repo=pytorch%2Fpytorch&fields=${field}`;

interface Request {
  url: string;
  answer: (_body: unknown, _status?: number) => Promise<void>;
}

function stubFetch(): Request[] {
  const requests: Request[] = [];
  global.fetch = jest.fn(
    (input: string | URL | globalThis.Request) =>
      new Promise<Response>((resolve) => {
        requests.push({
          url: String(input),
          answer: (body, status = 200) =>
            act(async () => {
              resolve(new Response(JSON.stringify(body), { status }));
            }),
        });
      })
  ) as unknown as typeof fetch;
  return requests;
}

describe("useCommitTimeline", () => {
  let renderer: ReactTestRenderer | undefined;
  let requests: Request[] = [];
  let result!: ReturnType<typeof useCommitTimeline>;

  beforeEach(() => {
    // SWR's timers are the test's, so none outlives it; what React and the
    // fetch stub wait on is left real.
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    requests = stubFetch();
    function Harness() {
      result = useCommitTimeline(REPO, SHA);
      return null;
    }
    act(() => {
      renderer = create(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <Harness />
        </SWRConfig>
      );
    });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    jest.useRealTimers();
  });

  const asked = (field: string) =>
    requests.filter((request) => request.url === urlOf(field));
  const jobs = { jobs: COMMIT_JOBS, hud_url: "", query_duration_ms: 1 };
  const tests = { tests: COMMIT_TESTS, hud_url: "", query_duration_ms: 1 };
  // What the page reads of the tests: the commit's failed test.
  const failedTests = () => result.timeline?.root.totals.counts.failed;

  test("asks for the jobs and for their tests at once, and draws the jobs while the tests are read", async () => {
    expect(requests.map((request) => request.url)).toEqual([
      urlOf("jobs"),
      urlOf("tests"),
    ]);
    expect(result.timeline).toBeUndefined();
    await asked("jobs")[0].answer(jobs);
    // The commit's own jobs; the bot's is apart.
    expect(result.timeline?.root.jobs).toHaveLength(5);
    expect([result.timeline?.testsPending, failedTests()]).toEqual([true, 0]);
    await asked("tests")[0].answer(tests);
    expect([result.timeline?.testsPending, failedTests()]).toEqual([false, 1]);
    expect(result.error).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  test("tests that arrive before the jobs wait for them", async () => {
    await asked("tests")[0].answer(tests);
    expect(result.timeline).toBeUndefined();
    await asked("jobs")[0].answer(jobs);
    expect([result.timeline?.testsPending, failedTests()]).toEqual([false, 1]);
  });

  test("the tests' failure leaves the jobs drawn, and Retry asks for the tests alone", async () => {
    await asked("jobs")[0].answer(jobs);
    // A 4xx is not asked for again by itself.
    await asked("tests")[0].answer({ error: "No", code: "bad_request" }, 400);
    expect(result.error).toBeDefined();
    expect(result.timeline?.testsPending).toBe(true);
    act(() => result.retry());
    // On its way again: no error to show.
    expect(result.error).toBeUndefined();
    expect([asked("jobs").length, asked("tests").length]).toEqual([1, 2]);
    await asked("tests")[1].answer(tests);
    expect([result.error, result.timeline?.testsPending]).toEqual([
      undefined,
      false,
    ]);
  });

  test("the jobs' failure leaves no timeline", async () => {
    await asked("jobs")[0].answer({ error: "No", code: "bad_request" }, 400);
    await asked("tests")[0].answer(tests);
    expect(result.timeline).toBeUndefined();
    expect(result.error).toBeDefined();
  });
});
