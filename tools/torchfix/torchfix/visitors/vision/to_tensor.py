import libcst as cst

from ...common import LintViolation, TorchVisitor


class TorchVisionDeprecatedToTensorVisitor(TorchVisitor):
    ERROR_CODE = "TOR202"

    def _maybe_add_violation(self, qualified_name, node):
        if qualified_name != "torchvision.transforms.v2.ToTensor":
            return
        position = self.get_metadata(
            cst.metadata.WhitespaceInclusivePositionProvider, node
        )
        self.violations.append(
            LintViolation(
                error_code=self.ERROR_CODE,
                message=(
                    "The transform `ToTensor()` is deprecated and will be removed in a"
                    "future release. Instead, please use "
                    "`v2.Compose([v2.ToImage(), v2.ToDtype(torch.float32, scale=True)])`."  # noqa: E501
                ),
                line=position.start.line,
                column=position.start.column,
                node=node,
                replacement=None,
            )
        )

    def visit_ImportFrom(self, node):
        module_path_parts = []

        def recurse_module_path(node):
            if isinstance(node, cst.Attribute):
                for child in node.children:
                    recurse_module_path(child)
            elif isinstance(node, cst.Name):
                module_path_parts.append(node.value)

        recurse_module_path(node.module)
        module_path = ".".join(module_path_parts)

        for import_node in node.names:
            self._maybe_add_violation(
                f"{module_path}.{import_node.evaluated_name}", import_node
            )

    def visit_Attribute(self, node):
        qualified_names = self.get_metadata(cst.metadata.QualifiedNameProvider, node)
        if not len(qualified_names) == 1:
            return

        self._maybe_add_violation(qualified_names.pop().name, node)
