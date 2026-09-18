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
import tempfile
import unittest
from pathlib import Path

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
REAL_SCHEMA = HOOKS_DIR / "verdict-schema.json"

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


def replay_policy(root, **overrides):
    """A Policy pointing at this repository's real hooks, schema and sanitize script.

    Real paths rather than stubs: several tests assert against what those files actually
    contain, so a policy built out of placeholders would pass while the harness broke.
    """
    fields = {
        "root": root,
        "prompt_template": PROMPT_TEMPLATE,
        "max_diff_lines": 2000,
        "max_diff_bytes": 500_000,
        "review_budget_minutes": CI_BUDGET_MINUTES,
        "too_large_verdict": {
            "status": "NO_LAND",
            "reason": "scope_too_large",
            "message": "- Scope\n  - The diff exceeds the size cap",
        },
        "schema_path": REAL_SCHEMA,
        "sanitize_script": HOOKS_DIR / "sanitize-untrusted-checkout.sh",
        "hooks_dir": HOOKS_DIR,
        "model": "global.anthropic.claude-opus-5",
        "effort": "high",
        "tools": "Read,Glob,Grep,Write",
    }
    fields.update(overrides)
    return Policy(**fields)
