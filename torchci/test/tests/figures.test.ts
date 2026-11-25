// The figures of the band above the tests table: how the page asks
// GET /api/tests/summary for them, finds a view's among them, and sets each
// kind as a number, a caption and a sentence.

import { parseTestSummaryParams } from "lib/api/tests/summary/parameters";
import type { TestViewFigure } from "lib/api/tests/summary/types";
import {
  figureCaption,
  figureOf,
  figureSentence,
  figureText,
  testsSummaryApiUrl,
  totalDurationLabel,
} from "lib/tests/figures";

const HOUR = 60 * 60 * 1000;

function figure(overrides: Partial<TestViewFigure>): TestViewFigure {
  return {
    id: "unhealthy",
    kind: "count",
    window: "12h",
    count: null,
    duration_milliseconds: null,
    test: null,
    hud_url: "https://hud.pytorch.org/tests/pytorch/pytorch?window=12h",
    ...overrides,
  };
}

const TEST: NonNullable<TestViewFigure["test"]> = {
  id: "13862921515559540007",
  hud_url:
    "https://hud.pytorch.org/tests/pytorch/pytorch/test/13862921515559540007",
  repo: "pytorch/pytorch",
  file: "test/test_nn.py",
  suite: "TestNN",
  case_name: "test_cudnn_rnn_dropout_states_device",
  declared_case_name: "test_cudnn_rnn_dropout_states_device",
  language: "python",
  first_seen_at: "2026-10-14T06:57:57.812Z",
};

describe("testsSummaryApiUrl", () => {
  test("names the repository, the window and each language, as the API takes them", () => {
    expect(
      testsSummaryApiUrl("pytorch/pytorch", { window: "12h", languages: [] })
    ).toBe("/api/tests/summary?repo=pytorch%2Fpytorch&window=12h");
    const url = testsSummaryApiUrl("pytorch/pytorch", {
      window: "7d",
      languages: ["python", "cpp"],
    });
    expect(url).toBe(
      "/api/tests/summary?repo=pytorch%2Fpytorch&window=7d&language=python&language=cpp"
    );
    // The endpoint's own parser accepts it and reads the same choices.
    const params = new URL(url, "https://hud.pytorch.org").searchParams;
    const parsed = parseTestSummaryParams({
      repo: params.get("repo") ?? undefined,
      window: params.get("window") ?? undefined,
      language: params.getAll("language"),
    });
    expect(parsed.success && parsed.data).toEqual({
      repo: "pytorch/pytorch",
      window: "7d",
      language: ["cpp", "python"],
    });
  });

  test("does not depend on what a view sets, so the figures stay put between views", () => {
    const query = {
      window: "12h" as const,
      languages: [],
      // What choosing a view changes.
      sort: "-flaky_runs,-flaky_rate",
      ranOn: ["pull_request"],
    };
    expect(testsSummaryApiUrl("pytorch/pytorch", query)).toBe(
      testsSummaryApiUrl("pytorch/pytorch", { window: "12h", languages: [] })
    );
  });
});

describe("figureOf", () => {
  const summary = {
    views: [figure({ id: "unhealthy", count: 20 }), figure({ id: "slowest" })],
  };
  test("finds a view's figure by its id", () => {
    expect(figureOf(summary, { id: "unhealthy" })?.count).toBe(20);
  });
  test("has none before the summary arrives, or for a view it does not answer", () => {
    expect(figureOf(undefined, { id: "unhealthy" })).toBeUndefined();
    expect(figureOf(summary, { id: "least_healthy" })).toBeUndefined();
  });
});

describe("figureText", () => {
  test("groups a count in threes and marks none", () => {
    expect(figureText(figure({ count: 20 }))).toEqual({
      value: "20",
      none: false,
    });
    expect(figureText(figure({ count: 1502 }))).toEqual({
      value: "1,502",
      none: false,
    });
    expect(figureText(figure({ count: 0 }))).toEqual({
      value: "0",
      none: true,
    });
  });

  test("sets the slowest mean as the table's duration cell does, its unit apart", () => {
    const slowest = (duration_milliseconds: number | null) =>
      figureText(figure({ kind: "slowest", duration_milliseconds }));
    expect(slowest(1296000)).toEqual({
      value: "21.6",
      unit: "min",
      none: false,
    });
    expect(slowest(625)).toEqual({ value: "625", unit: "ms", none: false });
    expect(slowest(12700)).toEqual({ value: "12.7", unit: "s", none: false });
    expect(slowest(2 * HOUR)).toEqual({ value: "2", unit: "h", none: false });
    // Hours and minutes are all number.
    expect(slowest(4 * HOUR + 22 * 60 * 1000)).toEqual({
      value: "4 h 22 min",
      none: false,
    });
    // Nothing passed: no figure.
    expect(slowest(null)).toBeNull();
  });

  test("sets machine time in whole hours from ten up", () => {
    const total = (duration_milliseconds: number | null) =>
      figureText(figure({ kind: "total_duration", duration_milliseconds }));
    expect(total(1240 * HOUR)).toEqual({
      value: "1,240",
      unit: "h",
      none: false,
    });
    expect(total(10 * HOUR)).toEqual({ value: "10", unit: "h", none: false });
    expect(total(10 * HOUR - 1)).toEqual({
      value: "10",
      unit: "h",
      none: false,
    });
    expect(total(4 * HOUR + 22 * 60 * 1000)).toEqual({
      value: "4 h 22 min",
      none: false,
    });
    expect(total(0)).toEqual({ value: "0", unit: "ms", none: true });
    expect(total(null)).toBeNull();
  });

  test("has no text for a count the API left null, or a kind it does not know", () => {
    expect(figureText(figure({ count: null }))).toBeNull();
    expect(
      figureText(figure({ kind: "trend" as TestViewFigure["kind"], count: 3 }))
    ).toBeNull();
  });
});

describe("totalDurationLabel", () => {
  test("rounds to the hour from ten hours, and reads as a duration below", () => {
    expect(totalDurationLabel(1239.6 * HOUR)).toBe("1,240 h");
    expect(totalDurationLabel(12.4 * HOUR)).toBe("12 h");
    expect(totalDurationLabel(9.5 * HOUR)).toBe("9 h 30 min");
    expect(totalDurationLabel(32.3 * 60 * 1000)).toBe("32.3 min");
  });
});

describe("figureCaption", () => {
  const view = {
    figure: { kind: "slowest" as const, caption: "mean passed duration" },
  };
  test("is the view's own caption until the figure names a test", () => {
    expect(figureCaption(view, undefined)).toEqual({
      text: "mean passed duration",
    });
    expect(
      figureCaption(view, figure({ kind: "slowest", test: null }))
    ).toEqual({ text: "mean passed duration" });
    expect(
      figureCaption(
        { figure: { kind: "count", caption: "failing or flaky" } },
        figure({ count: 20 })
      )
    ).toEqual({ text: "failing or flaky" });
  });

  test("is the slowest test's case, with its whole name beside it", () => {
    expect(
      figureCaption(
        view,
        figure({ kind: "slowest", duration_milliseconds: 1296000, test: TEST })
      )
    ).toEqual({
      text: "test_cudnn_rnn_dropout_states_device",
      name: "test/test_nn.py::TestNN::test_cudnn_rnn_dropout_states_device",
    });
  });

  test("is empty for a view from options that predate the figures", () => {
    expect(
      figureCaption({} as Parameters<typeof figureCaption>[0], undefined)
    ).toEqual({ text: "" });
  });
});

describe("figureSentence", () => {
  test("says a count is of rows, one per configuration, in its window", () => {
    expect(figureSentence(figure({ count: 20 }), "12 hours")).toBe(
      "20 rows in the last 12 hours, one per test, environment and test config."
    );
    expect(figureSentence(figure({ count: 1 }), "7 days")).toBe(
      "1 row in the last 7 days, one per test, environment and test config."
    );
    expect(figureSentence(figure({ count: 0 }), "3 hours")).toBe(
      "0 rows in the last 3 hours, one per test, environment and test config."
    );
  });

  test("names the slowest test, a module-level one without a suite", () => {
    expect(
      figureSentence(
        figure({ kind: "slowest", duration_milliseconds: 1296000, test: TEST }),
        "12 hours"
      )
    ).toBe(
      "test/test_nn.py::TestNN::test_cudnn_rnn_dropout_states_device averaged 21.6 min a passed run in the last 12 hours."
    );
    expect(
      figureSentence(
        figure({
          kind: "slowest",
          duration_milliseconds: 84,
          test: {
            ...TEST,
            file: "test/test_ops.py",
            suite: "",
            case_name: "test_add",
          },
        }),
        "12 hours"
      )
    ).toBe(
      "test/test_ops.py::test_add averaged 84 ms a passed run in the last 12 hours."
    );
    expect(
      figureSentence(
        figure({ kind: "slowest", duration_milliseconds: 1296000 }),
        "12 hours"
      )
    ).toBe(
      "The slowest test averaged 21.6 min a passed run in the last 12 hours."
    );
    expect(figureSentence(figure({ kind: "slowest" }), "12 hours")).toBe(
      "No test passed in the last 12 hours."
    );
  });

  test("says what the machine time counts", () => {
    expect(
      figureSentence(
        figure({ kind: "total_duration", duration_milliseconds: 1240 * HOUR }),
        "12 hours"
      )
    ).toBe(
      "1,240 h of machine time in the last 12 hours, every attempt counted."
    );
  });

  test("has nothing to say without a figure", () => {
    expect(figureSentence(figure({ count: null }), "12 hours")).toBeNull();
    expect(
      figureSentence(figure({ kind: "total_duration" }), "12 hours")
    ).toBeNull();
  });
});
