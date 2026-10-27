import type { PageDirection } from "lib/api/pagination";

// Keyset pagination shared by every sorted list. The public order places NULLS
// LAST; a previous-direction page reverses it, null placement included, and
// the predicate selects the rows beyond the cursor position with equality on
// every preceding key. Cursor values bind as the query parameters
// cursor_<index>; only the keys' own SQL reaches the statement.

export interface SeekKey {
  // The SQL expression the page orders and compares.
  column: string;
  // The ClickHouse type the cursor value binds as.
  parameterType: string;
  // Converts the bound placeholder when the column needs it, such as a
  // timestamp carried as Unix milliseconds in the cursor.
  bind?: (_placeholder: string) => string;
  direction: "ASC" | "DESC";
  // Whether the column can be NULL. A nullable key seeks past NULLs going
  // forward and orders with an explicit NULLS clause.
  nullable: boolean;
}

export interface SeekCursor {
  direction?: PageDirection;
  position: { values: (string | number | null)[] };
}

export function seekPredicate(
  keys: SeekKey[],
  cursor: SeekCursor | null,
  params: Record<string, unknown>
): string {
  if (cursor === null) return "1";
  const previous = cursor.direction === "previous";
  const prefix: string[] = [];
  const alternatives: string[] = [];
  keys.forEach((key, index) => {
    const value = cursor.position.values[index];
    if (value === null) {
      // NULLs end the public order: nothing follows them, and everything
      // non-null precedes them.
      if (previous) {
        alternatives.push(
          `(${[...prefix, `isNotNull(${key.column})`].join(" AND ")})`
        );
      }
      prefix.push(`isNull(${key.column})`);
      return;
    }
    const parameter = `cursor_${index}`;
    params[parameter] = value;
    const placeholder = `{${parameter}: ${key.parameterType}}`;
    const bound = key.bind ? key.bind(placeholder) : placeholder;
    const comparison = `${key.column} ${
      (key.direction === "DESC") !== previous ? "<" : ">"
    } ${bound}`;
    alternatives.push(
      `(${[
        ...prefix,
        key.nullable && !previous
          ? `(${comparison} OR isNull(${key.column}))`
          : comparison,
      ].join(" AND ")})`
    );
    prefix.push(`${key.column} = ${bound}`);
  });
  return alternatives.length === 0 ? "0" : alternatives.join(" OR ");
}

export function seekOrderBy(keys: SeekKey[], previous: boolean): string {
  return keys
    .map(
      (key) =>
        `${key.column} ${
          previous ? (key.direction === "ASC" ? "DESC" : "ASC") : key.direction
        }${key.nullable ? ` NULLS ${previous ? "FIRST" : "LAST"}` : ""}`
    )
    .join(", ");
}
