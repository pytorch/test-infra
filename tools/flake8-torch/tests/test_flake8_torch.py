import ast
from pathlib import Path
from flake8_torch.checker import TorchChecker
import logging

FIXTURES_PATH = Path(__file__).absolute().parent / "fixtures"
LOGGER = logging.getLogger(__name__)


def _results(s):
    tree = ast.parse(s)
    checker = TorchChecker(tree)
    return [f"{line}:{col} {msg}" for line, col, msg, _ in checker.run()]


def test_empty():
    assert _results("") == []


def test_fixtures():
    for source_path in FIXTURES_PATH.glob("*.py"):
        LOGGER.info("Testing %s", source_path)
        expected_path = str(source_path)[:-2] + "txt"
        expected_results = []
        with open(expected_path) as expected:
            for line in expected:
                expected_results.append(line.rstrip())

        with open(source_path) as source:
            assert _results(source.read()) == expected_results
