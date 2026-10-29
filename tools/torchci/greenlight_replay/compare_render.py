"""The markdown of the base-versus-PR replay comparison.

``compare`` validates what it reads and ``compare_stats`` counts it; this module
and ``compare_tables`` only lay the result out. What keeps the comment safe to
post is therefore stated once, over there: every value either module prints is a
number, a fixed string, a commit SHA or the run URL ``compare`` validated, a run
label it sanitized, or a field of a ``Row``, which holds nothing that failed
validation. Nothing is escaped because nothing that could need escaping reaches
these modules.

GitHub rejects a comment longer than 65536 characters. The full comment is tried
first. Past ``MAX_CHARS`` every pull request table is capped and points at the
workflow run's CSV artifacts, and only if that is still too long is the text
cut, with a note saying so.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from torchci.greenlight_replay.compare_stats import (
    Arm,
    Comparison,
    CONFIDENCE,
    FAILED,
    INVALID_REASON,
    LAND,
    MIN_VERDICTS,
    NO_LAND,
    Pr,
    Proportion,
)
from torchci.greenlight_replay.compare_tables import (
    BASE,
    CHANGE,
    Column,
    count_table,
    details,
    EXCLUDED_COLUMNS,
    FLIP_COLUMNS,
    markdown_table,
    MISSING,
    pr_table,
    run_health,
    UNSTABLE_BASE_COLUMNS,
    UNSTABLE_CHANGE_COLUMNS,
)
from torchci.greenlight_replay.verdict_cells import HARNESS_REASON_PREFIX


MAX_CHARS = 65000
CAPPED_ROWS = 25

ARROW = "→"

TRUNCATION_NOTE = (
    f"\n\n*Cut at {MAX_CHARS} characters to fit in a GitHub comment; the replay "
    "CSV artifacts of the workflow run hold everything.*\n"
)
_CLOSE_DETAILS = "\n\n</details>"

HOW_TO_READ = f"""\
- **Sample.** The harness's replay frame: landed PRs whose original GreenLight \
verdict is recoverable, size-gate declines excluded. It is not every PR GreenLight \
reviewed. The PR count above is every PR seen in any run of either arm.
- **Outcomes.** Each run gives each PR one outcome: `{LAND}`, `{NO_LAND}`, \
`{FAILED}` (a row with no policy verdict, reason `{HARNESS_REASON_PREFIX}<outcome>`), \
or `{MISSING}` (no row: the PR never reached the reviewer, or the run produced nothing).
- **Harness failures** come from the harness, never from the policy, and are left \
out of every verdict statistic. A row whose reason starts with \
`{HARNESS_REASON_PREFIX}` is one even when it carries {LAND} or {NO_LAND}.
- **Verdicts and LAND rate** count every row of the arm's runs: LAND rate = \
{LAND} / ({LAND} + {NO_LAND}).
- **Inconsistent input.** A PR whose recorded head SHA differs between any two of \
its rows, in either arm, is left out of the PR-level statistics and the comparison.
- **Per PR and arm.** With at least {MIN_VERDICTS} verdicts a PR is assessable: \
unanimous if they all agree, split (unstable) if not. Its majority is the verdict \
held by more than half of them; a tie has none. Unstable rate = split / assessable.
- **Flip rate (run to run)** is the share of pairs of one arm's runs that disagree on \
a PR, pooled over its PRs: the sum of {LAND} × {NO_LAND} over the sum of n(n-1)/2, \
n being a PR's verdict count. It estimates the reviewer's own noise under that policy.
- **Comparable** PRs are assessable in both arms. True flip: unanimous in both \
arms, with different verdicts. Non-true flip: not a true flip, but both majorities \
exist and differ. Stable: unanimous in both arms, same verdict. Anything else is \
unstable without a flip. **Flip rate, base {ARROW} this PR** = (true + non-true \
flips) / comparable. A direction runs from the base majority to this PR's majority.
- **Newly unstable**: comparable PRs split under this PR and unanimous under base. \
Newly stable is the reverse.
- **Majority LAND rate**: comparable PRs whose majority is {LAND}, over the \
comparable PRs that have a majority in that arm.
- **Intervals.** Each percentage comes with its {CONFIDENCE:.0%} Wilson score \
interval (CI), whose sample size counts PRs, never runs: the runs of one PR are not \
independent. The LAND rate and the run-to-run flip rate pool rows and pairs of runs, \
so their intervals count the PRs that contribute to them, shown as "over k PRs". \
Such a PR's own rate lies between 0 and 1, so its variance is at most p(1-p), p being \
the rate, as for one yes-or-no outcome: counting each PR once gives an interval at \
least as wide as needed when the PRs contribute equally many rows or pairs, and close \
to it otherwise. Overlapping intervals do not show that the arms are the same: both \
arms reviewed the same PRs, and the flips compare them PR by PR.
- **Reason codes** count the reason of every verdict; `{INVALID_REASON}` marks a \
reason that is not a well-formed reason code.
- **Attribution.** Each arm uses its policy commit's skill, verdict schema, hooks and \
`greenlight-pr-review.yml` prompt and settings; the CLI version and context window are \
the replay workflow's. Both arms ran the same harness and backend at the same time on \
the same PRs, so a difference between them is this PR's change plus run-to-run noise. \
The two flip rates have different bases and are not comparable with each other."""


def render(
    comparison: Comparison, *, base_sha: str, head_sha: str, run_url: str
) -> str:
    """The comment, at most ``MAX_CHARS`` characters long."""
    text = _document(comparison, base_sha, head_sha, run_url, cap=None)
    if len(text) > MAX_CHARS:
        text = _document(comparison, base_sha, head_sha, run_url, cap=CAPPED_ROWS)
    if len(text) > MAX_CHARS:
        text = _cut(text)
    return text


def _document(
    c: Comparison, base_sha: str, head_sha: str, run_url: str, cap: int | None
) -> str:
    sections = [_header(c, base_sha, head_sha, run_url)]
    if not (c.base.runs_with_rows or c.change.runs_with_rows):
        sections += [
            "No replay run produced results, so there is nothing to compare.",
            run_health(c),
        ]
        return "\n\n".join(sections) + "\n"

    def table(prs: Sequence[Pr], columns: Sequence[Column]) -> str:
        return pr_table(prs, columns, cap, run_url)

    sections += [
        _summary(c),
        _flips(c),
        "### True flips",
        table(c.true_flips, FLIP_COLUMNS),
        "### Non-true flips",
        table(c.non_true_flips, FLIP_COLUMNS),
        details(
            f"PRs unstable under this PR's policy ({len(c.unstable_change)})",
            table(c.unstable_change, UNSTABLE_CHANGE_COLUMNS),
        ),
        details(
            f"PRs unstable under the base policy ({len(c.unstable_base)})",
            table(c.unstable_base, UNSTABLE_BASE_COLUMNS),
        ),
        details(
            f"Excluded PRs ({len(c.excluded)})", table(c.excluded, EXCLUDED_COLUMNS)
        ),
        "### Reason codes",
        count_table(
            "Reason",
            c.base.reasons(failed=False),
            c.change.reasons(failed=False),
            delta=True,
        ),
        run_health(c),
        details("How to read this", HOW_TO_READ),
    ]
    return "\n\n".join(sections) + "\n"


def _header(c: Comparison, base_sha: str, head_sha: str, run_url: str) -> str:
    base = f"under the base policy (`{base_sha[:12]}`, the merge base)"
    head = f"under this PR's policy (`{head_sha[:12]}`)"
    unit = "time" if c.prs else "run"
    kb, kc = [_plural(len(arm.runs), unit) for arm in (c.base, c.change)]
    prs = _plural(len(c.prs), f"historical {c.repo} PR" if c.repo else "historical PR")
    what = (
        f"Re-reviewed {prs} {kb} {base} and {kc} {head}, on Bedrock."
        if c.prs
        else f"None of the {kb} {base} or the {kc} {head} produced results."
    )
    title = "## GreenLight policy replay: base vs this PR"
    return f"{title}\n\n{what} [Workflow run]({run_url})."


def _verdicts(arm: Arm) -> str:
    land, no_land = arm.total(LAND), arm.total(NO_LAND)
    return f"{land} / {no_land} (LAND rate {_rate(arm.land_rate)})"


def _split(arm: Arm) -> str:
    return f"{arm.split} of {arm.assessable} assessable ({_rate(arm.unstable_rate)})"


SUMMARY_ROWS: tuple[tuple[str, Callable[[Arm], str]], ...] = (
    ("Runs with results / runs", lambda a: f"{a.runs_with_rows} / {len(a.runs)}"),
    (f"Verdicts: {LAND} / {NO_LAND}", _verdicts),
    ("Harness failures", lambda a: str(a.total(FAILED))),
    ("Missing (never reached the reviewer)", lambda a: str(a.missing)),
    (f"PRs unanimous {LAND}", lambda a: str(a.unanimous(LAND))),
    (f"PRs unanimous {NO_LAND}", lambda a: str(a.unanimous(NO_LAND))),
    ("PRs split (unstable)", _split),
    (f"PRs with fewer than {MIN_VERDICTS} verdicts", lambda a: str(a.insufficient)),
    ("Flip rate (run to run)", lambda a: _share(a.disagreement, "pairs of runs")),
    (
        "Majority LAND rate, comparable PRs with a majority",
        lambda a: _share(a.majority_land),
    ),
)


def _summary(c: Comparison) -> str:
    rows = [[label, cell(c.base), cell(c.change)] for label, cell in SUMMARY_ROWS]
    return "### Summary\n\n" + markdown_table(["", BASE, CHANGE], rows)


def _flips(c: Comparison) -> str:
    comparable = len(c.comparable)
    if not comparable:
        short = [
            name
            for name, arm in ((BASE, c.base), (CHANGE, c.change))
            if len(arm.runs) < MIN_VERDICTS
        ]
        why = (
            f"{' and '.join(short)} had fewer than {MIN_VERDICTS} runs, so no PR can "
            f"reach {MIN_VERDICTS} verdicts there"
            if short
            else f"no PR with consistent input has at least {MIN_VERDICTS} verdicts "
            "in both arms"
        )
        return f"### Flips\n\nNothing is comparable: {why}. See Excluded PRs below."
    true, non_true = c.true_flips, c.non_true_flips
    bullets = [
        f"Comparable PRs (consistent input, at least {MIN_VERDICTS} verdicts in both "
        f"arms): {comparable}, of which {len(c.stable)} stable and "
        f"{len(c.unstable_unflipped)} unstable without a flip",
        f"Flip rate, base {ARROW} this PR: {_share(c.share([*true, *non_true]))}",
        f"True flips: {_share(c.share(true))}; {_directions(c, true)}",
        f"Non-true flips: {_share(c.share(non_true))}; {_directions(c, non_true)}",
        "Newly unstable (split under this PR, unanimous under base): "
        f"{len(c.newly_unstable)}",
        "Newly stable (split under base, unanimous under this PR): "
        f"{len(c.newly_stable)}",
    ]
    return "### Flips\n\n" + "\n".join(f"- {bullet}" for bullet in bullets)


def _directions(c: Comparison, prs: Sequence[Pr]) -> str:
    return ", ".join(
        f"{start} {ARROW} {end} {count}"
        for (start, end), count in c.directions(prs).items()
    )


def _cut(text: str) -> str:
    """Cut at a line boundary, closing an open <details> so the note shows."""
    limit = MAX_CHARS - len(TRUNCATION_NOTE) - len(_CLOSE_DETAILS)
    end = text.rfind("\n", 0, limit)
    kept = text[: end if end > 0 else limit]
    if kept.count("<details>") > kept.count("</details>"):
        kept += _CLOSE_DETAILS
    return kept + TRUNCATION_NOTE


def _percent(fraction: float) -> str:
    """The fraction in percent, to one decimal, without the % sign."""
    return f"{100 * fraction:.1f}"


def _rate(share: Proportion) -> str:
    """The percentage and its interval, and how many PRs a pooled rate rests on."""
    interval = share.interval
    if interval is None:
        return "n/a"
    low, high = interval
    prs = "" if share.prs is None else f" over {_plural(share.prs, 'PR')}"
    return (
        f"{_percent(share.part / share.whole)}%, {CONFIDENCE:.0%} CI "
        f"{_percent(low)}–{_percent(high)}%{prs}"
    )


def _share(share: Proportion, noun: str = "") -> str:
    if share.interval is None:
        return "n/a"
    return f"{share.part} of {share.whole}{' ' + noun if noun else ''} ({_rate(share)})"


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" + ("" if count == 1 else "s")
