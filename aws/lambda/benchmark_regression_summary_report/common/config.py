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
    # set baseline from past 4-8 days, and compare with the lastest 4 day
    policy=Policy(
        frequency=Frequency(value=1, unit="days"),
        range=RangeConfig(
            baseline=DayRangeWindow(value=4),
            comparison=DayRangeWindow(value=4),
        ),
        metrics={
            "bfloat16 fwd time (ms)": RegressionPolicy(
                name="bfloat16 fwd time (ms)",
                condition="less_equal",
                threshold=1.15,
                baseline_aggregation="min",
            ),
            "quantized fwd time (ms)": RegressionPolicy(
                name="quantized fwd time (ms)",
                condition="less_equal",
                threshold=1.15,
                baseline_aggregation="min",
            ),
            "fwd speedup (x)": RegressionPolicy(
                name="fwd speedup (x)",
                condition="greater_equal",
                threshold=0.90,
                baseline_aggregation="median",
            ),
        },
        notification_config={
            "type": "github",
            "repo": "pytorch/test-infra",
            "issue": "7477",
        },
    ),
    report_config=ReportConfig(
        report_level="clear",
    ),
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
                threshold=0.85,
                baseline_aggregation="median",
            ),
        },
        notification_config={
            "type": "github",
            "repo": "pytorch/test-infra",
            "issue": "7472",
        },
    ),
    report_config=ReportConfig(
        report_level="insufficient_data",
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
    # set baseline from past 4-8 days, and compare with the lastest 4 day
    policy=Policy(
        frequency=Frequency(value=1, unit="days"),
        range=RangeConfig(
            baseline=DayRangeWindow(value=4),
            comparison=DayRangeWindow(value=4),
        ),
        metrics={
            "latency": RegressionPolicy(
                name="latency",
                condition="less_equal",
                threshold=1.15,
                baseline_aggregation="min",
            ),
        },
        notification_config={
            "type": "github",
            "repo": "pytorch/test-infra",
            "issue": "7445",
        },
    ),
    report_config=ReportConfig(
        report_level="suspicous",
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
        # currently we only detect the regression for h100 with dtype bfloat16, and mode inference
        # we can extend this to other devices, dtypes and mode in the future
        api_endpoint_params_template="""
                {
                  "name": "compiler_precompute",
                  "response_formats":["time_series"],
                  "query_params": {
                    "commits": [],
                    "compilers": [],
                    "arch": "h100",
                    "device": "cuda",
                    "dtype": "bfloat16",
                    "granularity": "hour",
                    "mode": "inference",
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
                baseline_aggregation="max",
            ),
            "geomean": RegressionPolicy(
                name="geomean",
                condition="greater_equal",
                threshold=0.95,
                baseline_aggregation="max",
            ),
            "compression_ratio": RegressionPolicy(
                name="compression_ratio",
                condition="greater_equal",
                threshold=0.95,
                baseline_aggregation="max",
            ),
            "compilation_latency": RegressionPolicy(
                name="compilation_latency",
                condition="less_equal",
                threshold=1.15,
                baseline_aggregation="min",
            ),
        },
        notification_config={
            "type": "github",
            "repo": "pytorch/test-infra",
            "issue": "7081",
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
        "torchao_micro_api_benchmark": TORCHAO_MICRO_API_CONFIG,
    }
)


def get_benchmark_regression_config(config_id: str) -> BenchmarkConfig:
    """Get benchmark regression config by config id"""
    try:
        return BENCHMARK_REGRESSION_CONFIG[config_id]
    except KeyError:
        raise ValueError(f"Invalid config id: {config_id}")
