-- Initial tables for the test hub: a catalog of tests, of the environments and
-- flag sets they run in, the owners of test files, and one row per attempt.
-- Conventions: one statement per object, each ending with ';' at the end of a
-- line. Names are unqualified and resolve in the database deploy.py selects. A
-- catalog row's id is computed by the server from its identity columns, and
-- catalog rows are inserted only for unseen ids, so first_seen_at is the first
-- sighting (ReplacingMergeTree collapses racing duplicates). first_seen_at and
-- owners.created_at are MATERIALIZED: the server sets them, writers cannot,
-- and SELECT * omits them.

-- =============================================================================
--  pytorch_kv_sipHash64
-- -----------------------------------------------------------------------------
--  The id hash of the catalogs: (name, value) string pairs, empty values
--  dropped, sorted, hashed as a whole. Pair order is irrelevant, and a field
--  added later changes no id where it is empty. Values are hashed as given: an
--  array-valued field must be sorted and joined into one string by the caller,
--  and maps are passed as pairs, as flags does. ClickHouse expands the function
--  into each DEFAULT at CREATE time, so tables never depend on it afterwards
--  and redefining it changes no existing DEFAULT; it stays for later migrations
--  and for computing an id by hand. Functions are service-wide, hence the
--  project prefix.
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
    -- Identity of the test, referenced as runs.test_id and used in hub URLs. The
    -- ingester computes the same expression for runs, so it must know the
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

    -- The file the test was launched from, repo-relative: test/test_torch.py, or
    -- test/test_jit.py for the classes it imports from test/jit/; for C++ tests
    -- the test binary, cpp/test_api. With repo, the join key to owners; also the
    -- report's directory in the job's zip.
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
    -- the writer could not tell or did not say.
    -- Part of the identity, so a test reported without its language gets a
    -- different id than the same test reported with it.
    language           Enum8('unknown' = 0, 'python' = 1, 'cpp' = 2) DEFAULT 'unknown',

    -- Insert time, set by the server; the ReplacingMergeTree version.
    first_seen_at      DateTime MATERIALIZED now()
)
ENGINE = ReplacingMergeTree(first_seen_at)
ORDER BY id;

-- =============================================================================
--  environments
-- -----------------------------------------------------------------------------
--  One row per distinct hardware and build combination that tests run on (OS,
--  CPU, Python, compiler, accelerator, device). Harness flags live in the
--  separate flags table, so this id survives flag changes.
-- =============================================================================
CREATE TABLE environments
(
    -- Identity of the environment, referenced as runs.env_id. Empty fields (no
    -- accelerator version, no device) drop out of the hash.
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

    -- major.minor of the OS or container image: 22.04, 15.6. Constant per Linux
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

    -- Compiler that built torch (gcc, clang or msvc) and its major version (11,
    -- 21); only the major is kept, so minor and patch bumps never split history.
    cc_compiler               LowCardinality(String),
    cc_compiler_version       LowCardinality(String),

    -- What torch was built for (cpu, cuda, rocm, xpu, mps or tpu) and that
    -- stack's major.minor (13.2; empty for cpu). A CUDA build on a CPU-only
    -- runner stays cuda with device_count = 0.
    accelerator               LowCardinality(String),
    accelerator_version       LowCardinality(String),

    -- Normalized accelerator model: a10g, l4, h100, b200, mi300x, mi350x, m1,
    -- m2; empty when the build cannot use a GPU. Variants that share a marketing
    -- name (a partitioned MI350X and a full card) are split here.
    device_name               LowCardinality(String),

    -- Accelerators visible to the test process, 0 for none; honors
    -- CUDA_VISIBLE_DEVICES and HIP_VISIBLE_DEVICES.
    device_count              UInt8,

    -- Insert time, set by the server; the ReplacingMergeTree version.
    first_seen_at             DateTime MATERIALIZED now()
)
ENGINE = ReplacingMergeTree(first_seen_at)
ORDER BY id;

-- =============================================================================
--  flags
-- -----------------------------------------------------------------------------
--  One row per distinct set of harness flags in effect for a test process
--  (dynamo, inductor, slow, asan, ...). Separate from environments so hardware
--  and harness mode filter independently and a hardware id never changes
--  because a flag was registered.
-- =============================================================================
CREATE TABLE flags
(
    -- Identity of the flag set, referenced as runs.flags_id. Key order is
    -- irrelevant, entries with an empty value drop out, and the empty map is the
    -- id of "no flags".
    id            UInt64 DEFAULT pytorch_kv_sipHash64(arrayZip(mapKeys(flags), mapValues(flags))),

    -- Registered harness flags that are enabled, as '1', and registered settings
    -- that have a value, e.g. {'PYTORCH_TEST_WITH_INDUCTOR': '1',
    -- 'PYTORCH_TEST_WITH_DYNAMO': '1'}; sanitizer and debug builds appear as
    -- PYTORCH_TEST_WITH_ASAN, _UBSAN, _TSAN and _DEBUG_BUILD. Flags that are off
    -- are absent, so registering a flag never changes an existing id. The
    -- report lists every registered flag with its value; the ingester keeps the
    -- entries whose value is not '0' or ''.
    flags         Map(LowCardinality(String), String),

    -- Insert time, set by the server; the ReplacingMergeTree version.
    first_seen_at DateTime MATERIALIZED now()
)
ENGINE = ReplacingMergeTree(first_seen_at)
ORDER BY id;

-- =============================================================================
--  owners
-- -----------------------------------------------------------------------------
--  One row per test file per change of its "# Owner(s):" header, append-only:
--  the newest row per (repo, file) is the current owner, the newest row at or
--  before a time is the owner then. Keyed by file, not test, so one header
--  edit is one row.
-- =============================================================================
CREATE TABLE owners
(
    -- Repository and repo-relative file, in the same form as tests.repo and
    -- tests.file: the join key to tests.
    repo       LowCardinality(String),
    file       LowCardinality(String),

    -- Owner labels from the header line, e.g. ['module: nn']; empty once the
    -- file is deleted.
    owners     Array(LowCardinality(String)),

    -- Insert time, set by the server. The job that parses the headers on main
    -- appends a row only when a file's owners differ from its newest row.
    created_at DateTime MATERIALIZED now()
)
ENGINE = MergeTree
ORDER BY (repo, file, created_at);

-- =============================================================================
--  runs
-- -----------------------------------------------------------------------------
--  One row per attempt of one test, in one environment with one set of flags,
--  in one CI job: the fact table everything else is computed from. Facts about
--  the job (commit, branch, runner, conclusion, workflow) are not repeated
--  here; they are a join on github_workflow_job_id to default.workflow_job
--  (and through its run_id to default.workflow_run).
--  Scans pay for bytes, so the wide columns carry codecs: the timestamps and
--  the job id, which grow along the sort key, are delta-coded and then ZSTD
--  compressed; the ids, the summary and the properties are ZSTD compressed.
--  On freshly written parts of trial data that is 30 to 40 percent smaller
--  than the default LZ4 for the timestamps and ids, and 90 percent for the
--  job id.
-- =============================================================================
CREATE TABLE runs
(
    -- The test, environment and flag set, computed by the ingester with the same
    -- expressions as the catalogs' DEFAULTs; the leading sort keys.
    test_id                UInt64 CODEC(ZSTD(1)),
    env_id                 UInt64 CODEC(ZSTD(1)),
    flags_id               UInt64 CODEC(ZSTD(1)),

    -- The CI job, as GitHub Actions identifies it: the join to
    -- default.workflow_job and the leading key of the by_job projection, which
    -- serves per-job reads.
    github_workflow_job_id Int64 CODEC(Delta(8), ZSTD(1)),

    -- 0 for the first execution of the test in its process, then 1, 2, ... for
    -- each in-process rerun (or each repeat in rerun-disabled-tests mode). A
    -- restart at 0 marks a new process. Last sort key, so ReplacingMergeTree
    -- never merges the reruns of a test into one row.
    rerun_number           UInt16,

    -- What happened in this attempt. crashed and timed_out are synthetic rows
    -- the launcher writes for the test that was in flight. unknown is the default
    -- for a row whose outcome the writer could not map or did not send; it counts
    -- as an attempt and nothing else, and should be rare enough to investigate.
    outcome                Enum8(
        'unknown'   = 0,  -- not classified by the writer, or missing; see above
        'passed'    = 1,  -- the test ran and every assertion held
        'failed'    = 2,  -- an assertion in the test body failed
        'error'     = 3,  -- an exception outside the assertions: in setup or
                          --   teardown, or of an unexpected type
        'skipped'   = 4,  -- the test did not run: a skip decorator or call, or a
                          --   disabled-test entry (the reason stays in the report)
        'xfailed'   = 5,  -- marked expected-to-fail and it failed, which is the
                          --   expected result, not a failure
        'xpassed'   = 6,  -- marked expected-to-fail but it passed, so the mark is
                          --   stale
        'crashed'   = 7,  -- synthetic: the process died (signal, abort, OOM kill)
                          --   while this test was running, so it wrote no result
        'timed_out' = 8   -- synthetic: the launcher killed the process at its time
                          --   limit while this test was running
    ) DEFAULT 'unknown',

    -- One line saying why: exception type and message for failed and error, the
    -- reason for skipped, xfailed and xpassed when the writer gives one, the
    -- signal or time limit for crashed and timed_out; empty for passed and
    -- unknown. At most 256 characters, cut by the ingester from the attempt's
    -- message in the report; the traceback stays there.
    outcome_summary        String CODEC(ZSTD(1)),

    -- Start and end of the attempt, setup and teardown included; the duration is
    -- their difference. started_at partitions the table and drives the TTL.
    started_at             DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    ended_at               DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),

    -- Free-form metadata about the attempt with no column of its own, e.g. the
    -- report's properties: full versions behind the environment's major.minor
    -- ones, raw device string, memory, driver, CI build and config names.
    -- Metadata only: nothing joins, filters or groups on it; a value that
    -- queries need gets a real column.
    properties             JSON CODEC(ZSTD(1)),

    PROJECTION by_job (
        SELECT * ORDER BY (github_workflow_job_id, test_id, started_at, rerun_number)
    )
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(started_at)
PRIMARY KEY (test_id, env_id, flags_id, started_at)
ORDER BY (test_id, env_id, flags_id, started_at, github_workflow_job_id, rerun_number)
TTL toDateTime(started_at) + INTERVAL 14 DAY
-- ClickHouse 24.7+ refuses a PROJECTION on a ReplacingMergeTree unless
-- deduplicate_merge_projection_mode is set; 'rebuild' recomputes by_job after
-- every deduplicating merge, 'drop' would discard it on the first one.
SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';
