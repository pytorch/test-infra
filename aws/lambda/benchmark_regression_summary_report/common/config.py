from common.config_model import (
    BenchmarkApiSource,
    BenchmarkConfig,
    BenchmarkRegressionConfigBook,
    DayRangeWindow,
    Frequency,
    Policy,
    RangeConfig,
    RegressionPolicy,
    ReportConfig,
)


PYTORCH_HELION_CONFIG = BenchmarkConfig(
    name="Helion Benchmark Regression",
    id="pytorch_helion",
    source=BenchmarkApiSource(
        api_query_url="https://hud.pytorch.org/api/benchmark/get_time_series",
        type="benchmark_time_series_api",
        api_endpoint_params_template="""
                {
                  "name": "pytorch_helion",
                  "query_params": {
                    "mode": "",
                    "branches": ["main"],
                    "repo": "pytorch/helion",
                    "device": "",
                    "arch":"",
                    "benchmarkName": "Helion Benchmark",
                    "startTime": "{{ startTime }}",
                    "stopTime": "{{ stopTime }}"
                    },
                    "response_formats":["time_series"]
                }
                """,
    ),
    hud_info={
        "url": "https://hud.pytorch.org/benchmark/v3/dashboard/pytorch_helion",
    },
    # set baseline from past 4-8 days, and compare with the lastest 4 day
    policy=Policy(
        frequency=Frequency(value=1, unit="days"),
        range=RangeConfig(
            baseline=DayRangeWindow(value=4),
            comparison=DayRangeWindow(value=4),
        ),
        metrics={
            "helion_speedup": RegressionPolicy(
                name="helion_speedup",
                condition="greater_equal",
                threshold=0.95,
                baseline_aggregation="median",
            ),
        },
        notification_config={
            "configs": [
                {
                    "type": "github",
                    "repo": "pytorch/test-infra",
                    "issue": "7472",
                }
            ]
        },
    ),
    report_config=ReportConfig(
        report_level="insufficient_data",
    ),
)


TORCHAO_MICRO_API_CONFIG = BenchmarkConfig(
    name="Torchao Micro Api Regression",
    id="torchao_micro_api_benchmark",
    source=BenchmarkApiSource(
        api_query_url="https://hud.pytorch.org/api/benchmark/get_time_series",
        type="benchmark_time_series_api",
        api_endpoint_params_template="""
                {
                  "name": "torchao_micro_api_benchmark",
                  "query_params": {
                    "mode": "",
                    "branches": ["main"],
                    "repo": "pytorch/ao",
                    "device": "",
                    "benchmarkName": "micro-benchmark api",
                    "startTime": "{{ startTime }}",
                    "stopTime": "{{ stopTime }}"
                    },
                    "response_formats":["time_series"]
                }
                """,
    ),
    hud_info={
        "url": "https://hud.pytorch.org/benchmark/v3/dashboard/torchao_micro_api_benchmark",
    },
    # set baseline from past 3-6 days, and compare with the lastest 3 days
    policy=Policy(
        frequency=Frequency(value=1, unit="days"),
        range=RangeConfig(
            baseline=DayRangeWindow(value=3),
            comparison=DayRangeWindow(value=3),
        ),
        metrics={
            "bfloat16 fwd time (ms)": RegressionPolicy(
                name="bfloat16 fwd time (ms)",
                condition="less_equal",
                threshold=1.20,
                baseline_aggregation="min",
            ),
            "quantized fwd time (ms)": RegressionPolicy(
                name="quantized fwd time (ms)",
                condition="less_equal",
                threshold=1.20,
                baseline_aggregation="min",
            ),
            "fwd speedup (x)": RegressionPolicy(
                name="fwd speedup (x)",
                condition="greater_equal",
                threshold=0.9,
                baseline_aggregation="median",
            ),
        },
        notification_config={
            "configs": [
                {
                    "type": "github",
                    "repo": "pytorch/test-infra",
                    "issue": "7477",
                }
            ]
        },
    ),
    report_config=ReportConfig(
        report_level="clear",
    ),
)

PYTORCH_OPERATOR_MICROBENCH_CONFIG = BenchmarkConfig(
    name="Pytorch Operator Microbench Regression",
    id="pytorch_operator_microbenchmark",
    source=BenchmarkApiSource(
        api_query_url="https://hud.pytorch.org/api/benchmark/get_time_series",
        type="benchmark_time_series_api",
        api_endpoint_params_template="""
                {
                  "name": "pytorch_operator_microbenchmark",
                  "query_params": {
                    "mode": "",
                    "branches": ["main"],
                    "repo": "pytorch/pytorch",
                    "device": "",
                    "arch": "",
                    "benchmarkName": "PyTorch operator microbenchmark",
                    "startTime": "{{ startTime }}",
                    "stopTime": "{{ stopTime }}"
                    },
                    "response_formats":["time_series"]
                }
                """,
    ),
    hud_info={
        "url": "https://hud.pytorch.org/benchmark/v3/dashboard/pytorch_operator_microbenchmark",
    },
    # set baseline from past 3-6 days, and compare with the lastest 3 day
    policy=Policy(
        frequency=Frequency(value=1, unit="days"),
        range=RangeConfig(
            baseline=DayRangeWindow(value=3),
            comparison=DayRangeWindow(value=3),
        ),
        metrics={
            "latency": RegressionPolicy(
                name="latency",
                condition="less_equal",
                threshold=1.35,
                baseline_aggregation="median",
            ),
        },
        notification_config={
            "configs": [
                {
                    "type": "github",
                    "repo": "pytorch/test-infra",
                    "issue": "7445",
                    "condition": {
                        "type": "device_arch",
                        "device_arches": [{"device": "cuda"}],
                    },
                },
                {
                    "type": "github",
                    "repo": "pytorch/test-infra",
                    "issue": "7593",
                    "condition": {
                        "type": "device_arch",
                        "device_arches": [{"device": "rocm"}],
                    },
                },
            ]
        },
    ),
    report_config=ReportConfig(
        report_level="regression",
    ),
)

# Compiler benchmark regression config
# todo(elainewy): eventually each team should configure
# their own benchmark regression config, currenlty place
# here for lambda

COMPILER_BENCHMARK_CONFIG = BenchmarkConfig(
    name="Compiler Benchmark Regression",
    id="compiler_regression",
    source=BenchmarkApiSource(
        api_query_url="https://hud.pytorch.org/api/benchmark/get_time_series",
        type="benchmark_time_series_api",
        # currently we only detect the regression for h100,b200 with dtype bfloat16,amp,
        # and float16 with mode inference,training
        api_endpoint_params_template="""
                {
                  "name": "compiler_precompute",
                  "response_formats":["time_series"],
                  "query_params": {
                    "commits": [],
                    "arches": ["b200","h100"],
                    "devices": ["cuda"],
                    "dtypes": ["bfloat16","amp","float16"],
                    "granularity": "hour",
                    "modes": ["training","inference"],
                    "startTime": "{{ startTime }}",
                    "stopTime": "{{ stopTime }}",
                    "suites": ["torchbench", "huggingface", "timm_models"],
                    "branches": ["main"]
                  }
                }
                """,
    ),
    hud_info={
        "url": "https://hud.pytorch.org/benchmark/compilers",
    },
    # set baseline from past 7 days using avg, and compare with the last 1 day
    policy=Policy(
        frequency=Frequency(value=1, unit="days"),
        range=RangeConfig(
            baseline=DayRangeWindow(value=6),
            comparison=DayRangeWindow(value=4),
        ),
        metrics={
            "passrate": RegressionPolicy(
                name="passrate",
                condition="greater_equal",
                threshold=0.9,
                baseline_aggregation="median",
            ),
            "geomean_speedup": RegressionPolicy(
                name="geomean_speedup",
                condition="greater_equal",
                threshold=0.95,
                baseline_aggregation="median",
            ),
            "compression_ratio": RegressionPolicy(
                name="compression_ratio",
                condition="greater_equal",
                threshold=0.95,
                baseline_aggregation="median",
            ),
            "compilation_latency": RegressionPolicy(
                name="compilation_latency",
                condition="less_equal",
                threshold=1.15,
                baseline_aggregation="median",
            ),
        },
        notification_config={
            "configs": [
                {
                    "type": "github",
                    "repo": "pytorch/test-infra",
                    "issue": "7081",
                    "condition": {
                        "type": "device_arch",
                        "device_arches": [{"device": "cuda", "arch": "h100"}],
                    },
                },
            ]
        },
    ),
    report_config=ReportConfig(
        report_level="no_regression",
    ),
)

PYTORCH_X_VLLM_BENCHMARK_CONFIG = BenchmarkConfig(
    name="PyTorch x vLLM Benchmark Regression",
    id="pytorch_x_vllm_benchmark",
    source=BenchmarkApiSource(
        api_query_url="https://hud.pytorch.org/api/benchmark/get_time_series",
        type="benchmark_time_series_api",
        api_endpoint_params_template="""
                {
                  "name": "pytorch_x_vllm_benchmark",
                  "query_params": {
                    "mode": "",
                    "branches": ["main"],
                    "repo": "pytorch/pytorch",
                    "device": "",
                    "benchmarkName": "PyTorch x vLLM benchmark",
                    "startTime": "{{ startTime }}",
                    "stopTime": "{{ stopTime }}"
                    },
                    "response_formats":["time_series"]
                }
                """,
    ),
    hud_info={
        "url": "https://hud.pytorch.org/benchmark/v3/dashboard/pytorch_x_vllm_benchmark",
    },
    policy=Policy(
        frequency=Frequency(value=1, unit="days"),
        range=RangeConfig(
            baseline=DayRangeWindow(value=3),
            comparison=DayRangeWindow(value=3),
        ),
        metrics={
            "latency": RegressionPolicy(
                name="latency",
                condition="less_equal",
                threshold=1.20,
                baseline_aggregation="median",
            ),
            "median_itl_ms": RegressionPolicy(
                name="median_itl_ms",
                condition="less_equal",
                threshold=1.20,
                baseline_aggregation="median",
            ),
            "median_tpot_ms": RegressionPolicy(
                name="median_tpot_ms",
                condition="less_equal",
                threshold=1.20,
                baseline_aggregation="median",
            ),
            "median_ttft_ms": RegressionPolicy(
                name="median_ttft_ms",
                condition="less_equal",
                threshold=1.20,
                baseline_aggregation="median",
            ),
            "requests_per_second": RegressionPolicy(
                name="requests_per_second",
                condition="greater_equal",
                threshold=0.8,
                baseline_aggregation="median",
            ),
            "tokens_per_second": RegressionPolicy(
                name="tokens_per_second",
                condition="greater_equal",
                threshold=0.8,
                baseline_aggregation="median",
            ),
        },
        notification_config={
            "configs": [
                {
                    "type": "github",
                    "repo": "pytorch/test-infra",
                    "issue": "7676",
                    "condition": {
                        "type": "device_arch",
                        "device_arches": [
                            {"device": "cuda", "arch": "NVIDIA H100 80GB HBM3"},
                            {"device": "cuda", "arch": "NVIDIA B200"},
                        ],
                    },
                }
            ]
        },
    ),
    report_config=ReportConfig(
        report_level="no_regression",
    ),
)


BENCHMARK_REGRESSION_CONFIG = BenchmarkRegressionConfigBook(
    configs={
        "compiler_regression": COMPILER_BENCHMARK_CONFIG,
        "pytorch_operator_microbenchmark": PYTORCH_OPERATOR_MICROBENCH_CONFIG,
        "pytorch_helion": PYTORCH_HELION_CONFIG,
        "pytorch_x_vllm_benchmark": PYTORCH_X_VLLM_BENCHMARK_CONFIG,
        "torchao_micro_api_benchmark": TORCHAO_MICRO_API_CONFIG,
    }
)


def get_benchmark_regression_config(config_id: str) -> BenchmarkConfig:
    """Get benchmark regression config by config id"""
    try:
        return BENCHMARK_REGRESSION_CONFIG[config_id]
    except KeyError:
        raise ValueError(f"Invalid config id: {config_id}")
