# Confidence Scales

## classification_confidence (per group)

| Level | Meaning |
|---|---|
| high | Exact match to a cheat-sheet entry, or strong pattern match (same exception class + framework frames) |
| med | Reasonable inference from the exception pattern |
| low | Weak or generic signal — routing based on context, or guessing with no clear pattern match |

## new_failure_confidence (per group)

| Level | Meaning |
|---|---|
| high | Clearly a regression signature with no known variant; distinctive |
| med | Plausible but could be a flake or a known-issue variant |
| low | Weak, generic exception, or likely a variant of an existing known issue |

## shared_root_cause_confidence (per failure)

| Level | Meaning |
|---|---|
| high | Identical exception signature to the group, or same exception class + closely related message |
| med | Same exception class, different message but likely related |
| low | Different exception but plausibly the same bug, or grouped only by job proximity |
