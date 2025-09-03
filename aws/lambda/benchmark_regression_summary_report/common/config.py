from common.config_model import (
    BenchmarkApiSource,
    BenchmarkConfig,
    BenchmarkRegressionConfigBook,
    DayRangeWindow,
    Frequency,
    RegressionPolicy,
    Policy,
    RangeConfig,
)

# Compiler benchmark regression config
# todo(elainewy): eventually each team should configure their own benchmark regression config, currenlty place here for lambda
COMPILER_BENCHMARK_CONFIG = BenchmarkConfig(
    name="Compiler Benchmark Regression",
    id="compiler_regression",
    source=BenchmarkApiSource(
        api_query_url="http://localhost:3000/api/benchmark/get_time_series",
        type="benchmark_time_series_api",
        # currently we only detect the regression for h100 with dtype bfloat16, and mode inference
        # we can extend this to other devices, dtypes and mode in the future
        api_endpoint_params_template="""
                {
                  "name": "compiler_precompute",
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
                    "workflowId": 0,
                    "branches": ["main"]
                  }
                }
                """,
    ),
    # set baseline from past 7 days using avg, and compare with the last 1 day
    policy=Policy(
        frequency=Frequency(value=1, unit="days"),
        range=RangeConfig(
            baseline=DayRangeWindow(value=7),
            comparison=DayRangeWindow(value=1),
        ),
        metrics={
            "passrate": RegressionPolicy(
                name="passrate", condition="greater_than", threshold=0.9
            ),
            "geomean": RegressionPolicy(
                name="geomean", condition="greater_than", threshold=0.95
            ),
            "dynamo_peak_mem": RegressionPolicy(
                name="dynamo_peak_mem", condition="greater_than", threshold=0.9
            ),
        },
        notification_config={
            "type": "github",
            "repo": "pytorch/test-infra",
            "issue": "7081",
        },
    ),
)
BENCHMARK_REGRESSION_CONFIG = BenchmarkRegressionConfigBook(
    configs={
        "compiler_regression": COMPILER_BENCHMARK_CONFIG,
    }
)
