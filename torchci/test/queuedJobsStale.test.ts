import { readFileSync } from "fs";
import path from "path";

// The "suspected stuck" classification lives in ClickHouse, duplicated across
// two queries: queued_jobs_by_label (the "Queued Jobs by Machine Type" summary)
// and queued_jobs (the job list it drills into). The metrics page presents one
// as the summary of the other, so if the two drift the summary silently stops
// describing the list. There is no TS function to import, so these tests pin
// the SQL text itself.
//
// The predicate and the CTE it depends on are asserted as EXACT normalized
// strings rather than by keyword. Keyword checks look reassuring and are not:
// they survive an AND becoming an OR, or a `<` becoming a `>`, if both copies
// are edited together. Exact equality means any semantic edit fails here and
// has to be made deliberately, in both files and in this expectation.
//
// The other thing pinned here is that the SQL never acts on the classification
// — it only reports it. It is a heuristic that cannot tell an abandoned run
// from one whose every job is starving, so a query-side filter or ordering
// built on it would be a way to bury a real outage, with nothing on screen to
// say so. Every place is_stale is allowed to appear is enumerated below.
// (A reader sorting or filtering the rendered table is a different thing: that
// is visible and reversible, and these tests say nothing about it.)
//
// What these tests do NOT do is run the queries. Nothing here shows the SQL
// returns correct rows.

const queryPath = (name: string) =>
  path.resolve(__dirname, "..", "clickhouse_queries", name, "query.sql");

const BY_LABEL = readFileSync(queryPath("queued_jobs_by_label"), "utf-8");
const JOB_LIST = readFileSync(queryPath("queued_jobs"), "utf-8");

// The parenthesised `(...) AS is_stale` expression, wherever it appears.
const IS_STALE_RE = /\(\s*workflow\.updated_at[\s\S]*?\)\s*AS is_stale/g;
// The body of the live_runner_pools CTE the predicate depends on.
const LIVE_POOLS_RE = /live_runner_pools AS \([\s\S]*?\n\)/g;

const stripComments = (sql: string) => sql.replace(/---.*$/gm, "");

const collapse = (sql: string) => sql.replace(/\s+/g, " ").trim();

const normalize = (sql: string) => collapse(stripComments(sql));

const matchAll = (sql: string, re: RegExp) =>
  (stripComments(sql).match(re) ?? []).map(collapse);

// Every remaining mention of is_stale once the predicate definitions are taken
// out, one per line, trimmed. Comparing the whole list against an expected list
// is deliberate: a regex looking for `WHERE ... is_stale` can be walked around
// with a function call or a line break, whereas a new use of is_stale anywhere
// shows up here as an unexpected entry.
const isStaleUses = (sql: string) =>
  stripComments(sql)
    .replace(IS_STALE_RE, "IS_STALE_DEFINITION")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("is_stale"));

// Three independent things have to hold before a job is called suspect: the run
// made no progress at all and is old enough that "not yet" is not the
// explanation; this job never reached a runner; and it asks for a non-empty
// label set something else has run recently, so a starved pool is not blamed on
// GitHub. None of it is proof — see the query comments for what it cannot rule
// out, and why the result is therefore never acted on.
const EXPECTED_PREDICATE =
  "( workflow.updated_at = workflow.created_at " +
  "AND workflow.created_at < (CURRENT_TIMESTAMP() - INTERVAL 6 HOUR) " +
  "AND job.status = 'queued' " +
  "AND job.runner_name = '' " +
  "AND LENGTH(job.steps) = 0 " +
  "AND LENGTH(job.labels) > 0 " +
  "AND job.labels IN (SELECT labels FROM live_runner_pools) " +
  ") AS is_stale";

const EXPECTED_LIVE_POOLS =
  "live_runner_pools AS ( SELECT DISTINCT labels FROM default.workflow_job " +
  "WHERE created_at > (CURRENT_TIMESTAMP() - INTERVAL 1 HOUR) " +
  "AND runner_name != '' )";

describe("the suspected-stuck classifier is identical in both queries", () => {
  test("all four is_stale predicates match the expected expression exactly", () => {
    const all = [
      ...matchAll(BY_LABEL, IS_STALE_RE),
      ...matchAll(JOB_LIST, IS_STALE_RE),
    ];

    // Two per file: one in the EC2/LF branch, one in the ARC branch.
    expect(all).toHaveLength(4);
    for (const predicate of all) {
      expect(predicate).toBe(EXPECTED_PREDICATE);
    }
  });

  test("both live_runner_pools definitions match exactly", () => {
    // Widening this window, or changing its key, changes what the predicate
    // above means without touching the predicate itself.
    const all = [
      ...matchAll(BY_LABEL, LIVE_POOLS_RE),
      ...matchAll(JOB_LIST, LIVE_POOLS_RE),
    ];

    expect(all).toHaveLength(2);
    for (const cte of all) {
      expect(cte).toBe(EXPECTED_LIVE_POOLS);
    }
  });
});

describe("the summary query only adds columns", () => {
  test("count, avg_queue_s and the row order are untouched", () => {
    // Served unauthenticated at /api/clickhouse/queued_jobs_by_label, so these
    // must keep covering every queued job, suspect ones included.
    expect(BY_LABEL).toContain("COUNT(*) AS count");
    expect(BY_LABEL).toContain("MAX(queue_s) AS avg_queue_s");
    // Pinned through to the end of the statement. A prefix match would accept
    // `ORDER BY count DESC, stale_count DESC`, which is exactly the tie-break
    // that would quietly hand the ordering back to the heuristic.
    expect(normalize(BY_LABEL)).toContain(
      "GROUP BY machine_type ORDER BY count DESC " +
        "SETTINGS allow_experimental_analyzer = 1;"
    );
  });

  test("the two new columns are the whole change", () => {
    expect(BY_LABEL).toContain("COUNTIf(is_stale) AS stale_count");
    expect(BY_LABEL).toContain("MAXIf(queue_s, is_stale) AS oldest_stale_s");
  });

  test("is_stale is read only by those two aggregates", () => {
    // Anything else — a HAVING, a WHERE, an ORDER BY term — would let the guess
    // decide which machine types appear or in what order.
    expect(isStaleUses(BY_LABEL)).toEqual([
      "COUNTIf(is_stale) AS stale_count,",
      "MAXIf(queue_s, is_stale) AS oldest_stale_s,",
      "SELECT queue_s, is_stale, machine_type FROM ec2_queued_jobs",
      "SELECT queue_s, is_stale, machine_type FROM arc_queued_jobs",
    ]);
  });
});

describe("the job list only adds a column", () => {
  test("row order is untouched", () => {
    expect(normalize(JOB_LIST)).toContain(
      "ORDER BY queue_s DESC SETTINGS allow_experimental_analyzer = 1;"
    );
  });

  test("is_stale is selected and nothing more", () => {
    expect(isStaleUses(JOB_LIST)).toEqual([]);
  });
});
