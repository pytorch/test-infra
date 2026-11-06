import ast
import tempfile
from pathlib import Path
from unittest import main, TestCase

from torchci.td.llm import corpus


SOURCE = '''\
"""Docstring."""
import os
from torch.testing._internal.common_utils import (
    run_tests,
    TestCase,
)

try:
    import numpy as np
except ImportError:
    np = None


def helper():
    import json

    def test_inner():
        pass


def test_module_level():
    assert os.sep


class TestFoo(TestCase):
    import math

    def setUp(self):
        pass

    def test_one(self):
        self.assertTrue(True)

    async def test_async(self):
        pass

    class TestNested(TestCase):
        def test_deep(self):
            pass


if __name__ == "__main__":
    run_tests()
'''


class TestDiscover(TestCase):
    def test_glob_like_pytorch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel in [
                "test_a.py",
                "nn/test_b.py",
                "nn/deep/test_c.py",
                "helper.py",
                "nn/b_test.py",
                "test_d.txt",
            ]:
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_text("")
            (root / "test_dir.py").mkdir()
            self.assertEqual(
                corpus.discover(root), ["nn/deep/test_c", "nn/test_b", "test_a"]
            )

    def test_glob_metacharacters_in_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "a[b]*"
            root.mkdir()
            (root / "test_x.py").write_text("")
            self.assertEqual(corpus.discover(root), ["test_x"])


class TestSkeleton(TestCase):
    def test_skeleton_lines_in_source_order(self) -> None:
        units = corpus.units_for_source("nn/test_foo", SOURCE, with_functions=False)
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0].kind, "skeleton")
        self.assertEqual(units[0].test, "nn/test_foo")
        self.assertEqual(
            units[0].text.split("\n"),
            [
                "# test/nn/test_foo.py",
                "import os",
                "from torch.testing._internal.common_utils import run_tests, TestCase",
                "import numpy as np",
                "def test_module_level",
                "class TestFoo",
                "  def test_one",
                "  def test_async",
                "  class TestNested",
                "    def test_deep",
            ],
        )

    def test_split_into_pieces_led_by_path(self) -> None:
        source = "".join(f"def test_{i:04d}_{'x' * 40}(): pass\n" for i in range(100))
        units = corpus.units_for_source("test_big", source, with_functions=False)
        self.assertGreater(len(units), 1)
        lines = []
        for u in units:
            self.assertLessEqual(len(u.text), corpus.SKELETON_CHARS)
            head, *rest = u.text.split("\n")
            self.assertEqual(head, "# test/test_big.py")
            self.assertTrue(rest)
            lines += rest
        self.assertEqual(lines, [f"def test_{i:04d}_{'x' * 40}" for i in range(100)])

    def test_long_line_is_cut(self) -> None:
        source = f"import {'m' * 3000}\n"
        (unit,) = corpus.units_for_source("test_long", source, with_functions=False)
        self.assertEqual(len(unit.text), corpus.SKELETON_CHARS)
        self.assertTrue(unit.text.startswith("# test/test_long.py\nimport mmm"))

    def test_empty_file_gets_the_path_line(self) -> None:
        for source in ["", "x = 1\n"]:
            units = corpus.units_for_source("test_empty", source, with_functions=True)
            self.assertEqual(
                units, [corpus.Unit("test_empty", "skeleton", "# test/test_empty.py")]
            )

    def test_unparsable_source_uses_the_regex(self) -> None:
        source = (
            "import torch\n"
            "from a.b import c\n"
            "def test_top(:\n"
            "class TestX(TestCase):\n"
            "    async def test_y(self):\n"
            "    def helper(self):\n"
            "x = 'import nothing'\n"
        )
        units = corpus.units_for_source("test_bad", source, with_functions=True)
        self.assertEqual(
            units,
            [
                corpus.Unit(
                    "test_bad",
                    "skeleton",
                    "# test/test_bad.py\nimport torch\nfrom a.b import c\n"
                    "def test_top\nclass TestX\n  def test_y",
                )
            ],
        )

    def test_unparsable_empty_like_file_still_has_a_unit(self) -> None:
        units = corpus.units_for_source("test_bad", "((((\n", with_functions=False)
        self.assertEqual([u.text for u in units], ["# test/test_bad.py"])

    def test_null_byte_source_falls_back(self) -> None:
        units = corpus.units_for_source("t", "import a\n\0\n", with_functions=False)
        self.assertEqual([u.text for u in units], ["# test/t.py\nimport a"])

    def test_invalid_escape_does_not_warn(self) -> None:
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("error")
            units = corpus.units_for_source(
                "t", 'x = "\\d"\ndef test_a(): pass\n', with_functions=False
            )
        self.assertEqual(units[0].text, "# test/t.py\ndef test_a")


class TestFunctions(TestCase):
    def test_function_units(self) -> None:
        units = corpus.units_for_source("nn/test_foo", SOURCE, with_functions=True)
        functions = [u for u in units if u.kind == "function"]
        self.assertEqual(
            [u.text.split("\n", 1)[0] for u in functions],
            [
                "# test/nn/test_foo.py",
                "# test/nn/test_foo.py class TestFoo",
                "# test/nn/test_foo.py class TestFoo",
                "# test/nn/test_foo.py class TestNested",
            ],
        )
        self.assertEqual(
            functions[1].text,
            "# test/nn/test_foo.py class TestFoo\n"
            "def test_one(self):\n        self.assertTrue(True)",
        )
        self.assertTrue(
            functions[2].text.endswith("async def test_async(self):\n        pass")
        )
        self.assertEqual(units[0].kind, "skeleton")

    def test_function_cut(self) -> None:
        body = "".join(f"    x{i} = {i}\n" for i in range(2000))
        units = corpus.units_for_source(
            "test_long", f"def test_long():\n{body}", with_functions=True
        )
        self.assertEqual(len(units[-1].text), corpus.FUNCTION_CHARS)

    def test_segment_matches_get_source_segment(self) -> None:
        source = (
            "# \u00e9t\u00e9 \u4e2d\u6587\r\n"
            "class TestA:\r\n"
            "    def test_x(self):  # \u00e9\r\n"
            "        s = '\u00fc\u00fc\u00fc'; t = 1\r\n"
            "\f\n"
            "    def test_y(self): return '\u2603'\n"
            "def test_z():\r"
            "    pass\r"
        )
        tree = ast.parse(source)
        lines = corpus._SOURCE_LINE.findall(source)
        nodes = [
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef) and n.name.startswith("test")
        ]
        self.assertEqual(len(nodes), 3)
        for node in nodes:
            self.assertEqual(
                corpus._segment(lines, node), ast.get_source_segment(source, node)
            )


class TestBuild(TestCase):
    def test_build_reads_invalid_utf8(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "sub").mkdir()
            (root / "sub" / "test_a.py").write_bytes(
                b"import os\nx = '\xff'\ndef test_one(): pass\n"
            )
            (root / "test_b.py").write_text("def test_two(): pass\n")
            units = corpus.build(root, with_functions=True)
            skeletons = corpus.build(root, with_functions=False)
        self.assertEqual(skeletons, [u for u in units if u.kind == "skeleton"])
        self.assertEqual(
            [(u.test, u.kind) for u in units],
            [
                ("sub/test_a", "skeleton"),
                ("sub/test_a", "function"),
                ("test_b", "skeleton"),
                ("test_b", "function"),
            ],
        )
        self.assertEqual(units[0].text, "# test/sub/test_a.py\nimport os\ndef test_one")


if __name__ == "__main__":
    main()
