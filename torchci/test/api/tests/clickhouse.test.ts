import { createClient } from "@clickhouse/client";
import { queryClickhouse } from "lib/api/tests/clickhouse";

jest.mock("@clickhouse/client", () => ({ createClient: jest.fn() }));

describe("the test hub's queryClickhouse", () => {
  test("keeps one client, and sends a read once more on a new one when its connection was closed", async () => {
    const answer = { json: async () => [{ answer: 1 }] };
    const kept = jest.fn().mockResolvedValue(answer);
    const fresh = jest.fn().mockResolvedValue(answer);
    (createClient as jest.Mock)
      .mockReturnValueOnce({ query: kept })
      .mockReturnValue({ query: fresh });

    await queryClickhouse("SELECT 1", {}, "unit");
    await queryClickhouse("SELECT 1", {}, "unit");
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledTimes(2);

    kept.mockRejectedValueOnce(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    );
    expect(await queryClickhouse("SELECT 1", {}, "unit")).toEqual([
      { answer: 1 },
    ]);
    expect(fresh).toHaveBeenCalledTimes(1);

    kept.mockRejectedValueOnce(new Error("Syntax error"));
    await expect(queryClickhouse("SELECT", {}, "unit")).rejects.toThrow(
      "Syntax error"
    );
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});
