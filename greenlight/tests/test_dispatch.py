import pytest

from greenlight import dispatch
from greenlight.constants import DEFAULT_DISPATCH_REF, DISPATCH_REPO, WORKFLOW_FILE

_EVAL_HASH = "a" * 64
_HEAD_SHA = "b" * 40


class _FakeWorkflow:
    def __init__(self, *, result: bool = True, exc: Exception | None = None) -> None:
        self._result = result
        self._exc = exc
        self.calls: list[tuple[str, dict[str, str], bool]] = []

    def create_dispatch(self, ref: str, inputs: dict[str, str], throw: bool = False) -> bool:
        self.calls.append((ref, inputs, throw))
        if self._exc is not None:
            raise self._exc
        return self._result


class _FakeRepo:
    def __init__(self, workflow: _FakeWorkflow) -> None:
        self._workflow = workflow
        self.get_workflow_args: list[str] = []

    def get_workflow(self, id_or_file_name: str) -> _FakeWorkflow:
        self.get_workflow_args.append(id_or_file_name)
        return self._workflow


class _FakeClient:
    def __init__(self, repo: _FakeRepo) -> None:
        self._repo = repo
        self.get_repo_args: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _FakeRepo:
        self.get_repo_args.append(full_name_or_id)
        return self._repo


def _wire(*, result: bool = True, exc: Exception | None = None) -> tuple[_FakeClient, _FakeRepo, _FakeWorkflow]:
    workflow = _FakeWorkflow(result=result, exc=exc)
    repo = _FakeRepo(workflow)
    client = _FakeClient(repo)
    return client, repo, workflow


def test_dispatch_forwards_repo_workflow_ref_and_string_inputs() -> None:
    client, repo, workflow = _wire()

    dispatch.dispatch_review(client, 123, _HEAD_SHA, _EVAL_HASH, ref="release/2.9")

    assert client.get_repo_args == [DISPATCH_REPO]
    assert repo.get_workflow_args == [WORKFLOW_FILE]
    assert len(workflow.calls) == 1
    ref, inputs, throw = workflow.calls[0]
    assert ref == "release/2.9"
    assert throw is True
    assert inputs == {"pr_number": "123", "head_sha": _HEAD_SHA, "eval_hash": _EVAL_HASH}
    assert all(isinstance(value, str) for value in inputs.values())


def test_dispatch_defaults_ref_to_main() -> None:
    client, _repo, workflow = _wire()

    dispatch.dispatch_review(client, 7, _HEAD_SHA, _EVAL_HASH)

    ref, _inputs, _throw = workflow.calls[0]
    assert ref == DEFAULT_DISPATCH_REF


def test_dispatch_stringifies_pr_number() -> None:
    client, _repo, workflow = _wire()

    dispatch.dispatch_review(client, 4242, _HEAD_SHA, _EVAL_HASH)

    _ref, inputs, _throw = workflow.calls[0]
    assert inputs["pr_number"] == "4242"
    assert isinstance(inputs["pr_number"], str)


@pytest.mark.parametrize(
    "bad_hash",
    ["", "a" * 63, "a" * 65, "g" * 64, "A" * 64, " " + "a" * 63, "a" * 64 + "\n"],
    ids=["empty", "too-short", "too-long", "non-hex", "uppercase", "leading-space", "trailing-newline"],
)
def test_dispatch_rejects_malformed_eval_hash(bad_hash: str) -> None:
    client, repo, workflow = _wire()

    with pytest.raises(ValueError, match="eval_hash"):
        dispatch.dispatch_review(client, 1, _HEAD_SHA, bad_hash)

    assert client.get_repo_args == []
    assert repo.get_workflow_args == []
    assert workflow.calls == []


@pytest.mark.parametrize(
    "bad_sha",
    ["", "b" * 39, "b" * 41, "z" * 40, "refs/heads/main", _HEAD_SHA + "\n"],
    ids=["empty", "too-short", "too-long", "non-hex", "ref-not-sha", "trailing-newline"],
)
def test_dispatch_rejects_malformed_head_sha(bad_sha: str) -> None:
    client, _repo, workflow = _wire()

    with pytest.raises(ValueError, match="head_sha"):
        dispatch.dispatch_review(client, 1, bad_sha, _EVAL_HASH)

    assert client.get_repo_args == []
    assert workflow.calls == []


def test_dispatch_raises_when_create_dispatch_returns_false() -> None:
    client, _repo, workflow = _wire(result=False)

    with pytest.raises(RuntimeError, match="returned failure"):
        dispatch.dispatch_review(client, 99, _HEAD_SHA, _EVAL_HASH)

    assert len(workflow.calls) == 1


def test_dispatch_propagates_create_dispatch_exception() -> None:
    boom = RuntimeError("github 422")
    client, _repo, workflow = _wire(exc=boom)

    with pytest.raises(RuntimeError, match="github 422"):
        dispatch.dispatch_review(client, 99, _HEAD_SHA, _EVAL_HASH)

    assert len(workflow.calls) == 1
