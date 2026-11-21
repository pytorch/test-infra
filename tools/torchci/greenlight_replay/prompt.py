"""Render the reviewer prompt the policy's workflow carries, as CI would.

The prompt is the ``with.prompt`` of the workflow's review step, read verbatim by
:mod:`.workflow`, and it names the pull request through GitHub Actions expressions.
Two spellings are resolved: the dispatch inputs a policy reviewing pytorch/pytorch
alone uses, and the outputs of the workflow's ``target`` step a repo-aware policy uses.
Both stay, so a replay can run either side of a policy change that moves from one to
the other.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from torchci.greenlight_replay.checkout import (
    checkout_dirname,
    DEFAULT_REPO,
    require_repo,
)


if TYPE_CHECKING:
    from torchci.greenlight_replay.policy import Policy


__all__ = [
    "CHECKOUT_EXPR",
    "HEAD_SHA_EXPR",
    "PR_NUMBER_EXPR",
    "REPO_EXPR",
    "TARGET_HEAD_SHA_EXPR",
    "TARGET_PR_EXPR",
    "render_prompt",
]

PR_NUMBER_EXPR = "github.event.inputs.pr_number"
HEAD_SHA_EXPR = "github.event.inputs.head_sha"
REPO_EXPR = "steps.target.outputs.repo"
TARGET_PR_EXPR = "steps.target.outputs.pr"
TARGET_HEAD_SHA_EXPR = "steps.target.outputs.head_sha"
CHECKOUT_EXPR = "steps.target.outputs.checkout"

_INTERPOLATION = re.compile(r"\$\{\{(.*?)\}\}", re.DOTALL)
_INTERPOLATION_OPEN = re.compile(r"\$\{\{")


def render_prompt(
    policy: Policy, pr_number: int, head_sha: str, repo: str = DEFAULT_REPO
) -> str:
    """Resolve the interpolations naming the reviewed pull request and its checkout.

    Any other ``${{ ... }}`` aborts. An unresolved interpolation is not a crash, it is
    a successful-looking run: the reviewer is told it is reviewing PR
    ``${{ github.event.inputs.pr_number }}`` and returns a verdict about nothing.
    """
    _reject_unclosed(policy.prompt_template)
    substitutions = {
        PR_NUMBER_EXPR: str(pr_number),
        HEAD_SHA_EXPR: head_sha,
        REPO_EXPR: require_repo(repo),
        TARGET_PR_EXPR: str(pr_number),
        TARGET_HEAD_SHA_EXPR: head_sha,
        CHECKOUT_EXPR: checkout_dirname(repo),
    }
    unresolved: list[str] = []

    def replace(match: re.Match[str]) -> str:
        expression = match.group(1).strip()
        if expression in substitutions:
            return substitutions[expression]
        unresolved.append(expression)
        return match.group(0)

    # One pass: a substituted value that itself contains "${{" is never rescanned.
    rendered = _INTERPOLATION.sub(replace, policy.prompt_template)
    if unresolved:
        raise ValueError(
            "prompt template carries interpolations this harness cannot resolve: "
            + ", ".join(sorted(set(unresolved)))
        )
    return rendered


def _reject_unclosed(template: str) -> None:
    """Every ``${{`` in the template must open a well-formed interpolation.

    The substitution pattern only sees balanced ``${{ ... }}``, so a template carrying
    ``${{ github.event.inputs.pr_number }`` -- one closing brace -- renders verbatim and
    trips nothing, which defeats the whole guard. Checked against the template rather
    than the rendered text so that a substituted value which happens to contain ``${{``
    is not mistaken for the policy's own malformed markup.
    """
    for match in _INTERPOLATION_OPEN.finditer(template):
        if _INTERPOLATION.match(template, match.start()) is None:
            excerpt = template[match.start() : match.start() + 60]
            raise ValueError(
                "prompt template carries an interpolation that never closes: "
                f"{excerpt!r}"
            )
