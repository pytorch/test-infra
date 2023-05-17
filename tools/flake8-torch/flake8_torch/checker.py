from pathlib import Path
import ast
import yaml

__version__ = "0.0.1"


class TorchVisitor(ast.NodeVisitor):
    def __init__(self):
        # Map from import alias (may be the same as name) to import name
        self._import_info = {}
        self._call_info = []

    def visit_Call(self, node):
        func_name = ""
        curr = node.func
        while isinstance(curr, ast.Attribute):
            func_name = "." + curr.attr + func_name
            curr = curr.value
        if isinstance(curr, ast.Name):
            func_name = curr.id + func_name

        self._call_info.append(
            {"name": func_name, "lineno": node.lineno, "col_offset": node.col_offset}
        )

        self.generic_visit(node)

    def visit_Import(self, node):
        for alias in node.names:
            if alias.asname is None:
                self._import_info[alias.name] = alias.name
            else:
                self._import_info[alias.asname] = alias.name

        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        module = "" if node.module is None else node.module
        module = "." * node.level + module
        for alias in node.names:
            if alias.asname is None:
                self._import_info[alias.name] = f"{module}.{alias.name}"
            else:
                self._import_info[alias.asname] = f"{module}.{alias.name}"
        self.generic_visit(node)


class TorchChecker:
    name = "flake8-torch"
    version = __version__

    def __init__(self, tree):
        self.tree = tree
        self.deprecated_config = {}
        with open(Path(__file__).absolute().parent / "deprecated_symbols.yaml") as f:
            for item in yaml.load(f, yaml.SafeLoader):
                self.deprecated_config[item["name"]] = item

        self.func_calls = []
        self._get_qualified_func_calls()

    def _get_qualified_func_calls(self):
        """Return list of function calls in the tree.

        Each item in the list is a tuple
        (qualified_name, lineno, col_offset).
        """
        visitor = TorchVisitor()
        visitor.visit(self.tree)

        func_calls = visitor._call_info

        self.func_calls = []
        for call_info in func_calls:
            name = call_info["name"]
            dotted_parts = name.split(".")
            if dotted_parts[0] in visitor._import_info:
                qualified_name = ".".join(
                    [visitor._import_info[dotted_parts[0]]] + dotted_parts[1:]
                )
            else:
                qualified_name = name
            self.func_calls.append(
                (qualified_name, call_info["lineno"], call_info["col_offset"])
            )

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
