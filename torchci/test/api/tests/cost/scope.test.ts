import { GET } from "app/api/tests/cost/scope/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import {
  costScopeUrl,
  decodeTrail,
  scopeEcho,
} from "lib/api/tests/cost/contracts";
import {
  compactScope,
  getCostScope,
  pieceOf,
  scopeDaysQuery,
  scopeQuery,
  scopeSide,
} from "lib/api/tests/cost/scope";
import { CostScopeSchema } from "lib/api/tests/cost/types";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const PAIR = decodeTrail("o:inductor;m:Linux%20x86_64%20avx512");
const A = { from: "2026-11-05", to: "2026-11-11" };
const B = { from: "2026-11-12", to: "2026-11-18" };

describe("the scope SQL", () => {
  test("one machine definition: the environment's, else the label's that ISO week, else Unknown machine", () => {
    for (const sql of [
      scopeQuery("sides", [], "m"),
      scopeQuery("days", PAIR, "f"),
    ]) {
      expect(sql).toContain("week_label_machines AS (");
      expect(sql).toContain("argMax(machine, (ms, machine)) AS machine");
      expect(sql).toMatch(
        /multiIf\(em\.machine != '', em\.machine, wl\.machine != '', wl\.machine,\s+'Unknown machine'\) AS machine/
      );
      expect(sql).toContain("ON wl.week = p.week AND wl.label = p.label");
      expect(sql).toContain("INNER JOIN env_machines AS m");
    }
    // The label machines read whole ISO weeks, so A/B and any range agree.
    expect(scopeQuery("sides", [], "m")).toContain(
      "day BETWEEN toMonday({a_from: Date}) AND toMonday({a_to: Date}) + 6"
    );
    expect(scopeQuery("days", [], "m")).toContain(
      "day BETWEEN toMonday({from: Date}) AND toMonday({to: Date}) + 6"
    );
  });

  test("joins only what the scope needs: no owners for machines at the root, no machines for owners", () => {
    expect(scopeQuery("sides", [], "o")).not.toContain("env_machines");
    expect(scopeQuery("sides", [], "o")).toContain("ARRAY JOIN owner_list");
    expect(scopeQuery("sides", [], "m")).not.toContain("owner_list");
    const pair = scopeQuery("sides", PAIR, "f");
    expect(pair).toContain("ARRAY JOIN owner_list AS owner");
    expect(pair).toContain(
      "WHERE machine = {pill_m: String} AND owner = {pill_o: String}"
    );
    expect(pair).toContain("/ length(owner_list)");
    const file = scopeQuery(
      "sides",
      [...PAIR, { dim: "f", value: "test/test_ops.py" }],
      "lane"
    );
    expect(file).toContain("AND test_file = {pill_f: String}");
    expect(file).toContain(
      "concat(toString(environments_id), '|', workflow) AS child"
    );
    expect(scopeQuery("sides", [], "label")).toContain(
      "concat(label, '|', workflow) AS child"
    );
  });

  test("test hours only for files and lanes", () => {
    for (const by of ["f", "lane"] as const) {
      expect(scopeQuery("sides", PAIR, by)).toContain("AS executed_hours");
    }
    for (const by of ["o", "m", "label"] as const) {
      expect(scopeQuery("sides", [], by)).not.toContain("executed");
    }
  });

  test("pieces: a side's days inside one ISO week and one month; a day in both sides counts in both", () => {
    const sides = scopeQuery("sides", [], "o");
    expect(sides).toContain("arrayJoin(arrayFilter(s -> s >= 0, [");
    expect(sides).toContain(
      "greatest(toMonday(day), toStartOfMonth(day),\n        if(side = 0, {a_from: Date}, {b_from: Date})) AS piece_from"
    );
    expect(sides).toContain("GROUP BY side, piece, child, label");
    expect(scopeQuery("days", [], "o")).toContain(
      "GROUP BY day_utc, child, label"
    );
  });

  test("day pieces ($) change only piece_from; week pieces (hours) stay the default", () => {
    const WEEK_PIECE = `greatest(toMonday(day), toStartOfMonth(day),
        if(side = 0, {a_from: Date}, {b_from: Date})) AS piece_from`;
    const FILE = [...PAIR, { dim: "f" as const, value: "test/test_ops.py" }];
    for (const [trail, by] of [
      [[], "o"],
      [[], "m"],
      [PAIR, "f"],
      [FILE, "lane"],
      [PAIR, "label"],
    ] as const) {
      const week = scopeQuery("sides", trail, by);
      expect(scopeQuery("sides", trail, by, "week")).toBe(week);
      expect(week).toContain(WEEK_PIECE);
      expect(scopeQuery("sides", trail, by, "day")).toBe(
        week.replace(WEEK_PIECE, "day AS piece_from")
      );
    }
    // A range's days have no pieces.
    expect(scopeQuery("days", PAIR, "f", "day")).toBe(
      scopeQuery("days", PAIR, "f")
    );
  });

  test("reads each day's latest computation, in the workflow scope, never by trigger", () => {
    for (const sql of [
      scopeQuery("sides", PAIR, "f"),
      scopeQuery("days", [], "o"),
    ]) {
      expect(sql).toContain("(day, computed_at) IN (");
      expect(sql).toContain("{workflows: Array(String)}");
      expect(sql).toContain("repo = {repo: String}");
      expect(sql).toContain("SETTINGS join_use_nulls = 0");
      expect(sql).not.toMatch(/GROUP BY[^)]*trigger/);
      expect(sql).not.toContain("OVER (");
    }
  });

  test("the days hold every day the rollup holds, filling as the trend says, with pushes to main", () => {
    const days = scopeDaysQuery("sides");
    expect(days).toContain(
      "max(computed_at) < addHours(toDateTime(day, 'UTC'), 27) AS filling"
    );
    expect(days).toContain("uniqExact(head_commit.id) AS pushes");
    expect(days).not.toContain("{workflows");
    expect(scopeDaysQuery("days")).toContain(
      "head_commit.timestamp < {to: Date} + 1"
    );
  });
});

describe("compactScope", () => {
  test("pieces end at the earliest of the week's Sunday, the month's end and the side's end", () => {
    expect(
      pieceOf(0, "2026-10-29", { from: "2026-10-29", to: "2026-11-18" })
    ).toEqual({
      side: 0,
      from: "2026-10-29",
      to: "2026-10-31",
    });
    expect(pieceOf(1, "2026-11-16", B)).toEqual({
      side: 1,
      from: "2026-11-16",
      to: "2026-11-18",
    });
    expect(pieceOf(1, "2026-11-12", B).to).toBe("2026-11-15");
  });

  test("a day piece is its one day, across week and month ends alike", () => {
    for (const day of ["2026-10-31", "2026-11-12", "2026-11-15"]) {
      expect(pieceOf(1, day, B, "day")).toEqual({
        side: 1,
        from: day,
        to: day,
      });
    }
    const rows = ["2026-11-12", "2026-11-13", "2026-11-16"].map((piece) => ({
      side: 1,
      piece,
      child: "a.py",
      label: "x",
      runner_hours: 1,
      main_runner_hours: 0,
    }));
    const out = compactScope("o", A, B, rows, [], "day");
    expect(out.pieces).toEqual([
      { side: 1, from: "2026-11-12", to: "2026-11-12" },
      { side: 1, from: "2026-11-13", to: "2026-11-13" },
      { side: 1, from: "2026-11-16", to: "2026-11-16" },
    ]);
    expect(out.cells).toEqual([
      [1, 0, 0, 0, 1, 0],
      [1, 1, 0, 0, 1, 0],
      [1, 2, 0, 0, 1, 0],
    ]);
  });

  test("children and labels most hours first; cells and test hours as sorted index tuples; sides from the days", () => {
    const rows = [
      {
        side: "0",
        piece: "2026-11-05",
        child: "a.py",
        label: "x",
        runner_hours: 1,
        main_runner_hours: 0.5,
        executed_hours: 0.25,
        skipped_hours: 0,
      },
      {
        side: "1",
        piece: "2026-11-16",
        child: "b.py",
        label: "y",
        runner_hours: 3,
        main_runner_hours: 0,
        executed_hours: 1,
        skipped_hours: 0.5,
      },
      {
        side: "1",
        piece: "2026-11-12",
        child: "a.py",
        label: "y",
        runner_hours: 0.5,
        main_runner_hours: 0,
        executed_hours: 0,
        skipped_hours: 0,
      },
      {
        side: "1",
        piece: "2026-11-12",
        child: "b.py",
        label: "x",
        runner_hours: 0,
        main_runner_hours: 0,
        executed_hours: 0.125,
        skipped_hours: 0,
      },
    ];
    const days = [
      { day_utc: "2026-11-18", filling: 1, pushes: "86" },
      { day_utc: "2026-11-05", filling: 0, pushes: 59 },
      {
        day_utc: "2026-11-12",
        filling: false,
        pushes: null as unknown as number,
      },
    ];
    const out = compactScope("f", A, B, rows, days);
    expect(out.children).toEqual(["b.py", "a.py"]);
    expect(out.labels).toEqual(["y", "x"]);
    expect(out.pieces).toEqual([
      { side: 0, from: "2026-11-05", to: "2026-11-08" },
      { side: 1, from: "2026-11-12", to: "2026-11-15" },
      { side: 1, from: "2026-11-16", to: "2026-11-18" },
    ]);
    expect(out.cells).toEqual([
      [0, 0, 1, 1, 1, 0.5],
      [1, 1, 1, 0, 0.5, 0],
      [1, 2, 0, 0, 3, 0],
    ]);
    // A row of skipped tests only adds test hours, never a 0 h cell.
    expect(out.tests).toEqual([
      [0, 1, 0.25, 0],
      [1, 0, 1.125, 0.5],
      [1, 1, 0, 0],
    ]);
    expect(out.sides).toEqual([
      { days: ["2026-11-05"], pushes: [59], filling: [] },
      {
        days: ["2026-11-12", "2026-11-18"],
        pushes: [0, 86],
        filling: ["2026-11-18"],
      },
    ]);
    expect(compactScope("o", A, B, rows, days).tests).toEqual([]);
  });

  test("a side with no days holds none", () => {
    expect(scopeSide([], A)).toEqual({ days: [], pushes: [], filling: [] });
  });
});

describe("getCostScope", () => {
  afterEach(() => jest.restoreAllMocks());

  test("asks the cells, the days and the children's details, none heavy, and echoes the request", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) =>
        id === "tests_cost_scope"
          ? [
              {
                side: 1,
                piece: "2026-11-12",
                child: "NVIDIA L4",
                label: "linux.g6.4xlarge.experimental.nvidia.gpu",
                runner_hours: 2,
                main_runner_hours: 1,
              },
              {
                side: 0,
                piece: "2026-11-05",
                child: "Unknown machine",
                label: "linux.2xlarge",
                runner_hours: 1,
                main_runner_hours: 0,
              },
            ]
          : id === "tests_cost_scope_days"
          ? [
              { day_utc: "2026-11-05", filling: 0, pushes: 59 },
              { day_utc: "2026-11-12", filling: 0, pushes: 73 },
            ]
          : id === "tests_cost_scope_machines"
          ? [
              {
                machine: "NVIDIA L4",
                family: "CUDA",
                device: "NVIDIA L4",
                cpu: "x86_64 avx512",
              },
              {
                machine: "NVIDIA A10G",
                family: "CUDA",
                device: "NVIDIA A10G",
                cpu: "x86_64 avx2",
              },
            ]
          : []
      );
    const params = {
      repo: "pytorch/pytorch",
      a: "2026-11-05..2026-11-11",
      b: "2026-11-12..2026-11-18",
      trail: decodeTrail("o:inductor"),
      by: "m" as const,
      workflow: ["pull", "trunk"],
      piece: "week" as const,
    };
    const answer = await getCostScope(params);
    expect(query.mock.calls.map((c) => c[2])).toEqual([
      "tests_cost_scope",
      "tests_cost_scope_days",
      "tests_cost_scope_machines",
    ]);
    expect(query.mock.calls[0][0]).toBe(scopeQuery("sides", params.trail, "m"));
    expect(query.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      a_from: "2026-11-05",
      a_to: "2026-11-11",
      b_from: "2026-11-12",
      b_to: "2026-11-18",
      workflows: ["pull", "trunk"],
      pill_o: "inductor",
    });
    expect(query.mock.calls.map((c) => c[4])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(CostScopeSchema.parse(answer)).toEqual(answer);
    expect(answer.children).toEqual(["NVIDIA L4", "Unknown machine"]);
    expect(answer.info).toEqual([
      {
        family: "CUDA",
        short: "L4",
        device: "NVIDIA L4",
        cpu: "x86_64 avx512",
      },
      {},
    ]);
    expect(scopeEcho(answer)).toBe(
      costScopeUrl(
        "pytorch/pytorch",
        ["trunk", "pull"],
        A,
        B,
        params.trail,
        "m"
      )
    );
    expect(answer.piece).toBe("week");
    expect(answer.pieces).toEqual([
      { side: 0, from: "2026-11-05", to: "2026-11-08" },
      { side: 1, from: "2026-11-12", to: "2026-11-15" },
    ]);
  });

  test("piece day asks day pieces and answers them, echoing piece=day", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) =>
        id === "tests_cost_scope"
          ? [
              {
                side: 1,
                piece: "2026-11-13",
                child: "inductor",
                label: "linux.2xlarge",
                runner_hours: 2,
                main_runner_hours: 1,
              },
            ]
          : []
      );
    const params = {
      repo: "pytorch/pytorch",
      a: "2026-11-05..2026-11-11",
      b: "2026-11-12..2026-11-18",
      trail: [],
      by: "o" as const,
      workflow: [],
      piece: "day" as const,
    };
    const answer = await getCostScope(params);
    expect(query.mock.calls[0][0]).toBe(scopeQuery("sides", [], "o", "day"));
    expect(answer.piece).toBe("day");
    expect(answer.pieces).toEqual([
      { side: 1, from: "2026-11-13", to: "2026-11-13" },
    ]);
    expect(CostScopeSchema.parse(answer)).toEqual(answer);
    const url = costScopeUrl("pytorch/pytorch", [], A, B, [], "o", "day");
    expect(url).toContain("&piece=day");
    expect(scopeEcho(answer)).toBe(url);
  });
});

function get(query: RawQuery) {
  return callRoute(GET, "/api/tests/cost/scope", query);
}

describe("app/api/tests/cost/scope", () => {
  afterEach(() => jest.restoreAllMocks());

  const ok = {
    repo: "pytorch/pytorch",
    a: "2026-11-05..2026-11-11",
    b: "2026-11-12..2026-11-18",
    trail: "o:inductor;m:Linux%20x86_64%20avx512",
    by: "f",
  };

  test.each([
    { ...ok, trail: "x:inductor" },
    { ...ok, trail: "o:inductor;o:dynamo" },
    { ...ok, trail: "o:" },
    { ...ok, trail: "o:Linux x86_64" },
    { ...ok, trail: "f:test/test_ops.py" },
    { ...ok, trail: "o:%E0%A4%A" },
    { ...ok, by: "x" },
    { ...ok, by: undefined },
    { ...ok, a: "2026-11-11..2026-11-05" },
    { ...ok, a: "2025-01-01..2026-11-18" },
    { ...ok, b: undefined },
    { ...ok, rates: "{}" },
    { ...ok, piece: "month" },
    { ...ok, piece: "2026-11-12" },
  ])(
    "rejects a bad trail, by, range or piece before querying %j",
    async (query) => {
      const scope = jest.spyOn(clickhouse, "queryClickhouse");
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      expect(scope).not.toHaveBeenCalled();
    }
  );

  test("answers the root for an empty trail, cached privately for ten minutes, echoing the URL", async () => {
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
    const res = await get({
      ...ok,
      trail: "",
      by: "o",
      workflow: ["trunk", "pull"],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=600");
    expect(res.body.trail).toEqual([]);
    expect(res.body.workflows).toEqual(["pull", "trunk"]);
    expect(scopeEcho(res.body)).toBe(
      costScopeUrl("pytorch/pytorch", ["pull", "trunk"], A, B, [], "o")
    );
    // Hours ask no piece: week pieces, a URL without piece.
    expect(res.body.piece).toBe("week");
    expect(scopeEcho(res.body)).not.toContain("piece");
  });

  test("piece=day: day pieces in the SQL, echoed", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockResolvedValue([]);
    const res = await get({ ...ok, trail: "", by: "o", piece: "day" });
    expect(res.status).toBe(200);
    expect(res.body.piece).toBe("day");
    expect(query.mock.calls[0][0]).toBe(scopeQuery("sides", [], "o", "day"));
    expect(scopeEcho(res.body)).toBe(
      costScopeUrl("pytorch/pytorch", [], A, B, [], "o", "day")
    );
  });

  test("an absent trail is the root", async () => {
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
    const { trail: _trail, ...rest } = ok;
    const res = await get({ ...rest, by: "o" });
    expect(res.status).toBe(200);
    expect(res.body.trail).toEqual([]);
  });

  test("logs query failures and answers 500 without details", async () => {
    jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockRejectedValue(new Error("private"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await get(ok);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to compute the scope's runner-hours",
      code: "internal_error",
    });
  });
});
