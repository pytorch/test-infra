#!/usr/bin/env python3
"""Fill the trial tables with made-up but realistic test data.

    python3 populate_dummy_data.py                      # ~48,000 tests, 50M attempts over ten days
    python3 populate_dummy_data.py --count 1000000      # a quick look
    python3 populate_dummy_data.py --workers 20         # more statements in flight at once

Connection comes from ../migrate.py (the CLICKHOUSE_* variables), and the target
is its sandbox database, fortesting. The tables must already exist
(`python3 ../migrate.py --folder ci apply --execute`) and be empty.
`python3 ../migrate.py drop` previews a reset of the sandbox.
Refuses to run against any other database.

What it writes:
  tests         op-info style device-generic classes (one case per test
                method, op, dtype and device: test_out_add_cuda_float32, whose
                declared_case_name is test_out) in test_ops.py and its siblings,
                plain unittest classes, pytest parametrization in brackets,
                module-level functions, a jit wrapper file, distributed and
                inductor files, an xfail-heavy numpy-compat file, C++ gtest
                suites including typed and value-parameterized ones, and a few
                tests of unknown language, these without a declared_case_name.
  environments  CUDA, ROCm, CPU-only, aarch64, macOS, Windows, XPU and s390x
                machines, with one, two, four or zero devices.
  flags         default, dynamo, inductor, slow, sanitizers, debug, crossref,
                ROCm, rerun-disabled-tests, and a setting with a non-flag value.
  owners        one current row per file, including an ownership replacement.
  runs          --count attempts, as many CI rounds as that takes, spread
                evenly over the last ten days. A round is one job per
                (environment, flag set), each running its share of the tests
                over the next few hours. Rounds differ a little in size, so
                most run whole and in parallel, sized to stay half a percent
                under the count even if every round came out that much bigger
                than the first, and the gap is closed by cut rounds, one at a
                time, until the count is exact. Each test has a stable personality: most pass, a
                few always fail (three failed attempts per job), some are
                flaky (failed attempts then a pass), CUDA suites are skipped
                on machines without a device, the numpy-compat file is mostly
                xfailed, and there is a thin tail of error, crashed, timed_out
                and unknown outcomes. A quarter of the rows carry properties,
                and durations span four orders of magnitude. Job ids count up
                by round, so a round's jobs are one contiguous range. A round
                is one INSERT ... SELECT on the server, and --workers of them
                run at once.

Every INSERT is safe to repeat. When a reply is lost (the connection dropped,
the service moved a replica) the statement is retried up to three times, and
the server drops a second copy of a block it already has, keyed by the
statement's deduplication token, so a retry never doubles a round. The final
row counts are checked against the count asked for.

The ids of tests, environments and flags are never computed here: the rows are
inserted without them and the tables' DEFAULT expressions fill them in, which
is also how the runs rows pick them up. Everything is deterministic: the same
arguments produce the same rows, with timestamps relative to now. The ten-day
window stays inside the runs table's 14-day TTL.
"""

from __future__ import annotations

import argparse
import datetime
import math
import sys
import time
from concurrent.futures import as_completed, ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Sequence, Tuple


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from migrate import Failed, Http, SANDBOX  # noqa: E402


REPO = "pytorch/pytorch"
FIRST_JOB_ID = 50_000_000_000  # in the range GitHub uses today
JOBS_PER_ROUND = 10_000  # job ids per CI round: a slot per (environment, flag set)
RETRY_DELAYS = (10, 30)  # seconds before the second and third attempt of a statement
WINDOW = datetime.timedelta(
    days=10
)  # the runs span the last ten days, inside the 14-day TTL
DEFAULT_COUNT = 50_000_000
# Rounds differ in size through which tests get reruns, by about 0.2 percent
# either way of round 0 (measured over 1,043 rounds). The whole rounds that run
# in parallel are sized to stay this far under the count, so they cannot
# overshoot it; cut rounds then close the gap.
DRIFT_ALLOWANCE = 0.005
TABLES = ("tests", "environments", "flags", "owners", "runs")

# file, suite, case_name, declared_case_name, language
Test = Tuple[str, str, str, str, str]


def sql_str(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def sql_map(pairs: Dict[str, str]) -> str:
    items = sorted(pairs.items())
    return "map(" + ", ".join(f"{sql_str(k)}, {sql_str(v)}" for k, v in items) + ")"


def sql_array(items: Sequence[str]) -> str:
    return "[" + ", ".join(sql_str(item) for item in items) + "]"


# --------------------------------------------------------------------------- the catalog

# fmt: off
DEVICES = ("cpu", "cuda")
DTYPES = (
    "float32", "float64", "float16", "bfloat16", "complex64", "complex128",
    "int8", "int16", "int32", "int64", "uint8", "bool",
)
OPS = (  # OpInfo names, dots replaced by underscores as in the test names
    "abs", "acos", "add", "addcdiv", "addcmul", "addmm", "addmv", "all", "amax", "amin",
    "any", "argmax", "argsort", "as_strided", "atan2", "baddbmm", "bitwise_and", "bmm",
    "cat", "cdist", "ceil", "chunk", "clamp", "clone", "cos", "cross", "cummax", "cumprod",
    "cumsum", "diag", "diagonal", "diff", "div", "dot", "einsum", "eq", "erf", "exp",
    "expand", "fft_fft", "fft_fftn", "fft_rfft", "flip", "floor_divide", "fmod", "gather",
    "index_add", "index_put", "index_select", "isfinite", "kron", "lerp", "linalg_cholesky",
    "linalg_det", "linalg_eigh", "linalg_inv", "linalg_lstsq", "linalg_lu_factor",
    "linalg_matrix_norm", "linalg_norm", "linalg_pinv", "linalg_qr", "linalg_solve",
    "linalg_svd", "linalg_vector_norm", "log", "log_softmax", "logaddexp", "logcumsumexp",
    "logsumexp", "masked_fill", "masked_scatter", "matmul", "max", "mean", "median", "min",
    "mm", "mul", "mv", "nan_to_num", "nansum", "narrow", "neg",
    "nn_functional_adaptive_avg_pool2d", "nn_functional_avg_pool2d",
    "nn_functional_batch_norm", "nn_functional_conv2d", "nn_functional_cross_entropy",
    "nn_functional_embedding", "nn_functional_gelu", "nn_functional_group_norm",
    "nn_functional_interpolate_bilinear", "nn_functional_layer_norm", "nn_functional_linear",
    "nn_functional_max_pool2d", "nn_functional_mse_loss", "nn_functional_pad_constant",
    "nn_functional_relu", "nn_functional_scaled_dot_product_attention", "nn_functional_silu",
    "nn_functional_softmax", "nonzero", "norm", "outer", "permute", "pow", "prod",
    "reciprocal", "remainder", "repeat", "reshape", "roll", "round", "rsqrt", "scatter",
    "scatter_add", "scatter_reduce_sum", "searchsorted", "select", "sigmoid", "sign", "sin",
    "softmax", "sort", "split", "sqrt", "square", "squeeze", "stack", "std", "sub", "sum",
    "take_along_dim", "tanh", "tensordot", "topk", "trace", "transpose", "tril", "triu",
    "unbind", "unfold", "unique", "unsqueeze", "var", "view", "where", "xlogy", "zeros_like",
)

# device-generic op-info classes: file, suite prefix, the test methods, and how
# many of DTYPES each op gets. One test per (method, op, dtype, device).
OPINFO_SUITES = (
    ("test/test_ops.py", "TestCommon", (
        "test_out", "test_variant_consistency_eager", "test_noncontiguous_samples",
        "test_python_ref_meta", "test_compare_cpu"), 12),
    ("test/test_ops.py", "TestMathBits", ("test_conj_view", "test_neg_view", "test_neg_conj_view"), 2),
    ("test/test_ops.py", "TestFakeTensor", (
        "test_fake", "test_fake_autocast", "test_fake_crossref_backward_no_amp"), 4),
    ("test/test_ops.py", "TestCompositeCompliance", ("test_operator", "test_backward", "test_forward_ad"), 2),
    ("test/test_ops_gradients.py", "TestBwdGradients", ("test_fn_grad", "test_fn_gradgrad", "test_inplace_grad"), 3),
    ("test/test_ops_fwd_gradients.py", "TestFwdGradients", ("test_forward_mode_AD", "test_inplace_forward_mode_AD"), 3),
    ("test/test_decomp.py", "TestDecomp", ("test_comprehensive", "test_quick"), 8),
    ("test/test_meta.py", "TestMeta", ("test_meta_outplace", "test_meta_inplace", "test_dispatch_meta_outplace"), 8),
    ("test/inductor/test_torchinductor_opinfo.py", "TestInductorOpInfo", ("test_comprehensive",), 6),
    ("functorch/test_ops.py", "TestOperators", (
        "test_grad", "test_vjp", "test_vmapvjp", "test_jvp", "test_vmapjvpall"), 2),
    ("functorch/test_vmap.py", "TestVmapOperatorsOpInfo", ("test_vmap_exhaustive", "test_op_has_batch_rule"), 2),
    ("test/distributed/tensor/test_dtensor_ops.py", "TestDTensorOps", ("test_dtensor_op_db",), 1),
)

# plain classes: file, suite, cases
PLAIN_SUITES = (
    ("test/test_torch.py", "TestTorch", (
        "test_add", "test_add_broadcast", "test_copy_", "test_empty_strided",
        "test_index_put_accumulate", "test_narrow", "test_pin_memory",
        "test_scalar_check", "test_storage_setitem", "test_sum_dim",
    )),
    ("test/dynamo/test_misc.py", "MiscTests", (
        "test_simple", "test_closure_out_of_scope_cell", "test_dict_mutation_side_effect",
        "test_inplace_param_update", "test_nested_closure", "test_numpy_int_constant",
        "test_user_defined_class_name",
    )),
    ("test/inductor/test_torchinductor.py", "CpuTests", (
        "test_add_const_int", "test_arange1", "test_cat_upcasting", "test_conv2d_channels_last",
        "test_embedding_bag", "test_index_put", "test_linear_float64", "test_max_pool2d1",
        "test_multilayer_var", "test_pointwise_broadcast", "test_sum_keepdims",
    )),
    ("test/inductor/test_torchinductor.py", "GPUTests", (
        "test_add_const_int", "test_arange1", "test_cat_upcasting", "test_conv2d_channels_last",
        "test_embedding_bag", "test_index_put", "test_linear_float64", "test_max_pool2d1",
        "test_multilayer_var", "test_pointwise_broadcast", "test_sum_keepdims",
    )),
    ("test/distributed/test_c10d_nccl.py", "ProcessGroupNCCLTest", (
        "test_allreduce_basics", "test_barrier", "test_broadcast_coalesced",
        "test_reduce_scatter_tensor", "test_send_recv",
    )),
    ("test/distributed/tensor/test_api.py", "DTensorAPITest", (
        "test_distribute_tensor", "test_redistribute", "test_dtensor_api_device_mesh",
    )),
    ("test/typing/test_typing.py", "", (  # module-level functions
        "test_reveal[torch.rand]", "test_reveal[torch.zeros]", "test_fail[arithmetic_ops]",
    )),
    ("test/test_jit.py", "TestScript", (  # classes imported from test/jit/
        "test_script_module", "test_tracing_bound_method", "test_fuser_double_float_casts",
    )),
    ("test/test_cuda.py", "TestCuda", (
        "test_cuda_memory_leak_detection", "test_graph_capture_simple",
        "test_mem_get_info", "test_stream_event_nogil",
    )),
    ("test/test_mps.py", "TestMPS", (
        "test_mps_allocator_module", "test_binary_ops_mps", "test_conv_transpose_mps",
    )),
    ("test/test_testing.py", "TestTesting", (  # awkward names
        "test_assert_close_quantized[msg=foo bar 'baz']",
        "test_unicode_ünïcödé_message",
        "test_" + "_".join(["very_long_parametrized_name"] * 8),
    )),
)

CPP_SUITES = (
    ("cpp/test_api", "ModulesTest", (
        "Linear", "Conv2d", "BatchNorm2d", "Embedding", "LSTM", "MultiheadAttention",
        "TransformerEncoderLayer", "PrettyPrintLinear",
    )),
    ("cpp/test_api", "OptimTest", ("SGD", "Adam", "LBFGS")),
    ("cpp/c10_optional_test", "OptionalTest/0", ("Empty", "Value", "Reset")),  # typed suites
    ("cpp/c10_optional_test", "OptionalTest/1", ("Empty", "Value", "Reset")),
    ("cpp/c10_optional_test", "OptionalTest/2", ("Empty", "Value", "Reset")),
    ("cpp/c10_bfloat16_test", "BFloat16RNETest/0", ("RoundToNearestEven",)),  # value-parameterized
    ("cpp/c10_bfloat16_test", "BFloat16RNETest/1", ("RoundToNearestEven",)),
    ("cpp/atest", "atest", ("operators", "logical_and_operators", "weakref_test")),
    ("cpp/c10_intrusive_ptr_test", "IntrusivePtrTest", (
        "givenValidPtr_whenCopyAssigning_thenPointsToSameObject",
        "givenMoveConstructedPtr_whenDestructed_thenDestructsObjectOnce",
    )),
)

# os, os_version, cpu_architecture, cpu_capability, python_version, cc_compiler,
# cc_compiler_version, accelerator, accelerator_version, device_name, device_count
ENVIRONMENT_COLUMNS = (
    "os", "os_version", "cpu_architecture", "cpu_capability", "python_version", "cc_compiler",
    "cc_compiler_version", "accelerator", "accelerator_version", "device_name", "device_count",
)
ENVIRONMENTS = (
    ("linux", "22.04", "x86_64", "avx512", "3.10", "gcc", "11", "cuda", "12.8", "a10g", 1),
    ("linux", "22.04", "x86_64", "avx512", "3.10", "gcc", "11", "cuda", "13.0", "h100", 1),
    ("linux", "22.04", "x86_64", "avx512", "3.10", "gcc", "11", "cuda", "13.0", "h100", 4),
    ("linux", "22.04", "x86_64", "avx512", "3.12", "clang", "21", "cuda", "12.8", "l4", 2),
    ("linux", "22.04", "x86_64", "avx512", "3.10", "gcc", "11", "cuda", "12.8", "", 0),
    ("linux", "22.04", "x86_64", "avx2", "3.10", "gcc", "11", "cpu", "", "", 0),
    ("linux", "22.04", "x86_64", "amx", "3.14t", "gcc", "13", "cpu", "", "", 0),
    ("linux", "22.04", "aarch64", "sve256", "3.10", "gcc", "11", "cpu", "", "", 0),
    ("linux", "22.04", "x86_64", "avx512", "3.10", "clang", "21", "rocm", "7.1", "mi300x", 1),
    ("linux", "22.04", "x86_64", "avx512", "3.10", "clang", "21", "rocm", "7.1", "mi300x", 4),
    ("linux", "22.04", "x86_64", "avx512", "3.10", "gcc", "11", "xpu", "2025.1", "pvc", 1),
    ("linux", "22.04", "s390x", "zvector", "3.10", "gcc", "11", "cpu", "", "", 0),
    ("macos", "15.6", "aarch64", "default", "3.10", "clang", "17", "mps", "", "m2", 1),
    ("windows", "2022", "x86_64", "avx512", "3.10", "msvc", "19", "cuda", "12.8", "l4", 1),
)

FLAG_SETS = (
    {},
    {"PYTORCH_TEST_WITH_DYNAMO": "1"},
    {"PYTORCH_TEST_WITH_INDUCTOR": "1", "PYTORCH_TEST_WITH_DYNAMO": "1"},
    {"PYTORCH_TEST_WITH_SLOW": "1"},
    {"PYTORCH_TEST_WITH_ASAN": "1", "PYTORCH_TEST_WITH_UBSAN": "1"},
    {"PYTORCH_TEST_WITH_DEBUG_BUILD": "1"},
    {"PYTORCH_TEST_WITH_CROSSREF": "1"},
    {"PYTORCH_TEST_WITH_ROCM": "1"},
    {"PYTORCH_TEST_WITH_ROCM": "1", "PYTORCH_TEST_WITH_DYNAMO": "1"},
    {"PYTORCH_TEST_RERUN_DISABLED_TESTS": "1"},
    {"OPINFO_RESTRICT_TO_DSL": "aten.add.Tensor"},  # a setting, not a flag
)

OWNER_RULES = (  # file prefix -> owners; first match wins
    ("test/test_nn.py", ["module: nn"]),
    ("test/inductor/", ["module: inductor"]),
    ("test/dynamo/", ["module: dynamo"]),
    ("test/distributed/", ["oncall: distributed"]),
    ("test/torch_np/", ["module: numpy"]),
    ("functorch/", ["module: functorch"]),
    ("test/test_jit.py", ["oncall: jit"]),
    ("test/test_cuda.py", ["module: cuda"]),
    ("test/test_mps.py", ["module: mps"]),
    ("test/typing/", ["module: typing"]),
    ("cpp/", ["module: cpp"]),
    ("test/test_ops.py", ["module: tests", "module: primTorch"]),
)
# fmt: on


def declared_case_of(case: str) -> str:
    """The declared name behind a pytest-parametrized case: before the brackets."""
    return case.split("[", 1)[0]


def catalog() -> List[Test]:
    tests: List[Test] = []
    for file, suite_prefix, methods, dtype_count in OPINFO_SUITES:
        for device in DEVICES:
            suite = f"{suite_prefix}{device.upper()}"
            for method in methods:
                for op in OPS:
                    for dtype in DTYPES[:dtype_count]:
                        case = f"{method}_{op}_{device}_{dtype}"
                        tests.append((file, suite, case, method, "python"))
    for file, suite, cases in PLAIN_SUITES:
        for case in cases:
            tests.append((file, suite, case, declared_case_of(case), "python"))
    for device in DEVICES:
        suite = f"TestNNDeviceType{device.upper()}"
        for case in ("test_conv_backend", "test_grid_sample", "test_layer_norm_grad"):
            tests.append(("test/test_nn.py", suite, f"{case}_{device}", case, "python"))
    for index in range(1, 41):
        case = f"test_issue{100000 + 37 * index}"
        tests.append(("test/dynamo/test_repros.py", "ReproTests", case, case, "python"))
    for case in (
        "test_fsdp_core",
        "test_mixed_precision_e2e",
        "test_sharding_strategy",
    ):
        for config in ("cuda", "cuda_hsdp"):
            file, suite = "test/distributed/fsdp/test_fsdp_core.py", "TestParityWithDDP"
            tests.append((file, suite, f"{case}_{config}", case, "python"))
    declared, file = "test_param_invariance", "test/test_subclass.py"
    for subclass in (
        "DiagTensorBelow",
        "LoggingTensor",
        "SparseTensor",
        "WrapperTensor",
    ):
        for grad in ("True", "False"):
            case = f"{declared}[subclass_name={subclass}-requires_grad={grad}]"
            tests.append((file, "TestSubclass", case, declared, "python"))
    declared, file = "test_registrations", "functorch/test_vmap_registrations.py"
    for index in range(1, 9):
        for inner in range(1, 4):
            case = f"{declared}[{index}-{inner}]"
            tests.append((file, "", case, declared, "python"))
    for name in ("int8", "uint8", "int16", "float32", "float64", "complex64", "bool_"):
        for case in ("test_convert", "test_cast_safe", "test_promote"):
            file = "test/torch_np/test_dtype.py"
            tests.append((file, "TestConvertDType", f"{case}[{name}]", case, "python"))
    for file, suite, cases in CPP_SUITES:
        tests.extend((file, suite, case, case, "cpp") for case in cases)
    # unknown language: the writer did not say the declared name either
    tests.extend(
        ("tools/testing/selftest", "", f"selftest_{i}", "", "unknown") for i in range(3)
    )
    return tests


def owners_for(file: str) -> List[str]:
    for prefix, owners in OWNER_RULES:
        if file.startswith(prefix):
            return owners
    return ["module: tests"]


# --------------------------------------------------------------------------- the runs

COVERAGE = """
    -- ROCm flag sets run on ROCm machines, and only there
    mapContains(f.flags, 'PYTORCH_TEST_WITH_ROCM') = (e.accelerator = 'rocm')
    -- macOS, Windows and s390x run the default flag set only
    AND (e.os = 'linux' AND e.cpu_architecture != 's390x' OR length(f.flags) = 0)
    -- C++ tests run on Linux, with default flags or the sanitizers
    AND (t.language != 'cpp'
         OR (e.os = 'linux'
             AND (length(f.flags) = 0 OR mapContains(f.flags, 'PYTORCH_TEST_WITH_ASAN'))))
    -- unknown-language tests: Linux, default flags
    AND (t.language != 'unknown' OR (e.os = 'linux' AND length(f.flags) = 0))
    -- platform-specific files
    AND (t.file != 'test/test_cuda.py' OR e.accelerator = 'cuda')
    AND (t.file != 'test/test_mps.py' OR e.os = 'macos')
    AND (e.os != 'macos' OR t.file IN ('test/test_mps.py', 'test/test_torch.py',
                                        'test/test_nn.py', 'test/test_ops.py',
                                        'test/test_testing.py'))
    AND (t.file NOT LIKE 'test/distributed/%' OR e.device_count >= 2)
    -- dynamo and inductor wrap Python tests outside distributed
    AND (NOT mapContains(f.flags, 'PYTORCH_TEST_WITH_DYNAMO')
         OR (t.language = 'python' AND t.file NOT LIKE 'test/distributed/%'))
    -- not every test is in every job; the default set covers the most
    AND cityHash64(t.id, e.id, f.id) % 100 < if(length(f.flags) = 0, 45, 18)
"""

# One CI round: a job per (environment, flag set) and the tests each one covers.
ROUND_SELECT = """
SELECT
    test_id, env_id, flags_id, job_id,
    toUInt16(attempt_index) AS rerun_number,
    multiIf(kind = 'flaky', if(attempt_index = attempts - 1, 'passed', 'failed'),
            kind = 'rerun_disabled',
                if(cityHash64(test_id, job_id, attempt_index) % 10 < 2, 'failed', 'passed'),
            kind) AS outcome,
    multiIf(
        outcome = 'failed', ['AssertionError: Tensor-likes are not close!',
                             'AssertionError: False is not true',
                             'RuntimeError: Expected all tensors to be on the same device',
                             'torch.AcceleratorError: CUDA error: an illegal memory access was encountered'
                            ][1 + cityHash64(test_id, 'message') % 4],
        outcome = 'error', ['RuntimeError: setup error',
                            'ImportError: cannot import name einops',
                            'OSError: [Errno 24] Too many open files'
                           ][1 + cityHash64(test_id, 'message') % 3],
        outcome = 'skipped', ['Skipped: Only runs on cuda',
                              'Skipped: test is slow; run with PYTORCH_TEST_WITH_SLOW to enable test',
                              'Skipped: Test is disabled because an issue exists: pytorch/pytorch#123456',
                              'Skipped: not supported on this device'
                             ][1 + cityHash64(test_id, 'message') % 4],
        outcome = 'xfailed', 'XFAIL: tracked in https://github.com/pytorch/pytorch/issues/98765',
        outcome = 'xpassed', 'XPASS: the expected failure passed; the xfail mark is stale',
        outcome = 'crashed', 'crash: signal 11 (SIGSEGV) while this test was running',
        outcome = 'timed_out', 'timeout: the process exceeded 1800s while this test was running',
        '') AS outcome_summary,
    first_started_at + toIntervalMillisecond((duration_ms + 500) * attempt_index) AS started_at,
    started_at + toIntervalMillisecond(duration_ms) AS ended_at,
    properties
FROM
(
    SELECT
        t.id AS test_id, e.id AS env_id, f.id AS flags_id,
        toInt64({first_job_id} + {round} * {jobs_per_round} + (e.slot - 1) * 100 + f.slot) AS job_id,
        cityHash64(t.id) % 100 AS personality,
        cityHash64(t.id, job_id) % 1000 AS roll,
        multiIf(
            t.file LIKE 'test/torch_np/%' AND roll < 600, 'xfailed',
            t.file LIKE 'test/torch_np/%' AND roll < 630, 'xpassed',
            e.device_count = 0 AND t.suite LIKE '%CUDA', 'skipped',
            personality < 1, 'failed',
            personality < 4 AND roll < 250, 'flaky',
            mapContains(f.flags, 'PYTORCH_TEST_RERUN_DISABLED_TESTS') AND personality < 2,
                'rerun_disabled',
            roll < 20, 'skipped',
            roll < 25, 'failed',
            roll < 28, 'error',
            roll < 29, 'crashed',
            roll < 30, 'timed_out',
            roll < 32, 'xfailed',
            roll < 33, 'unknown',
            'passed') AS kind,
        multiIf(kind IN ('failed', 'error'), 3,
                kind = 'flaky', 2 + toUInt8(roll % 2),
                kind = 'rerun_disabled', 50,
                1) AS attempts,
        multiIf(kind = 'timed_out', 1800000,
                t.language = 'cpp', toUInt32(5 + cityHash64(t.id, 'duration') % 400),
                toUInt32(pow(10, 1.3 + (cityHash64(t.id, 'duration') % 1000) / 1000 * 3.2)
                         * if(mapContains(f.flags, 'PYTORCH_TEST_WITH_SLOW'), 5, 1))) AS duration_ms,
        toDateTime64({round_start}, 3, 'UTC')
            + toIntervalSecond(cityHash64(e.id, f.id, {round}, 'start') % 7200
                               + cityHash64(t.id, job_id) % 3600) AS first_started_at,
        if(roll % 4 = 0,
           CAST(toJSONString(map(
               'build_environment',
                   concat(e.os, '-', e.os_version, '-py', e.python_version, '-',
                          e.cc_compiler, e.cc_compiler_version,
                          if(e.accelerator = 'cpu', '',
                             concat('-', e.accelerator, e.accelerator_version))),
               'TEST_CONFIG',
                   multiIf(mapContains(f.flags, 'PYTORCH_TEST_WITH_INDUCTOR'), 'inductor',
                           mapContains(f.flags, 'PYTORCH_TEST_WITH_DYNAMO'), 'dynamo_wrapped',
                           mapContains(f.flags, 'PYTORCH_TEST_WITH_SLOW'), 'slow',
                           t.file LIKE 'test/distributed/%', 'distributed',
                           'default'),
               'shard', toString(1 + cityHash64(t.id) % 5))), 'JSON'),
           CAST('{{}}', 'JSON')) AS properties
    FROM tests AS t
    CROSS JOIN (SELECT *, row_number() OVER (ORDER BY id) AS slot FROM environments) AS e
    CROSS JOIN (SELECT *, row_number() OVER (ORDER BY id) AS slot FROM flags) AS f
    WHERE {coverage}
)
ARRAY JOIN range(attempts) AS attempt_index
{tail}
"""

RUNS_INSERT = (  # in front of retry_safe() and a round_select()
    "INSERT INTO runs (test_id, env_id, flags_id, github_workflow_job_id, rerun_number,"
    " outcome, outcome_summary, started_at, ended_at, properties)"
)

# The job id formula above needs every (environment, flag set) slot to fit in a round's block.
assert len(ENVIRONMENTS) <= 100 and len(FLAG_SETS) < 100, (
    "job slots would overflow JOBS_PER_ROUND"
)


def retry_safe(token: str) -> str:
    """INSERT settings that make a statement safe to run again after a lost
    reply: its rows go in one block per partition, and the token makes the
    server drop a second copy of a block it already has."""
    return (
        f" SETTINGS insert_deduplication_token = {sql_str(token)}, max_insert_threads = 1,"
        " min_insert_block_size_rows = 100000000, min_insert_block_size_bytes = 10000000000\n"
    )


def round_select(index: int, start: datetime.datetime, limit: int = 0) -> str:
    """The rows of CI round `index`, which begins at `start`. A limit cuts the
    round short after that many rows, whole jobs first."""
    tail = f"ORDER BY job_id, test_id, attempt_index LIMIT {limit}" if limit else ""
    return ROUND_SELECT.format(
        first_job_id=FIRST_JOB_ID,
        jobs_per_round=JOBS_PER_ROUND,
        round=index,
        round_start=sql_str(f"{start:%Y-%m-%d %H:%M:%S}"),
        coverage=COVERAGE,
        tail=tail,
    )


def round_insert(index: int, start: datetime.datetime, limit: int = 0) -> str:
    return (
        RUNS_INSERT
        + retry_safe(f"runs round {index}")
        + round_select(index, start, limit)
    )


# --------------------------------------------------------------------------- driver


def insert_values(
    executor, table: str, columns: Sequence[str], rows: Iterable[str]
) -> None:
    values = ",\n".join(rows)
    executor.run(f"INSERT INTO {table} ({', '.join(columns)}) VALUES\n{values}")


def count(executor, table: str) -> int:
    # Count current owners even before background merges replace the old row.
    final = " FINAL" if table == "owners" else ""
    return int(executor.run(f"SELECT count() FROM {table}{final}").strip())


def run_with_retries(executor, name: str, sql: str) -> None:
    """Run one retry-safe statement, trying again after a lost or failed reply.

    A statement that the server finished but whose reply was lost is a no-op
    when run again (see retry_safe). An HTTP 4xx is the statement's own fault
    and is not retried.
    """
    for attempt, delay in enumerate(RETRY_DELAYS + (None,), 1):
        try:
            executor.run(sql)
            return
        except Failed as error:
            if delay is None or str(error).startswith("HTTP 4"):
                raise
            print(f"   {name}: {error}; attempt {attempt + 1} in {delay} s", flush=True)
            time.sleep(delay)


def run_in_parallel(
    executor,
    workers: int,
    statements: Dict[str, str],
    progress: Callable[[str, int, int], None],
) -> None:
    """Run independent statements, workers at a time; stop at the first failure.

    Each statement is an INSERT ... SELECT the server does on its own, so a
    worker only waits for its reply. progress(name, done, total) runs on the
    calling thread after each statement finishes.
    """
    total = len(statements)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(run_with_retries, executor, name, sql): name
            for name, sql in statements.items()
        }
        for done, future in enumerate(as_completed(futures), 1):
            try:
                future.result()
            except Failed as error:
                pool.shutdown(cancel_futures=True)
                raise Failed(f"{futures[future]}: {error}") from None
            progress(futures[future], done, total)


def round_start(
    start: datetime.datetime, step: datetime.timedelta, index: int, rounds: int
) -> datetime.datetime:
    """When CI round `index` begins. A round past the planned count shares the
    last planned start, so nothing is dated after now."""
    return start + min(index, rounds - 1) * step


def populate(executor, target: int, workers: int) -> int:
    if executor.database != SANDBOX:
        raise Failed("dummy data is for the trial database only")
    rows = {}
    for table in TABLES:
        try:
            rows[table] = count(executor, table)
        except Failed as error:
            raise Failed(
                f"{SANDBOX}.{table} is missing; run python3 ../migrate.py --folder ci apply --execute first ({error})"
            ) from None
    for table in TABLES:
        if rows[table]:
            raise Failed(
                f"{SANDBOX}.{table} already has {rows[table]:,} rows; drop and apply first"
            )
    tests = catalog()
    print(f"== tests: {len(tests)} rows")
    insert_values(
        executor,
        "tests",
        ("repo", "file", "suite", "case_name", "declared_case_name", "language"),
        (
            f"({sql_str(REPO)}, {sql_str(file)}, {sql_str(suite)}, {sql_str(case)}, "
            f"{sql_str(declared)}, {sql_str(lang)})"
            for file, suite, case, declared, lang in tests
        ),
    )

    print(f"== environments: {len(ENVIRONMENTS)} rows")
    insert_values(
        executor,
        "environments",
        ENVIRONMENT_COLUMNS,
        (
            "("
            + ", ".join(sql_str(v) if isinstance(v, str) else str(v) for v in row)
            + ")"
            for row in ENVIRONMENTS
        ),
    )

    print(f"== flags: {len(FLAG_SETS)} rows")
    insert_values(executor, "flags", ("flags",), (f"({sql_map(f)})" for f in FLAG_SETS))

    files = sorted({file for file, *_ in tests})
    print(f"== owners: {len(files)} files, one of them re-owned")
    owner_row = f"({sql_str(REPO)}, {{file}}, {{owners}})"
    insert_values(
        executor,
        "owners",
        ("repo", "file", "owners"),
        (
            owner_row.format(file=sql_str(f), owners=sql_array(owners_for(f)))
            for f in files
        ),
    )
    time.sleep(1)  # give the replacement a newer server-generated created_at
    reowned = owner_row.format(
        file=sql_str("test/test_jit.py"),
        owners=sql_array(["oncall: jit", "module: dynamo"]),
    )
    insert_values(executor, "owners", ("repo", "file", "owners"), [reowned])

    generate_runs(executor, target, workers)
    return summary(executor)


def generate_runs(executor, target: int, workers: int) -> None:
    """Write exactly `target` attempt rows to runs, as CI rounds."""
    # Size one round, then spread as many as the count needs over the window.
    # Rounds differ in size only through which tests get reruns, so most run
    # whole and in parallel: as many as stay DRIFT_ALLOWANCE under the count
    # even if every one came out that much bigger than round 0. Cut rounds then
    # land on the count, one at a time, each limited to what is still missing.
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    start = now - WINDOW
    per_round = int(executor.run(f"SELECT count() FROM ({round_select(0, start)})"))
    rounds = max(1, math.ceil(target / per_round))  # planned; sets the spacing
    step = WINDOW / rounds
    whole = min(rounds - 1, int(target * (1 - DRIFT_ALLOWANCE) // per_round))
    spacing = f", one every {step.total_seconds() / 3600:.1f} h" if rounds > 1 else ""
    print(
        f"== runs: {target:,} attempts in about {rounds} CI round{'s' if rounds > 1 else ''} "
        f"of ~{per_round:,}{spacing}, from {start:%Y-%m-%d %H:%M} UTC: "
        f"{whole} whole round{'s' if whole != 1 else ''} {workers} at a time, then cut rounds one at a time"
    )
    run_in_parallel(
        executor,
        workers,
        {
            f"round {index + 1}": round_insert(
                index, round_start(start, step, index, rounds)
            )
            for index in range(whole)
        },
        lambda name, done, total: print(
            f"   {name} done ({done}/{total}): {count(executor, 'runs'):,} rows so far"
        ),
    )
    written = count(executor, "runs")
    if written > target:
        raise Failed(
            f"the {whole} whole rounds already hold {written:,} rows, {written - target:,} more "
            f"than asked: rounds came out more than {DRIFT_ALLOWANCE:.1%} bigger than round 0 "
            f"({per_round:,} rows); raise DRIFT_ALLOWANCE, then drop the tables and start over"
        )
    index = whole
    while written < target:
        remaining = target - written
        print(f"   round {index + 1}: up to {remaining:,} rows", flush=True)
        statement = round_insert(
            index, round_start(start, step, index, rounds), limit=remaining
        )
        run_with_retries(executor, f"round {index + 1}", statement)
        before, written = written, count(executor, "runs")
        if written == before:
            raise Failed(
                f"round {index + 1} added no rows; drop the tables and start over"
            )
        index += 1
        print(f"   round {index} added {written - before:,} rows: {written:,} so far")
    if written != target:
        raise Failed(
            f"runs has {written:,} rows but {target:,} were asked for: a round was written "
            "twice (a retried statement the server did not deduplicate); drop the tables and "
            "start over"
        )


def summary(executor) -> int:
    print()
    for table in TABLES:
        print(f"{table:14} {count(executor, table):>12,}")
    return 0


def positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return value


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    parser.add_argument(
        "--count",
        type=positive_int,
        default=DEFAULT_COUNT,
        help=f"attempt rows to write to runs (default {DEFAULT_COUNT:,})",
    )
    parser.add_argument(
        "--workers",
        type=positive_int,
        default=6,
        help="statements to run at once (default 6)",
    )
    args = parser.parse_args(argv)
    try:
        return populate(Http(SANDBOX), args.count, args.workers)
    except Failed as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
