// The page of one test, /tests/[organization]/[repo]/test/[test_id]: how a
// test's page is addressed at the API, how its header reads a test, what
// the headline shows, and how the detail hook treats an answer, an unknown
// test and a failure that may pass on retry. The API is a fetch stub
// answered by hand.

import { Tooltip } from "@mui/material";
import DetailList from "components/tests/DetailList";
import TestHeader from "components/tests/TestHeader";
import TestTitle from "components/tests/TestTitle";
import type { TestDetail } from "lib/api/tests/test/types";
import type { TestRecord } from "lib/api/tests/types";
import {
  caseNameDetails,
  firstSeenLabel,
  headerCrumbs,
  LANGUAGE_COLORS,
  splitCaseName,
} from "lib/tests/header";
import { mayPassOnRetry, requestJson } from "lib/tests/request";
import {
  isNotFound,
  testDetailApiUrl,
  useTestDetail,
} from "lib/tests/useTestDetail";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { SWRConfig } from "swr";

const record: TestRecord = {
  id: "42",
  hud_url: "https://hud.pytorch.org/tests/pytorch/pytorch/test/42",
  repo: "pytorch/pytorch",
  file: "test/test_torch.py",
  suite: "TestTorch",
  case_name: "test_add_cpu_float32",
  declared_case_name: "test_add",
  language: "python",
  first_seen_at: "2026-10-24T12:00:00.000Z",
};

const detail = { test: record, owners: ["nn"] } as unknown as TestDetail;

// A rendering without the style tags emotion writes beside it.
function unstyled(markup: string): string {
  return markup.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");
}

// The text of a rendering with its tags and break opportunities taken out.
function text(markup: string): string {
  return unstyled(markup)
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, "");
}

describe("testDetailApiUrl", () => {
  test("addresses the detail endpoint by the test's id", () => {
    expect(testDetailApiUrl("10798099672608881194")).toBe(
      "/api/tests/test/10798099672608881194"
    );
  });

  test("escapes an id that is not one", () => {
    expect(testDetailApiUrl("a/b?c")).toBe("/api/tests/test/a%2Fb%3Fc");
  });
});

describe("splitCaseName", () => {
  test("tells the declared name from the parameters the runner appended", () => {
    expect(splitCaseName(record)).toEqual({
      declared: "test_add",
      parameters: "_cpu_float32",
    });
  });

  test("gives an unparametrized test no parameters", () => {
    expect(
      splitCaseName({ case_name: "test_add", declared_case_name: "test_add" })
    ).toEqual({ declared: "test_add", parameters: "" });
  });

  test("keeps the whole name when the declared name is unknown or does not fit", () => {
    expect(
      splitCaseName({ case_name: "test_add_cpu", declared_case_name: "" })
    ).toEqual({ declared: "test_add_cpu", parameters: "" });
    expect(
      splitCaseName({
        case_name: "test_add_cpu",
        declared_case_name: "test_sub",
      })
    ).toEqual({ declared: "test_add_cpu", parameters: "" });
  });
});

describe("headerCrumbs", () => {
  test("leads back to the list: the repository, the file searched, the suite searched with its file", () => {
    expect(headerCrumbs(record)).toEqual([
      { text: "pytorch/pytorch", href: "/tests/pytorch/pytorch" },
      {
        text: "test/test_torch.py",
        href: "/tests/pytorch/pytorch?search=test%2Ftest_torch.py",
      },
      {
        text: "TestTorch",
        href: "/tests/pytorch/pytorch?search=test%2Ftest_torch.py%3A%3ATestTorch",
      },
    ]);
  });

  test("has no suite crumb for a module-level function", () => {
    expect(
      headerCrumbs({ ...record, suite: "" }).map((crumb) => crumb.text)
    ).toEqual(["pytorch/pytorch", "test/test_torch.py"]);
  });
});

describe("firstSeenLabel", () => {
  test("is the date in the viewer's zone", () => {
    // Noon UTC is the same calendar day in every zone a viewer is likely in.
    expect(firstSeenLabel("2026-10-24T12:00:00.000Z")).toBe("Oct 24, 2026");
  });
});

describe("caseNameDetails", () => {
  test("names the declared name and the case name for the tooltip", () => {
    expect(caseNameDetails(record)).toEqual([
      { name: "Declared name", value: "test_add" },
      { name: "Case name", value: "test_add_cpu_float32" },
    ]);
  });

  test("says when the declared name is unknown", () => {
    expect(
      caseNameDetails({ case_name: "test_add", declared_case_name: "" })[0]
    ).toEqual({ name: "Declared name", value: "unknown" });
  });
});

describe("LANGUAGE_COLORS", () => {
  test("marks Python and C++ with GitHub's colors and an unknown language with none", () => {
    expect(LANGUAGE_COLORS.python).toBe("#3572A5");
    expect(LANGUAGE_COLORS.cpp).toBe("#f34b7d");
    expect(LANGUAGE_COLORS.unknown).toBeNull();
  });
});

describe("TestTitle", () => {
  test("sets the declared name at full weight and the parameters muted after it", () => {
    const markup = renderToStaticMarkup(<TestTitle test={record} />);
    expect(unstyled(markup)).toMatch(/^<h1/);
    expect(text(markup)).toBe("test_add_cpu_float32");
    // The declared name is the heading's own text; each piece of the
    // parameters is a span of its own, one text node each.
    expect(unstyled(markup)).toMatch(/^<h1[^>]*>test_<wbr\/>add<wbr\/><span/);
    const pieces = [
      ...unstyled(markup).matchAll(/<span[^>]*>([^<]*)<\/span>/g),
    ].map((match) => match[1]);
    expect(pieces).toEqual(["_", "cpu_", "float32"]);
  });

  test("sets a name without parameters whole", () => {
    const markup = renderToStaticMarkup(
      <TestTitle
        test={{ case_name: "test_add", declared_case_name: "test_add" }}
      />
    );
    expect(text(markup)).toBe("test_add");
    expect(unstyled(markup)).not.toContain("<span");
  });

  test("says only what the page is when there is no test", () => {
    const markup = renderToStaticMarkup(<TestTitle test={undefined} />);
    expect(text(markup)).toBe("Test");
  });

  test("tells the two names apart in its tooltip", () => {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(<TestTitle test={record} />);
    });
    const tooltip = renderer!.root.findByType(Tooltip);
    expect(tooltip.props.title.type).toBe(DetailList);
    expect(tooltip.props.title.props.details).toEqual(caseNameDetails(record));
    act(() => renderer!.unmount());
  });
});

describe("TestHeader", () => {
  test("marks a known language with a dot and names the owner", () => {
    // The dot's color is in the styles emotion writes beside the markup.
    const styled = renderToStaticMarkup(
      <TestHeader test={record} owners={["nn"]} languageLabel="Python" />
    );
    expect(styled).toContain("background-color:#3572A5");
    expect(text(styled)).toContain("Python");
    expect(text(styled)).toContain("Ownernn");
    expect(text(styled)).not.toContain("Unknown");
  });

  test("says when the owners and the language are unknown instead of hiding them", () => {
    const styled = renderToStaticMarkup(
      <TestHeader
        test={{ ...record, language: "unknown" }}
        owners={[]}
        languageLabel="Unknown"
      />
    );
    expect(text(styled)).toContain("LanguageUnknown");
    expect(text(styled)).toContain("OwnerUnknown");
    // No dot: neither language color is painted.
    expect(styled).not.toContain("#3572A5");
    expect(styled).not.toContain("#f34b7d");
  });

  test("pluralizes the owners", () => {
    const markup = renderToStaticMarkup(
      <TestHeader
        test={record}
        owners={["nn", "core"]}
        languageLabel="Python"
      />
    );
    expect(text(markup)).toContain("Ownersnn · core");
  });
});

describe("requestJson", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("carries the API's text and code on a failure", async () => {
    global.fetch = jest.fn(async () =>
      Response.json(
        { error: "Test not found", code: "not_found" },
        { status: 404 }
      )
    );
    await expect(requestJson("/api/tests/test/1")).rejects.toMatchObject({
      status: 404,
      info: "Test not found",
      code: "not_found",
    });
  });

  test("tells the failures that may pass on retry from the API's verdicts", () => {
    expect(mayPassOnRetry(new TypeError("Failed to fetch"))).toBe(true);
    expect(mayPassOnRetry({ status: 503 })).toBe(true);
    expect(mayPassOnRetry({ status: 404 })).toBe(false);
    expect(mayPassOnRetry({ status: 401 })).toBe(false);
    expect(mayPassOnRetry({ status: 400 })).toBe(false);
  });

  test("knows the API's not-found code", () => {
    expect(isNotFound({ status: 404, code: "not_found" })).toBe(true);
    expect(isNotFound({ status: 400, code: "invalid_parameters" })).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe("useTestDetail", () => {
  type Result = ReturnType<typeof useTestDetail>;
  let result: Result | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe({ testId }: { testId: string | undefined }) {
    result = useTestDetail(testId);
    return null;
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

  // Mounts the hook with its own SWR cache, quick retries and no slow-load
  // timer, so the tests neither share answers nor wait seconds for a retry
  // nor leave a timer behind.
  function mount(testId: string | undefined) {
    act(() => {
      renderer = create(
        <SWRConfig
          value={{
            provider: () => new Map(),
            dedupingInterval: 0,
            errorRetryInterval: 1,
            loadingTimeout: 0,
          }}
        >
          <Probe testId={testId} />
        </SWRConfig>
      );
    });
  }

  // Lets the fetch stub's answers and SWR's retries, if any, run their
  // course.
  async function settle(milliseconds = 50) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
  }

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    result = undefined;
    jest.restoreAllMocks();
  });

  test("asks nothing until the id is known", async () => {
    const fetchMock = stubFetch(() => {
      throw new Error("not to be asked");
    });
    mount(undefined);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ detail: undefined, notFound: false });
    expect(result!.error).toBeUndefined();
  });

  test("hands over the test once the API answers", async () => {
    const fetchMock = stubFetch(() => Response.json(detail));
    mount("42");
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/tests/test/42");
    expect(result!.detail).toEqual(detail);
    expect(result!.notFound).toBe(false);
    expect(result!.error).toBeUndefined();
  });

  test("reports an unknown test as not found and does not ask again", async () => {
    const fetchMock = stubFetch(() =>
      Response.json(
        { error: "Test not found", code: "not_found" },
        { status: 404 }
      )
    );
    mount("1");
    await settle();
    expect(result!.notFound).toBe(true);
    expect(result!.detail).toBeUndefined();
    // Not found is not an error the page should show as one.
    expect(result!.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keeps the gate's refusal as an error with its status", async () => {
    const fetchMock = stubFetch(() =>
      Response.json(
        { error: "Sign in required", code: "unauthorized" },
        { status: 401 }
      )
    );
    mount("42");
    await settle();
    expect(result!.notFound).toBe(false);
    expect(result!.error).toMatchObject({ status: 401 });
    // The API's verdict: not asked again on its own.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("shows a server failure and asks again on its own", async () => {
    const fetchMock = stubFetch(() =>
      Response.json(
        { error: "Failed to get test", code: "internal_error" },
        { status: 500 }
      )
    );
    mount("42");
    await settle();
    expect(result!.notFound).toBe(false);
    expect(result!.error).toMatchObject({
      status: 500,
      info: "Failed to get test",
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  test("retry asks again and recovers", async () => {
    let failing = true;
    const fetchMock = stubFetch(() =>
      failing
        ? Response.json(
            { error: "Bad", code: "invalid_parameters" },
            { status: 400 }
          )
        : Response.json(detail)
    );
    mount("42");
    await settle();
    // The API's verdict: shown, and not asked again on its own.
    expect(result!.error).toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    failing = false;
    await act(async () => {
      await result!.retry();
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result!.detail).toEqual(detail);
    expect(result!.error).toBeUndefined();
  });
});
