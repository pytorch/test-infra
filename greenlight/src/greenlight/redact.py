"""Scrub credential-shaped substrings out of untrusted, model-authored text.

The reviewer LLM writes a free-text ``message`` that greenlight persists to ClickHouse and
posts to a public GitHub PR comment. If the model ever echoes a checkout token, cloud key, or
other credential it saw, that secret would leak to both sinks. ``scrub_secrets`` replaces
credential-shaped runs with ``[REDACTED]`` at the single source point before the message fans
out to either sink.

This is best-effort defense-in-depth, not a guarantee: it favors precision over recall so
benign reviewer prose, file paths, and short commit hashes pass through untouched, accepting
that a novel or reshaped secret may slip past. Worst-case regex time is bounded from two sides:
the patterns are kept simple, and the input is truncated to ``_MAX_SCRUB_INPUT`` before any
pattern runs, so total work stays small even on adversarial input (no ReDoS).
"""

from __future__ import annotations

import re

__all__ = ["scrub_secrets"]

# The verdict message is a few sentences in practice; capping the input bounds worst-case regex
# time (the PEM block scan is not single-char-class-linear) on an adversarial message. Content past
# the cap is never published anyway: defang length-caps the comment and the row message is a debug
# field.
_MAX_SCRUB_INPUT = 20000

_REDACTED = "[REDACTED]"
# Keep a captured label/prefix, redact only the value that follows it.
_KEEP_LABEL = r"\g<1>" + _REDACTED

# Value charset for a token carried after a context label (x-access-token, Bearer): base64url plus
# the punctuation git/HTTP embed. Unbounded on purpose -- a single char class with no nested
# quantifier stays linear (no ReDoS), and any upper bound would leak the tail of a longer token.
_LABELED_VALUE = r"[A-Za-z0-9_.+/=~-]{8,}"

_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.DOTALL), _REDACTED),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"), _REDACTED),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,255}\b"), _REDACTED),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), _REDACTED),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,255}"), _REDACTED),
    (re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b"), _REDACTED),
    # AWS STS session token -- the strongest OIDC cred in the review job's env. Two complementary
    # routes: the distinctive base64 blob by prefix+length when it appears bare, and the labeled
    # NAME=value form (e.g. a /proc/self/environ dump) that keeps the label and redacts the value.
    (re.compile(r"\b(?:IQoJ|FwoG|FQoG)[A-Za-z0-9/+=]{100,}"), _REDACTED),
    (re.compile(r"(aws_session_token['\"]?\s*[:=]\s*['\"]?)([A-Za-z0-9/+=]{20,})", re.IGNORECASE), _KEEP_LABEL),
    (re.compile(r"(x-access-token:)" + _LABELED_VALUE, re.IGNORECASE), _KEEP_LABEL),
    (re.compile(r"(\bBearer )" + _LABELED_VALUE), _KEEP_LABEL),
    # Context-anchored: a bare 40-char base64 run collides with too much benign content (hashes,
    # ids), so the secret key is redacted only when the label names it.
    (re.compile(r"(aws_secret_access_key['\"]?\s*[:=]\s*['\"]?)([A-Za-z0-9/+]{40})", re.IGNORECASE), _KEEP_LABEL),
)


def scrub_secrets(text: str) -> str:
    """Return ``text`` with credential-shaped substrings replaced by ``[REDACTED]``.

    Surrounding text is preserved. A string that was entirely a secret collapses to the single
    token ``[REDACTED]`` (still non-empty). Input beyond ``_MAX_SCRUB_INPUT`` is truncated first.
    """
    text = text[:_MAX_SCRUB_INPUT]
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text
