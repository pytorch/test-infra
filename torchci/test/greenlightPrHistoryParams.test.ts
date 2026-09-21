// greenlight_pr_state_history declares two parameters that only the commit page
// sets. Everything else calling the saved query -- pages/api/greenlight/report.ts
// -- passes four, and the missing two are filled by the `defaults` block in
// params.json rather than by the caller.
//
// Nothing else guards that block. The params linter only checks that `params`
// and `tests` exist, and the report route's own test mocks queryClickhouseSaved,
// so the layer that applies defaults never runs there. Delete `defaults` and
// both stay green while the route binds two undefined parameters and 500s. This
// runs the real function with only queryClickhouse stubbed, so what it asserts
// is what production would send.

import * as clickhouse from "lib/clickhouse";

const REPORT_ROUTE_PARAMETERS = {
  repo: "pytorch/pytorch",
  owner: "pytorch",
  project: "pytorch",
  prNumber: 197977,
};

async function boundParameters(inputParams: Record<string, unknown>) {
  const spy = jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
  try {
    await clickhouse.queryClickhouseSaved(
      "greenlight_pr_state_history",
      inputParams
    );
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][1];
  } finally {
    spy.mockRestore();
  }
}

describe("greenlight_pr_state_history parameter binding", () => {
  test("a caller that names only the PR still binds every parameter", async () => {
    const bound = await boundParameters(REPORT_ROUTE_PARAMETERS);
    expect(bound).toEqual({
      ...REPORT_ROUTE_PARAMETERS,
      sha: "",
      committedAt: "",
    });
    // Spelled out separately: toEqual treats an explicit undefined as a match
    // for an absent key, and undefined is exactly what reaches ClickHouse when
    // the defaults go missing.
    expect(Object.values(bound).every((value) => value !== undefined)).toBe(
      true
    );
  });

  test("a caller that names the commit passes it through untouched", async () => {
    const viewed = {
      ...REPORT_ROUTE_PARAMETERS,
      sha: "82b29a21c4095bc78784e2eb5bd6b664132c45d1",
      committedAt: "2026-09-21T18:07:03Z",
    };
    expect(await boundParameters(viewed)).toEqual(viewed);
  });
});
