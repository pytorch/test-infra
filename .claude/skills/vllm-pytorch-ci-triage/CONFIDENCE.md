# Confidence Scales

## classification_confidence (per group)

| Score | Meaning |
|---|---|
| 5 | Exact match to a cheat-sheet entry |
| 4 | Strong pattern match (same exception class + framework frames) |
| 3 | Reasonable inference from exception pattern |
| 2 | Weak signal — exception is generic, routing based on context |
| 1 | Guessing — no clear pattern match |

## new_failure_confidence (per group)

| Score | Meaning |
|---|---|
| 5 | Clearly a regression signature with no known variant |
| 4 | Likely new — signature is distinctive |
| 3 | Plausible but could be a flake or known issue variant |
| 2 | Weak — generic exception that could appear in many contexts |
| 1 | Likely a variant of an existing known issue |

## shared_root_cause_confidence (per failure)

| Score | Meaning |
|---|---|
| 5 | Identical exception signature to the group's root cause |
| 4 | Same exception class + closely related message |
| 3 | Same exception class, different message but likely related |
| 2 | Different exception but plausibly the same underlying bug |
| 1 | Grouped only by job proximity, low certainty |
