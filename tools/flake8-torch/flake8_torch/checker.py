from pathlib import Path
import yaml
import libcst as cst
import libcst.codemod as codemod
from dataclasses import dataclass
from typing import Optional, List
import argparse

__version__ = "0.0.1"


@dataclass
class LintViolation:
    error_code: str
    message: str
    line: int
    column: int
    node: cst.CSTNode
    replacement: Optional[cst.CSTNode]

    def flake8_result(self):
        full_message = f"{self.error_code} {self.message}"
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
                error_code = "TOR101"
                message = f"Use of deprecated function {qualified_name}"
            else:
                error_code = "TOR201"
                message = f"Use of removed function {qualified_name}"

            replacement = None
            if qualified_name == "torch.ger":
                replacement = node.with_deep_changes(
                    old_node=node.func.attr, value="outer"
                )

            self.violations.append(
                LintViolation(
                    error_code=error_code,
                    message=message,
                    line=position_metadata.start.line,
                    column=position_metadata.start.column,
                    node=node,
                    replacement=replacement,
                )
            )


def _read_deprecated_config(path=None):
    if path is None:
        path = Path(__file__).absolute().parent / "deprecated_symbols.yaml"

    deprecated_config = {}
    with open(path) as f:
        for item in yaml.load(f, yaml.SafeLoader):
            deprecated_config[item["name"]] = item
    return deprecated_config


def _get_violations(code: str):
    module = cst.parse_module(code)
    visitor = TorchVisitor(_read_deprecated_config())
    module = cst.MetadataWrapper(module)
    module.visit(visitor)
    return visitor.violations


class TorchChecker:
    name = "flake8-torch"
    version = __version__

    # The parameters need to have these exact names.
    # See https://flake8.pycqa.org/en/latest/plugin-development/plugin-parameters.html
    # tree is unused, but the plugin doesn't work without it.
    def __init__(self, tree, lines):
        self.violations = _get_violations("".join(lines))

    def run(self):
        for violation in self.violations:
            yield violation.flake8_result()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("filename")
    args = parser.parse_args()
    with open(args.filename) as source:
        module = cst.parse_module(source.read())
        visitor = TorchVisitor(_read_deprecated_config())
        wrapped_module = cst.MetadataWrapper(module)
        wrapped_module.visit(visitor)
        violations = visitor.violations

    for violation in violations:
        if violation.replacement is not None:
            print(
                codemod.diff_code(
                    module.code_for_node(violation.node),
                    module.code_for_node(violation.replacement),
                    3,
                )
            )


if __name__ == "__main__":
    main()
