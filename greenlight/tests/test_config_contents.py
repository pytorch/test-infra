from __future__ import annotations

import base64

import pytest

from greenlight.config_contents import ContentsAnswer, config_url, contents_answer
from greenlight.constants import CONFIG_MAX_BYTES, REPO_CONFIG_PATH


def _file(text: bytes, *, size: int | None = None, kind: str = "file") -> dict[str, object]:
    return {"type": kind, "size": len(text) if size is None else size, "content": base64.b64encode(text).decode()}


def test_a_file_answers_its_text_and_size():
    assert contents_answer(_file(b"mode: shadow\n")) == ContentsAnswer("mode: shadow\n", 13, None)


@pytest.mark.parametrize(
    ("data", "size", "reason"),
    [
        pytest.param([{"name": "a"}], None, "it is a directory, not a file", id="directory"),
        pytest.param(_file(b"x", kind="symlink"), 1, "it is a symlink, not a file", id="symlink"),
        pytest.param(
            _file(b"x", size=CONFIG_MAX_BYTES + 1),
            CONFIG_MAX_BYTES + 1,
            f"the file is {CONFIG_MAX_BYTES + 1} bytes, over the {CONFIG_MAX_BYTES}-byte limit",
            id="too-big",
        ),
        pytest.param(_file(b"\xff\xfe"), 2, "the file is not UTF-8 text", id="not-utf8"),
    ],
)
def test_an_answer_that_cannot_be_a_config_says_why(data, size, reason):
    assert contents_answer(data) == ContentsAnswer(None, size, reason)


@pytest.mark.parametrize("data", [{"type": "file"}, "text", None], ids=["no-size", "string", "none"])
def test_an_answer_that_is_no_contents_response_raises(data):
    with pytest.raises(ValueError, match="unexpected shape"):
        contents_answer(data)


def test_the_config_url_is_the_contents_path_on_the_default_branch():
    assert config_url("pytorch/vision") == f"/repos/pytorch/vision/contents/{REPO_CONFIG_PATH}"
