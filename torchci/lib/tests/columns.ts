// The four columns the hub's tables share, the tests list's
// (components/tests/TestsTable.tsx) and the commit page's: Name,
// Environment, Test Config and Owners, defined once in
// components/tests/sharedColumns.tsx. What of them is free of React is here:
// the API sort fields a header click means and the header help, so the two
// tables sort and explain the same column the same way. Each table adds its
// own columns' fields to these (TESTS_TABLE_SORT_FIELDS in lib/tests/table.ts).

// Each shared sortable column and the API sort fields, in order, that
// sorting by it means. A header click sorts every field the same way and
// the API orders by them left to right.
export const SHARED_COLUMN_SORT_FIELDS: Record<string, readonly string[]> = {
  name: ["file", "suite", "case_name"],
  // Like with like: what torch was built for, then the device, the Python,
  // then the platform details, in the order the cell sets them.
  environment: [
    "accelerator",
    "accelerator_version",
    "device_name",
    "device_count",
    "python_version",
    "os",
    "os_version",
    "cpu_architecture",
    "cpu_capability",
    "cc_compiler",
    "cc_compiler_version",
  ],
  test_config: ["test_config"],
  // The API orders by the alphabetically first label and puts unowned tests
  // last either way.
  owners: ["owner"],
};

// What each shared column shows, said once, in its header's tooltip, in the
// page owner's words.
export const SHARED_COLUMN_DESCRIPTIONS = {
  name: "The name of the test. A name can appear more than once, in a different environment or test config each time.",
  environment: "Where the test ran.",
  test_config:
    "The TEST_CONFIG set in the GitHub workflow that ran the test, plus any env vars from TestEnvironment.repro_env_vars that differ from their defaults.",
  owners:
    "The owners of the test, as determined by scripts/codeowners/owners.py.",
};
