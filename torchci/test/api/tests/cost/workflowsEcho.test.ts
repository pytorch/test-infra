// A workflow scope through each scoped route: the page asks with the
// workflows sorted, a hand-written URL may list them in any order, and every
// answer echoes them sorted, so the echo rebuilds the page's URL (current()).
import { GET as coverageRoute } from "app/api/tests/cost/coverage/route";
import { GET as scopeRoute } from "app/api/tests/cost/scope/route";
import { GET as seriesRoute } from "app/api/tests/cost/series/route";
import { GET as trendRoute } from "app/api/tests/cost/trend/route";
import type { RawQuery } from "lib/api/parameters";
import {
  costCoverageUrl,
  costScopeUrl,
  costSeriesUrl,
  costTrendDaysUrl,
  coverageEcho,
  decodeTrail,
  scopeEcho,
  seriesEcho,
  trendEcho,
} from "lib/api/tests/cost/contracts";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";

jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const REPO = "pytorch/pytorch";
const PR = ["trunk", "pull"];
const SORTED = ["pull", "trunk"];
const A = { from: "2026-11-05", to: "2026-11-11" };
const B = { from: "2026-11-12", to: "2026-11-18" };
const TRAIL = decodeTrail("o:inductor");

describe("scoped routes echo the scope sorted", () => {
  beforeEach(() => {
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
  });
  afterEach(() => jest.restoreAllMocks());

  const ask = async (
    route: Parameters<typeof callRoute>[0],
    path: string,
    query: RawQuery
  ) => {
    const res = await callRoute(route, path, { ...query, workflow: PR });
    expect(res.status).toBe(200);
    expect(res.body.workflows).toEqual(SORTED);
    return res.body;
  };

  test("trend", async () => {
    const body = await ask(trendRoute, "/api/tests/cost/trend", {
      repo: REPO,
      rollup: "day",
      periods: "49",
    });
    expect(trendEcho(body)).toBe(costTrendDaysUrl(REPO, PR, 49));
  });

  test("scope, in hours and in $ (day pieces)", async () => {
    for (const piece of [undefined, "day"] as const) {
      const body = await ask(scopeRoute, "/api/tests/cost/scope", {
        repo: REPO,
        a: `${A.from}..${A.to}`,
        b: `${B.from}..${B.to}`,
        trail: "o:inductor",
        by: "m",
        ...(piece === undefined ? {} : { piece }),
      });
      expect(scopeEcho(body)).toBe(
        costScopeUrl(REPO, PR, A, B, TRAIL, "m", piece)
      );
    }
  });

  test("series", async () => {
    const body = await ask(seriesRoute, "/api/tests/cost/series", {
      repo: REPO,
      trail: "o:inductor",
      by: "m",
      from: "2026-10-08",
      to: B.to,
    });
    expect(seriesEcho(body)).toBe(
      costSeriesUrl(REPO, PR, TRAIL, "m", { from: "2026-10-08", to: B.to })
    );
  });

  test("coverage", async () => {
    const body = await ask(coverageRoute, "/api/tests/cost/coverage", {
      repo: REPO,
      from: B.from,
      to: B.to,
    });
    expect(coverageEcho(body)).toBe(costCoverageUrl(REPO, PR, B));
  });
});
