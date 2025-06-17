import { insertFeedback } from "../pages/api/torchagent-feedback";
import * as clickhouse from "../lib/clickhouse";

describe("torchagent feedback", () => {
  test("insertFeedback inserts into clickhouse", async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    jest
      .spyOn(clickhouse, "getClickhouseClientWritableTorchAgent")
      .mockReturnValue({ insert } as any);

    await insertFeedback("user", "session1", 1);
    expect(insert).toHaveBeenCalledWith({
      table: "misc.torchagent_feedback",
      values: expect.any(Array),
    });
    const args = insert.mock.calls[0][0].values[0];
    expect(args[0]).toBe("user");
    expect(args[1]).toBe("session1");
    expect(args[2]).toBe(1);
    expect(typeof args[3]).toBe("string");
  });
});
