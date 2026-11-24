from __future__ import annotations

import sys
from typing import Any
from unittest.mock import MagicMock

import pytest

from greenlight import state_dynamo
from greenlight.constants import AWS_REGION, RATE_LIMIT_LATCH_MAX
from greenlight.guards import IterationTimeout
from greenlight.state_dynamo import DynamoStore
from greenlight.state_store import ConfigRecord, EligibilityKey, LeaseLost, StoreError

_TABLE = "greenlight-state"
_REPO = "pytorch/vision"
_KEY = {"pk": {"S": f"repo#{_REPO}"}}


class _ClientError(Exception):
    """The shape botocore's ClientError has: a ``response`` naming the error code."""

    def __init__(self, code: str) -> None:
        super().__init__(f"An error occurred ({code})")
        self.response = {"Error": {"Code": code, "Message": "x"}}


class _Client:
    """Records each request and answers from ``answers`` (an exception is raised)."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def _answer(self, operation: str, kwargs: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((operation, kwargs))
        answer = self.answers.pop(0) if self.answers else {}
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def get_item(self, **kwargs: Any) -> dict[str, Any]:
        return self._answer("get_item", kwargs)

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        return self._answer("update_item", kwargs)

    def scan(self, **kwargs: Any) -> dict[str, Any]:
        return self._answer("scan", kwargs)


def _named(kwargs: dict[str, Any], expression: str) -> str:
    """``expression`` with its placeholders replaced by the attribute names and values they stand for."""
    for placeholder, name in kwargs.get("ExpressionAttributeNames", {}).items():
        expression = expression.replace(placeholder, name)
    for placeholder, value in sorted(kwargs.get("ExpressionAttributeValues", {}).items(), reverse=True):
        expression = expression.replace(placeholder, repr(next(iter(value.values()))))
    return expression


def test_a_repo_is_read_consistently_and_every_attribute_type_decodes():
    item = {
        "pk": {"S": f"repo#{_REPO}"},
        "lease_owner": {"S": "a"},
        "lease_expires": {"N": "330.5"},
        "memory": {"B": b"blob"},
        "last_tick": {"S": "t1"},
        "last_completed_at": {"N": "12"},
        "drain_complete": {"BOOL": True},
        "cfg_kind": {"S": "file"},
        "cfg_size": {"N": "7"},
        "served": {"BOOL": True},
        "unknown": {"NULL": True},
    }
    client = _Client({"Item": item})

    found = DynamoStore(_TABLE, client).read_repo(_REPO)

    assert client.calls == [("get_item", {"TableName": _TABLE, "Key": _KEY, "ConsistentRead": True})]
    assert (found.lease_owner, found.lease_expires, found.memory) == ("a", 330.5, b"blob")
    assert (found.last_tick, found.last_completed_at, found.drain_complete) == ("t1", 12.0, True)
    assert (found.config.kind, found.config.size, found.config.served) == ("file", 7, True)


def test_a_missing_repo_reads_empty():
    assert DynamoStore(_TABLE, _Client({})).read_repo(_REPO).config == ConfigRecord()


def test_scan_repos_pages_through_the_repo_items_without_their_memory():
    first = {"Items": [{"pk": {"S": f"repo#{_REPO}"}, "last_tick": {"S": "t"}}], "LastEvaluatedKey": {"pk": {"S": "k"}}}
    second = {"Items": [{"pk": {"S": "repo#pytorch/audio"}}, {"pk": {"S": "ratelimit"}}]}
    client = _Client(first, second)

    found = DynamoStore(_TABLE, client).scan_repos()

    assert set(found) == {_REPO, "pytorch/audio"}
    assert found[_REPO].last_tick == "t"
    (_op, params), (_op2, again) = client.calls
    assert params["ConsistentRead"] is True
    projected = set(params["ExpressionAttributeNames"].values())
    assert "memory" not in projected
    assert {"pk", "lease_owner", "lease_expires", "cfg_text", "reported", "last_completed_at"} <= projected
    assert _named(params, params["FilterExpression"]) == "begins_with(pk, 'repo#')"
    assert "ExclusiveStartKey" not in params
    assert again["ExclusiveStartKey"] == {"pk": {"S": "k"}}


def test_a_config_write_sets_what_it_has_and_removes_the_rest():
    client = _Client()
    record = ConfigRecord(kind="file", text="mode: off\n", etag='"e"', size=10, read_at=1.5, served=True)

    DynamoStore(_TABLE, client).write_config(_REPO, record)

    [(operation, params)] = client.calls
    assert operation == "update_item"
    assert params["Key"] == _KEY
    assert "ConditionExpression" not in params
    update = _named(params, params["UpdateExpression"])
    assert update.startswith("SET cfg_kind = 'file', cfg_text = 'mode: off\\n', cfg_etag = '\"e\"', cfg_size = '10'")
    assert "served = True" in update
    assert update.endswith("REMOVE cfg_reason, cfg_valid_text, work_since, reported")


def test_a_lease_is_a_write_conditioned_on_no_live_lease():
    client = _Client({}, _ClientError("ConditionalCheckFailedException"))
    store = DynamoStore(_TABLE, client)

    assert store.acquire_lease(_REPO, "a", expires=330.0, now=0.0)
    assert not store.acquire_lease(_REPO, "b", expires=340.0, now=10.0)

    params = client.calls[0][1]
    assert _named(params, params["UpdateExpression"]) == "SET lease_owner = 'a', lease_expires = '330.0'"
    assert _named(params, params["ConditionExpression"]) == (
        "attribute_not_exists(lease_owner) OR attribute_not_exists(lease_expires) OR lease_expires <= '0.0'"
    )


def test_a_save_under_a_lease_is_conditioned_on_its_owner_and_expiry():
    client = _Client({}, _ClientError("ConditionalCheckFailedException"))
    store = DynamoStore(_TABLE, client)

    store.save_memory(_REPO, b"m", owner="a", now=5.0, tick="t1", drain_complete=False)
    with pytest.raises(LeaseLost, match="the lease of a is gone"):
        store.save_memory(_REPO, b"m", owner="a", now=500.0, tick="t1", drain_complete=False)

    params = client.calls[0][1]
    assert _named(params, params["ConditionExpression"]) == "lease_owner = 'a' AND lease_expires > '5.0'"
    update = _named(params, params["UpdateExpression"])
    assert update == "SET memory = b'm', drain_complete = False, last_tick = 't1', last_completed_at = '5.0'"


def test_a_save_without_an_owner_is_unconditional():
    client = _Client()

    DynamoStore(_TABLE, client).save_memory(_REPO, b"m", owner=None, now=5.0, tick=None, drain_complete=True)

    params = client.calls[0][1]
    assert "ConditionExpression" not in params
    assert _named(params, params["UpdateExpression"]) == "SET memory = b'm', drain_complete = True"


def test_a_release_removes_the_lease_only_for_its_owner():
    client = _Client({}, _ClientError("ConditionalCheckFailedException"))
    store = DynamoStore(_TABLE, client)

    assert store.release_lease(_REPO, "a")
    assert not store.release_lease(_REPO, "a")

    params = client.calls[0][1]
    assert _named(params, params["UpdateExpression"]) == "REMOVE lease_owner, lease_expires"
    assert _named(params, params["ConditionExpression"]) == "lease_owner = 'a'"


def test_an_eligibility_snapshot_is_written_and_read_under_its_key():
    key = EligibilityKey(_REPO, "write_permission", "maintain")
    stored = {"Item": {"snapshot": {"B": b"s"}, "fetched_at": {"N": "4.5"}}}
    client = _Client({}, stored, {}, {"Item": {"snapshot": {"S": "not bytes"}}})
    store = DynamoStore(_TABLE, client)

    store.write_eligibility(key, b"s", 4.5)

    assert store.read_eligibility(key) == (b"s", 4.5)
    assert store.read_eligibility(key) is None
    assert store.read_eligibility(key) is None
    assert {params["Key"]["pk"]["S"] for _op, params in client.calls} == {
        f"eligibility#{_REPO}#write_permission#maintain"
    }
    update = client.calls[0][1]
    assert _named(update, update["UpdateExpression"]) == "SET snapshot = b's', fetched_at = '4.5'"


def test_the_latch_is_read_clamped_and_expired_reads_none():
    client = _Client({"Item": {"until": {"N": "100000"}}}, {"Item": {"until": {"N": "50"}}}, {})
    store = DynamoStore(_TABLE, client)

    assert store.read_latch(10.0) == 10.0 + RATE_LIMIT_LATCH_MAX.total_seconds()
    assert store.read_latch(60.0) is None
    assert store.read_latch(0.0) is None
    assert client.calls[0][1]["Key"] == {"pk": {"S": "ratelimit"}}


def test_the_latch_extends_only_later_and_sets_the_ttl():
    client = _Client({}, _ClientError("ConditionalCheckFailedException"))
    store = DynamoStore(_TABLE, client)

    store.extend_latch(60.2, 0.0)
    store.extend_latch(30.0, 0.0)

    params = client.calls[0][1]
    assert _named(params, params["UpdateExpression"]) == "SET until = '60.2', ttl_at = '61'"
    assert _named(params, params["ConditionExpression"]) == "attribute_not_exists(until) OR until < '60.2'"


@pytest.mark.parametrize(
    "call",
    [
        lambda store: store.read_repo(_REPO),
        lambda store: store.scan_repos(),
        lambda store: store.acquire_lease(_REPO, "a", expires=1.0, now=0.0),
        lambda store: store.save_memory(_REPO, b"m", owner="a", now=0.0, tick=None, drain_complete=False),
        lambda store: store.release_lease(_REPO, "a"),
        lambda store: store.extend_latch(1.0, 0.0),
    ],
)
@pytest.mark.parametrize("error", [_ClientError("ProvisionedThroughputExceededException"), OSError("unreachable")])
def test_any_other_failure_is_a_store_error(call, error):
    with pytest.raises(StoreError, match=f"on {_TABLE} failed") as excinfo:
        call(DynamoStore(_TABLE, _Client(error)))

    assert not isinstance(excinfo.value, LeaseLost)
    assert excinfo.value.__cause__ is error


def test_an_iteration_timeout_is_never_wrapped():
    with pytest.raises(IterationTimeout):
        DynamoStore(_TABLE, _Client(IterationTimeout("late"))).read_repo(_REPO)


def test_the_default_client_is_dynamodb_in_the_scan_region_with_bounded_timeouts(monkeypatch):
    fake_boto3 = MagicMock()
    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)

    store = DynamoStore(_TABLE)

    args, kwargs = fake_boto3.client.call_args
    assert args == ("dynamodb",)
    assert kwargs["region_name"] == AWS_REGION
    assert (kwargs["config"].connect_timeout, kwargs["config"].read_timeout) == (5, 5)
    assert store._client is fake_boto3.client.return_value


def test_values_encode_by_type_and_numbers_decode_as_int_or_float():
    assert state_dynamo._encode(True) == {"BOOL": True}
    assert state_dynamo._encode("s") == {"S": "s"}
    assert state_dynamo._encode(b"b") == {"B": b"b"}
    assert state_dynamo._encode(3) == {"N": "3"}
    assert state_dynamo._encode(1.25) == {"N": "1.25"}
    assert state_dynamo._decode({"N": "3"}) == 3
    assert state_dynamo._decode({"N": "1e3"}) == 1000.0
    assert state_dynamo._decode({"N": "1.25"}) == 1.25
    assert state_dynamo._decode({"L": []}) is None


def test_an_expression_with_no_placeholders_sends_no_empty_map():
    assert state_dynamo._Expression().params() == {}
