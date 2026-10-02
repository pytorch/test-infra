-- The wide twin of runs for the layout trial: the same attempts, with the
-- columns of the test, environment, flag set and owners inline instead of
-- behind test_id, env_id and flags_id. It holds exactly the data the five
-- tables of 000001 hold, so the two layouts can be measured on the same rows
-- (query time, bytes read, storage) and one of them moves to `tests`. Each
-- column keeps the name, type and meaning it has in its source table, and its
-- comment; only what those comments say about ids and join keys is left out,
-- because nothing here joins. No ids are stored: a row is addressed by
-- its identity columns, and pytorch_kv_sipHash64 recomputes an id from them
-- when a comparison needs one.

-- =============================================================================
--  runs_wide
-- -----------------------------------------------------------------------------
--  One row per attempt of one test, in one environment with one set of flags,
--  in one CI job, with everything known about it in the row. Facts about the
--  job stay a join on github_workflow_job_id to default.workflow_job, as in
--  runs.
-- =============================================================================
CREATE TABLE runs_wide
(
    -- the test, as in tests -------------------------------------------------------

    -- Repository the test lives in, e.g. pytorch/pytorch.
    repo                   LowCardinality(String),

    -- The file the test was launched from, repo-relative: test/test_torch.py, or
    -- test/test_jit.py for the classes it imports from test/jit/; for C++ tests
    -- the test binary, cpp/test_api. Also the report's directory in the job's
    -- zip.
    file                   LowCardinality(String),

    -- Test class or C++ test suite; empty for module-level functions. Disable
    -- issues match on "case_name (__main__.suite)".
    suite                  String,

    -- Test name exactly as the runner selects it, parameters included:
    -- test_add_cpu_float32, test_foo[1-2].
    case_name              String,

    -- python: a test in a .py file; cpp: a test in a compiled test binary; unknown:
    -- the writer could not tell or did not say.
    -- Part of the key, so a test reported without its language is a different
    -- test than the same test reported with it.
    language               Enum8('unknown' = 0, 'python' = 1, 'cpp' = 2) DEFAULT 'unknown',

    -- the environment, as in environments -----------------------------------------

    -- linux, macos or windows.
    os                     LowCardinality(String),

    -- major.minor of the OS or container image: 22.04, 15.6. Constant per Linux
    -- image; matters on macOS, where tests gate on the OS version.
    os_version             LowCardinality(String),

    -- x86_64, aarch64, s390x or ppc64le; kernels and numerics differ by it.
    cpu_architecture       LowCardinality(String),

    -- CPU kernel level, ATEN_CPU_CAPABILITY override included: default, avx2,
    -- avx512, amx, sve128, sve256, vsx or zvector. Tells AMX apart from plain
    -- AVX-512 machines and Graviton3 (sve256) from Graviton4 (sve128).
    cpu_capability         LowCardinality(String),

    -- Interpreter major.minor, with a t suffix when free-threaded: 3.10, 3.14t.
    python_version         LowCardinality(String),

    -- Compiler that built torch (gcc, clang or msvc) and its major version (11,
    -- 21); only the major is kept, so minor and patch bumps never split history.
    cc_compiler            LowCardinality(String),
    cc_compiler_version    LowCardinality(String),

    -- What torch was built for (cpu, cuda, rocm, xpu, mps or tpu) and that
    -- stack's major.minor (13.2; empty for cpu). A CUDA build on a CPU-only
    -- runner stays cuda with device_count = 0.
    accelerator            LowCardinality(String),
    accelerator_version    LowCardinality(String),

    -- Normalized accelerator model: a10g, l4, h100, b200, mi300x, mi350x, m1,
    -- m2; empty when the build cannot use a GPU. Variants that share a marketing
    -- name (a partitioned MI350X and a full card) are split here.
    device_name            LowCardinality(String),

    -- Accelerators visible to the test process, 0 for none; honors
    -- CUDA_VISIBLE_DEVICES and HIP_VISIBLE_DEVICES.
    device_count           UInt8,

    -- the flag set, as in flags ---------------------------------------------------

    -- Registered harness flags that are enabled, as '1', and registered settings
    -- that have a value, e.g. {'PYTORCH_TEST_WITH_INDUCTOR': '1',
    -- 'PYTORCH_TEST_WITH_DYNAMO': '1'}; sanitizer and debug builds appear as
    -- PYTORCH_TEST_WITH_ASAN, _UBSAN, _TSAN and _DEBUG_BUILD. Flags that are off
    -- are absent, so registering a flag changes nothing for the rows where it is
    -- off. The report lists every registered flag with its value; the ingester
    -- keeps the entries whose value is not '0' or ''. A map compares entry by
    -- entry in the order written, so the ingester sorts the keys for equal sets
    -- to be equal in the key below (flags.id sorts them itself).
    flags                  Map(LowCardinality(String), String),

    -- the owners, as in owners ----------------------------------------------------

    -- Owner labels from the "# Owner(s):" header line of file, e.g. ['module: nn'],
    -- as they were when the row was written: owners.owners from the newest row
    -- for (repo, file) at that time. The owners table keeps the history as rows;
    -- here it is spread over the attempts, so a header edit shows in the rows
    -- written after it.
    owners                 Array(LowCardinality(String)),

    -- the attempt, as in runs -----------------------------------------------------

    -- The CI job, as GitHub Actions identifies it: the join to
    -- default.workflow_job and the leading key of the by_job projection, which
    -- serves per-job reads.
    github_workflow_job_id Int64,

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
    outcome_summary        String,

    -- Start and end of the attempt, setup and teardown included; the duration is
    -- their difference. started_at partitions the table and drives the TTL.
    started_at             DateTime64(3, 'UTC'),
    ended_at               DateTime64(3, 'UTC'),

    -- Free-form metadata about the attempt with no column of its own, e.g. the
    -- report's properties: full versions behind the environment's major.minor
    -- ones, raw device string, memory, driver, CI build and config names.
    -- Metadata only: nothing joins, filters or groups on it; a value that
    -- queries need gets a real column.
    properties             JSON,

    -- Per-job reads, as runs.by_job, with the test's identity columns in place
    -- of test_id.
    PROJECTION by_job (
        SELECT * ORDER BY (github_workflow_job_id, repo, file, suite, case_name,
                           started_at, rerun_number)
    )
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(started_at)
-- The keys of runs with each id replaced by the columns it hashes, so rows
-- cluster the same way (test, environment, flags, time) and the layouts
-- differ only in the joins.
PRIMARY KEY (repo, file, suite, case_name, language,
             os, os_version, cpu_architecture, cpu_capability, python_version,
             cc_compiler, cc_compiler_version, accelerator, accelerator_version,
             device_name, device_count, flags, started_at)
ORDER BY (repo, file, suite, case_name, language,
          os, os_version, cpu_architecture, cpu_capability, python_version,
          cc_compiler, cc_compiler_version, accelerator, accelerator_version,
          device_name, device_count, flags, started_at,
          github_workflow_job_id, rerun_number)
TTL toDateTime(started_at) + INTERVAL 14 DAY
SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';
