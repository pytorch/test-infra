import inspect
import pathlib
import tempfile
import textwrap
from typing import Any


def make_file(tmp_path: pathlib.Path, object: Any) -> pathlib.Path:
    """Takes source and writes it into a temporary file, returning the path."""
    path = pathlib.Path(tempfile.mkstemp(dir=tmp_path)[1])
    path.write_text(textwrap.dedent(inspect.getsource(object)))
    return path
