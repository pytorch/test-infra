"""Shared fixtures for bump-triage tests.

All fixtures derived from real Buildkite build #77837 (vllm/ci, 2026-07-13,
branch=main, state=failed). 25 hard failures including a CUDA driver init
infra cluster (~20 jobs) and a nixl ImportError (6 jobs).
"""

from pathlib import Path

import pytest


FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture()
def log_cuda_init_fail() -> str:
    """Cleaned log tail: Cudagraph job failing with CUDA driver init error.

    Root cause: RuntimeError: CUDA driver initialization failed.
    4 failed, 10 passed, 2 skipped.
    """
    return (FIXTURES_DIR / "log_cudagraph_cuda_init_fail.txt").read_text()


@pytest.fixture()
def log_nixl_import() -> str:
    """Cleaned log tail: NixlConnector job failing with ImportError.

    Root cause: ImportError on nixl_ep_cpp (ABI mismatch).
    1 failed, 16 warnings.
    """
    return (FIXTURES_DIR / "log_nixl_import_error.txt").read_text()


@pytest.fixture()
def log_engine_cuda_fail() -> str:
    """Cleaned log tail: Engine job with 50 failures from CUDA init.

    Root cause: RuntimeError: CUDA driver initialization failed.
    50 failed, 67 passed, 2 skipped.
    """
    return (FIXTURES_DIR / "log_engine_cuda_init_fail.txt").read_text()


@pytest.fixture()
def raw_log_snippet() -> bytes:
    """Raw (uncleaned) log bytes with ANSI escapes and BKT timestamp markers.

    From DeepGEMM log around the pytest summary section.
    Contains 29 ANSI escapes and 11 BKT markers.
    """
    return (FIXTURES_DIR / "raw_log_snippet.bin").read_bytes()


@pytest.fixture()
def raw_log_64854_elastic_ep() -> str:
    """Full raw log from build #64854 Elastic EP Scaling Test.

    2 failed: one bare assert, one AssertionError with message.
    """
    return (FIXTURES_DIR / "raw_log_64854_elastic_ep_scaling.txt").read_text()


@pytest.fixture()
def log_multi_root_cause_sentinels() -> str:
    """Two sentinel tests with different root causes in the same session.

    test_model_loading wraps ValueError: GPU memory exhausted on device 0
    test_kernel_dispatch wraps TypeError: unsupported dtype bfloat16 for this kernel
    Both FAILED lines show the same sentinel RuntimeError message.
    """
    return (FIXTURES_DIR / "log_multi_root_cause_sentinels.txt").read_text()


@pytest.fixture()
def log_dynamo_regression() -> str:
    """Real log from build #72925 PyTorch Compilation Unit Tests.

    Contains a real Dynamo regression: AttributeError on AlwaysHitShapeEnv
    hidden behind the "Engine core initialization failed. See root cause
    above" sentinel (~430 lines apart). From torch 2.13 umbrella #187471,
    issue #187721.
    """
    return (FIXTURES_DIR / "log_dynamo_regression.txt").read_text()
