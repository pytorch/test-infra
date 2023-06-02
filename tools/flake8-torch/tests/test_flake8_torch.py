from pathlib import Path
from flake8_torch.checker import TorchChecker, TorchCodemod
import logging
import libcst.codemod as codemod

FIXTURES_PATH = Path(__file__).absolute().parent / "fixtures"
LOGGER = logging.getLogger(__name__)


def _checker_results(s):
    checker = TorchChecker(None, s)
    return [f"{line}:{col} {msg}" for line, col, msg, _ in checker.run()]


def _codemod_results(source_path):
    with open(source_path) as source:
        code = source.read()
    context = TorchCodemod(codemod.CodemodContext(filename=source_path))
    new_module = codemod.transform_module(context, code)
    return new_module.code


def test_empty():
    assert _checker_results([""]) == []


def test_checker_fixtures():
    for source_path in (FIXTURES_PATH / "checker").glob("*.py"):
        LOGGER.info("Testing %s", source_path.relative_to(Path.cwd()))
        expected_path = str(source_path)[:-2] + "txt"
        expected_results = []
        with open(expected_path) as expected:
            for line in expected:
                expected_results.append(line.rstrip())

        with open(source_path) as source:
            assert _checker_results(source.readlines()) == expected_results


def test_codemod_fixtures():
    for source_path in (FIXTURES_PATH / "codemod").glob("*.py"):
        LOGGER.info("Testing %s", source_path.relative_to(Path.cwd()))
        expected_path = source_path.with_suffix(".py.out")
        expected_results = expected_path.read_text()
        assert _codemod_results(source_path) == expected_results
