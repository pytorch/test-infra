"""Scrub credential-shaped substrings out of untrusted, model-authored text.

The reviewer LLM writes a free-text ``message`` that greenlight persists to ClickHouse and
posts to a public GitHub PR comment. If the model ever echoes a checkout token, cloud key, or
other credential it saw, that secret would leak to both sinks. ``scrub_secrets`` replaces
credential-shaped runs with ``[REDACTED]`` at the single source point before the message fans
out to either sink.

Nothing leaves this module unscanned. Text past ``_MAX_SCRUB_INPUT`` is dropped rather than left
unread, and the cut retreats to a whitespace boundary -- the one cut point that cannot fall inside
a credential value -- so the run it would otherwise sever is redacted whole. A message with no
whitespace to retreat to keeps its run minus any credential-shaped tail. A private key block
running to the end of the text without its END marker is swept too, whether the cut severed it or
it arrived that way. Every character a sink can publish has therefore been offered to every pattern.

Coverage within that scanned text is best-effort defense-in-depth, not a guarantee: it favors
precision over recall so benign reviewer prose, file paths, and short commit hashes pass through
untouched, accepting that a novel or reshaped secret may slip past. Worst-case regex time is
bounded from two sides: the patterns are kept simple, and the input is truncated to
``_MAX_SCRUB_INPUT`` before any pattern runs, so total work stays small even on adversarial
input (no ReDoS).
"""

from __future__ import annotations

import re

__all__ = ["scrub_secrets"]

# The verdict message is a few sentences in practice; capping the input bounds worst-case regex
# time (the PEM block scan is not single-char-class-linear) on an adversarial message. It governs
# which source characters survive, not the result's length -- substituting [REDACTED] for a shorter
# severed run can push the result a marker-width past the cap. Nothing here depends on a byte
# ceiling: defang re-caps the comment independently.
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

# A cut at _MAX_SCRUB_INPUT can land mid-credential, and the surviving head is by construction too
# short for the pattern that would have caught it -- every shape above is length-gated. A PEM block
# is the one shape spanning newlines, so it survives a tail-run cut and needs its own sweep: once
# the paired pattern has consumed the complete blocks, a leftover BEGIN marker has no END inside
# the cut text, meaning its key body runs off the end. Having cut is the evidence, so this one
# demands no particular body shape -- what survives the cut is often too short to look like a key.
_SEVERED_KEY_BLOCK = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?s:.*)\Z")

# The cut is not the only thing that severs a key block. The model's own output limit can emit one
# already unterminated, and text landing exactly on the cap is never cut at all, so an unterminated
# block has to be swept whether or not truncation happened. Absent a cut to serve as evidence, this
# one requires a key-shaped body: either an unbroken base64 run, or two wrapped base64 lines. Prose
# naming the marker has neither, its words being short and space-separated. Each branch pins base64
# chars against a disjoint separator class, leaving nothing to backtrack over.
_UNTERMINATED_KEY_BLOCK = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----\s*"
    r"(?:[A-Za-z0-9/+=]{40}|(?:[A-Za-z0-9/+=]{16,}[\r\n]+[ \t]*){2})"
    r"(?s:.*)\Z"
)


# Distinctive openers of the credential values above, for the one case the whitespace retreat
# cannot serve: a message carrying no whitespace at all, where retreating would erase everything.
# The run is kept and cut at its opener instead. A length threshold could not stand in here -- the
# JWT shape gates on structure, not length, so a head severed before its second dot stays
# unmatchable no matter how much of it survives. Bearer is absent by construction: its label
# carries a space, so a run reached only when there is no whitespace cannot contain it.
_SEVERED_HEAD = re.compile(
    r"(?:gh[pousr]_|github_pat_|eyJ|xox[baprs]-|IQoJ|FwoG|FQoG"
    r"|AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA"
    r"|(?i:x-access-token|aws_session_token|aws_secret_access_key))\S*\Z"
)


def _truncate(text: str) -> tuple[str, bool]:
    """Cut ``text`` to ``_MAX_SCRUB_INPUT``, redacting any run the cut severs.

    Returns the cut text and whether truncation happened. The value portion of every non-PEM shape
    is whitespace-free, so a whitespace boundary is the one cut point that cannot fall inside a
    value: retreating to the last one and redacting the remainder removes a severed credential
    whole. A cut already landing on such a boundary severs nothing and is kept verbatim. Where the
    message holds no whitespace to retreat to, the run is kept -- erasing it would leave a verdict
    with no justification -- and only a credential-shaped tail is dropped. Swapping in
    ``[REDACTED]`` can leave the result a marker-width longer than the cap; the cap governs which
    source characters survive, not the length of what comes back.
    """
    if len(text) <= _MAX_SCRUB_INPUT:
        return text, False
    kept = text[:_MAX_SCRUB_INPUT]
    if text[_MAX_SCRUB_INPUT].isspace() or kept[-1].isspace():
        return kept, True
    start = len(kept)
    while start > 0 and not kept[start - 1].isspace():
        start -= 1
    if start > 0:
        return kept[:start] + _REDACTED, True
    return _SEVERED_HEAD.sub("", kept) + _REDACTED, True


def scrub_secrets(text: str) -> str:
    """Return ``text`` with credential-shaped substrings replaced by ``[REDACTED]``.

    Surrounding text is preserved. A string that was entirely a secret collapses to the single
    token ``[REDACTED]`` (still non-empty), but a merely over-long one never does -- the cut keeps
    everything up to the whitespace it retreats to, and the whole run when there is none. No text
    from beyond
    ``_MAX_SCRUB_INPUT`` reaches the result, and every character that does was offered to every
    pattern -- offered, not matched: what the patterns recognise stays best-effort.
    """
    text, truncated = _truncate(text)
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    if truncated:
        text = _SEVERED_KEY_BLOCK.sub(_REDACTED, text)
    return _UNTERMINATED_KEY_BLOCK.sub(_REDACTED, text)
