import { createClient } from "@clickhouse/client";
import { queryClickhouse } from "lib/clickhouse";

jest.mock("@clickhouse/client", () => ({ createClient: jest.fn() }));

describe("queryClickhouse", () => {
  const query = jest.fn();

  beforeEach(() => {
    query.mockResolvedValue({ json: async () => [{ answer: 1 }] });
    (createClient as jest.Mock).mockReturnValue({ query });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("sends the shared settings and a unique query id", async () => {
    expect(await queryClickhouse("SELECT 1", {}, "unit")).toEqual([
      { answer: 1 },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const request = query.mock.calls[0][0];
    expect(request.query).toBe("SELECT 1");
    expect(request.query_id).toMatch(/^unit-[0-9a-f-]{36}$/);
    expect(request.clickhouse_settings).toEqual({
      output_format_json_quote_64bit_integers: 0,
      date_time_output_format: "iso",
      use_query_cache: 0,
      query_cache_nondeterministic_function_handling: "ignore",
    });
  });

  test("adds a query's own settings, such as a heavy query's profile, over the shared ones", async () => {
    await queryClickhouse("SELECT 1", { id: "7" }, "unit", true, {
      profile: "ci_workload_heavy",
    });
    expect(query.mock.calls[0][0]).toMatchObject({
      query_params: { id: "7" },
      clickhouse_settings: {
        output_format_json_quote_64bit_integers: 0,
        date_time_output_format: "iso",
        use_query_cache: 1,
        profile: "ci_workload_heavy",
        query_cache_nondeterministic_function_handling: "ignore",
      },
    });
  });
});
