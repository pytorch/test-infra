// The cost page's URL: the trends' and drill-down's state round-trips
// through it with defaults left off, an older link's highlight becomes a
// trail, and the page's one writer (useCostUrl) merges a tick's patches and
// starts each write from the one still in flight.

import {
  costChoices,
  type CostQuery,
  costUrlParams,
  parseDayRange,
  resolveCostQuery,
} from "lib/tests/cost/queryV2";
import {
  applyPatch,
  type CostRouter,
  costUrlWriter,
  useCostUrl,
} from "lib/tests/cost/urlState";

jest.mock("next/router", () => {
  const router = {
    pathname: "/tests/[organization]/[repo]/cost",
    query: { organization: "pytorch", repo: "pytorch" },
    push: jest.fn(() => Promise.resolve(true)),
    replace: jest.fn(() => Promise.resolve(true)),
  };
  return { __esModule: true, default: router };
});

const written = (query: CostQuery) =>
  Object.fromEntries(
    Object.entries(costUrlParams(query)).filter(([, v]) => v !== undefined)
  );
const roundTrip = (query: CostQuery) =>
  resolveCostQuery(costUrlParams(query) as never);

describe("cost page URL", () => {
  test("a bare URL is the defaults and writes back bare", () => {
    const query = resolveCostQuery({
      organization: "pytorch",
      repo: "pytorch",
    });
    expect(query.trends).toEqual({
      rollup: "day",
      show: null,
      cmp: null,
      a: null,
      b: null,
      per: "day",
      unit: "hours",
    });
    expect(query.drill).toEqual({
      trail: [],
      root: "m",
      chg: "h",
      sort: "change",
      more: [],
      tests: false,
      cfg: null,
      cases: null,
      rank: null,
    });
    expect(written(query)).toEqual({});
  });

  test("a preset writes cmp alone; a and b win over it and drop it", () => {
    const preset = resolveCostQuery({ cmp: "7v7" });
    expect(preset.trends.cmp).toBe("7v7");
    expect(written(preset)).toEqual({ cmp: "7v7" });
    // The rollup's own default is left off.
    expect(written(resolveCostQuery({ cmp: "dod" }))).toEqual({});
    expect(written(resolveCostQuery({ rollup: "week", cmp: "wow" }))).toEqual({
      rollup: "week",
    });
    expect(written(resolveCostQuery({ rollup: "week", cmp: "dod" }))).toEqual({
      rollup: "week",
      cmp: "dod",
    });
    const ranges = resolveCostQuery({
      cmp: "7v7",
      a: "2026-11-05..2026-11-11",
      b: "2026-11-12..2026-11-18",
    });
    expect(ranges.trends).toMatchObject({
      cmp: null,
      a: { from: "2026-11-05", to: "2026-11-11" },
      b: { from: "2026-11-12", to: "2026-11-18" },
    });
    expect(written(ranges)).toEqual({
      a: "2026-11-05..2026-11-11",
      b: "2026-11-12..2026-11-18",
    });
    // A patch that sets a and b leaves cmp in the query; the URL drops it.
    expect(
      written(
        applyPatch(preset, {
          trends: {
            a: { from: "2026-11-17", to: "2026-11-17" },
            b: { from: "2026-11-18", to: "2026-11-18" },
          },
        })
      )
    ).toEqual({ a: "2026-11-17", b: "2026-11-18" });
  });

  test("ranges: one day alone, malformed or backwards ones dropped, an A before the data kept", () => {
    expect(parseDayRange("2026-11-17")).toEqual({
      from: "2026-11-17",
      to: "2026-11-17",
    });
    for (const bad of [
      "2026-11-18..2026-11-12",
      "2026-13-01",
      "2026-02-30",
      "2026-11-01..2026-11-02..2026-11-03",
      "yesterday",
      "",
    ]) {
      expect(parseDayRange(bad)).toBeNull();
    }
    const predata = resolveCostQuery({
      a: "2026-10-20..2026-10-26",
      b: "2026-11-12..2026-11-18",
    });
    expect(predata.trends.a).toEqual({ from: "2026-10-20", to: "2026-10-26" });
    expect(roundTrip(predata)).toEqual(predata);
    expect(written(predata).a).toBe("2026-10-20..2026-10-26");
  });

  test("every trends and drill choice round-trips", () => {
    const query = resolveCostQuery({
      workflow: ["pull", "Trunk"],
      rollup: "week",
      show: "13",
      b: "2026-11-09..2026-11-15",
      per: "commit",
      unit: "usd",
      trail:
        "o:inductor;m:Linux%20x86_64%20avx512;f:test%2Finductor%2Ftest_flex_attention.py",
      chg: "pct",
      sort: "grew",
      more: "f,o",
      tests: "1",
      cfg: "123:456",
      cases: "slower",
      rank: "day",
      cells: "hours",
      only: "1",
      window: "3d",
    });
    expect(query).toMatchObject({
      workflows: ["pull", "trunk"],
      trends: { rollup: "week", show: 13, per: "commit", unit: "usd", a: null },
      drill: {
        trail: [
          { dim: "o", value: "inductor" },
          { dim: "m", value: "Linux x86_64 avx512" },
          { dim: "f", value: "test/inductor/test_flex_attention.py" },
        ],
        root: "o",
        chg: "pct",
        sort: "grew",
        more: ["o", "f"],
        tests: true,
        cfg: "123:456",
        cases: "slower",
        rank: "day",
      },
    });
    expect(roundTrip(query)).toEqual(query);
    expect(written(query).more).toBe("o,f");
    // Machines first is the default, so root=o is written, and only while the
    // trail is empty; a trail led by a machine implies root=m.
    expect(written(resolveCostQuery({ root: "m" }))).toEqual({});
    const owners = resolveCostQuery({ root: "o" });
    expect(owners.drill.root).toBe("o");
    expect(written(owners)).toEqual({ root: "o" });
    const led = resolveCostQuery({ trail: "m:NVIDIA%20L4", root: "m" });
    expect(led.drill.root).toBe("m");
    expect(written(led)).toEqual({ trail: "m:NVIDIA%20L4" });
    expect(roundTrip(led)).toEqual(led);
  });

  test("bad values fall back to the defaults", () => {
    const query = resolveCostQuery({
      rollup: "year",
      show: "500",
      cmp: "yoy",
      per: "week",
      unit: "eur",
      root: "f",
      chg: "x",
      sort: "z",
      more: "x,o",
      tests: "yes",
      cfg: "12",
      cases: "all",
      rank: "week",
    });
    expect(written(query)).toEqual({ more: "o" });
    // Show is per rollup: 90 days is fine, 90 weeks is not.
    expect(resolveCostQuery({ show: "90" }).trends.show).toBe(90);
    expect(resolveCostQuery({ rollup: "week", show: "90" }).trends.show).toBe(
      null
    );
    expect(resolveCostQuery({ show: "42" }).trends.show).toBeNull();
  });

  test("an older link's highlight becomes the trail, as written; a trail wins over it", () => {
    const legacy = resolveCostQuery({
      owner: ["inductor", "dynamo"],
      machine: "Linux x86_64 avx512",
    });
    expect(legacy.drill.trail).toEqual([
      { dim: "o", value: "inductor" },
      { dim: "m", value: "Linux x86_64 avx512" },
    ]);
    const params = costUrlParams(legacy);
    expect(params.owner).toBeUndefined();
    expect(params.machine).toBeUndefined();
    expect(params.trail).toBe("o:inductor;m:Linux%20x86_64%20avx512");
    // A name no answer holds is kept: the drill decides once its answers are in.
    expect(
      resolveCostQuery({ machine: "Nonexistent machine" }).drill.trail
    ).toEqual([{ dim: "m", value: "Nonexistent machine" }]);
    expect(resolveCostQuery({ machine: "NVIDIA L4" }).drill.root).toBe("m");
    expect(
      resolveCostQuery({ trail: "o:dynamo", owner: "inductor" }).drill.trail
    ).toEqual([{ dim: "o", value: "dynamo" }]);
    // The matrix highlights the trail's owner and machine.
    expect(costChoices(legacy)).toEqual({
      workflows: [],
      owners: ["inductor"],
      machines: ["Linux x86_64 avx512"],
    });
  });
});

describe("useCostUrl", () => {
  function stubRouter(query: Record<string, string | string[]> = {}) {
    let finish: () => void = () => {};
    const router = {
      pathname: "/tests/[organization]/[repo]/cost",
      query: { organization: "pytorch", repo: "pytorch", ...query },
      push: jest.fn(),
      // Each write stays in flight until finish(): the router's query keeps
      // its old value meanwhile, as Next's does.
      replace: jest.fn(
        (
          url: { query: Record<string, string | string[]> },
          _as?: unknown,
          _options?: unknown
        ) =>
          new Promise<boolean>((resolve) => {
            finish = () => {
              router.query = url.query as typeof router.query;
              resolve(true);
            };
          })
      ),
    };
    return { router, finish: () => finish() };
  }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const lastQuery = (fn: jest.Mock) =>
    (fn.mock.calls[fn.mock.calls.length - 1][0] as { query: object }).query;

  test("two patches in one tick write once, with both", async () => {
    const { router } = stubRouter({ owner: "inductor", split_by: "none" });
    const write = costUrlWriter(router as unknown as CostRouter);
    write({ trends: { per: "commit" } });
    write({ drill: { chg: "pct" } });
    expect(router.replace).not.toHaveBeenCalled();
    await tick();
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
    expect(lastQuery(router.replace)).toEqual({
      organization: "pytorch",
      repo: "pytorch",
      per: "commit",
      chg: "pct",
      // The older link's owner moved into the trail; split_by is retired.
      trail: "o:inductor",
    });
    expect(router.replace.mock.calls[0][2]).toEqual({
      shallow: true,
      scroll: false,
    });
  });

  test("a patch during an in-flight write starts from it, not the router's old query", async () => {
    const { router, finish } = stubRouter();
    const write = costUrlWriter(router as unknown as CostRouter);
    write({ drill: { trail: [{ dim: "o", value: "inductor" }] } });
    await tick();
    // The router still reads the old query; the first write is in flight.
    expect(router.query).not.toHaveProperty("trail");
    write({ trends: { cmp: "7v7" } });
    await tick();
    expect(router.replace).toHaveBeenCalledTimes(2);
    expect(lastQuery(router.replace)).toMatchObject({
      trail: "o:inductor",
      cmp: "7v7",
    });
    finish();
    await tick();
    write({ drill: { sort: "b" } });
    await tick();
    expect(lastQuery(router.replace)).toMatchObject({
      trail: "o:inductor",
      cmp: "7v7",
      sort: "b",
    });
  });

  test("a workflow scope pushes a history entry; the hook shares one writer", async () => {
    const { router } = stubRouter();
    const write = costUrlWriter(router as unknown as CostRouter);
    write({ workflows: ["pull", "trunk"] }, "push");
    write({ drill: { trail: [] } });
    await tick();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    expect(lastQuery(router.push)).toMatchObject({
      workflow: ["pull", "trunk"],
    });
    expect(useCostUrl()).toBe(useCostUrl());
    const Router = jest.requireMock("next/router").default;
    useCostUrl()({ trends: { unit: "usd" } });
    await tick();
    expect(lastQuery(Router.replace)).toMatchObject({ unit: "usd" });
  });
});
