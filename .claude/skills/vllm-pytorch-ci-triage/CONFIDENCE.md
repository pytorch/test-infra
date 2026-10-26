# Confidence Scales

## classification_confidence (per group)

| Level | Meaning |
|---|---|
| high |  Evidence directly identifies one route and rules out the alternatives, exact match to a cheat-sheet entry, or strong pattern match (same exception class + framework frames) |
| medium | Reasonable inference from the exception pattern |
| low | Weak or generic signal — routing based on context, or guessing with no clear pattern match |

### Silent hangs (no exception)

A hang identified only by its stopping point is `determined: true` with `classification_confidence` at most
`medium`: the log shows where it stopped, not which component is at fault. `new_failure_confidence` is `high`
when the baseline passes the job and the same stopping line appears in two or more clusters or builds, and
`medium` when it is a single job.

## new_failure_confidence (per group)

| Level | Meaning |
|---|---|
| high | Clearly a regression signature with no known variant; distinctive |
| medium | Plausible but could be a flake or a known-issue variant |
| low | Weak, generic exception, or likely a variant of an existing known issue |

## shared_root_cause_confidence (per failure)

| Level | Meaning |
|---|---|
| high | Identical exception signature to the group, or same exception class + closely related message |
| medium | Same exception class, different message but likely related |
| low | Different exception but plausibly the same bug, or grouped only by job proximity |
