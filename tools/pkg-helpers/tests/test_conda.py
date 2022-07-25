import json

from pkg_helpers.determine_conda import get_conda_version


def test_get_conda_version():
    with open("tests/assets/conda_search.json", "r") as fp:
        assert (
            get_conda_version(
                json.loads(fp.read()), gpu_arch_version="cpu", python_version="3.8"
            )
            == "1.13.0.dev20220725"
        )
