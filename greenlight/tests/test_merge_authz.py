import logging
import textwrap
from collections.abc import Iterable

import pytest

from greenlight import constants, merge_authz
from greenlight.guards import IterationTimeout


class _FakeContent:
    def __init__(self, text: str) -> None:
        self._text = text

    @property
    def decoded_content(self) -> bytes:
        return self._text.encode("utf-8")


class _FakeMember:
    def __init__(self, login: str | None) -> None:
        self.login = login


class _FakeTeam:
    def __init__(self, members: list[_FakeMember]) -> None:
        self._members = members

    def get_members(self) -> list[_FakeMember]:
        return self._members


class _FakeOrg:
    def __init__(self) -> None:
        self._teams: dict[str, _FakeTeam] = {}
        self.requested_slugs: list[str] = []

    def get_team_by_slug(self, slug: str) -> _FakeTeam:
        self.requested_slugs.append(slug)
        return self._teams[slug]


class _FakeMergeRulesRepo:
    def __init__(self, contents: object) -> None:
        self._contents = contents
        self.requested_paths: list[str] = []

    # Untyped so the fake can return a single content or a directory list (via ``self._contents``)
    # without annotating around the real Protocol's covariant return.
    def get_contents(self, path):
        self.requested_paths.append(path)
        return self._contents


class _FakeAuthzClient:
    def __init__(self, *, contents: object = None, orgs: dict[str, _FakeOrg] | None = None) -> None:
        self._repo = _FakeMergeRulesRepo(contents)
        self._orgs = orgs or {}
        self.get_repo_names: list[str] = []
        self.get_org_names: list[str] = []

    def get_repo(self, full_name_or_id: str) -> _FakeMergeRulesRepo:
        self.get_repo_names.append(full_name_or_id)
        return self._repo

    def get_organization(self, login: str) -> _FakeOrg:
        self.get_org_names.append(login)
        return self._orgs[login]


def _client(yaml_text: str, *, teams: dict[str, list[str | None]] | None = None) -> _FakeAuthzClient:
    orgs: dict[str, _FakeOrg] = {}
    for ref, logins in (teams or {}).items():
        org_name, slug = ref.split("/")
        org = orgs.setdefault(org_name, _FakeOrg())
        org._teams[slug] = _FakeTeam([_FakeMember(login) for login in logins])
    return _FakeAuthzClient(contents=_FakeContent(yaml_text), orgs=orgs)


def test_resolve_unions_plain_logins_lowercased():
    yaml_text = textwrap.dedent(
        """
        - name: A
          approved_by:
          - Alice
          - BOB
        - name: B
          approved_by:
          - bob
          - carol
        """
    )
    client = _client(yaml_text)

    result = merge_authz.resolve_authorized_logins(client)

    assert result == frozenset({"alice", "bob", "carol"})
    assert client.get_repo_names == [constants.TARGET_REPO]
    assert client._repo.requested_paths == [constants.MERGE_RULES_PATH]


def test_resolve_strips_and_lowercases_padded_plain_login():
    client = _client("- name: CI\n  approved_by: ['  Alice  ']\n")

    # Padded entries must resolve to the bare login, or a real author login never matches.
    assert merge_authz.resolve_authorized_logins(client) == frozenset({"alice"})


def test_resolve_expands_team_refs_to_lowercased_members():
    yaml_text = textwrap.dedent(
        """
        - name: CI
          approved_by:
          - alice
          - pytorch/pytorch-dev-infra
        """
    )
    client = _client(yaml_text, teams={"pytorch/pytorch-dev-infra": ["Dan", "erin"]})

    result = merge_authz.resolve_authorized_logins(client)

    assert result == frozenset({"alice", "dan", "erin"})
    assert client.get_org_names == ["pytorch"]
    assert client._orgs["pytorch"].requested_slugs == ["pytorch-dev-infra"]


def test_resolve_skips_team_members_with_falsy_login():
    client = _client("- {name: CI, approved_by: [pytorch/team]}", teams={"pytorch/team": ["alice", None, ""]})

    assert merge_authz.resolve_authorized_logins(client) == frozenset({"alice"})


def test_resolve_raises_on_malformed_yaml():
    client = _client("- name: [unclosed")

    with pytest.raises(ValueError, match="failed to parse"):
        merge_authz.resolve_authorized_logins(client)


def test_resolve_raises_when_top_level_not_list():
    client = _client("name: not-a-list")

    with pytest.raises(ValueError, match="must be a list of rules"):
        merge_authz.resolve_authorized_logins(client)


def test_resolve_raises_when_rule_not_mapping():
    client = _client("- alice\n- bob\n")

    with pytest.raises(ValueError, match="merge rule must be a mapping"):
        merge_authz.resolve_authorized_logins(client)


def test_resolve_raises_when_approved_by_not_list():
    client = _client("- name: CI\n  approved_by: alice\n")

    with pytest.raises(ValueError, match="approved_by must be a list"):
        merge_authz.resolve_authorized_logins(client)


@pytest.mark.parametrize("entry", ["[123]", "['   ']", "[null]"])
def test_resolve_raises_on_non_string_or_blank_entry(entry: str) -> None:
    client = _client(f"- name: CI\n  approved_by: {entry}\n")

    with pytest.raises(ValueError, match="approved_by entry must be a non-empty string"):
        merge_authz.resolve_authorized_logins(client)


@pytest.mark.parametrize("bad_ref", ["org/team/extra", "/team", "org/"])
def test_resolve_raises_on_malformed_team_ref(bad_ref: str) -> None:
    client = _client(f"- name: CI\n  approved_by: ['{bad_ref}']\n")

    with pytest.raises(ValueError, match="team ref must be 'org/team-slug'"):
        merge_authz.resolve_authorized_logins(client)


@pytest.mark.parametrize("yaml_text", ["[]", "- name: CI\n  patterns: ['*']\n"])
def test_resolve_raises_on_empty_result(yaml_text: str) -> None:
    client = _client(yaml_text)

    with pytest.raises(ValueError, match="empty merge-authorized set"):
        merge_authz.resolve_authorized_logins(client)


def test_resolve_raises_when_contents_is_a_directory():
    client = _FakeAuthzClient(contents=[_FakeContent("- x")])

    with pytest.raises(ValueError, match="resolved to a directory"):
        merge_authz.resolve_authorized_logins(client)


def test_resolve_merge_rules_keeps_exact_case_approvers_beside_the_lowercased_flat_set():
    yaml_text = textwrap.dedent(
        """
        - name: Docs
          patterns: ['docs/**']
          approved_by:
          - AlbanD
        - name: CI
          patterns: ['*']
          approved_by:
          - pytorch/pytorch-dev-infra
        """
    )
    client = _client(yaml_text, teams={"pytorch/pytorch-dev-infra": ["Dan", "erin"]})

    snapshot = merge_authz.resolve_merge_rules(client)

    assert snapshot.authorized == frozenset({"alband", "dan", "erin"})
    docs, ci = snapshot.rules
    assert (docs.name, docs.approvers, docs.covers_all) == ("Docs", frozenset({"AlbanD"}), False)
    assert (ci.name, ci.approvers, ci.covers_all) == ("CI", frozenset({"Dan", "erin"}), True)


@pytest.mark.parametrize(
    "patterns",
    [
        pytest.param("['*', 'torch/(x)']", id="invalid-character"),
        pytest.param("['?torch']", id="does-not-compile"),
    ],
)
def test_resolve_merge_rules_turns_an_invalid_pattern_into_a_rule_that_covers_nothing(
    patterns: str, caplog: pytest.LogCaptureFixture
) -> None:
    yaml_text = f"- name: Broken\n  patterns: {patterns}\n  approved_by: [Alice]\n"

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        snapshot = merge_authz.resolve_merge_rules(_client(yaml_text))

    assert snapshot.authorized == frozenset({"alice"})
    (rule,) = snapshot.rules
    assert rule.covers(["torch/x.py"]) is False
    assert rule.covers_all is False
    assert any(record.levelno == logging.ERROR for record in caplog.records)


def test_resolve_merge_rules_never_reads_a_missing_pattern_list_as_a_catch_all():
    snapshot = merge_authz.resolve_merge_rules(_client("- name: Odd\n  approved_by: [Alice]\n"))

    (rule,) = snapshot.rules
    assert rule.covers([]) is False


@pytest.mark.parametrize(
    ("patterns", "files", "uncovered"),
    [
        pytest.param(
            ["torch/*docs.py"],
            ["torch/_torch_docs.py", "torch/nn/_docs.py"],
            ["torch/nn/_docs.py"],
            id="star-stays-within-one-segment",
        ),
        pytest.param(
            ["aten/**Kernel.cpp"], ["aten/native/cpu/LinearAlgebraKernel.cpp"], [], id="double-star-spans-segments"
        ),
        pytest.param(
            ["third_party/onnx"], ["third_party/onnx-tensorrt/x.cc"], [], id="prefix-match-with-no-end-anchor"
        ),
        pytest.param(
            ["torch/**", "-torch/csrc/**"],
            ["torch/nn/linear.py", "torch/csrc/api/x.cpp"],
            ["torch/csrc/api/x.cpp"],
            id="exclusion-wins",
        ),
    ],
)
def test_patterns_follow_trymerge_semantics(patterns: list[str], files: list[str], uncovered: list[str]) -> None:
    rule = merge_authz.compile_rule("rule", patterns, frozenset())

    assert [path for path in files if not rule.covers([path])] == uncovered


class _FakePRFile:
    def __init__(self, filename: str) -> None:
        self.filename = filename


class _FakePRPart:
    def __init__(self, ref: str, sha: str = "0" * 40) -> None:
        self.ref = ref
        self.sha = sha


class _FakeFilesPR:
    def __init__(self, files: Iterable[_FakePRFile], *, head_ref: str = "feature", base_ref: str = "main") -> None:
        self.head = _FakePRPart(head_ref)
        self.base = _FakePRPart(base_ref)
        self._files = files
        self.get_files_calls = 0

    def get_files(self) -> Iterable[_FakePRFile]:
        self.get_files_calls += 1
        return self._files


def _files_pr(*filenames: str, **refs: str) -> _FakeFilesPR:
    return _FakeFilesPR([_FakePRFile(name) for name in filenames], **refs)


def test_changed_files_of_a_ghstack_head_is_none_without_listing():
    pr = _files_pr("a.py", head_ref="gh/jeanschmidt/12/head")

    assert merge_authz.changed_files(pr) is None
    assert pr.get_files_calls == 0


def test_changed_files_of_a_base_other_than_main_is_none_without_listing():
    pr = _files_pr("a.py", base_ref="release/2.9")

    assert merge_authz.changed_files(pr) is None
    assert pr.get_files_calls == 0


def test_changed_files_lists_the_filenames_of_a_branch_based_on_main():
    assert merge_authz.changed_files(_files_pr("a.py", "b.py")) == ("a.py", "b.py")


def test_changed_files_lists_every_filename_of_a_listing_at_the_file_cap():
    filenames = [f"f{index}.py" for index in range(constants.MAX_DIFF_FILES)]

    assert merge_authz.changed_files(_files_pr(*filenames)) == tuple(filenames)


def test_changed_files_of_a_listing_over_the_file_cap_is_none_after_reading_one_entry_past_it():
    listing = iter([_FakePRFile(f"f{index}.py") for index in range(3000)])

    assert merge_authz.changed_files(_FakeFilesPR(listing)) is None
    assert len(list(listing)) == 3000 - constants.MAX_DIFF_FILES - 1


def test_changed_files_counts_a_repeated_path_toward_the_file_cap():
    filenames = [f"f{index}.py" for index in range(constants.MAX_DIFF_FILES)]

    assert merge_authz.changed_files(_files_pr(*filenames, filenames[-1], "a.py")) is None


def _snapshot(*logins: str) -> merge_authz.MergeRulesSnapshot:
    return merge_authz.MergeRulesSnapshot(authorized=frozenset(logins), rules=())


class _Clock:
    def __init__(self, start: float = 0.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t


def test_cache_is_lazy_no_fetch_before_snapshot():
    calls: list[int] = []

    def fetch(_client):
        calls.append(1)
        return _snapshot("alice")

    merge_authz.AuthorizedLoginsCache(lambda: _FakeAuthzClient(), ttl_seconds=600, monotonic=lambda: 0.0, fetch=fetch)

    assert calls == []


def test_cache_first_snapshot_builds_client_and_passes_it_to_fetch():
    client = _FakeAuthzClient()
    fetched: list[object] = []

    def fetch(passed):
        fetched.append(passed)
        return _snapshot("alice")

    cache = merge_authz.AuthorizedLoginsCache(lambda: client, ttl_seconds=600, monotonic=lambda: 0.0, fetch=fetch)

    assert cache.snapshot().authorized == frozenset({"alice"})
    assert fetched == [client]


def test_cache_serves_cached_within_ttl():
    fetch_calls: list[int] = []

    def fetch(_client):
        fetch_calls.append(1)
        return _snapshot(f"fetch{len(fetch_calls)}")

    clock = _Clock(0.0)
    cache = merge_authz.AuthorizedLoginsCache(lambda: _FakeAuthzClient(), ttl_seconds=600, monotonic=clock, fetch=fetch)

    first = cache.snapshot().authorized
    clock.t = 599.0
    second = cache.snapshot().authorized

    assert first == second == frozenset({"fetch1"})
    assert len(fetch_calls) == 1


def test_cache_refetches_after_ttl_expiry():
    fetch_calls: list[int] = []

    def fetch(_client):
        fetch_calls.append(1)
        return _snapshot(f"fetch{len(fetch_calls)}")

    clock = _Clock(0.0)
    cache = merge_authz.AuthorizedLoginsCache(lambda: _FakeAuthzClient(), ttl_seconds=600, monotonic=clock, fetch=fetch)

    assert cache.snapshot().authorized == frozenset({"fetch1"})
    clock.t = 600.0  # at the boundary the entry is already expired (strict <)
    assert cache.snapshot().authorized == frozenset({"fetch2"})
    assert len(fetch_calls) == 2


def test_cache_serves_stale_set_on_refresh_error(caplog):
    state = {"n": 0}

    def fetch(_client):
        state["n"] += 1
        if state["n"] == 1:
            return _snapshot("good")
        raise RuntimeError("merge_rules down")

    clock = _Clock(0.0)
    cache = merge_authz.AuthorizedLoginsCache(lambda: _FakeAuthzClient(), ttl_seconds=600, monotonic=clock, fetch=fetch)

    assert cache.snapshot().authorized == frozenset({"good"})
    clock.t = 700.0
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        stale = cache.snapshot().authorized

    assert stale == frozenset({"good"})
    assert "serving stale" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_cache_cold_failure_raises():
    def fetch(_client):
        raise RuntimeError("merge_rules down")

    cache = merge_authz.AuthorizedLoginsCache(
        lambda: _FakeAuthzClient(), ttl_seconds=600, monotonic=lambda: 0.0, fetch=fetch
    )

    with pytest.raises(RuntimeError, match="merge_rules down"):
        cache.snapshot()


def test_cache_default_fetch_resolves_from_merge_rules():
    client = _client("- name: CI\n  approved_by: [Alice]\n")

    cache = merge_authz.AuthorizedLoginsCache(lambda: client, ttl_seconds=600, monotonic=lambda: 0.0)

    assert cache.snapshot().authorized == frozenset({"alice"})


class _ClosableAuthzClient(_FakeAuthzClient):
    def __init__(self, *, close_error: bool = False) -> None:
        super().__init__()
        self.closed = 0
        self._close_error = close_error

    def close(self) -> None:
        self.closed += 1
        if self._close_error:
            raise RuntimeError("close boom")


def test_cache_warm_refetch_propagates_iteration_timeout():
    calls = {"n": 0}

    def fetch(_client):
        calls["n"] += 1
        if calls["n"] == 1:
            return _snapshot("good")
        raise IterationTimeout("iteration exceeded")

    clock = _Clock(0.0)
    cache = merge_authz.AuthorizedLoginsCache(lambda: _FakeAuthzClient(), ttl_seconds=600, monotonic=clock, fetch=fetch)

    assert cache.snapshot().authorized == frozenset({"good"})
    clock.t = 700.0
    # A warm cache must NOT mask the soft timeout as a transient refresh error and serve stale.
    with pytest.raises(IterationTimeout):
        cache.snapshot()


def test_cache_closes_transient_client_after_fetch():
    client = _ClosableAuthzClient()
    cache = merge_authz.AuthorizedLoginsCache(
        lambda: client, ttl_seconds=600, monotonic=lambda: 0.0, fetch=lambda _c: _snapshot("alice")
    )

    assert cache.snapshot().authorized == frozenset({"alice"})
    assert client.closed == 1


def test_cache_closes_transient_client_even_when_fetch_raises():
    client = _ClosableAuthzClient()

    def fetch(_client):
        raise RuntimeError("boom")

    cache = merge_authz.AuthorizedLoginsCache(lambda: client, ttl_seconds=600, monotonic=lambda: 0.0, fetch=fetch)

    with pytest.raises(RuntimeError, match="boom"):
        cache.snapshot()
    assert client.closed == 1


def test_cache_swallows_client_close_error(caplog):
    client = _ClosableAuthzClient(close_error=True)
    cache = merge_authz.AuthorizedLoginsCache(
        lambda: client, ttl_seconds=600, monotonic=lambda: 0.0, fetch=lambda _c: _snapshot("alice")
    )

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        assert cache.snapshot().authorized == frozenset({"alice"})

    assert client.closed == 1
    assert "failed to close GitHub client" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)
