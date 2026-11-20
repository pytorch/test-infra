import { readFileSync } from "fs";
import { STATE_LABELS } from "lib/triage/issueTriage";
import path from "path";

// The four /triage/modules queries each carry their own copy of the triage
// definition: the state labels, the label-event lookup that dates a state
// label, and (for the drill-down queries) the label selection. Named queries
// cannot share SQL, so if one copy drifts the tiles, table, chart and lists
// silently disagree. These tests pin the copies to each other and to
// STATE_LABELS in lib/triage/issueTriage.ts.

const QUERIES = [
  "issue_triage_labels",
  "issue_triage_overview",
  "issue_triage_weekly",
  "issue_triage_issues",
];
const SELECTION_QUERIES = QUERIES.filter((q) => q !== "issue_triage_labels");

function sql(name: string): string {
  return readFileSync(
    path.join(__dirname, "..", "clickhouse_queries", name, "query.sql"),
    "utf8"
  );
}

// Whitespace and comments do not matter, only the SQL.
function normalize(text: string): string {
  return text
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extract(name: string, re: RegExp): string {
  const match = normalize(sql(name)).match(re);
  if (!match) {
    throw new Error(`${name}: ${re} not found`);
  }
  return match[0];
}

test("state labels match STATE_LABELS everywhere", () => {
  const expected = `[ ${STATE_LABELS.map(
    (l) => `'${l.replace("'", "''")}'`
  ).join(", ")} ] AS state_labels`;
  for (const name of QUERIES) {
    expect(extract(name, /\[ [^\]]* \] AS state_labels/)).toEqual(expected);
  }
});

test("the label-event lookup is the same everywhere", () => {
  const re =
    /LEFT JOIN \( SELECT .*? GROUP BY issue_number \) AS e ON e\.issue_number = i\.number/;
  const first = extract(QUERIES[0], re);
  expect(first).toContain("has(state_labels, label_name)");
  expect(first).toContain("action = 'labeled'");
  for (const name of QUERIES.slice(1)) {
    expect(extract(name, re)).toEqual(first);
  }
});

test("a state label's date comes from that lookup everywhere", () => {
  for (const name of QUERIES) {
    expect(normalize(sql(name))).toContain(
      "if(e.first_state_at = 0, never, e.first_state_at)"
    );
  }
});

test("the label selection is the same in every drill-down query", () => {
  const re =
    /AND \( \( empty\(\{includeLabels.*?ownExcludes: Array\(Array\(String\)\)\} \) \)/;
  const first = extract(SELECTION_QUERIES[0], re);
  for (const name of SELECTION_QUERIES.slice(1)) {
    expect(extract(name, re)).toEqual(first);
  }
});
