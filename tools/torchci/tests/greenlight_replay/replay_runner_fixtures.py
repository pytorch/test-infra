"""What the replay's runner tests share: a policy fixture and reviewer output envelopes.

The key sets here were taken from actual Claude Code CLI 2.1.267 output on 2026-09-18. That
matters more than usual: the failures ``transcript`` exists to catch are distinguished by
which keys are PRESENT rather than by what any message says, so an envelope missing the
incidental keys would let a classifier pass that a real run would defeat.

Shared by ``test_runner``, ``test_transcript`` and ``test_settings`` so the three cannot
drift onto different ideas of what the CLI returns or what a policy looks like. The single
``Policy`` literal is the point: when the type gained a required field, exactly one place
needed fixing.
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import yaml
from torchci.greenlight_replay import arm_code, settings, workflow, workflow_steps
from torchci.greenlight_replay.arm_code import Target
from torchci.greenlight_replay.policy import Policy


class ScratchTestCase(unittest.TestCase):
    """Base for tests needing a temp directory the read sandbox will accept."""

    def scratch(self, prefix: str) -> Path:
        """A temp directory removed when the test ends.

        The ``greenlight-`` prefix is required, not cosmetic: ``remap.run_dir_violation``
        refuses a run directory outside the read sandbox's scratch prefix. Cleanup is
        required too -- a full run creates roughly 135 of these.
        """
        made = tempfile.TemporaryDirectory(prefix=prefix, dir="/tmp")
        self.addCleanup(made.cleanup)
        return Path(made.name)


REPO_ROOT = Path(__file__).resolve().parents[4]
HOOKS_DIR = REPO_ROOT / ".claude/hooks/greenlight"
WORKFLOW_PATH = REPO_ROOT / workflow.WORKFLOW_RELPATH
HEAD_WORKFLOW = workflow.load(WORKFLOW_PATH)

REPO_POLICIES_RELPATH = ".claude/skills/greenlight-review/repos"

# A repos.yaml entry a repo other than pytorch/pytorch can be configured with.
REPOS_YAML_ENTRY = """  - repo: {repo}
    status_comment: greenlight
    safety: gate
    eligibility: write_permission
    mode: shadow
    change_source: github
"""

PYTORCH_TARGET = Target(
    repo="pytorch/pytorch",
    checkout="pytorch",
    policy=".claude/skills/greenlight-review/repos/pytorch.md",
    policy_present=True,
)

PROMPT_TEMPLATE = (
    "Read the skill file at .claude/skills/greenlight-review/SKILL.md.\n"
    "You are reviewing pytorch/pytorch PR #${{ github.event.inputs.pr_number }}\n"
    "at commit ${{ github.event.inputs.head_sha }}.\n"
)

DEFAULT_MODEL = "claude-opus-5[1m]"
DEFAULT_CONTEXT_WINDOW = 1_000_000

GOOD_VERDICT = {
    "status": "NO_LAND",
    "reason": "insufficient_tests",
    "message": "- Change\n  - Adds a fast path with no test covering it",
}

ABSENT = object()
"""Override value meaning "delete this key", which is how a budget trip drops ``result``."""


def model_usage(model=DEFAULT_MODEL, context_window=DEFAULT_CONTEXT_WINDOW):
    return {
        model: {
            "inputTokens": 3,
            "outputTokens": 4071,
            "cacheReadInputTokens": 867,
            "cacheCreationInputTokens": 105770,
            "webSearchRequests": 0,
            "costUSD": 1.33,
            "contextWindow": context_window,
            "maxOutputTokens": 64000,
            "thinkingTokens": 1420,
            "canonicalModel": "claude-opus-5",
            "provider": "vertex",
            "costBasis": "list",
        }
    }


def result_element(**overrides):
    """A result element carrying the keys a real one carries, before any override."""
    element = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "api_error_status": None,
        "duration_ms": 612_004,
        "duration_api_ms": 598_221,
        "num_turns": 27,
        "result": "Verdict written to /tmp/greenlight-verdict.json.",
        "session_id": "0c6c2c2f-1f2e-4f4a-9a1b-2f0f2d7a1b33",
        "stop_reason": None,
        "permission_denials": [],
        "total_cost_usd": 1.3312,
        "modelUsage": model_usage(),
        "usage": {"input_tokens": 3, "output_tokens": 4071},
        "uuid": "b0a1c2d3-1111-2222-3333-444455556666",
    }
    for key, value in overrides.items():
        if value is ABSENT:
            element.pop(key, None)
        else:
            element[key] = value
    return element


def envelope(result, tool_uses=()):
    """A full --verbose array: system/init, one assistant turn per tool use, result."""
    elements = [
        {
            "type": "system",
            "subtype": "init",
            "cwd": "/private/tmp/greenlight-replay/slot-0",
            "tools": ["Read", "Glob", "Grep", "Write"],
            "mcp_servers": [],
            "model": DEFAULT_MODEL,
            "output_style": "Concise",
        }
    ]
    for name, payload in tool_uses:
        elements.append(
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Writing the verdict."},
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": name,
                            "input": payload,
                        },
                    ],
                },
            }
        )
        elements.append(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": "ok",
                        }
                    ],
                },
            }
        )
    elements.append(result)
    return json.dumps(elements)


# The workflow's review job states these; policy.py extracts them verbatim.
CI_BUDGET_MINUTES = (20, 25, 33)


def head_hook_settings(checkout="pytorch"):
    """This repository's workflow's hook settings, derived as materialize derives them."""
    return settings.derive_hook_settings(
        workflow_steps.hook_settings_text(HEAD_WORKFLOW, WORKFLOW_PATH),
        checkout,
        WORKFLOW_PATH,
    )


HEAD_RECORD_STEP = workflow_steps.record_step(HEAD_WORKFLOW, WORKFLOW_PATH)


def replay_policy(root=REPO_ROOT, **overrides):
    """A Policy pointing at this repository's real tree: hooks, record step, greenlight.

    Real paths rather than stubs: several tests assert against what those files actually
    contain, and the record checks and the detector run as this tree's own code, so a
    policy built out of placeholders would pass while the harness broke.
    """
    fields = {
        "root": root,
        "prompt_template": PROMPT_TEMPLATE,
        "max_diff_lines": 2000,
        "max_diff_bytes": 500_000,
        "max_diff_files": 200,
        "review_budget_minutes": CI_BUDGET_MINUTES,
        "timeout_s": 37 * 60,
        "too_large_verdict": {
            "status": "NO_LAND",
            "reason": "scope_too_large",
            "message": "- Scope\n  - The diff exceeds the size cap",
        },
        "no_policy_verdict": None,
        "sanitize_script": HOOKS_DIR / "sanitize-untrusted-checkout.sh",
        "hook_settings": head_hook_settings(),
        "output_style": "Concise",
        "model": "global.anthropic.claude-opus-5",
        "effort": "high",
        "tools": "Read,Glob,Grep,Write",
        "target": PYTORCH_TARGET,
        "record_step": HEAD_RECORD_STEP,
        "detector_script": REPO_ROOT / workflow_steps.DETECTOR_RELPATH,
        "detector_dirname": "pytorch",
    }
    fields.update(overrides)
    return Policy(**fields)


def build_arm_tree(
    root,
    *,
    extra_repos=(),
    policies=("pytorch.md",),
    target_step=True,
    workflow_document=None,
):
    """A policy tree laid out as this repository's is, in ``root``: greenlight's code
    and repos.yaml, the hooks, the review policies and the review workflow.

    ``extra_repos`` are configured in repos.yaml beside pytorch/pytorch, ``policies``
    are the review policy files present, and ``target_step`` False removes
    ``workflow_target.py`` and the subcommand that runs it.
    """
    root = Path(root)
    shutil.copytree(
        REPO_ROOT / arm_code.ARM_SRC_RELPATH,
        root / arm_code.ARM_SRC_RELPATH,
        ignore=shutil.ignore_patterns("__pycache__"),
        dirs_exist_ok=True,
    )
    repos_yaml = (REPO_ROOT / "greenlight/repos.yaml").read_text() + "".join(
        REPOS_YAML_ENTRY.format(repo=repo) for repo in extra_repos
    )
    (root / "greenlight/repos.yaml").write_text(repos_yaml)
    if not target_step:
        _drop_target_step(root)
    shutil.copytree(HOOKS_DIR, root / ".claude/hooks/greenlight", dirs_exist_ok=True)
    policies_dir = root / REPO_POLICIES_RELPATH
    policies_dir.mkdir(parents=True, exist_ok=True)
    for name in policies:
        (policies_dir / name).write_text(f"policy of {name}\n")
    workflow_path = root / workflow.WORKFLOW_RELPATH
    workflow_path.parent.mkdir(parents=True, exist_ok=True)
    workflow_path.write_text(
        yaml.safe_dump(workflow_document or HEAD_WORKFLOW, sort_keys=False)
    )
    return root


# What ``cli.py`` holds of the target subcommand, each replaced to remove it.
_TARGET_IN_CLI = (
    (", workflow_target\n", "\n"),
    ("    workflow_target.add_parser(subparsers)\n", ""),
    (
        '    if args.command == "target":\n        return workflow_target.run(args)\n',
        "",
    ),
)


def _drop_target_step(root):
    """Remove ``greenlight target`` from ``root``'s greenlight."""
    (root / arm_code.WORKFLOW_TARGET_RELPATH).unlink()
    cli = root / arm_code.ARM_SRC_RELPATH / "greenlight/cli.py"
    text = cli.read_text()
    for old, new in _TARGET_IN_CLI:
        if old not in text:
            raise AssertionError(f"greenlight/cli.py no longer holds {old!r}")
        text = text.replace(old, new)
    cli.write_text(text)
