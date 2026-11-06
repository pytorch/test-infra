// What changed, from the example answer beside this file (changes.json, an
// answer of GET /api/tests/cost/changes for inductor over trend.json's A and
// B) and rates.json, worked by hand: inductor ran 14 h a day in A (10 on L4,
// 4 on A10G, which rates.json leaves unpriced) and 16 in B (12 and 4); of
// those, pushes to main ran 4 h a day in A (3 on L4) and 5 in B (4 on L4),
// over 10 pushes a day in A and 8 in B. The changes agree with the trend's
// inductor row per day and per commit, in runner-hours and in $; at $1 an
// hour they are the runner-hours; the machines' rows, and each machine's
// runners, sum to the change, as the machine table's rows do, folded past
// the largest few or not.

import {
  type CostChanges,
  CostChangesSchema,
  CostTrendSchema,
} from "lib/api/tests/cost/types";
import {
  changeDays,
  changeSummary,
  changeWord,
  foldChanges,
  labelMachines,
  machineChanges,
  machineLines,
  TOP_MACHINE_ROWS,
} from "lib/tests/cost/changes";
import { parseRates } from "lib/tests/cost/rates";
import { NOT_PROBED, prepareRunnerHours } from "lib/tests/cost/runnerHours";
import {
  DEFAULT_TREND_SORT,
  prepareTrend,
  rangeDates,
  trendRows,
} from "lib/tests/cost/trend";
import ANSWER_JSON from "./answer.json";
import CHANGES_JSON from "./changes.json";
import RATES_JSON from "./rates.json";
import TREND_JSON from "./trend.json";

const changes = CostChangesSchema.parse(CHANGES_JSON);
const rates = parseRates(JSON.stringify(RATES_JSON), "rates.json");
const L4 = "mt-l-x86aavx2-11-41-l4";
const A10G = "mt-l-x86aavx2-11-41-a10g";
// Every label at $1 an hour.
const one = parseRates(
  JSON.stringify(Object.fromEntries(changes.labels.map((l) => [l, 1]))),
  "one.json"
);
// Both labels priced, so B's mix of machines costs more an hour than A's.
const both = parseRates(
  JSON.stringify({ [L4]: 1.25, [A10G]: 0.5 }),
  "both.json"
);
// Both labels' machines, as the cost answer names them.
const MACHINES = new Map([
  [L4, "NVIDIA L4"],
  [A10G, "NVIDIA A10G"],
]);

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("the example changes answer", () => {
  test("holds 98 runner-hours in A and 112 in B, of them 28 and 35 of pushes to main", () => {
    for (const [side, hours, main] of [
      [0, 98, 28],
      [1, 112, 35],
    ]) {
      const mine = changes.cells.filter((c) => c[0] === side);
      expect(sum(mine.map((c) => c[2]))).toBe(hours);
      expect(sum(mine.map((c) => c[3]))).toBe(main);
    }
  });

  test("covers trend.json's A and B: 7 days with data each, 70 and 56 pushes to main", () => {
    const trend = prepareTrend(CostTrendSchema.parse(TREND_JSON));
    expect(rangeDates(trend, { from: 0, to: 6 })).toEqual(changes.a);
    expect(rangeDates(trend, { from: 7, to: 13 })).toEqual(changes.b);
    expect(changeDays(changes)).toEqual({
      aDays: 7,
      bDays: 7,
      aPushes: 70,
      bPushes: 56,
    });
  });

  test("a day in both periods counts in both", () => {
    const overlap = { ...changes, a: { from: "2026-10-22", to: "2026-11-04" } };
    expect(changeDays(overlap)).toMatchObject({ aDays: 14, aPushes: 126 });
  });
});

describe("changeSummary", () => {
  test("agrees with the trend's inductor row per day and per commit, in runner-hours and in $", () => {
    const trend = prepareTrend(CostTrendSchema.parse(TREND_JSON));
    const A = { from: 0, to: 6 };
    const B = { from: 7, to: 13 };
    for (const per of ["day", "commit"] as const) {
      for (const r of [null, rates]) {
        const row = trendRows(
          trend,
          r,
          A,
          B,
          new Set(),
          DEFAULT_TREND_SORT,
          false,
          undefined,
          per
        ).find((x) => x.key === "inductor")!;
        const s = changeSummary(changes, r, per);
        expect([per, s.aPer, s.bPer]).toEqual([per, row.aPer, row.bPer]);
        expect(s.b).toEqual(row.b);
      }
    }
    // 14 h to 16 h a day; at rates.json's $1.25 an L4 hour, $12.50 to $15.
    expect(changeSummary(changes, null)).toMatchObject({
      aPer: 14,
      bPer: 16,
      delta: 2,
    });
    expect(changeSummary(changes, rates)).toMatchObject({
      aPer: 12.5,
      bPer: 15,
      delta: 2.5,
      change: 0.2,
    });
    // 28 push:main hours over 70 pushes, 35 over 56: 0.4 h to 0.625 h a
    // commit; $26.25 and $35 of L4 hours, $0.375 to $0.625.
    expect(changeSummary(changes, null, "commit")).toMatchObject({
      aPer: 0.4,
      bPer: 0.625,
    });
    expect(changeSummary(changes, rates, "commit")).toMatchObject({
      aPer: 0.375,
      bPer: 0.625,
      delta: 0.25,
    });
  });

  test("in $, the change is more runner-hours plus pricier machines; in hours, neither", () => {
    // A: 10 L4 hours at $1.25 and 4 A10G at $0.50, $14.50 over 14 priced
    // hours a day; B: $17 over 16. More hours at A's $1.0357 an hour is
    // $2.0714; B's 16 hours at $0.0268 more an hour, $0.4286.
    const s = changeSummary(changes, both);
    expect(s.delta).toBeCloseTo(2.5, 10);
    expect(s.volume).toBeCloseTo((2 * 14.5) / 14, 10);
    expect(s.mix).toBeCloseTo(16 * (17 / 16 - 14.5 / 14), 10);
    expect(s.volume! + s.mix!).toBeCloseTo(s.delta, 10);
    const commit = changeSummary(changes, both, "commit");
    expect(commit.volume! + commit.mix!).toBeCloseTo(commit.delta, 10);
    // rates.json prices only L4, at the same $1.25 in A and B: all volume.
    expect(changeSummary(changes, rates)).toMatchObject({
      volume: 2.5,
      mix: 0,
    });
    expect(changeSummary(changes, null)).toMatchObject({
      volume: null,
      mix: null,
    });
  });

  test("pushes to main: per day, and per commit beside a per-day change", () => {
    const push = changeSummary(changes, null).push!;
    expect(push).toMatchObject({
      aPushesPerDay: 10,
      bPushesPerDay: 8,
      aPerPush: 0.4,
      bPerPush: 0.625,
    });
    expect(push.change).toBeCloseTo(0.5625, 10);
  });

  test("without pushes there is no per-commit figure", () => {
    const quiet = {
      ...changes,
      days: changes.days.map(([d]) => [d, 0] as [string, number]),
    };
    expect(changeSummary(quiet, null).push).toBeNull();
    expect(changeSummary(quiet, null, "commit")).toMatchObject({
      aPer: 0,
      bPer: 0,
    });
  });
});

describe("machines", () => {
  test("each runner label's machine is the one the cost answer gave the most of its runner-hours", () => {
    const prepared = prepareRunnerHours(ANSWER_JSON as never);
    const machineOf = labelMachines(prepared);
    expect(machineOf.size).toBeGreaterThan(0);
    for (const [label, machine] of machineOf) {
      const hours = new Map<string, number>();
      for (let i = 0; i < prepared.rowLabel.length; i++) {
        if (prepared.runnerLabels[prepared.rowLabel[i]] !== label) continue;
        const m = prepared.machines[prepared.rowMachine[i]];
        hours.set(m, (hours.get(m) ?? 0) + prepared.rowRunnerHours[i]);
      }
      expect(hours.get(machine)).toBe(Math.max(...hours.values()));
    }
  });

  test("the change by machine, largest in B first, its runners under it, Unknown machine last", () => {
    const machineOf = new Map([[L4, "NVIDIA L4"]]);
    const rows = machineChanges(changes, null, "day", machineOf);
    expect(
      rows.map((m) => [
        m.machine,
        m.row.aPer,
        m.row.bPer,
        m.runners.map((r) => r.name),
      ])
    ).toEqual([
      ["NVIDIA L4", 10, 12, [L4]],
      [NOT_PROBED, 4, 4, [A10G]],
    ]);
    // Per commit: 3 L4 push:main hours a day over 10 pushes, 4 over 8.
    const commit = machineChanges(changes, null, "commit", machineOf);
    expect([commit[0].row.aPer, commit[0].row.bPer]).toEqual([0.3, 0.5]);
    expect(sum(commit.map((m) => m.row.delta))).toBeCloseTo(
      changeSummary(changes, null, "commit").delta,
      10
    );
  });

  test("every machine together is the whole change, and each machine its runners', per day and per commit, in runner-hours and in $", () => {
    for (const per of ["day", "commit"] as const) {
      for (const r of [null, rates, both]) {
        const whole = changeSummary(changes, r, per);
        const machines = machineChanges(changes, r, per, MACHINES);
        const all = foldChanges(
          "all",
          "All machines",
          machines.map((m) => m.row)
        );
        expect(all.aPer).toBeCloseTo(whole.aPer, 10);
        expect(all.bPer).toBeCloseTo(whole.bPer, 10);
        expect(all.delta).toBeCloseTo(whole.delta, 10);
        expect(all.b).toEqual(whole.b);
        for (const m of machines) {
          expect(sum(m.runners.map((x) => x.delta))).toBeCloseTo(
            m.row.delta,
            10
          );
        }
      }
    }
  });

  test("per day, L4 ran 10 h then 12 and A10G 4 and 4; at $1 an hour, the $ are the runner-hours", () => {
    const perDay = (r: typeof one | null, per: "day" | "commit" = "day") =>
      machineChanges(changes, r, per, MACHINES).map((m) => [
        m.machine,
        m.row.aPer,
        m.row.bPer,
      ]);
    expect(perDay(null)).toEqual([
      ["NVIDIA L4", 10, 12],
      ["NVIDIA A10G", 4, 4],
    ]);
    for (const per of ["day", "commit"] as const) {
      expect(perDay(one, per)).toEqual(perDay(null, per));
    }
  });

  test("in $, a machine rates.json has no rate for is unpriced, not free", () => {
    const a10g = machineChanges(changes, rates, "day", MACHINES)[1];
    expect(a10g.machine).toBe("NVIDIA A10G");
    expect([a10g.row.aPer, a10g.row.bPer]).toEqual([0, 0]);
    expect(a10g.row.a.unpriced).toBe(28);
    expect(a10g.row.b.unpriced).toBe(28);
  });

  test("foldChanges: each side summed, totals too; the change against A's sum, none where A had nothing", () => {
    const [l4, a10g] = machineChanges(changes, rates, "day", MACHINES);
    const both = foldChanges("other", "Other machines", [l4.row, a10g.row]);
    expect(both).toMatchObject({
      key: "other",
      name: "Other machines",
      aPer: 12.5,
      bPer: 15,
      delta: 2.5,
      change: 0.2,
    });
    expect(both.a.unpriced).toBe(28);
    expect(foldChanges("none", "None", [])).toMatchObject({
      aPer: 0,
      bPer: 0,
      delta: 0,
      change: null,
    });
  });
});

describe("the machine table's rows", () => {
  // Nine machines over the example's days (7 with data on each side, 70
  // and 56 pushes): M1 to M6 colored, O1 and O2 not, and a label no machine
  // is known for. Runner-hours a side, a seventh of which is a day; pushes
  // to main ran half of each.
  const HOURS: [string, string | null, number, number][] = [
    ["m1", "M1", 63, 70],
    ["m2", "M2", 56, 56],
    ["m3", "M3", 49, 42],
    ["m4", "M4", 28, 35],
    ["m5", "M5", 28, 28],
    ["m6", "M6", 14, 21],
    ["o1", "O1", 21, 14],
    ["o2", "O2", 0, 7],
    ["u", null, 7, 7],
  ];
  const many: CostChanges = {
    ...changes,
    labels: HOURS.map(([label]) => label),
    cells: HOURS.flatMap(([, , a, b], l) => [
      ...(a > 0 ? [[0, l, a, a / 2] as [number, number, number, number]] : []),
      [1, l, b, b / 2] as [number, number, number, number],
    ]),
  };
  const machineOf = new Map(
    HOURS.filter(([, m]) => m !== null).map(([l, m]) => [l, m!])
  );
  const colored = (m: string) => m.startsWith("M") || m === NOT_PROBED;
  const lines = (expanded: boolean, top?: number, r = null, per = "day") =>
    machineLines(
      machineChanges(many, r, per as "day" | "commit", machineOf),
      colored,
      expanded,
      top
    );
  const words = (ls: ReturnType<typeof lines>) =>
    ls.map((l) => [l.label, l.kind, l.row.aPer, l.row.bPer]);

  test("every machine, the colored ones, the others together and Unknown machine; past the top 5, the rest folded", () => {
    expect(TOP_MACHINE_ROWS).toBe(5);
    expect(words(lines(false))).toEqual([
      ["All machines", "all", 38, 40],
      ["M1", "machine", 9, 10],
      ["M2", "machine", 8, 8],
      ["M3", "machine", 7, 6],
      ["M4", "machine", 4, 5],
      ["M5", "machine", 4, 4],
      // M6, the others (O1, O2) and Unknown machine: 2 + 3 + 0 + 1 a day in
      // A, 3 + 2 + 1 + 1 in B.
      ["4 more machines", "more", 6, 7],
    ]);
    const more = lines(false)[6];
    expect(more.machines.map((m) => m.machine)).toEqual([
      "M6",
      "O1",
      "O2",
      NOT_PROBED,
    ]);
    expect([more.row.delta, more.row.change]).toEqual([1, 1 / 6]);
  });

  test("listed, every row and one that folds them back; it stands for no machine", () => {
    expect(words(lines(true))).toEqual([
      ["All machines", "all", 38, 40],
      ["M1", "machine", 9, 10],
      ["M2", "machine", 8, 8],
      ["M3", "machine", 7, 6],
      ["M4", "machine", 4, 5],
      ["M5", "machine", 4, 4],
      ["M6", "machine", 2, 3],
      ["Other machines (2)", "group", 3, 3],
      [NOT_PROBED, "machine", 1, 1],
      ["Show fewer", "less", 0, 0],
    ]);
    const group = lines(true)[7];
    expect(group.machines.map((m) => m.machine)).toEqual(["O1", "O2"]);
  });

  test("never one row folded: with room for all but one, every row shows and none folds back", () => {
    // M1 to M6, the others, then Unknown machine.
    for (const expanded of [false, true]) {
      expect(lines(expanded, 7).map((l) => l.kind)).toEqual([
        "all",
        ...Array(6).fill("machine"),
        "group",
        "machine",
      ]);
    }
    // Two rows past the top fold: the others and Unknown machine, 3
    // machines, 3 + 0 + 1 a day in A and 2 + 1 + 1 in B.
    expect(words(lines(false, 6)).slice(7)).toEqual([
      ["3 more machines", "more", 4, 4],
    ]);
    // inductor's two machines never fold.
    expect(
      machineLines(
        machineChanges(changes, null, "day", MACHINES),
        () => true,
        false
      ).map((l) => l.label)
    ).toEqual(["All machines", "NVIDIA L4", "NVIDIA A10G"]);
  });

  test("the rows under every machine sum to it, folded or listed, per day and per commit, in runner-hours and in $", () => {
    const half = parseRates(
      JSON.stringify(Object.fromEntries(HOURS.map(([l]) => [l, 0.5]))),
      "half.json"
    );
    for (const r of [null, half, rates]) {
      for (const per of ["day", "commit"] as const) {
        for (const [expanded, top] of [
          [false, 5],
          [true, 5],
          [false, 1],
          [false, 6],
          [true, 0],
        ] as const) {
          const [all, ...rest] = machineLines(
            machineChanges(many, r, per, machineOf),
            colored,
            expanded,
            top
          );
          for (const field of ["aPer", "bPer", "delta"] as const) {
            expect([field, sum(rest.map((l) => l.row[field]))]).toEqual([
              field,
              expect.closeTo(all.row[field], 10),
            ]);
          }
        }
      }
    }
  });
});

describe("changeWord", () => {
  test("new where A had none, gone where B has none", () => {
    expect(changeWord({ delta: 3, change: null, bPer: 3 })).toBe("new");
    expect(changeWord({ delta: -2, change: -1, bPer: 0 })).toBe("gone");
    expect(changeWord({ delta: 1, change: 0.125, bPer: 9 })).toBe("▲ +13%");
    expect(changeWord({ delta: -2, change: -0.5, bPer: 2 })).toBe("▼ −50%");
  });

  test("no change is a dash; a sliver is under 1%", () => {
    expect(changeWord({ delta: 0, change: 0, bPer: 3 })).toBe("—");
    expect(changeWord({ delta: 0.001, change: 0.001, bPer: 1 })).toBe("▲ <1%");
    expect(changeWord({ delta: -0.001, change: -0.001, bPer: 1 })).toBe(
      "▼ <1%"
    );
  });
});
