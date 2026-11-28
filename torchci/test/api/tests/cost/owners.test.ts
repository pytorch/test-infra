// GET /api/tests/cost/owners (lib/api/tests/cost/owners.ts): the owner bars'
// SQL text (each day's latest computation, the week label machines /scope
// uses, the scope, the owner split), the query rows folded into the answer
// (days away into rows; with piece=day, cells that sum to their rows), the
// queries it asks, and the route's checks. Whether the SQL returns the right
// rows is measured in query-validation.md.

import { GET } from "app/api/tests/cost/owners/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import { costOwnersUrl, ownersEcho } from "lib/api/tests/cost/contracts";
import {
  compactOwners,
  getCostOwners,
  ownersDaysQuery,
  ownersQuery,
} from "lib/api/tests/cost/owners";
import {
  ENV_MACHINES,
  IN_SCOPE,
  latestDayRows,
  machinesQuery,
  weekLabelMachines,
} from "lib/api/tests/cost/query";
import { METHOD } from "lib/api/tests/cost/runnerHours";
import { DAYS, scopeDaysQuery, WEEKS } from "lib/api/tests/cost/scope";
import { CostOwnersSchema } from "lib/api/tests/cost/types";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const REPO = "pytorch/pytorch";
const RANGE = { from: "2026-11-16", to: "2026-11-18" };
const DAY_ROWS = [
  { day_utc: "2026-11-18", filling: 1 },
  { day_utc: "2026-11-16", filling: 0 },
  { day_utc: "2026-11-17", filling: 0 },
];
const row = (
  owner: string,
  machine: string,
  runner_hours: number,
  day_utc?: string,
  machine_source: "environment" | "runner_label" | "none" = machine === ""
    ? "none"
    : "environment"
) => ({
  owner,
  workflow: "pull",
  machine,
  machine_source,
  label: machine === "" ? "linux.idc.xpu" : "x",
  runner_hours,
  ...(day_utc === undefined ? {} : { day_utc }),
});

describe("ownersQuery", () => {
  test("each day's latest computation, the scope, and the week's label machines joined on week and label", () => {
    for (const byDay of [false, true]) {
      const sql = ownersQuery(byDay);
      expect(sql).toContain(latestDayRows(DAYS.days));
      expect(sql).toContain(ENV_MACHINES);
      expect(sql).toContain(weekLabelMachines(WEEKS.days));
      expect(sql).toContain(
        "LEFT JOIN week_label_machines AS wl ON wl.week = p.week AND wl.label = p.label"
      );
      expect(sql).toContain(IN_SCOPE);
      expect(sql).toContain("day BETWEEN {from: Date} AND {to: Date}");
      // GET /api/tests/cost's owner split and buckets, and its machine source.
      expect(sql).toContain(
        "multiIf(m.test_file = '', ['unattributed:no_test_reports'],\n      empty(o.owners), ['unattributed:no_owner'], o.owners) AS owner_list"
      );
      expect(sql).toContain("sum(ms / length(owner_list)) / 3600000");
      expect(sql).toContain(
        "multiIf(em.machine != '', 'environment',\n        wl.machine != '', 'runner_label', 'none') AS machine_source"
      );
      expect(sql).toContain("SETTINGS join_use_nulls = 0");
      // No file column: the answer has no contributors.
      expect(sql).not.toMatch(/label, file|AS file\b/);
      // Rounded in Node, cells only.
      expect(sql).not.toContain("round(");
      expect(sql.includes("day_utc")).toBe(byDay);
    }
    expect(ownersQuery(true)).toContain("toString(day_date) AS day_utc");
    expect(ownersQuery(true)).toMatch(
      /GROUP BY owner, workflow, machine, machine_source, label, day_utc\n/
    );
  });

  test("the days query reads /scope's days and filling, without pushes or the scope", () => {
    const sql = ownersDaysQuery();
    const filling =
      "max(computed_at) < addHours(toDateTime(day, 'UTC'), 27) AS filling";
    expect(sql).toContain(filling);
    expect(scopeDaysQuery("days")).toContain(filling);
    expect(sql).toContain(DAYS.days);
    expect(sql).not.toContain("push");
    expect(sql).not.toContain("workflows");
  });
});

describe("compactOwners", () => {
  test("folds days into rows, largest first; cells 4-dp, in day and row order, summing to their rows", () => {
    const rows = [
      row("inductor", "NVIDIA L4", 1.123456, "2026-11-17"),
      row("inductor", "NVIDIA L4", 2.000004, "2026-11-16"),
      row("dynamo", "", 0.5, "2026-11-18"),
      row("dynamo", "", 0, "2026-11-17"),
    ];
    const out = compactOwners(rows, DAY_ROWS, true);
    expect(out.days).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(out.filling).toEqual(["2026-11-18"]);
    expect(out.rows.map((r) => [r.owner, r.runner_hours])).toEqual([
      ["inductor", 1.123456 + 2.000004],
      ["dynamo", 0.5],
    ]);
    expect(out.cells).toEqual([
      [0, 0, 2],
      [1, 0, 1.1235],
      [2, 1, 0.5],
    ]);
    out.rows.forEach((r, i) => {
      const sum = out.cells
        .filter((c) => c[1] === i)
        .reduce((s, c) => s + c[2], 0);
      expect(Math.abs(sum - r.runner_hours)).toBeLessThan(0.0005);
    });
  });

  test("hours mode has no cells", () => {
    const out = compactOwners(
      [row("inductor", "NVIDIA L4", 3), row("dynamo", "", 1)],
      DAY_ROWS,
      false
    );
    expect(out.rows).toHaveLength(2);
    expect(out.cells).toEqual([]);
  });
});

describe("getCostOwners", () => {
  afterEach(() => jest.restoreAllMocks());

  test("asks the rows, the days and the machines, none heavy, and echoes the request", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) =>
        id === "tests_cost_owners"
          ? [
              row("inductor", "NVIDIA L4", 3, "2026-11-17"),
              row(
                "unattributed:no_test_reports",
                "NVIDIA L4",
                1,
                "2026-11-16",
                "runner_label"
              ),
              row("unattributed:no_test_reports", "", 2, "2026-11-16"),
            ]
          : id === "tests_cost_owners_days"
          ? DAY_ROWS
          : [
              {
                machine: "NVIDIA L4",
                family: "CUDA",
                device: "NVIDIA L4",
                cpu: "x86_64 avx2",
              },
            ]
      );
    const answer = await getCostOwners({
      repo: REPO,
      ...RANGE,
      workflow: ["pull", "trunk"],
      piece: "day",
    });
    expect(query.mock.calls.map((c) => c[2])).toEqual([
      "tests_cost_owners",
      "tests_cost_owners_days",
      "tests_cost_owners_machines",
    ]);
    expect(query.mock.calls[0][0]).toBe(ownersQuery(true));
    expect(query.mock.calls[1][0]).toBe(ownersDaysQuery());
    expect(query.mock.calls[2][0]).toBe(machinesQuery());
    expect(query.mock.calls[0][1]).toEqual({
      repo: REPO,
      ...RANGE,
      workflows: ["pull", "trunk"],
    });
    expect(query.mock.calls[1][1]).toEqual({ repo: REPO, ...RANGE });
    expect(query.mock.calls.map((c) => c[4])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(CostOwnersSchema.parse(answer)).toEqual(answer);
    expect(answer.piece).toBe("day");
    expect(answer.method).toBe(METHOD);
    expect(answer.machines.map((m) => m.machine)).toEqual(["NVIDIA L4"]);
    expect(answer.unprobed_labels).toEqual([
      { label: "linux.idc.xpu", runner_hours: 2 },
    ]);
    expect(answer.cells).toHaveLength(3);
    expect(ownersEcho(answer)).toBe(
      costOwnersUrl(REPO, ["pull", "trunk"], RANGE, "day")
    );
  });

  test("without piece, the unsplit query and no cells", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) =>
        id === "tests_cost_owners"
          ? [row("inductor", "NVIDIA L4", 3)]
          : id === "tests_cost_owners_days"
          ? DAY_ROWS
          : []
      );
    const answer = await getCostOwners({ repo: REPO, ...RANGE });
    expect(query.mock.calls[0][0]).toBe(ownersQuery(false));
    expect(query.mock.calls[0][1]).toEqual({
      repo: REPO,
      ...RANGE,
      workflows: [],
    });
    expect(answer.piece).toBeNull();
    expect(answer.workflows).toEqual([]);
    expect(answer.cells).toEqual([]);
    expect(ownersEcho(answer)).toBe(costOwnersUrl(REPO, [], RANGE));
  });
});

function get(query: RawQuery) {
  return callRoute(GET, "/api/tests/cost/owners", query);
}

describe("app/api/tests/cost/owners", () => {
  afterEach(() => jest.restoreAllMocks());

  const ok = { repo: REPO, from: "2026-11-12", to: "2026-11-18" };

  test.each([
    { ...ok, from: "2026-11-19" },
    { ...ok, from: "2025-10-01" },
    { ...ok, from: "2026-02-30" },
    { ...ok, to: undefined },
    { ...ok, piece: "week" },
  ])("rejects a bad range or piece before querying %j", async (query) => {
    const spy = jest.spyOn(clickhouse, "queryClickhouse");
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_parameters");
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(spy).not.toHaveBeenCalled();
  });

  test("names to in a range too long", async () => {
    const res = await get({ ...ok, from: "2025-01-01" });
    expect(res.body.issues).toEqual([
      { path: ["to"], message: "from..to must span at most 400 days" },
    ]);
  });

  test("answers, cached privately for ten minutes, echoing the URL with piece=day", async () => {
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
    const res = await get({
      ...ok,
      workflow: ["trunk", "pull"],
      piece: "day",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=600");
    expect(ownersEcho(res.body)).toBe(
      costOwnersUrl(REPO, ["pull", "trunk"], ok, "day")
    );
  });
});
