// The cost page V2 preview's URL (/cost/v2, lib/tests/cost/queryV2.ts): a
// bare URL is the defaults, choices round-trip, and an older link's
// highlight becomes the trail.
import { costApiUrl } from "lib/tests/cost/query";
import { costUrlParams, resolveCostQuery } from "lib/tests/cost/queryV2";
import { NOT_PROBED } from "lib/tests/cost/runnerHours";

describe("cost page V2 query", () => {
  test("a bare URL is the defaults and writes back bare", () => {
    const query = resolveCostQuery({});
    expect(query).toMatchObject({
      window: "7d",
      workflows: [],
      cells: "machine",
      only: false,
    });
    expect(query.trends.rollup).toBe("day");
    expect(query.drill.trail).toEqual([]);
    expect(
      Object.values(costUrlParams(query)).filter((v) => v !== undefined)
    ).toEqual([]);
  });

  test("choices round-trip; the PR preset is two workflow parameters", () => {
    const query = resolveCostQuery({
      workflow: ["pull", "Trunk"],
      owner: "inductor",
      machine: ["NVIDIA L4", NOT_PROBED],
      split_by: "none",
      cells: "hours",
      only: "1",
      organization: "pytorch",
    });
    expect(query).toMatchObject({
      workflows: ["pull", "trunk"],
      cells: "hours",
      only: true,
    });
    // An older link's highlight is the trail now: its first owner and machine.
    expect(query.drill.trail).toEqual([
      { dim: "o", value: "inductor" },
      { dim: "m", value: "NVIDIA L4" },
    ]);
    expect(resolveCostQuery(costUrlParams(query) as never)).toEqual(query);
    expect(costUrlParams(query).workflow).toEqual(["pull", "trunk"]);
    expect(costUrlParams(query).owner).toBeUndefined();
    expect(costUrlParams(query).machine).toBeUndefined();
    expect(resolveCostQuery({ cells: "x", only: "yes" })).toMatchObject({
      cells: "machine",
      only: false,
    });
    expect(costApiUrl("pytorch/pytorch", "3d")).toBe(
      "/api/tests/cost?repo=pytorch%2Fpytorch&window=3d"
    );
    expect(resolveCostQuery({ window: "3d" }).window).toBe("3d");
    expect(resolveCostQuery({ window: "14d" }).window).toBe("7d");
    expect(costUrlParams(resolveCostQuery({ window: "1d" })).window).toBe("1d");
  });
});
