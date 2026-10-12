// Pins how lib/greenlight/qualityCharts puts the GreenLight Quality queries on
// the time axis every trend chart shares: the default bucket size and when a
// picked one is dropped, the UTC day and ISO week spine, the keys query rows and
// reverts land on, and what a bucket plots when its row is missing.

import { QUALITY_CHARTS } from "components/greenlight/quality/chartConfigs";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  alignRows,
  bucketKey,
  bucketSpine,
  bucketValue,
  bucketValueText,
  CHART_GRANULARITY_OPTIONS,
  ChartBucket,
  chartedReverts,
  ChartGranularity,
  chartPlot,
  clearsGranularityOverride,
  defaultGranularity,
  pickedRangeDays,
  revertRowsBySpine,
} from "lib/greenlight/qualityCharts";
import { ABSENT, secondsFormatter } from "lib/greenlight/qualityFigures";
import {
  ANCHOR,
  INVERTED_WINDOW,
  revert,
  shas,
  SHORT_WINDOW,
  span,
  utcDays,
  WINDOW,
} from "./greenlightQuality.helpers";

dayjs.extend(utc);

const GRANULARITIES = CHART_GRANULARITY_OPTIONS.map((option) => option.value);

// TimeRangePicker's value for a range set by hand.
const CUSTOM = -1;

function plotted(
  key: keyof typeof QUALITY_CHARTS,
  spine: ChartBucket[],
  rows: any[],
  granularity: ChartGranularity = "day"
): (number | null)[][] {
  const chart = QUALITY_CHARTS[key];
  return chartPlot(
    spine,
    rows,
    granularity,
    chart.source,
    chart.series.map((series) => series.value)
  ).values;
}

describe("the bucket size", () => {
  test("the page offers day and week", () => {
    expect(GRANULARITIES).toEqual(["day", "week"]);
  });

  // TimeRangePicker's presets, in days.
  test.each([1, 3, 7, 14, 30, 90])("a %p-day range buckets by day", (days) => {
    expect(defaultGranularity(days)).toBe("day");
  });

  test.each([180, 365])("a %p-day range buckets by week", (days) => {
    expect(defaultGranularity(days)).toBe("week");
  });

  test("the boundary sits after 90 days", () => {
    expect(defaultGranularity(89.99)).toBe("day");
    expect(defaultGranularity(90)).toBe("day");
    expect(defaultGranularity(90.01)).toBe("week");
    expect(defaultGranularity(91)).toBe("week");
  });

  test("a span not yet known buckets by day", () => {
    expect(defaultGranularity(undefined)).toBe("day");
  });
});

describe("pickedRangeDays", () => {
  const stop = dayjs.utc("2026-09-28T04:13:00.000Z");

  test("a preset is its own span, whatever the bounds hold", () => {
    expect(pickedRangeDays(30, stop.subtract(400, "day"), stop)).toBe(30);
    expect(pickedRangeDays(180, null, undefined)).toBe(180);
  });

  test("a Custom span is counted in whole minutes", () => {
    expect(pickedRangeDays(CUSTOM, stop.subtract(36, "hour"), stop)).toBe(1.5);
    expect(
      pickedRangeDays(
        CUSTOM,
        stop.subtract(1, "day").subtract(59, "second"),
        stop
      )
    ).toBe(1);
  });

  // "Now" is read once for the stop and once for the start, a millisecond or
  // so apart, which must not tip a 90-day range into weeks.
  test("a millisecond past 90 days still buckets by day, a minute past does not", () => {
    const justOver = pickedRangeDays(
      CUSTOM,
      stop.subtract(90, "day").subtract(1, "millisecond"),
      stop
    );
    expect(justOver).toBe(90);
    expect(defaultGranularity(justOver)).toBe("day");
    expect(
      defaultGranularity(
        pickedRangeDays(
          CUSTOM,
          stop.subtract(90, "day").subtract(1, "minute"),
          stop
        )
      )
    ).toBe("week");
  });

  // The picker hands back times in the reader's zone. A range whose two dates
  // fall either side of a change of UTC offset spans the calendar days picked,
  // not an hour more or less, so "Last Quarter" re-picked as Custom stays Day.
  test.each([
    [
      "the autumn change, an hour longer in UTC",
      dayjs.utc("2026-08-10T19:00:00.000Z").utcOffset(-420),
      dayjs.utc("2026-11-08T20:00:00.000Z").utcOffset(-480),
    ],
    [
      "the spring change, an hour shorter in UTC",
      dayjs.utc("2026-02-01T20:00:00.000Z").utcOffset(-480),
      dayjs.utc("2026-05-02T19:00:00.000Z").utcOffset(-420),
    ],
  ])("90 local days across %s are 90 days", (_case, start, end) => {
    expect(pickedRangeDays(CUSTOM, start, end)).toBe(90);
    expect(defaultGranularity(pickedRangeDays(CUSTOM, start, end))).toBe("day");
    expect(pickedRangeDays(CUSTOM, start.subtract(1, "millisecond"), end)).toBe(
      90
    );
    expect(
      pickedRangeDays(CUSTOM, start.subtract(1, "minute"), end)
    ).toBeGreaterThan(90);
  });

  test.each([
    ["a cleared start", null, stop],
    ["a cleared stop", stop, null],
    ["an absent start", undefined, stop],
    ["an invalid start", dayjs("not a date"), stop],
    ["an invalid stop", stop, dayjs("not a date")],
  ])(
    "%s leaves a Custom span unknown, which buckets by day",
    (_case, start, end) => {
      expect(pickedRangeDays(CUSTOM, start, end)).toBeUndefined();
      expect(defaultGranularity(pickedRangeDays(CUSTOM, start, end))).toBe(
        "day"
      );
    }
  );
});

describe("clearsGranularityOverride", () => {
  test.each([1, 30, 365, CUSTOM])(
    "picking a range drops the bucket size (%p)",
    (range) => {
      expect(clearsGranularityOverride("range", range)).toBe(true);
    }
  );

  test("editing a Custom range's start or stop drops it", () => {
    expect(clearsGranularityOverride("bound", CUSTOM)).toBe(true);
  });

  test("a preset's periodic refresh of its bounds keeps it", () => {
    expect(clearsGranularityOverride("bound", 30)).toBe(false);
  });
});

describe("bucketSpine", () => {
  test("daily buckets are the UTC days the window touches, its edges clipped", () => {
    const spine = bucketSpine(WINDOW, "day");
    expect(spine.map((bucket) => bucket.key)).toEqual(
      utcDays("2026-07-31", 13)
    );
    expect(spine.map((bucket) => bucket.partial)).toEqual([
      true,
      ...Array(11).fill(false),
      true,
    ]);
    expect(span(spine[0])).toEqual([
      "2026-07-31T19:35:59.404Z",
      "2026-08-01T00:00:00.000Z",
    ]);
    expect(span(spine[1])).toEqual([
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    ]);
    expect(span(spine[12])).toEqual([
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T14:00:00.000Z",
    ]);
    expect(spine.slice(0, 3).map((bucket) => bucket.label)).toEqual([
      "Jul 31",
      "Aug 1",
      "Aug 2",
    ]);
  });

  // The covered span of a clipped week is the tooltip's to state; its axis label
  // stays the Monday, so a week reads the same wherever the window starts.
  test("weekly buckets start and are labelled on Monday, the edges clipped", () => {
    const spine = bucketSpine(WINDOW, "week");
    expect(
      spine.map((bucket) => [bucket.key, bucket.label, bucket.partial])
    ).toEqual([
      ["2026-07-27", "Jul 27", true],
      ["2026-08-03", "Aug 3", false],
      ["2026-08-10", "Aug 10", true],
    ]);
    expect(span(spine[0])).toEqual([
      "2026-07-31T19:35:59.404Z",
      "2026-08-03T00:00:00.000Z",
    ]);
    expect(span(spine[2])).toEqual([
      "2026-08-10T00:00:00.000Z",
      "2026-08-12T14:00:00.000Z",
    ]);
  });

  test("a window opening on a Sunday starts in the ISO week that Sunday ends", () => {
    const spine = bucketSpine(
      {
        effective_start: "2026-08-02T06:00:00.000Z",
        effective_end: "2026-08-04T00:00:00.000Z",
      },
      "week"
    );
    expect(spine.map((bucket) => [bucket.key, bucket.label])).toEqual([
      ["2026-07-27", "Jul 27"],
      ["2026-08-03", "Aug 3"],
    ]);
  });

  test("an end on a bucket boundary closes the last whole bucket and opens none", () => {
    const aligned = {
      effective_start: "2026-08-03T00:00:00.000Z",
      effective_end: "2026-08-17T00:00:00.000Z",
    };
    expect(
      bucketSpine(aligned, "week").map((bucket) => [bucket.key, bucket.partial])
    ).toEqual([
      ["2026-08-03", false],
      ["2026-08-10", false],
    ]);
    const days = bucketSpine(aligned, "day");
    expect(days.map((bucket) => bucket.key)).toEqual(utcDays("2026-08-03", 14));
    expect(days.filter((bucket) => bucket.partial)).toEqual([]);
  });

  test("a window inside one day is one bucket clipped at both ends", () => {
    const spine = bucketSpine(
      {
        effective_start: "2026-08-05T10:00:00.000Z",
        effective_end: "2026-08-05T14:00:00.000Z",
      },
      "day"
    );
    expect(
      spine.map((bucket) => [bucket.key, bucket.partial, ...span(bucket)])
    ).toEqual([
      [
        "2026-08-05",
        true,
        "2026-08-05T10:00:00.000Z",
        "2026-08-05T14:00:00.000Z",
      ],
    ]);
  });

  test.each([
    [
      "an end equal to the start",
      {
        effective_start: "2026-08-05T10:00:00.000Z",
        effective_end: "2026-08-05T10:00:00.000Z",
      },
    ],
    ["an end before the start", INVERTED_WINDOW],
    ["no end", { effective_start: "2026-08-05T10:00:00.000Z" }],
    ["no start", { effective_end: "2026-08-05T10:00:00.000Z" }],
    [
      "an unparseable start",
      {
        effective_start: "not a date",
        effective_end: "2026-08-05T10:00:00.000Z",
      },
    ],
    ["no row", undefined],
  ])("%s has no buckets", (_case, row) => {
    for (const granularity of GRANULARITIES) {
      expect(bucketSpine(row, granularity)).toEqual([]);
    }
  });
});

describe("bucketKey", () => {
  test.each([
    ["a DateTime64(3)", "2026-09-23T00:00:00.000Z", "2026-09-23", "2026-09-21"],
    ["a DateTime", "2026-09-23T00:00:00Z", "2026-09-23", "2026-09-21"],
    ["a Date", "2026-09-21", "2026-09-21", "2026-09-21"],
    [
      "a day's last instant",
      "2026-09-23T23:59:59.999Z",
      "2026-09-23",
      "2026-09-21",
    ],
    [
      "a revert's raw timestamp",
      "2026-07-31T19:35:59.404Z",
      "2026-07-31",
      "2026-07-27",
    ],
  ])("%s keys to its UTC day and ISO week", (_shape, value, day, week) => {
    expect(bucketKey(value, "day")).toBe(day);
    expect(bucketKey(value, "week")).toBe(week);
  });

  test.each([undefined, null, "", "not a date", 20260923])(
    "%p has no key",
    (value) => {
      for (const granularity of GRANULARITIES) {
        expect(bucketKey(value, granularity)).toBeUndefined();
      }
    }
  );
});

describe("rows on the spine", () => {
  const spine = bucketSpine(SHORT_WINDOW, "day");

  test("each bucket takes its own row, and rows keyed outside the spine fall off", () => {
    const rows = [
      "2026-07-31",
      "2026-09-09",
      "2026-09-10",
      "2026-09-12",
      "2026-09-13",
    ].map((day, i) => ({
      latency_bucket: `${day}T00:00:00.000Z`,
      n_review_runs: i,
    }));
    expect(
      alignRows(spine, rows, "latency_bucket", "day").map(
        (row) => row?.n_review_runs
      )
    ).toEqual([2, undefined, 3]);
  });

  test("a bucket with no row plots zero counts and breaks the share line", () => {
    const rows = [
      {
        latency_bucket: "2026-09-10T00:00:00.000Z",
        n_review_runs_failed: 1,
        n_review_runs: 4,
      },
      {
        latency_bucket: "2026-09-12T00:00:00.000Z",
        n_review_runs_failed: 0,
        n_review_runs: 5,
      },
    ];
    expect(plotted("runsFailed", spine, rows)).toEqual([
      [1, 0, 0],
      [25, null, 0],
    ]);
  });

  test("a bucket whose clock measured nothing plots no share and no median", () => {
    const rows = [
      {
        latency_bucket: "2026-09-10T00:00:00.000Z",
        n_end_to_end: 4,
        n_e2e_within_cutoff: 3,
        e2e_p50_s: 600,
      },
      {
        latency_bucket: "2026-09-11T00:00:00.000Z",
        n_end_to_end: 0,
        n_e2e_within_cutoff: 0,
        e2e_p50_s: null,
      },
    ];
    expect(plotted("endToEnd", spine, rows)).toEqual([
      [75, null, null],
      [10, null, null],
    ]);
  });

  test("a measured median of zero stays measured in the tooltip, off the log axis", () => {
    const p50 = QUALITY_CHARTS.endToEnd.series[1].value;
    const measured = { n_end_to_end: 2, e2e_p50_s: 0 };
    expect(bucketValue(p50, measured)).toBeNull();
    expect(bucketValueText(p50, measured, null)).toBe(secondsFormatter(0));
    expect(bucketValueText(p50, { n_end_to_end: 0, e2e_p50_s: 0 }, null)).toBe(
      ABSENT
    );
    expect(bucketValueText(p50, undefined, null)).toBe(ABSENT);
  });

  test("a share the query left NULL is a gap, and a real 0% is not", () => {
    const rows = [
      {
        merge_bucket: "2026-09-10T00:00:00.000Z",
        gl_only: 0,
        merged_evaluated_prs: 0,
        pct_gl_only: null,
        merged_prs_total: 12,
        pct_of_all_merges: 0,
      },
    ];
    expect(plotted("mergedGlAlone", spine, rows)).toEqual([
      [0, 0, 0],
      [null, null, null],
      [0, null, null],
    ]);
  });

  test("the no-verdict bars read 0 where the row is missing or cannot say", () => {
    const rows = [
      {
        coverage_bucket: "2026-09-10T00:00:00.000Z",
        prs_evaluated: 5,
        prs_with_verdict: 3,
        prs_land: 2,
        prs_no_land: 1,
      },
      { coverage_bucket: "2026-09-11T00:00:00.000Z" },
    ];
    const [, , noVerdict] = plotted("prsEvaluated", spine, rows);
    expect(noVerdict).toEqual([2, 0, 0]);
  });
});

// A version skew between page and queries: rows keyed by a column this page
// does not read would otherwise plot a chart of zeros.
describe("misaligned rows", () => {
  const spine = bucketSpine(SHORT_WINDOW, "day");
  const chart = QUALITY_CHARTS.runsFailed;
  const misaligned = (spineUsed: ChartBucket[], rows: any[]) =>
    chartPlot(
      spineUsed,
      rows,
      "day",
      chart.source,
      chart.series.map((series) => series.value)
    ).misaligned;

  test("rows that all miss the spine are flagged", () => {
    expect(
      misaligned(spine, [{ latency_bucket: "2020-01-01T00:00:00.000Z" }])
    ).toBe(true);
    expect(misaligned(spine, [{ n_review_runs: 4 }])).toBe(true);
  });

  test("one row on the spine is enough", () => {
    expect(
      misaligned(spine, [
        { latency_bucket: "2020-01-01T00:00:00.000Z" },
        { latency_bucket: "2026-09-11T00:00:00.000Z" },
      ])
    ).toBe(false);
  });

  test("no rows, or no spine to miss, is not a misalignment", () => {
    expect(misaligned(spine, [])).toBe(false);
    expect(
      misaligned([], [{ latency_bucket: "2026-09-11T00:00:00.000Z" }])
    ).toBe(false);
  });

  test("the reverts chart is never flagged, since a revert-free spine is the best outcome", () => {
    const reverts = QUALITY_CHARTS.approvedReverts;
    expect(
      chartPlot(
        spine,
        [ANCHOR],
        "day",
        reverts.source,
        reverts.series.map((series) => series.value)
      ).misaligned
    ).toBe(false);
  });
});

describe("revert buckets", () => {
  // Each counted revert sits half an hour from a UTC midnight, on one side or
  // the other, so bucketing in local time moves one of them to another day in
  // any zone at least that far off UTC.
  const lateSaturday = revert(
    "late-saturday",
    "LAND",
    "yes",
    "nosignal",
    "2026-08-01T23:30:00.000Z"
  );
  const earlySunday = revert(
    "early-sunday",
    "LAND",
    "unknown",
    "",
    "2026-08-02T00:30:00.000Z"
  );
  const lateSunday = revert(
    "late-sunday",
    "LAND",
    "yes",
    "weird",
    "2026-08-02T23:30:00.000Z"
  );
  // Every revert here lands inside the window, as the query guarantees; the
  // anchor row a revert-free window returns rides along to show it never counts.
  const ROWS = [
    ANCHOR,
    lateSaturday,
    earlySunday,
    lateSunday,
    revert("stale", "LAND", "no", "nosignal", "2026-08-01T12:00:00.000Z"),
    revert(
      "stale-ghfirst",
      "LAND",
      "no",
      "ghfirst",
      "2026-08-01T12:00:00.000Z"
    ),
    revert("ghfirst", "LAND", "yes", "ghfirst", "2026-08-03T12:00:00.000Z"),
    revert(
      "no-land",
      "NO_LAND",
      "unknown",
      "nosignal",
      "2026-08-03T12:00:00.000Z"
    ),
    revert("unevaluated", "", "unknown", "", "2026-08-04T12:00:00.000Z"),
  ];

  function grouped(
    granularity: ChartGranularity,
    rows: any[] = ROWS
  ): string[][] {
    return revertRowsBySpine(
      bucketSpine(WINDOW, granularity),
      rows,
      granularity
    ).map(shas);
  }

  test("only the reverts the query flags as counted are bucketed, by the UTC day they landed", () => {
    expect(grouped("day")).toEqual([
      [],
      [lateSaturday.revert_sha],
      [earlySunday.revert_sha, lateSunday.revert_sha],
      ...Array(10).fill([]),
    ]);
  });

  // The flag is the query's UInt8, which the wire carries as the number 0 or 1,
  // never as a boolean.
  test.each([
    ["0", 0],
    ["null", null],
    ["absent", undefined],
  ])("a counts_in_rate of %s is not counted", (_case, flag) => {
    expect(
      grouped("day", [{ ...lateSaturday, counts_in_rate: flag }]).flat()
    ).toEqual([]);
  });

  test("a Sunday revert falls in the ISO week that Sunday ends", () => {
    expect(grouped("week")).toEqual([
      [lateSaturday.revert_sha, earlySunday.revert_sha, lateSunday.revert_sha],
      [],
      [],
    ]);
  });

  test("a revert landing on no bucket of the spine is in no group", () => {
    const outside = [
      revert("before", "LAND", "yes", "nosignal", "2026-07-30T12:00:00.000Z"),
      revert("after", "LAND", "yes", "nosignal", "2026-09-30T12:00:00.000Z"),
    ];
    expect(grouped("day", outside).flat()).toEqual([]);
  });

  test("the revert chart plots those counts, and totals the reverts it placed", () => {
    const spine = bucketSpine(WINDOW, "day");
    const chart = QUALITY_CHARTS.approvedReverts;
    const plot = chartPlot(
      spine,
      ROWS,
      "day",
      chart.source,
      chart.series.map((series) => series.value)
    );
    expect(plot.values).toEqual([[0, 1, 2, ...Array(10).fill(0)]]);
    expect(chartedReverts(plot)).toBe(3);
    expect(chartedReverts(plot)).toBe(
      ROWS.filter((row) => row.counts_in_rate === 1).length
    );
  });
});
