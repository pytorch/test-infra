import {
  decodeCursor,
  encodeCursor,
  listIdentity,
  TestListCursor,
} from "lib/api/tests/cursor";
import { parseTestListParams } from "lib/api/tests/parameters";
import { baseCursor, LAST_RUN_AT, UNSUPPORTED_ID_SORTS } from "./fixtures";

describe("lib/api/tests/cursor", () => {
  test("round-trips unicode, exact filters, null sort keys and UInt64 ids", () => {
    const cursor: TestListCursor = {
      ...baseCursor,
      query: {
        ...baseCursor.query,
        search: "test_quotes_'and'_\"doubles\"_[param-1/2]\\tab",
        owner: ["module: nn"],
        workflow_path: ["", " .github/workflows/a,b.yml "],
        env_vars: { CUDA_VISIBLE_DEVICES: ["", "0,1"] },
        sort: ["-failure_rate", "-runs", "case_name"],
      },
      position: {
        values: [
          null,
          "8",
          "TestÜnïcödé",
          "18446744073709551615",
          "18446744073709551614",
          "18446744073709551613",
        ],
      },
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  test("round-trips configuration sorts with all identity tie-breakers", () => {
    const cursor: TestListCursor = {
      ...baseCursor,
      query: {
        ...baseCursor.query,
        sort: ["cpu_architecture", "-device_count"],
      },
      position: {
        values: [
          "aarch64",
          "4",
          "18446744073709551615",
          "18446744073709551614",
          "18446744073709551613",
        ],
      },
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  test("rejects old test-level cursors that lack configuration identities", () => {
    expect(
      decodeCursor(
        encodeCursor({
          ...baseCursor,
          position: { values: baseCursor.position.values.slice(0, -2) },
        })
      )
    ).toBeNull();
  });

  test.each(UNSUPPORTED_ID_SORTS)(
    "rejects previously valid cursors with explicit ID ordering: %s",
    (sort) => {
      const cursor = {
        ...baseCursor,
        query: { ...baseCursor.query, sort: sort.split(",") },
        position: {
          values: [
            ...(sort.includes(",") ? [Date.parse(LAST_RUN_AT)] : []),
            "123",
            "123",
            "123",
          ],
        },
      };
      expect(decodeCursor(encodeCursor(cursor))).toBeNull();
    }
  );

  test.each([
    "not-a-cursor",
    Buffer.from("[1,2,3]").toString("base64url"),
    encodeCursor({ ...baseCursor, version: 2 } as any),
    encodeCursor({ ...baseCursor, resource: "test-configurations" } as any),
    encodeCursor({
      ...baseCursor,
      position: {
        values: [
          ...baseCursor.position.values.slice(0, -1),
          "18446744073709551616",
        ],
      },
    }),
    encodeCursor({
      ...baseCursor,
      position: {
        values: [...baseCursor.position.values.slice(0, -1), "not-an-id"],
      },
    }),
    encodeCursor({
      ...baseCursor,
      position: { values: baseCursor.position.values.slice(1) },
    }),
    encodeCursor({
      ...baseCursor,
      position: {
        values: ["not-a-timestamp", ...baseCursor.position.values.slice(1)],
      },
    }),
    encodeCursor({
      ...baseCursor,
      query: { ...baseCursor.query, sort: ["cpu_architecture"] },
      position: { values: ["aarch64", "123"] },
    }),
  ])("rejects a malformed cursor: %s", (cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });

  test("the list identity includes every effective parameter except page size", () => {
    const parsed = parseTestListParams({
      repo: "pytorch/pytorch",
      owner: ["module: nn", "module: autograd"],
      workflow_path: [
        ".github/workflows/trunk.yml",
        ".github/workflows/pull.yml",
      ],
      environments_id: "18446744073709551615",
      "env_vars[TEST_CONFIG]": "default",
      search: "test_a,b",
      sort: "-runs,file",
      limit: "50",
    });
    if (!parsed.success) throw parsed.error;
    const { cursor: _cursor, ...query } = parsed.data;
    const { limit: _limit, ...expected } = query;
    expect(listIdentity(query)).toEqual(expected);
    expect(listIdentity({ ...query, limit: 1 })).toEqual(expected);
    expect(listIdentity({ ...query, search: "test_a" })).not.toEqual(expected);
  });

  test("equivalent repeated filter ordering produces the same cursor identity", () => {
    const identities = [
      {
        owner: ["module: nn", "module: autograd", "module: nn"],
        workflow_path: [
          ".github/workflows/trunk.yml",
          ".github/workflows/pull.yml",
          ".github/workflows/trunk.yml",
        ],
        "env_vars[TEST_CONFIG]": ["b", "a", "a"],
        ran_on: "pull_request,main",
      },
      {
        owner: ["module: autograd", "module: nn"],
        workflow_path: [
          ".github/workflows/pull.yml",
          ".github/workflows/trunk.yml",
        ],
        "env_vars[TEST_CONFIG]": ["a", "b"],
        ran_on: ["main", "pull_request"],
      },
    ].map((raw) => {
      const parsed = parseTestListParams({ repo: "pytorch/pytorch", ...raw });
      if (!parsed.success) throw parsed.error;
      const { cursor: _cursor, ...query } = parsed.data;
      return listIdentity(query);
    });
    expect(identities[0]).toEqual(identities[1]);
  });
});
