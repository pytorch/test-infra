from pathlib import Path
import yaml
import libcst as cst

__version__ = "0.0.1"


class TorchVisitor(cst.CSTVisitor):

    METADATA_DEPENDENCIES = (
        cst.metadata.QualifiedNameProvider,
        cst.metadata.WhitespaceInclusivePositionProvider,
    )

    def __init__(self):
        self.call_info = []

    def visit_Call(self, node):
        name_metadata = list(
            self.get_metadata(cst.metadata.QualifiedNameProvider, node)
        )
        if not name_metadata:
            return
        qualified_name = name_metadata[0].name

        position_metadata = self.get_metadata(
            cst.metadata.WhitespaceInclusivePositionProvider, node
        )

        self.call_info.append(
            (
                qualified_name,
                position_metadata.start.line,
                position_metadata.start.column,
            )
        )


class TorchChecker:
    name = "flake8-torch"
    version = __version__

    # The parameters need to have these exact names.
    # See https://flake8.pycqa.org/en/latest/plugin-development/plugin-parameters.html
    # tree is unused but the plugin doesn't work without it.
    def __init__(self, tree, lines):
        self.deprecated_config = {}
        with open(Path(__file__).absolute().parent / "deprecated_symbols.yaml") as f:
            for item in yaml.load(f, yaml.SafeLoader):
                self.deprecated_config[item["name"]] = item

        module = cst.parse_module("".join(lines))
        visitor = TorchVisitor()
        self.module = cst.MetadataWrapper(module)
        self.module.visit(visitor)
        self.func_calls = visitor.call_info

    def _check_deprecated_functions(self):
        for (name, lineno, col_offset) in self.func_calls:
            if name in self.deprecated_config:
                if self.deprecated_config[name]["remove_pr"] is None:
                    message = f"TOR101 Use of deprecated function {name}"
                else:
                    message = f"TOR201 Use of removed function {name}"
                yield ((lineno, 1 + col_offset, message, TorchChecker))

    def run(self):
        yield from self._check_deprecated_functions()
