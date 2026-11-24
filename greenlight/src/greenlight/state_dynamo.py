"""The ``state_store.StateStore`` backend on a DynamoDB table (``PYTORCH_GREENLIGHT_STATE_TABLE``).

The table's partition key is the string attribute ``pk``, with TTL on ``ttl_at``. Requests go through
boto3's low-level client: every write is one ``UpdateItem``, so writes to distinct attributes of one item
(the planner's config cache, a worker's memory and lease) never clobber each other, and every read is
consistent. Each attribute name goes through an expression placeholder, since DynamoDB reserves many
plain words. A ``ConditionalCheckFailedException`` is the condition's answer; any other failure is a
``StoreError``.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Protocol, cast

from greenlight.constants import AWS_REGION
from greenlight.guards import IterationTimeout
from greenlight.state_store import (
    CONFIG_ATTRIBUTE_NAMES,
    DRAIN_COMPLETE,
    FETCHED_AT,
    LAST_COMPLETED_AT,
    LAST_TICK,
    LATCH_KEY,
    LEASE_EXPIRES,
    LEASE_OWNER,
    REPO_PREFIX,
    SNAPSHOT,
    TTL_AT,
    UNTIL,
    LeaseLost,
    StoreError,
    clamp_latch,
    config_attributes,
    eligibility_key,
    memory_attributes,
    repo_item,
    repo_key,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from greenlight.state_store import ConfigRecord, EligibilityKey, RepoItem, Value

logger = logging.getLogger(__name__)

_CONDITION_FAILED = "ConditionalCheckFailedException"
_SCANNED_ATTRIBUTES = (
    "pk",
    LEASE_OWNER,
    LEASE_EXPIRES,
    LAST_TICK,
    LAST_COMPLETED_AT,
    DRAIN_COMPLETE,
    *CONFIG_ATTRIBUTE_NAMES,
)


class DynamoClient(Protocol):
    def get_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def update_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def scan(self, **kwargs: Any) -> dict[str, Any]: ...


class _ConditionFailed(Exception):
    """The write's condition did not hold."""


def _encode(value: Value) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, bytes):
        return {"B": value}
    return {"N": repr(value)}


def _decode(typed: Mapping[str, Any]) -> Value | None:
    if "BOOL" in typed:
        return bool(typed["BOOL"])
    if "S" in typed:
        return str(typed["S"])
    if "B" in typed:
        return bytes(typed["B"])
    if "N" in typed:
        number = str(typed["N"])
        return float(number) if any(mark in number for mark in ".eE") else int(number)
    return None


def _attributes(item: Mapping[str, Mapping[str, Any]]) -> dict[str, Value]:
    return {name: value for name, typed in item.items() if (value := _decode(typed)) is not None}


def _condition_failed(exc: BaseException) -> bool:
    response = getattr(exc, "response", None)
    error = response.get("Error") if isinstance(response, dict) else None
    return isinstance(error, dict) and error.get("Code") == _CONDITION_FAILED


class _Expression:
    """The placeholders of one request's expressions."""

    def __init__(self) -> None:
        self.names: dict[str, str] = {}
        self.values: dict[str, dict[str, Any]] = {}

    def name(self, attribute: str) -> str:
        for placeholder, known in self.names.items():
            if known == attribute:
                return placeholder
        placeholder = f"#n{len(self.names)}"
        self.names[placeholder] = attribute
        return placeholder

    def value(self, value: Value) -> str:
        placeholder = f":v{len(self.values)}"
        self.values[placeholder] = _encode(value)
        return placeholder

    def params(self) -> dict[str, Any]:
        """The placeholder maps; DynamoDB refuses an empty one."""
        params: dict[str, Any] = {}
        if self.names:
            params["ExpressionAttributeNames"] = self.names
        if self.values:
            params["ExpressionAttributeValues"] = self.values
        return params


def _default_client() -> DynamoClient:
    import boto3
    from botocore.config import Config

    config = Config(connect_timeout=5, read_timeout=5, retries={"max_attempts": 3, "mode": "standard"})
    return cast("DynamoClient", boto3.client("dynamodb", region_name=AWS_REGION, config=config))


class DynamoStore:
    """``StateStore`` on the DynamoDB table ``table``."""

    def __init__(self, table: str, client: DynamoClient | None = None) -> None:
        self._table = table
        self._client = _default_client() if client is None else client

    def _call(self, operation: str, **params: Any) -> dict[str, Any]:
        try:
            response: dict[str, Any] = getattr(self._client, operation)(TableName=self._table, **params)
        except IterationTimeout:
            raise
        except Exception as exc:
            if _condition_failed(exc):
                raise _ConditionFailed from exc
            raise StoreError(f"DynamoDB {operation} on {self._table} failed: {exc}") from exc
        return response

    def _get(self, key: str) -> dict[str, Value]:
        response = self._call("get_item", Key={"pk": {"S": key}}, ConsistentRead=True)
        return _attributes(response.get("Item") or {})

    def _update(
        self,
        key: str,
        values: Mapping[str, Value | None],
        *,
        expression: _Expression | None = None,
        condition: str | None = None,
        remove: tuple[str, ...] = (),
    ) -> None:
        expression = expression or _Expression()
        assignments = [
            f"{expression.name(name)} = {expression.value(value)}"
            for name, value in values.items()
            if value is not None
        ]
        removals = [expression.name(name) for name, value in values.items() if value is None]
        removals.extend(expression.name(name) for name in remove)
        clauses = [f"SET {', '.join(assignments)}"] if assignments else []
        if removals:
            clauses.append(f"REMOVE {', '.join(removals)}")
        params: dict[str, Any] = {"Key": {"pk": {"S": key}}, "UpdateExpression": " ".join(clauses)}
        if condition is not None:
            params["ConditionExpression"] = condition
        self._call("update_item", **params, **expression.params())

    def read_repo(self, repo: str) -> RepoItem:
        return repo_item(repo, self._get(repo_key(repo)))

    def scan_repos(self) -> dict[str, RepoItem]:
        expression = _Expression()
        projection = ", ".join(expression.name(name) for name in _SCANNED_ATTRIBUTES)
        params: dict[str, Any] = {
            "ConsistentRead": True,
            "ProjectionExpression": projection,
            "FilterExpression": f"begins_with({expression.name('pk')}, {expression.value(REPO_PREFIX)})",
            **expression.params(),
        }
        found: dict[str, RepoItem] = {}
        while True:
            response = self._call("scan", **params)
            for item in response.get("Items", []):
                attributes = _attributes(item)
                key = attributes.get("pk")
                if isinstance(key, str) and key.startswith(REPO_PREFIX):
                    repo = key.removeprefix(REPO_PREFIX)
                    found[repo] = repo_item(repo, attributes)
            last = response.get("LastEvaluatedKey")
            if not last:
                return found
            params["ExclusiveStartKey"] = last

    def write_config(self, repo: str, record: ConfigRecord) -> None:
        self._update(repo_key(repo), config_attributes(record))

    def acquire_lease(self, repo: str, owner: str, *, expires: float, now: float) -> bool:
        expression = _Expression()
        holder, expiry = expression.name(LEASE_OWNER), expression.name(LEASE_EXPIRES)
        condition = (
            f"attribute_not_exists({holder}) OR attribute_not_exists({expiry}) OR {expiry} <= {expression.value(now)}"
        )
        try:
            self._update(
                repo_key(repo), {LEASE_OWNER: owner, LEASE_EXPIRES: expires}, expression=expression, condition=condition
            )
        except _ConditionFailed:
            return False
        return True

    def save_memory(
        self, repo: str, memory: bytes, *, owner: str | None, now: float, tick: str | None, drain_complete: bool
    ) -> None:
        expression = _Expression()
        condition = None
        if owner is not None:
            holder, expiry = expression.name(LEASE_OWNER), expression.name(LEASE_EXPIRES)
            condition = f"{holder} = {expression.value(owner)} AND {expiry} > {expression.value(now)}"
        values = memory_attributes(memory, now=now, tick=tick, drain_complete=drain_complete)
        try:
            self._update(repo_key(repo), values, expression=expression, condition=condition)
        except _ConditionFailed as exc:
            raise LeaseLost(f"{repo}: the lease of {owner} is gone, expired or held by another owner") from exc

    def release_lease(self, repo: str, owner: str) -> bool:
        expression = _Expression()
        condition = f"{expression.name(LEASE_OWNER)} = {expression.value(owner)}"
        try:
            self._update(
                repo_key(repo), {}, expression=expression, condition=condition, remove=(LEASE_OWNER, LEASE_EXPIRES)
            )
        except _ConditionFailed:
            return False
        return True

    def read_eligibility(self, key: EligibilityKey) -> tuple[bytes, float] | None:
        attributes = self._get(eligibility_key(key))
        snapshot, fetched_at = attributes.get(SNAPSHOT), attributes.get(FETCHED_AT)
        if not isinstance(snapshot, bytes) or not isinstance(fetched_at, int | float) or isinstance(fetched_at, bool):
            return None
        return snapshot, float(fetched_at)

    def write_eligibility(self, key: EligibilityKey, snapshot: bytes, fetched_at: float) -> None:
        self._update(eligibility_key(key), {SNAPSHOT: snapshot, FETCHED_AT: fetched_at})

    def read_latch(self, now: float) -> float | None:
        until = self._get(LATCH_KEY).get(UNTIL)
        if not isinstance(until, int | float) or isinstance(until, bool) or until <= now:
            return None
        return clamp_latch(float(until), now)

    def extend_latch(self, until: float, now: float) -> None:
        clamped = clamp_latch(until, now)
        expression = _Expression()
        name, value = expression.name(UNTIL), expression.value(clamped)
        condition = f"attribute_not_exists({name}) OR {name} < {value}"
        try:
            self._update(
                LATCH_KEY,
                {UNTIL: clamped, TTL_AT: int(clamped) + 1},
                expression=expression,
                condition=condition,
            )
        except _ConditionFailed:
            logger.debug("the shared rate-limit latch already holds until %s or later", clamped)
