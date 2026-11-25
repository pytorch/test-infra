"""The strict YAML loader for a repo's GreenLight config file, and the bounded way its values are shown."""

from __future__ import annotations

import logging
import reprlib
from typing import TYPE_CHECKING

import yaml

from greenlight.config_contents import too_big
from greenlight.constants import CONFIG_MAX_BYTES, REPO_CONFIG_PATH

if TYPE_CHECKING:
    from collections.abc import Mapping


logger = logging.getLogger(__name__)


class _Invalid(ValueError):
    """The file cannot be used as a config; the message is the reason."""


_REPR = reprlib.Repr(maxstring=60, maxother=60)


def _cut(text: str) -> str:
    return text if len(text) <= _REPR.maxstring else text[: _REPR.maxstring - 3] + "..."


def _shown(value: object) -> str:
    """``value`` for a problem message: a string's repr cut to a bounded length, anything else by type."""
    return _REPR.repr(value) if isinstance(value, str) else f"a {type(value).__name__}"


class _Loader(yaml.SafeLoader):
    """``yaml.SafeLoader`` that reads no scalar as a boolean and refuses anchors, aliases and duplicate keys.

    PyYAML follows YAML 1.1, which reads a bare ``off`` (and ``on``, ``yes``, ``no``) as a boolean, so
    ``mode: off`` would otherwise arrive as False. No value this file holds is a boolean. Aliases
    let a few hundred bytes expand into a structure of many megabytes, and with a duplicate key the
    last copy would silently win. A bare ``<<`` is a plain key; any tag written in the file is refused,
    since an explicit ``!!merge`` would merge keys past the duplicate check.
    """

    def compose_node(self, parent: yaml.Node | None, index: int) -> yaml.Node | None:
        event = self.peek_event()  # type: ignore[no-untyped-call]
        if isinstance(event, yaml.AliasEvent) or getattr(event, "anchor", None) is not None:
            raise _Invalid("anchors and aliases are not allowed")
        if getattr(event, "tag", None) is not None:
            raise _Invalid(f"explicit YAML tags are not allowed (found {_shown(event.tag)})")
        return super().compose_node(parent, index)

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[object, object]:
        seen: set[tuple[str, str]] = set()
        for key_node, _value_node in node.value:
            if isinstance(key_node, yaml.ScalarNode):
                if (key_node.tag, key_node.value) in seen:
                    raise _Invalid(f"duplicate key {_shown(key_node.value)}")
                seen.add((key_node.tag, key_node.value))
        return super().construct_mapping(node, deep=deep)


_Loader.yaml_implicit_resolvers = {
    first: [
        (tag, regexp) for tag, regexp in resolvers if tag not in {"tag:yaml.org,2002:bool", "tag:yaml.org,2002:merge"}
    ]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def _load(text: str | bytes) -> Mapping[object, object]:
    """The file's top-level mapping; ``_Invalid`` when it cannot be one."""
    size = len(text.encode() if isinstance(text, str) else text)
    if size > CONFIG_MAX_BYTES:
        raise _Invalid(too_big(size))
    try:
        document = yaml.load(text, Loader=_Loader)  # noqa: S506 -- _Loader is a yaml.SafeLoader
    except _Invalid:
        raise
    except Exception as exc:
        logger.error("cannot parse a %s", REPO_CONFIG_PATH, exc_info=True)
        raise _Invalid(f"not valid YAML: {type(exc).__name__}: {exc}") from exc
    if not isinstance(document, dict):
        raise _Invalid(f"the top level must be a mapping, got {type(document).__name__}")
    return document
