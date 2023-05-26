from pathlib import Path
import yaml
import libcst as cst
from dataclasses import dataclass
from typing import Optional, List


__version__ = "0.0.1"


@dataclass
class LintViolation:
    code: str
    message: str
    line: int
    column: int
    node: cst.CSTNode
    replacement: Optional[cst.CSTNode]

    def flake8_result(self):
        full_message = f"{self.code} {self.message}"
        return (self.line, 1 + self.column, full_message, "TorchChecker")


class TorchVisitor(cst.CSTVisitor):
    METADATA_DEPENDENCIES = (
        cst.metadata.QualifiedNameProvider,
        cst.metadata.WhitespaceInclusivePositionProvider,
    )

    def __init__(self, deprecated_config=None):
        self.deprecated_config = {} if deprecated_config is None else deprecated_config
        self.violations: List[LintViolation] = []

    def visit_Call(self, node):
        name_metadata = list(
            self.get_metadata(cst.metadata.QualifiedNameProvider, node)
        )
        if not name_metadata:
            return
        qualified_name = name_metadata[0].name

        if qualified_name in self.deprecated_config:
            position_metadata = self.get_metadata(
                cst.metadata.WhitespaceInclusivePositionProvider, node
            )
            if self.deprecated_config[qualified_name]["remove_pr"] is None:
                code = "TOR101"
                message = f"Use of deprecated function {qualified_name}"
            else:
                code = "TOR201"
                message = f"Use of removed function {qualified_name}"
            self.violations.append(
                LintViolation(
                    code=code,
                    message=message,
                    line=position_metadata.start.line,
                    column=position_metadata.start.column,
                    node=node,
                    replacement=None,
                )
            )


class TorchChecker:
    name = "flake8-torch"
    version = __version__

    # The parameters need to have these exact names.
    # See https://flake8.pycqa.org/en/latest/plugin-development/plugin-parameters.html
    # tree is unused, but the plugin doesn't work without it.
    def __init__(self, tree, lines):
        deprecated_config = {}
        with open(Path(__file__).absolute().parent / "deprecated_symbols.yaml") as f:
            for item in yaml.load(f, yaml.SafeLoader):
                deprecated_config[item["name"]] = item

        module = cst.parse_module("".join(lines))
        visitor = TorchVisitor(deprecated_config)
        self.module = cst.MetadataWrapper(module)
        self.module.visit(visitor)
        self.violations = visitor.violations

    def run(self):
        for violation in self.violations:
            yield violation.flake8_result()
