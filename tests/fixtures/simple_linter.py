import argparse
import json

from enum import Enum
from typing import NamedTuple, Optional


class LintSeverity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    ADVICE = "advice"
    DISABLED = "disabled"


class LintMessage(NamedTuple):
    path: Optional[str]
    line: Optional[int]
    char: Optional[int]
    code: str
    severity: LintSeverity
    name: str
    original: Optional[str]
    replacement: Optional[str]
    description: Optional[str]

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="simple linter, with various switches to control ")

    msg = LintMessage(
        path="tests/fixtures/simple_linter.py",
        line=3,
        char=1,
        code='SIMPLE',
        severity=LintSeverity.ADVICE,
        name='simple linter failure',
        original=None,
        replacement=None,
        description="An example lint failure message!",
    )

    print(json.dumps(msg._asdict()), flush=True)
