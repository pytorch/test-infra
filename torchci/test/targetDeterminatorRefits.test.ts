import {
  liveModelSub,
  monthSeries,
  monthTooltip,
  RefitSectionView,
  type RefitSectionViewProps,
} from "components/targetDeterminator/RefitSection";
import { refitTableRows } from "components/targetDeterminator/RefitTable";
import fs from "fs";
import yaml from "js-yaml";
import { countedRange, sectionLimits } from "lib/targetDeterminator";
import {
  lastCompleteMonth,
  latestReport,
  LIVE_MODEL_URLS,
  liveModel,
  modelAgeDays,
  NO_FILE,
  readLiveModel,
  REFIT_STEP,
  REFIT_TIMEOUT_MINUTES,
  refitOutcome,
  REPORT_UPLOAD_STEP,
  reportInconsistent,
  reportMonths,
  reportState,
  runUrl,
  verdict,
  type RefitRow,
} from "lib/targetDeterminatorRefits";
import path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mockCharts: { title: string; series: any[] }[] = [];
jest.mock("components/metrics/panels/TimeSeriesPanel", () => ({
  TimeSeriesPanelWithData: (props: { title: string; series: any[] }) => {
    mockCharts.push(props);
    return null;
  },
}));
const mockTables: { data: any[] }[] = [];
jest.mock("components/metrics/panels/TablePanel", () => ({
  TablePanelWithData: (props: { data: any[] }) => {
    mockTables.push(props);
    return null;
  },
}));

const ms = (iso: string) => Date.parse(`${iso}Z`);
const NOW = ms("2026-11-20T12:00:00.000");

function refit(partial: Partial<RefitRow> = {}): RefitRow {
  return {
    run_id: "43432678301",
    created_at: "2026-11-20 03:17:00.000000000",
    run_status: "completed",
    run_conclusion: "success",
    refit_attempt: 1,
    refit_conclusion: "success",
    refit_minutes: 117.6,
    refit_failed_step: "",
    check_conclusion: "success",
    publish_conclusion: "success",
    report_upload: "success",
    report_attempt: 1,
    report_infos: 1,
    report_valid: 1,
    passed: 1,
    floor_ok: 1,
    floor_ratio: 0.6,
    budget_on: 1,
    budget_retention: 0.8065,
    budget_retention_floor: 0.65,
    budget_ok: 1,
    budget_seconds_share: 0.0929,
    holdout_events: 34,
    holdout_td_caught: 23,
    holdout_scorer_caught: 22,
    holdout_healthy: 0,
    days_training: 330,
    days_gaps: 2,
    days_unhealthy: 1,
    days_missing: 0,
    total_ratio: 0.9739,
    wf_month: ["2026-09", "2026-10", "2026-11"],
    wf_prs: [300, 310, 189],
    wf_ratio: [0.95, 0.97, 0.93],
    wf_event_recall: [0.96, 0.99, 0.9],
    wf_trunk_landings: [2, 3, 3],
    wf_trunk_caught: [1, 2, 1],
    wf_risk_auc: [0.6, 0.61, 0.63],
    ...partial,
  };
}

describe("refitOutcome", () => {
  it.each<[string, Partial<RefitRow>, string]>([
    ["a run in progress", { run_status: "in_progress" }, "running"],
    [
      "a cancelled run without jobs",
      { run_conclusion: "cancelled", refit_conclusion: "" },
      "cancelled",
    ],
    ["a run without job rows", { refit_conclusion: "" }, "unknown"],
    ["a cancelled refit", { refit_conclusion: "cancelled" }, "cancelled"],
    [
      "a refit whose report did not pass",
      { refit_conclusion: "failure", passed: 0 },
      "gate_failed",
    ],
    [
      "a refit failure without a report",
      { refit_conclusion: "failure", passed: null },
      "refit_failed",
    ],
    [
      "a refit cancelled at its timeout",
      { refit_conclusion: "cancelled", refit_minutes: 284.2, passed: null },
      "timed_out",
    ],
    [
      "a refit cancelled before its timeout",
      { refit_conclusion: "cancelled", refit_minutes: 283.9 },
      "cancelled",
    ],
    [
      "a refit with a timed_out conclusion",
      { refit_conclusion: "timed_out", passed: null },
      "timed_out",
    ],
    [
      "a re-run refit whose only report is an earlier attempt's",
      { refit_conclusion: "failure", passed: 0, refit_attempt: 2 },
      "refit_failed",
    ],
    [
      "a failed gate whose report a later attempt re-uploaded",
      { refit_conclusion: "failure", passed: 0, report_attempt: 2 },
      "gate_failed",
    ],
    ["a failed check", { check_conclusion: "failure" }, "check_failed"],
    ["a check job not yet recorded", { check_conclusion: "" }, "unknown"],
    ["a skipped publish", { publish_conclusion: "skipped" }, "not_validated"],
    ["a failed publish", { publish_conclusion: "failure" }, "publish_failed"],
    ["a cancelled publish", { publish_conclusion: "cancelled" }, "cancelled"],
    ["every job green", {}, "published"],
  ])("reads %s from the jobs", (_name, partial, outcome) => {
    expect(refitOutcome(refit(partial))).toBe(outcome);
  });

  it("never reads a passed report as a failed gate", () => {
    expect(
      refitOutcome(refit({ refit_conclusion: "failure", passed: 1 }))
    ).toBe("refit_failed");
  });
});

describe("the workflow the refit section reads", () => {
  const workflow = yaml.load(
    fs.readFileSync(
      path.resolve(__dirname, "..", "..", ".github/workflows/td-scorer.yml"),
      "utf8"
    )
  ) as { jobs: Record<string, any> };
  const steps = (job: string) =>
    (workflow.jobs[job].steps as { name?: string }[]).map((s) => s.name);

  it("times the refit job out at REFIT_TIMEOUT_MINUTES", () => {
    expect(workflow.jobs.refit["timeout-minutes"]).toBe(REFIT_TIMEOUT_MINUTES);
    expect(steps("refit")).toContain(REFIT_STEP);
  });

  it("uploads the report in a job named upload, after refit", () => {
    expect(workflow.jobs.upload.needs).toBe("refit");
    expect(steps("upload")).toContain(REPORT_UPLOAD_STEP);
  });
});

describe("reportInconsistent", () => {
  it.each<[string, Partial<RefitRow>, boolean]>([
    ["a green refit whose report passed", {}, false],
    ["a green refit whose report failed", { passed: 0 }, true],
    [
      "a refit failed at its gate step whose report passed",
      { refit_conclusion: "failure", refit_failed_step: REFIT_STEP },
      true,
    ],
    [
      "a refit failed at another step whose report passed",
      {
        refit_conclusion: "failure",
        refit_failed_step: "Install dependencies",
      },
      false,
    ],
    [
      "a failed gate",
      {
        refit_conclusion: "failure",
        refit_failed_step: REFIT_STEP,
        passed: 0,
      },
      false,
    ],
    ["a report of an earlier attempt", { passed: 0, refit_attempt: 2 }, false],
    ["no report", { passed: null }, false],
  ])("flags %s: %s", (_name, partial, flagged) => {
    expect(reportInconsistent(refit(partial))).toBe(flagged);
  });
});

describe("reportState", () => {
  const missing = { report_attempt: 0, report_infos: 0, report_valid: 0 };

  it("is present, conflicting or invalid once a report row exists", () => {
    expect(reportState(refit(), NOW)).toBe("present");
    expect(reportState(refit({ report_attempt: "2" }), NOW)).toBe("present");
    expect(reportState(refit({ report_infos: 2, report_valid: 0 }), NOW)).toBe(
      "conflicting"
    );
    expect(reportState(refit({ report_valid: 0 }), NOW)).toBe("invalid");
  });

  it("waits six hours after the run's creation, and while it runs", () => {
    const created = refit({
      ...missing,
      created_at: "2026-11-20 06:00:00.000",
    });
    expect(reportState(created, ms("2026-11-20T11:59:59.999"))).toBe("pending");
    expect(reportState(created, ms("2026-11-20T12:00:00.000"))).toBe("missing");
    expect(
      reportState({ ...created, run_status: "in_progress" }, NOW + 86400000)
    ).toBe("pending");
  });

  it("is none when the refit stopped before its upload step ran", () => {
    const failed = {
      ...missing,
      refit_conclusion: "failure",
      created_at: "2026-11-20 11:00:00.000",
    };
    expect(reportState(refit({ ...failed, report_upload: "" }), NOW)).toBe(
      "none"
    );
    expect(
      reportState(refit({ ...failed, report_upload: "skipped" }), NOW)
    ).toBe("none");
    expect(
      reportState(
        refit({ ...failed, refit_conclusion: "cancelled", report_upload: "" }),
        NOW
      )
    ).toBe("none");
    expect(
      reportState(refit({ ...failed, report_upload: "failure" }), NOW)
    ).toBe("pending");
    expect(
      reportState(
        refit({ ...failed, report_upload: "failure" }),
        NOW + 86400000
      )
    ).toBe("missing");
    expect(
      reportState(refit({ ...missing, report_upload: "" }), NOW + 86400000)
    ).toBe("missing");
  });

  it("finds the newest report, readable or not", () => {
    const rows = [
      refit({ run_id: "3", ...missing, created_at: "2026-11-19 00:00:00" }),
      refit({ run_id: "2", report_infos: 2 }),
      refit({ run_id: "1" }),
    ];
    expect(latestReport(rows, NOW)).toMatchObject({
      row: { run_id: "2" },
      state: "conflicting",
    });
    expect(latestReport(rows.slice(2), NOW)).toMatchObject({
      row: { run_id: "1" },
      state: "present",
    });
    expect(latestReport(rows.slice(0, 1), NOW)).toBeUndefined();
  });

  it("reads a verdict as met, not met or unknown", () => {
    expect([1, 0, null, "1", "nan"].map(verdict)).toEqual([
      "met",
      "not met",
      "unknown",
      "met",
      "unknown",
    ]);
  });
});

describe("reportMonths", () => {
  it("marks the run's own month partial and finds the last complete one", () => {
    const months = reportMonths(refit());
    expect(months.map((m) => [m.month, m.partial])).toEqual([
      ["2026-09", false],
      ["2026-10", false],
      ["2026-11", true],
    ]);
    expect(months[0].start).toBe(ms("2026-09-01T00:00:00.000"));
    expect(lastCompleteMonth(months)?.month).toBe("2026-10");
    expect(lastCompleteMonth(months.slice(2))).toBeUndefined();
  });

  it("keeps only month labels, and reads missing or bad values as null", () => {
    const months = reportMonths(
      refit({
        wf_month: ["2026-09", "<b>x</b>", "total", "2026-10"],
        wf_ratio: [null, 5, 1, "0.5"],
        wf_prs: ["12"],
        wf_risk_auc: ["nan", 1, 1, "inf"],
      })
    );
    expect(months.map((m) => [m.month, m.ratio, m.prs, m.riskAuc])).toEqual([
      ["2026-09", null, 12, null],
      ["2026-10", 0.5, null, null],
    ]);
    expect(reportMonths(refit({ wf_month: undefined as any }))).toEqual([]);
  });
});

describe("runUrl", () => {
  it("links only a numeric run id", () => {
    expect(runUrl("43432678301")).toBe(
      "https://github.com/pytorch/test-infra/actions/runs/43432678301"
    );
    expect(runUrl("1/../../evil")).toBeUndefined();
    expect(runUrl(43432678301)).toBeUndefined();
  });
});

const model = (version: string, extra: Record<string, unknown> = {}) => ({
  enabled: true,
  version,
  ...extra,
});
const withBudget = (version: string) =>
  model(version, { budget: { share: 0.175 } });

describe("liveModel", () => {
  // 2026-11-20 at 23:59 UTC: ages are whole UTC dates, not 24-hour spans.
  const now = ms("2026-11-20T23:59:00.000");

  it("ages models in UTC dates", () => {
    expect(modelAgeDays("2026-11-20", now)).toBe(0);
    expect(modelAgeDays("2026-11-19", ms("2026-11-20T00:01:00.000"))).toBe(1);
    expect(modelAgeDays("2026-11-21", now)).toBe(-1);
    expect(modelAgeDays("2026-02-30", now)).toBeNull();
    expect(modelAgeDays("20261120", now)).toBeNull();
  });

  it.each([
    ["2026-11-22", "stale"],
    ["2026-11-21", "usable"],
    ["2026-11-13", "usable"],
    ["2026-11-12", "stale"],
    ["not a date", "stale"],
  ])("uses a model of version %s: %s", (version, state) => {
    expect(liveModel(model(version), model(version), now).state).toBe(state);
  });

  it.each([
    ["2026-11-17", "live"],
    ["2026-11-16", "stale"],
  ])("keeps a budget of version %s: %s", (version, budget) => {
    expect(liveModel(model(version), withBudget(version), now)).toEqual({
      state: "usable",
      version,
      ageDays: modelAgeDays(version, now),
      budget,
    });
  });

  it("drops a budget from another refit, a disabled file or none", () => {
    const plain = model("2026-11-20");
    const budget = (file: unknown) =>
      (liveModel(plain, file, now) as { budget: string }).budget;
    expect(budget(withBudget("2026-11-19"))).toBe("mismatch");
    expect(budget({ ...withBudget("2026-11-20"), enabled: false })).toBe(
      "unusable"
    );
    expect(budget(model("2026-11-20"))).toBe("off");
    expect(budget(NO_FILE)).toBe("off");
    expect(budget("not json")).toBe("unknown");
  });

  it("fails closed on a file it cannot read", () => {
    expect(liveModel(null, null, now)).toEqual({ state: "unknown" });
    expect(liveModel([], null, now)).toEqual({ state: "unknown" });
    expect(
      liveModel({ enabled: "yes", version: "2026-11-20" }, null, now)
    ).toEqual({ state: "unknown" });
    expect(liveModel({ enabled: true, version: 20261120 }, null, now)).toEqual({
      state: "unknown",
    });
    expect(
      liveModel({ ...model("2026-11-20"), enabled: false }, null, now)
    ).toEqual({ state: "disabled", version: "2026-11-20" });
  });
});

describe("readLiveModel", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function serve(files: Record<string, { status?: number; body: string }>) {
    const fetched: string[] = [];
    global.fetch = jest.fn(async (url: any) => {
      fetched.push(String(url));
      const file = files[String(url)];
      if (file === undefined) {
        throw new Error("network down");
      }
      return new Response(file.body, { status: file.status ?? 200 });
    }) as typeof fetch;
    return fetched;
  }
  const now = ms("2026-11-20T12:00:00.000");
  const json = (value: unknown) => ({ body: JSON.stringify(value) });

  it("reads both files from generated-stats", async () => {
    const fetched = serve({
      [LIVE_MODEL_URLS.plain]: json(model("2026-11-20")),
      [LIVE_MODEL_URLS.budget]: json(withBudget("2026-11-20")),
    });
    expect(await readLiveModel(now)).toEqual({
      state: "usable",
      version: "2026-11-20",
      ageDays: 0,
      budget: "live",
    });
    expect(fetched.sort()).toEqual(
      [LIVE_MODEL_URLS.budget, LIVE_MODEL_URLS.plain].sort()
    );
  });

  it("is unknown when the model file fails, and the budget unknown when its file does", async () => {
    serve({
      [LIVE_MODEL_URLS.plain]: { status: 404, body: "404: Not Found" },
      [LIVE_MODEL_URLS.budget]: json(withBudget("2026-11-20")),
    });
    expect(await readLiveModel(now)).toEqual({ state: "unknown" });
    serve({ [LIVE_MODEL_URLS.plain]: { body: "{not json" } });
    expect(await readLiveModel(now)).toEqual({ state: "unknown" });
    serve({
      [LIVE_MODEL_URLS.plain]: json(model("2026-11-20")),
      [LIVE_MODEL_URLS.budget]: { body: "{not json" },
    });
    expect(await readLiveModel(now)).toMatchObject({ budget: "unknown" });
    serve({ [LIVE_MODEL_URLS.plain]: json(model("2026-11-20")) });
    expect(await readLiveModel(now)).toMatchObject({ budget: "unknown" });
  });

  it("reads a budget file generated-stats does not have as no budget", async () => {
    serve({
      [LIVE_MODEL_URLS.plain]: json(model("2026-11-20")),
      [LIVE_MODEL_URLS.budget]: { status: 404, body: "404: Not Found" },
    });
    expect(await readLiveModel(now)).toMatchObject({
      state: "usable",
      budget: "off",
    });
    serve({
      [LIVE_MODEL_URLS.plain]: json(model("2026-11-20")),
      [LIVE_MODEL_URLS.budget]: { status: 500, body: "boom" },
    });
    expect(await readLiveModel(now)).toMatchObject({ budget: "unknown" });
  });

  it("says why the live model reads as it does", () => {
    expect(
      liveModelSub(
        liveModel(model("2026-11-19"), withBudget("2026-11-19"), now)
      )
    ).toBe("Version 2026-11-19, 1 day old (UTC); budget live.");
    expect(liveModelSub({ state: "unknown" })).toBe(
      "The model files could not be read."
    );
  });
});

describe("refit section", () => {
  const NOTHING = new Set<"months" | "runs">();
  function render(partial: Partial<RefitSectionViewProps>) {
    mockCharts.length = 0;
    mockTables.length = 0;
    const props: RefitSectionViewProps = {
      range: countedRange(
        {
          startTime: "2026-11-01T00:00:00.000",
          stopTime: "2026-11-21T00:00:00.000",
        },
        sectionLimits(NOW).refits,
        NOW
      ),
      refits: { loading: false, rows: [] },
      live: { state: "loading" },
      open: NOTHING,
      onToggle: () => {},
      now: NOW,
      ...partial,
    };
    const html = renderToStaticMarkup(createElement(RefitSectionView, props));
    return { html, charts: [...mockCharts], tables: [...mockTables] };
  }

  it("counts from the workflow's first day on main", () => {
    expect(render({}).html).toContain(
      "Counted 2026-11-12 to 2026-11-20 (UTC). The daily refit runs on main from 2026-11-12."
    );
  });

  it("shows the latest run, the published share and the latest report's month", () => {
    const failed = refit({
      run_id: "9",
      refit_conclusion: "failure",
      refit_failed_step: "<img src=x onerror=alert(1)>",
      report_attempt: 0,
      report_infos: 0,
      report_valid: 0,
      passed: null,
    });
    const { html } = render({
      refits: { loading: false, rows: [failed, refit()] },
    });
    expect(html).toContain("Refit failed");
    expect(html).toContain("at &quot;&lt;img src=x onerror=alert(1)&gt;&quot;");
    expect(html).not.toContain("<img");
    expect(html).toContain("1 of 2");
    expect(html).toContain("97.0%");
    expect(html).toContain("2026-10, 310 PRs with failures; floor 60.0%");
    expect(html).toContain("0.61");
    expect(html).toContain("floor 65.0%: met; 9.3% of test time");
  });

  it("says when no report was uploaded, or the budget was off", () => {
    const none = render({
      refits: {
        loading: false,
        rows: [refit({ report_attempt: 0, created_at: "2026-11-01 00:00:00" })],
      },
    });
    expect(none.html).toContain("No report uploaded in this range");
    const off = render({
      refits: { loading: false, rows: [refit({ budget_on: 0 })] },
    });
    expect(off.html).toContain("Budget off in the latest report");
    const unknown = render({
      refits: { loading: false, rows: [refit({ budget_ok: null })] },
    });
    expect(unknown.html).toContain("floor 65.0%: unknown;");
  });

  it("says the newest report is unreadable rather than show an older one", () => {
    const { html, charts } = render({
      refits: {
        loading: false,
        rows: [refit({ run_id: "2", report_infos: 2 }), refit({ run_id: "1" })],
      },
      open: new Set(["months"]),
    });
    expect(html).toContain("Newest report: conflicting rows");
    expect(html).not.toContain("97.0%");
    expect(html).not.toContain("0.61");
    expect(charts).toHaveLength(0);
    const invalid = render({
      refits: { loading: false, rows: [refit({ report_valid: 0 })] },
    });
    expect(invalid.html).toContain("Newest report: not valid json");
  });

  it("opens the month chart with fixed series names and the report's floor", () => {
    const { html, charts } = render({
      refits: { loading: false, rows: [refit({ floor_ratio: 0.55 })] },
      open: new Set(["months"]),
    });
    expect(html).toContain('id="td-refit-months"');
    expect(charts).toHaveLength(1);
    expect(charts[0].series.map((s: any) => s.name)).toEqual([
      "Scorer / TD recall",
      "Event recall",
      "Risk AUC",
    ]);
    expect(charts[0].series[0].markLine.data).toEqual([{ yAxis: 0.55 }]);
    expect(charts[0].series[1].markLine).toBeUndefined();
    expect((charts[0] as any).additionalOptions.yAxis).toEqual({ min: 0 });
  });

  it("marks partial months on the chart and in the tooltip", () => {
    const months = reportMonths(refit());
    const series = monthSeries(months, null);
    expect(series[0].data[2]).toMatchObject({ symbol: "emptyCircle" });
    expect(series[0].data[1].symbol).toBeUndefined();
    expect(series[0].markLine).toBeUndefined();
    expect(monthTooltip(months[2])).toBe(
      "<b>2026-11</b> (partial month)<br/>Scorer / TD recall: 0.93<br/>" +
        "Event recall: 0.90<br/>Risk AUC: 0.63<br/>PRs with failures: 189<br/>" +
        "Trunk landings caught: 1 of 3"
    );
    expect(monthTooltip(undefined)).toBe("");
  });

  it("opens the runs table, which shows report figures only when present", () => {
    const rows = [
      refit({
        run_id: "2",
        report_attempt: 0,
        created_at: "2026-11-01 00:00:00",
      }),
      refit({ run_id: "1" }),
    ];
    const { html, tables } = render({
      refits: { loading: false, rows },
      open: new Set(["runs"]),
    });
    expect(html).toContain('id="td-refit-runs"');
    expect(tables).toHaveLength(1);
    expect(refitTableRows(rows, NOW)).toEqual([
      {
        id: "2",
        day: "2026-11-01",
        outcome: "Published",
        failedStep: "-",
        minutes: "118 min",
        report: "Missing",
        pooled: "-",
        holdout: "-",
        days: "-",
        url: "https://github.com/pytorch/test-infra/actions/runs/2",
      },
      {
        id: "1",
        day: "2026-11-20",
        outcome: "Published",
        failedStep: "-",
        minutes: "118 min",
        report: "Uploaded",
        pooled: "97.4% (floor 60.0%: met)",
        holdout: "scorer 22, TD 23 of 34 (unsound)",
        days: "330 trained, 0 missing (2 gaps, 1 unhealthy)",
        url: "https://github.com/pytorch/test-infra/actions/runs/1",
      },
    ]);
  });

  it("notes the figures' attempt, an inconsistent report and a run without one", () => {
    const table = refitTableRows(
      [
        refit({ run_id: "3", refit_attempt: 2, report_attempt: 1 }),
        refit({ run_id: "2", passed: 0 }),
        refit({
          run_id: "1",
          refit_conclusion: "failure",
          refit_failed_step: "Install dependencies",
          report_upload: "",
          report_attempt: 0,
          report_infos: 0,
          report_valid: 0,
          passed: null,
        }),
      ],
      NOW
    );
    expect(table.map((row) => [row.outcome, row.report])).toEqual([
      ["Published", "Uploaded; figures from attempt 1"],
      ["Published", "Uploaded; inconsistent with the refit job"],
      ["Refit failed", "None (refit stopped before its report)"],
    ]);
  });

  it("names a failed query on its tiles", () => {
    const { html } = render({
      refits: { loading: false, error: "td_scorer_refits: boom", rows: [] },
    });
    expect(html).toContain("td_scorer_refits: boom");
  });
});
