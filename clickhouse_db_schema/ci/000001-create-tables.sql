-- noqa: disable=CP05,LT01
-- Initial tables for the test hub: a catalog of tests, of the environments and
-- env var sets they run in, the owners of test files, and one row per attempt.
-- Conventions: one statement per object, each ending with ';' at the end of a
-- line. Names are unqualified and resolve in the database migrate.py selects. A
-- catalog row's id is computed by the server from its identity columns, and
-- catalog rows are inserted only for unseen ids. AggregatingMergeTree collapses
-- racing duplicates and preserves the minimum first_seen_at. All other catalog
-- fields must be identical for a given id. first_seen_at and owners.created_at
-- are MATERIALIZED: the server sets them, writers cannot, and SELECT * omits them.
-- Queries must use FINAL when reading tests, environments or env_vars,
-- including in joins and subqueries (e.g. FROM tests FINAL), to return one row
-- per id.
-- Background deduplication alone does not guarantee unique query results.

-- =============================================================================
--  pytorch_kv_sipHash64
-- -----------------------------------------------------------------------------
--  The id hash of the catalogs: (name, value) string pairs, empty values
--  dropped, sorted, hashed as a whole. Pair order is irrelevant, and a field
--  added later changes no id where it is empty. Values are hashed as given: an
--  array-valued field must be sorted and joined into one string by the caller,
--  and maps are passed as pairs, as env_vars does. ClickHouse expands the
--  function into each DEFAULT at CREATE time, so tables never depend on it
--  afterwards and redefining it changes no existing DEFAULT; it stays for later
--  migrations and for computing an id by hand. Functions are service-wide,
--  hence the project prefix.
-- =============================================================================
CREATE OR REPLACE FUNCTION pytorch_kv_sipHash64 AS (pairs) ->
    sipHash64(arraySort(arrayFilter(kv -> kv.2 != '', pairs)));

-- =============================================================================
--  tests
-- -----------------------------------------------------------------------------
--  One row per test case in a launched test file: the catalog that gives every
--  test its stable id.
-- =============================================================================
CREATE TABLE tests
(
    -- Identity of the test, referenced as runs.tests_id and used in hub URLs.
    -- The ingester computes the same expression for runs, so it must know the
    -- language and declared_case_name of every test. language is hashed by
    -- name, and unknown is a real value that never drops out; an empty
    -- declared_case_name does drop out, so it changes no id where it is empty.
    id                 UInt64 DEFAULT pytorch_kv_sipHash64([
        ('repo', repo), ('file', file), ('suite', suite),
        ('case_name', case_name), ('declared_case_name', declared_case_name),
        ('language', toString(language))
    ]),

    -- Repository the test lives in, e.g. pytorch/pytorch.
    -- With file, the join key to owners.
    repo               LowCardinality(String),

    -- The file the test was launched from, repo-relative: test/test_torch.py.
    file               LowCardinality(String),

    -- Test class or C++ test suite; empty for module-level functions. Disable
    -- issues match on "case_name (__main__.suite)".
    suite              String,

    -- Test name exactly as the runner selects it, parameters included:
    -- test_add_cpu_float32, test_foo[1-2]; see declared_case_name.
    case_name          String,

    -- Test name as declared in the code, before the runner appends parameters:
    -- test_add for test_add_cpu_float32, test_foo for test_foo[1-2]. Equal to
    -- case_name for an unparametrized test; empty when the writer did not say.
    -- Part of the identity; empty drops out of the hash, so a test reported
    -- without it and later with it gets two ids.
    declared_case_name String,

    -- python: a test in a .py file; cpp: a test in a compiled test binary; unknown:
    -- the report did not say.
    -- Part of the identity, so a test reported without its language gets a
    -- different id than the same test reported with it.
    language           Enum8('unknown' = 0, 'python' = 1, 'cpp' = 2) DEFAULT 'unknown',

    -- Earliest insert time, preserved across duplicate inserts and merges.
    first_seen_at      SimpleAggregateFunction(min, DateTime64(3, 'UTC'))
        MATERIALIZED now64(3, 'UTC')
)
ENGINE = AggregatingMergeTree
ORDER BY id;

-- =============================================================================
--  environments
-- -----------------------------------------------------------------------------
--  One row per distinct hardware and build combination that tests run on (OS,
--  CPU, Python, compiler, accelerator, device). Harness env vars live in the
--  separate env_vars table, so this id survives env var changes.
-- =============================================================================
CREATE TABLE environments
(
    -- Identity of the environment, referenced as runs.environments_id. Empty
    -- fields (no accelerator version, no device) drop out of the hash.
    id                        UInt64 DEFAULT pytorch_kv_sipHash64([
        ('os', os), ('os_version', os_version),
        ('cpu_architecture', cpu_architecture), ('cpu_capability', cpu_capability),
        ('python_version', python_version), ('cc_compiler', cc_compiler),
        ('cc_compiler_version', cc_compiler_version), ('accelerator', accelerator),
        ('accelerator_version', accelerator_version), ('device_name', device_name),
        ('device_count', toString(device_count))
    ]),

    -- identity fields (hashed into id) ------------------------------------------

    -- linux, macos or windows.
    os                        LowCardinality(String),

    -- OS or container image version: VERSION_ID on Linux (22.04), major.minor
    -- on macOS (15.7), the NT build on Windows (10.0.17763). Constant per Linux
    -- image; matters on macOS, where tests gate on the OS version.
    os_version                LowCardinality(String),

    -- x86_64, aarch64, s390x or ppc64le; kernels and numerics differ by it.
    cpu_architecture          LowCardinality(String),

    -- CPU kernel level, ATEN_CPU_CAPABILITY override included: default, avx2,
    -- avx512, amx, sve128, sve256, vsx or zvector. Tells AMX apart from plain
    -- AVX-512 machines and Graviton3 (sve256) from Graviton4 (sve128).
    cpu_capability            LowCardinality(String),

    -- Interpreter major.minor, with a t suffix when free-threaded: 3.10, 3.14t.
    python_version            LowCardinality(String),

    -- Compiler that built torch (gcc, clang or msvc) and its version as
    -- torch.__config__.show() prints it: 11.4 for gcc, 21.1.8 for clang,
    -- _MSC_FULL_VER for msvc (194234444). Not cut to the major, so a minor or
    -- patch update that changes it gives the environment a new id.
    cc_compiler               LowCardinality(String),
    cc_compiler_version       LowCardinality(String),

    -- What torch was built for (cpu, cuda, rocm, xpu or mps) and that stack's
    -- version as torch.version gives it (13.2 for cuda, 10.1.0 for rocm; empty
    -- for cpu and mps). A CUDA build on a CPU-only runner stays cuda with
    -- device_count = 0.
    accelerator               LowCardinality(String),
    accelerator_version       LowCardinality(String),

    -- The first visible accelerator's name as its vendor reports it, not
    -- normalized: NVIDIA L4, NVIDIA H100 80GB HBM3, Tesla T4, AMD Instinct
    -- MI350X VF, Apple M2 Pro. Empty when device_count is 0 or the name could
    -- not be read.
    device_name               LowCardinality(String),

    -- Accelerators visible to the test process, 0 for none; honors
    -- CUDA_VISIBLE_DEVICES and HIP_VISIBLE_DEVICES.
    device_count              UInt8,

    -- Earliest insert time, preserved across duplicate inserts and merges.
    first_seen_at             SimpleAggregateFunction(min, DateTime64(3, 'UTC'))
        MATERIALIZED now64(3, 'UTC')
)
ENGINE = AggregatingMergeTree
ORDER BY id;

-- =============================================================================
--  env_vars
-- -----------------------------------------------------------------------------
--  One row per distinct set of environment variables in effect for a test
--  process (test config, dynamo, inductor, slow, asan, ...). Not an exhaustive
--  list of the process's env vars: just those behind a TestEnvironment.def_flag
--  or def_setting in torch's common_utils, which records each one unless it is
--  registered with include_in_repro=False. Separate from environments so
--  hardware and harness mode filter independently and a hardware id never
--  changes because a variable was registered.
-- =============================================================================
CREATE TABLE env_vars
(
    -- Identity of the env var set, referenced as runs.env_vars_id. Key order is
    -- irrelevant, entries with an empty value drop out, and the empty map is the
    -- id of "none set".
    id            UInt64 DEFAULT pytorch_kv_sipHash64(arrayZip(mapKeys(env_vars), mapValues(env_vars))),

    -- The recorded variables that are set or on, by name and value; on/off ones
    -- carry '1', e.g. {'TEST_CONFIG': 'inductor', 'PYTORCH_TEST_WITH_INDUCTOR':
    -- '1', 'PYTORCH_TEST_WITH_DYNAMO': '1'}; sanitizer runs appear as
    -- PYTORCH_TEST_WITH_ASAN, _UBSAN, _TSAN and _DEV_DBG_ASAN. A flag that is
    -- on by default or implied (PYTORCH_TEST_WITH_ROCM on ROCm) carries '1'
    -- even when unset, so registering a new variable changes the ids of the
    -- sets where it is on, and no others. The report lists every recorded
    -- variable with its value; the ingester keeps the entries whose value is
    -- not '0' or ''.
    env_vars      Map(LowCardinality(String), String),

    -- Earliest insert time, preserved across duplicate inserts and merges.
    first_seen_at SimpleAggregateFunction(min, DateTime64(3, 'UTC'))
        MATERIALIZED now64(3, 'UTC')
)
ENGINE = AggregatingMergeTree
ORDER BY id;

-- =============================================================================
--  owners
-- -----------------------------------------------------------------------------
--  Current owners of each test file, as pytorch's scripts/codeowners/owners.py
--  maps them: the "module: " labels of its "# Owner(s):" header, else those of
--  the most specific CODEOWNERS entry, else that entry's group. On merge, keep
--  only the newest row per (repo, file), replacing the whole owners array;
--  ownership history is not retained. Before background merges, read with
--  FINAL or argMax(owners, created_at) grouped by repo, file to get one row
--  per file.
-- =============================================================================
CREATE TABLE owners
(
    -- Repository and repo-relative file, in the same form as tests.repo and
    -- tests.file: the join key to tests. C++ test sources are listed too, but
    -- C++ tests are named by binary (cpp/test_api), so they match no row.
    repo       LowCardinality(String),
    file       LowCardinality(String),

    -- Owner labels without the "module: " prefix, e.g. ['nn'] for
    -- test/test_nn.py's "module: nn", or a CODEOWNERS group such as
    -- ['core_tests']; empty once the file is deleted.
    owners     Array(LowCardinality(String)),

    -- Insert time, set by the server, and the replacement version: the row
    -- with the greatest timestamp wins. The hourly owners job on main inserts
    -- a row when a file's owners change.
    created_at DateTime64(6, 'UTC') MATERIALIZED now64(6, 'UTC')
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (repo, file);

-- =============================================================================
--  runs
-- -----------------------------------------------------------------------------
--  One row per attempt of one test, in one environment with one env var set,
--  in one CI job: the fact table everything else is computed from. Facts about
--  the job (commit, branch, runner, conclusion, workflow) are not repeated
--  here; they are a join on github_workflow_job_id to default.workflow_job
--  (and through its run_id to default.workflow_run).
--  Scans pay for bytes, so the wide columns carry codecs: the timestamps and
--  the job id, which grow along the sort key, are delta-coded and then ZSTD
--  compressed; the catalog ids, the report uuid and the summary are ZSTD
--  compressed; the row id is stored as is, since a UUID does not compress.
--  On freshly written parts of trial data that is 30 to 40 percent smaller
--  than the default LZ4 for the timestamps and the catalog ids, and 90 percent
--  for the job id.
-- =============================================================================
CREATE TABLE runs
(
    -- Identifier of this stored row: the uuid4 the writer gives each run line,
    -- the handle for one attempt. The ingester copies it, and a report with a
    -- missing or invalid one fails to insert. Not part of the identity below: a
    -- report ingested again outside the deduplication window stores a second
    -- copy, under the same id, until a merge collapses them. Nothing here
    -- indexes it; a lookup by id alone scans the table.
    id                     UUID CODEC(NONE),

    -- The test, environment and env var set, computed by the ingester with the
    -- same expressions as the catalogs' DEFAULTs; the leading sort keys.
    tests_id               UInt64 CODEC(ZSTD(1)),
    environments_id        UInt64 CODEC(ZSTD(1)),
    env_vars_id            UInt64 CODEC(ZSTD(1)),

    -- The CI job, as GitHub Actions identifies it: the join to
    -- default.workflow_job and the leading key of the by_job projection, which
    -- serves per-job reads.
    github_workflow_job_id Int64 CODEC(Delta(8), ZSTD(1)),

    -- The report this row was parsed from, by the uuid the writer gave it: the
    -- file in the job's torchci-reports folder whose name ends in the uuid. The
    -- writer gives each launch of a test file its own report, so the rows that
    -- share a uuid came out of one process (for an xdist launch, the controller
    -- and its workers), and the full message behind outcome_summary is in that
    -- file. No index of its own: find a report's rows through its job. The zero
    -- UUID when the writer did not say.
    report_uuid            UUID CODEC(ZSTD(1)),

    -- 0 for the first execution of the test in its process, then 1, 2, ... for
    -- each in-process rerun (or each repeat in rerun-disabled-tests mode). A
    -- restart at 0 marks a new process. Last sort key, so ReplacingMergeTree
    -- never merges the reruns of a test into one row.
    rerun_number           UInt16,

    -- What happened in this attempt. crashed and timed_out are synthetic rows
    -- the launcher writes for the test that was in flight, only for launches
    -- without xdist; a crashed C++ test is failed. unknown is the default
    -- for a row whose outcome the writer could not map or did not send; it counts
    -- as an attempt and nothing else, and should be rare enough to investigate.
    outcome                Enum8(
        'unknown'   = 0,  -- not classified by the writer, or missing; see above
        'passed'    = 1,  -- the test ran and every assertion held
        'failed'    = 2,  -- the test body raised: a failed assertion or any
                          --   other exception, unittest's setUp and tearDown
                          --   included
        'error'     = 3,  -- pytest's setup or teardown phase failed (a fixture,
                          --   setUpClass, tearDownClass), not the body
        'skipped'   = 4,  -- the test did not run: a skip decorator or call, or a
                          --   disabled-test entry (reason in outcome_summary)
        'xfailed'   = 5,  -- marked expected-to-fail and it failed, which is the
                          --   expected result, not a failure
        'xpassed'   = 6,  -- marked expected-to-fail but it passed, so the mark is
                          --   stale
        'crashed'   = 7,  -- synthetic: the process died (signal, abort, OOM kill)
                          --   while this test was running, so it wrote no result
        'timed_out' = 8   -- synthetic: the launcher killed the process at its time
                          --   limit while this test was running
    ) DEFAULT 'unknown',

    -- Why, in brief: pytest's exception type and message for failed and error,
    -- often several lines; the reason for skipped and xfailed when the test
    -- gives one; the exit code and signal, or the time limit, for crashed and
    -- timed_out (exit code -11 (SIGSEGV), timed out after 30min); empty for
    -- passed, xpassed and unknown. At most 256 characters, cut by the ingester
    -- from the attempt's message in the report, which has no traceback either.
    outcome_summary        String CODEC(ZSTD(1)),

    -- Start and end of the attempt, setup and teardown included; the duration is
    -- their difference. started_at partitions the table and drives the TTL.
    started_at             DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    ended_at               DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),

    PROJECTION by_job (
        SELECT * ORDER BY (github_workflow_job_id, tests_id, started_at, rerun_number)
    )
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(started_at)
PRIMARY KEY (tests_id, environments_id, env_vars_id, started_at)
ORDER BY (tests_id, environments_id, env_vars_id, started_at, github_workflow_job_id, rerun_number)
TTL toDateTime(started_at) + INTERVAL 14 DAY
-- ClickHouse 24.7+ refuses a PROJECTION on a ReplacingMergeTree unless
-- deduplicate_merge_projection_mode is set; 'rebuild' recomputes by_job after
-- every deduplicating merge, 'drop' would discard it on the first one.
SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';
