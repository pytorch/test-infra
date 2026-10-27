import { GET } from "app/api/tests/route";
import { TestListPageSchema } from "lib/api/tests/types";
import * as clickhouse from "lib/clickhouse";
import { entityRow, REFRESHED_AT } from "./fixtures";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

// Interpret the health query's small keyset WHERE expression independently
// of its cursor builder. This catches missing equality prefixes and reversed
// null/comparison rules while the handler performs the full page round trip.
function matches(
  source: string,
  values: (string | number | null)[],
  params: Record<string, unknown>
): boolean {
  source = source.trim();
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")") depth--;
    if (depth === 0 && source.slice(i, i + 4) === " OR ") {
      return (
        matches(source.slice(0, i), values, params) ||
        matches(source.slice(i + 4), values, params)
      );
    }
  }
  depth = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")") depth--;
    if (depth === 0 && source.slice(i, i + 5) === " AND ") {
      return (
        matches(source.slice(0, i), values, params) &&
        matches(source.slice(i + 5), values, params)
      );
    }
  }
  if (source.startsWith("("))
    return matches(source.slice(1, -1), values, params);
  if (source === "1" || source === "0") return source === "1";
  const nullCheck = source.match(/^is(Not)?Null\(key_(\d+)\)$/);
  if (nullCheck)
    return (values[Number(nullCheck[2])] === null) !== Boolean(nullCheck[1]);
  const comparison = source.match(
    /^key_(\d+) ([<>=]) \{(cursor_\d+): (\w+)\}$/
  );
  if (!comparison) throw new Error(`Unexpected health predicate ${source}`);
  const [, index, operator, parameter, type] = comparison;
  const value = values[Number(index)];
  if (value === null) return false;
  const left = type === "UInt64" ? BigInt(value) : value;
  const right =
    type === "UInt64"
      ? BigInt(params[parameter] as string)
      : (params[parameter] as string | number);
  return operator === "="
    ? left === right
    : operator === "<"
    ? left < right
    : left > right;
}

describe("health-list bidirectional keyset pagination", () => {
  afterEach(() => jest.restoreAllMocks());

  test("round trips tied and null mixed-sort rows with changed page sizes", async () => {
    const rows = [
      { id: 3, environment: "10", rate: 0.9, name: "z" },
      { id: 1, environment: "10", rate: 0.5, name: "a" },
      { id: 1, environment: "11", rate: 0.5, name: "a" },
      { id: 2, environment: "10", rate: 0.5, name: "a" },
      { id: 4, environment: "10", rate: null, name: "a" },
      { id: 5, environment: "10", rate: null, name: "b" },
      { id: 6, environment: "10", rate: null, name: "b" },
    ].map(({ id, environment, rate, name }) => {
      const row = entityRow(id, environment, "20", {
        failure_rate: rate,
        case_name: name,
      });
      return {
        ...row,
        sort_0: rate,
        sort_1: name,
        sort_2: row.tests_id_string,
        sort_3: environment,
        sort_4: "20",
      };
    });
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (sql, params, queryId) => {
        if (queryId === "api_tests_generation")
          return [{ refreshed_at: REFRESHED_AT }];
        const [predicate, ordering] = sql
          .slice(sql.lastIndexOf("\nWHERE ") + 7)
          .split("\nORDER BY ");
        const previous = ordering.startsWith("key_0 ASC NULLS FIRST");
        expect(ordering.split("\nLIMIT")[0]).toBe(
          previous
            ? "key_0 ASC NULLS FIRST, key_1 DESC NULLS FIRST, key_2 DESC NULLS FIRST, key_3 DESC NULLS FIRST, key_4 DESC NULLS FIRST"
            : "key_0 DESC NULLS LAST, key_1 ASC NULLS LAST, key_2 ASC NULLS LAST, key_3 ASC NULLS LAST, key_4 ASC NULLS LAST"
        );
        const selected = rows.filter((row) =>
          matches(
            predicate,
            [row.sort_0, row.sort_1, row.sort_2, row.sort_3, row.sort_4],
            params
          )
        );
        if (previous) selected.reverse();
        return selected.slice(0, params.entries_limit as number);
      });
    const initial = new URL(
      "https://hud.pytorch.org/api/tests?repo=pytorch%2Fpytorch&sort=-failure_rate,case_name&limit=2"
    );
    const read = async (url: URL, limit?: number) => {
      if (limit !== undefined) url.searchParams.set("limit", String(limit));
      const response = await GET(new Request(url));
      expect(response.status).toBe(200);
      return TestListPageSchema.parse(await response.json());
    };
    const identities = (page: Awaited<ReturnType<typeof read>>) =>
      page.tests.map((entry) => [entry.test.id, entry.environment!.id]);
    const expected = rows.map((row) => [
      row.tests_id_string,
      row.environments_id_string,
    ]);
    let page = await read(initial);
    expect(page.pagination.previous).toBeNull();
    expect(identities(page)).toEqual(expected.slice(0, 2));
    page = await read(new URL(page.pagination.next!.url, initial));
    expect(identities(page)).toEqual(expected.slice(2, 4));
    page = await read(new URL(page.pagination.next!.url, initial));
    expect(identities(page)).toEqual(expected.slice(4, 6));
    page = await read(new URL(page.pagination.next!.url, initial), 1);
    expect(identities(page)).toEqual(expected.slice(6));
    expect(page.pagination.next).toBeNull();

    page = await read(new URL(page.pagination.previous!.url, initial), 3);
    expect(identities(page)).toEqual(expected.slice(3, 6));
    page = await read(new URL(page.pagination.previous!.url, initial), 2);
    expect(identities(page)).toEqual(expected.slice(1, 3));
    const middle = page;
    page = await read(new URL(page.pagination.previous!.url, initial), 4);
    expect(identities(page)).toEqual(expected.slice(0, 1));
    expect(page.pagination.previous).toBeNull();
    page = await read(new URL(middle.pagination.next!.url, initial), 3);
    expect(identities(page)).toEqual(expected.slice(3, 6));
    expect(
      query.mock.calls
        .filter((call) => call[2] === "api_tests_page_boundary")
        .every((call) => call[1].entries_limit === 1)
    ).toBe(true);
  });
});
