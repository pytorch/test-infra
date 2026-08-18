from greenlight import github_types


def test_github_types_module_imports_and_exposes_runtime_protocols():
    # Every other Protocol in github_types is defined under TYPE_CHECKING; VerdictClient and ScanClient
    # are the only two that exist at import time, so importing the module and touching them is all there
    # is to exercise at runtime.
    assert isinstance(github_types.VerdictClient, type)
    assert isinstance(github_types.ScanClient, type)
