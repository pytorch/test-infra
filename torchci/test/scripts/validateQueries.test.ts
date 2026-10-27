import { spawnSync } from "node:child_process";
import path from "node:path";

// Every evidence bundle under lib/api/tests ships with a replay script that,
// run without --live, regenerates each recorded statement from the
// working-tree builders and fails when the SQL or bindings differ. Running
// them here makes a stale bundle fail `yarn test` instead of waiting for
// someone to run the script by hand; a query change must re-record and
// remeasure its evidence (see lib/api/tests/query-validation.md).
const SCRIPTS = [
  "validateTestsApiQueries",
  "validateRunAttemptsQueries",
  "validateRunWorkflowQuery",
  "validateLastAttemptOutcomeQueries",
  "validateCommitStatsQueries",
  "validateCommitSharedStartsQueries",
  "validateBidirectionalPaginationQueries",
];

describe("offline SQL replays", () => {
  test.each(SCRIPTS)("%s matches the working tree", (script) => {
    const result = spawnSync(
      process.execPath,
      [path.join("scripts", `${script}.cjs`)],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }
    );
    if (result.status !== 0) {
      throw new Error(
        `${script} exited with ${result.status}:\n${result.stderr}${result.stdout}`
      );
    }
    expect(result.stdout).toMatch(/Verified/);
  });
});
