from pathlib import Path
import yaml
import libcst as cst
import libcst.codemod as codemod
from dataclasses import dataclass
from typing import Optional, List
import argparse
import contextlib
import io
import sys

__version__ = "0.0.1"

IS_TTY = hasattr(sys.stdout, "isatty") and sys.stdout.isatty()
CYAN = "\033[96m" if IS_TTY else ""
RED = "\033[31m" if IS_TTY else ""
BOLD = "\033[1m" if IS_TTY else ""
ENDC = "\033[0m" if IS_TTY else ""


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

    def codemod_result(self) -> str:
        fixable = f" [{CYAN}*{ENDC}]" if self.replacement is not None else ""
        colon = f"{CYAN}:{ENDC}"
        position = f"{colon}{self.line}{colon}{1 + self.column}{colon}"
        error_code = f"{RED}{BOLD}{self.error_code}{ENDC}"
        return f"{position} {error_code}{fixable} {self.message}"


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


class TorchChecker:
    name = "flake8-torch"
    version = __version__

    # The parameters need to have these exact names.
    # See https://flake8.pycqa.org/en/latest/plugin-development/plugin-parameters.html
    # `tree` is unused, but the plugin doesn't work without it.
    def __init__(self, tree, lines):
        module = cst.parse_module("".join(lines))
        visitor = TorchVisitor(_read_deprecated_config())
        module = cst.MetadataWrapper(module, unsafe_skip_copy=True)
        module.visit(visitor)
        self.violations = visitor.violations

    def run(self):
        for violation in self.violations:
            yield violation.flake8_result()


class TorchCodemod(codemod.Codemod):
    def transform_module_impl(self, module: cst.Module) -> cst.Module:
        visitor = TorchVisitor(_read_deprecated_config())
        fixes_count = 0

        # We use `unsafe_skip_copy`` here not only to save some time, but
        # because `deep_replace`` is identity-based and will not work on
        # the original module if the wrapper does a deep copy:
        # in that case we would need to use `wrapped_module.module`
        # instead of `module`.
        wrapped_module = cst.MetadataWrapper(module, unsafe_skip_copy=True)
        wrapped_module.visit(visitor)
        new_module = module

        violations = visitor.violations
        for violation in violations:
            if violation.replacement is not None:
                new_module = new_module.deep_replace(
                    violation.node, violation.replacement
                )
                fixes_count += 1
            try:
                path = Path(self.context.filename).relative_to(Path.cwd())
            except ValueError:
                # Not a subpath of a current dir, use absolute path
                path = self.context.filename
            print(f"{path}{violation.codemod_result()}")
        if fixes_count == 0:
            raise codemod.SkipFile("No changes")
        return new_module


def main() -> None:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "path",
        nargs="+",
        help=("Path to check/fix. Can be a directory, a file, or multiple of either."),
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Fix fixable violations.",
    )
    parser.add_argument(
        "-j",
        "--jobs",
        help="Number of jobs to use when processing files. Defaults to number of cores",
        type=int,
        default=None,
    )

    args = parser.parse_args()

    files = codemod.gather_files(args.path)
    command_instance = TorchCodemod(codemod.CodemodContext())
    DIFF_CONTEXT = 5
    try:
        # XXX TODO: Get rid of this!
        # Silence "Failed to determine module name"
        # https://github.com/Instagram/LibCST/issues/944
        with contextlib.redirect_stderr(io.StringIO()):
            result = codemod.parallel_exec_transform_with_prettyprint(
                command_instance,
                files,
                jobs=args.jobs,
                unified_diff=(None if args.fix else DIFF_CONTEXT),
                hide_progress=True,
                format_code=False,
                repo_root=None,
            )
    except KeyboardInterrupt:
        print("Interrupted!", file=sys.stderr)
        sys.exit(2)

    print(
        f"Finished checking {result.successes + result.skips + result.failures} files.",
        file=sys.stderr,
    )

    if result.successes > 0:
        if args.fix:
            print(
                f"Transformed {result.successes} files successfully.", file=sys.stderr
            )
        else:
            print(
                f"[{CYAN}*{ENDC}] {result.successes} "
                "potentially fixable with the --fix option",
                file=sys.stderr,
            )

    if result.failures > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
