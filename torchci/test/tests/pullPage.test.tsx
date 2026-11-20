// The pull request page, /tests/[organization]/[repo]/pull/[number]: the
// API URL it asks, the commit page it opens with the parameters it passes
// on, and the page itself, mounted with a stub router and a fetch stub
// answered by hand.

import type { PullRequestHead } from "lib/api/tests/pull/types";
import { pullPageTarget, pullRequestApiUrl } from "lib/tests/pullPage";
import Page from "pages/tests/[organization]/[repo]/pull/[number]";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { SWRConfig } from "swr";

// The router the page reads, which records where the page sends the reader.
const mockRouter = {
  query: { organization: "pytorch", repo: "pytorch", number: "203277" },
  replace: jest.fn(async (_url: string) => true),
};
jest.mock("next/router", () => ({ useRouter: () => mockRouter }));

const REPO = "pytorch/pytorch";
const SHA = "b2bbfce524a163c99bb1ad47909387679100688d";
const COMMIT_PAGE = `/tests/pytorch/pytorch/commit/${SHA}`;
// The head before it, which pull request 203277 had a minute earlier.
const EARLIER_SHA = "c900f5fc0257ef7d9a7decb6e0665e034b1301ee";

describe("the pull request page", () => {
  test("asks the API for the pull request by its number in the repository", () => {
    expect(pullRequestApiUrl(REPO, "203277")).toBe(
      "/api/tests/pull/203277?repo=pytorch%2Fpytorch"
    );
    // The number goes as the URL gave it, encoded; the API refuses it.
    expect(pullRequestApiUrl(REPO, "12/../3")).toBe(
      "/api/tests/pull/12%2F..%2F3?repo=pytorch%2Fpytorch"
    );
  });

  test("opens the head's commit page, bare when its URL carries nothing for it", () => {
    expect(
      pullPageTarget(REPO, SHA, {
        organization: "pytorch",
        repo: "pytorch",
        number: "203277",
      })
    ).toBe(COMMIT_PAGE);
  });

  test("passes on the commit page's parameters as the commit page writes them", () => {
    const target = new URL(
      pullPageTarget(REPO, SHA, {
        organization: "pytorch",
        repo: "pytorch",
        number: "203277",
        status: ["failed", "passed"],
        sort: "-duration_milliseconds",
        search: "test_add",
        test_config: "default",
        window: "7d",
      }),
      "https://hud.pytorch.org"
    );
    expect(target.pathname).toBe(COMMIT_PAGE);
    expect(target.searchParams.getAll("status")).toEqual(["failed", "passed"]);
    expect(target.searchParams.get("search")).toBe("test_add");
    expect(target.searchParams.getAll("test_config")).toEqual(["default"]);
    // The commit page's default sort is left off, and what the commit page
    // does not read, the path's own segments among it, is dropped.
    expect([...target.searchParams.keys()].sort()).toEqual([
      "search",
      "status",
      "status",
      "test_config",
    ]);
  });

  test("a value the commit page refuses falls back to its default, which is left off", () => {
    expect(
      pullPageTarget(REPO, SHA, { status: "bogus", sort: "nonsense" })
    ).toBe(COMMIT_PAGE);
  });
});

describe("the pull request page, mounted", () => {
  let renderer: ReactTestRenderer | undefined;

  function pullRequest(headSha: string): PullRequestHead {
    return {
      number: 203277,
      title: "[BE][Test] Trim mode OpInfo sample inputs",
      url: "https://github.com/pytorch/pytorch/pull/203277",
      head_sha: headSha,
      hud_url: "https://hud.pytorch.org/tests/pytorch/pytorch/pull/203277",
      query_duration_ms: 5,
    };
  }

  // A fetch answered by the given function, typed as fetch is so the calls
  // can be read back.
  function stubFetch(respond: () => Response) {
    const fetchMock = jest.fn(
      async (_input: string | URL | globalThis.Request, _init?: RequestInit) =>
        respond()
    );
    global.fetch = fetchMock;
    return fetchMock;
  }

  // One visit: the page mounted with quick retries and no slow-load timer.
  // Its cache is its own business, so none is given here.
  function visit() {
    act(() => {
      renderer = create(
        <SWRConfig
          value={{
            dedupingInterval: 0,
            errorRetryInterval: 1,
            loadingTimeout: 0,
          }}
        >
          <Page />
        </SWRConfig>
      );
    });
  }

  // Lets the fetch stub's answers run their course.
  async function settle(milliseconds = 50) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
  }

  // The text the page shows.
  function shownText(): string {
    const textOf = (node: unknown): string =>
      typeof node === "string"
        ? node
        : Array.isArray(node)
        ? node.map(textOf).join("")
        : node !== null && typeof node === "object" && "children" in node
        ? textOf((node as { children: unknown }).children ?? [])
        : "";
    return textOf(renderer?.toJSON() ?? null);
  }

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    mockRouter.replace.mockClear();
    jest.restoreAllMocks();
  });

  test("opens the head's commit page in its place, and a later visit asks afresh", async () => {
    let head = EARLIER_SHA;
    const fetchMock = stubFetch(() => Response.json(pullRequest(head)));
    visit();
    await settle();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/tests/pull/203277?repo=pytorch%2Fpytorch",
    ]);
    expect(mockRouter.replace.mock.calls).toEqual([
      [`/tests/pytorch/pytorch/commit/${EARLIER_SHA}`],
    ]);
    act(() => renderer?.unmount());

    // The pull request moves on, and the reader comes back in the same tab:
    // an answer kept from the first visit would open the old head.
    head = SHA;
    mockRouter.replace.mockClear();
    visit();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockRouter.replace.mock.calls).toEqual([[COMMIT_PAGE]]);
  });

  test("says when HUD has no such pull request, and opens nothing", async () => {
    stubFetch(() =>
      Response.json(
        { error: "Pull request not found", code: "not_found" },
        { status: 404 }
      )
    );
    visit();
    await settle();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(shownText()).toContain("Pull request #203277");
    expect(shownText()).toContain(
      "HUD has no pull request #203277 in pytorch/pytorch."
    );
  });
});
