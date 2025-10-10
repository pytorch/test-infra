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
            baseline=DayRangeWindow(value=8),
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
    }
)


def get_benchmark_regression_config(config_id: str) -> BenchmarkConfig:
    """Get benchmark regression config by config id"""
    try:
        return BENCHMARK_REGRESSION_CONFIG[config_id]
    except KeyError:
        raise ValueError(f"Invalid config id: {config_id}")
