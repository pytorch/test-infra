"""The dashboard's fixed text: population and signal names."""

POP_NAMES = {
    "gold": (
        "Reverted trunk breakages",
        "Landings later reverted for breaking a test on main that test selection could have caught (false green, signal on the PR, or passed on the PR); caught when a breaking test file is selected in one of the configs that failed at the landing, over that config's own test list.",
    ),
    "silver": (
        "New failures on main",
        "Landed single-commit changes after which a test file newly failed on main and kept failing (every shard of its config reported before; the failure repeated after); caught like the reverted breakages.",
    ),
    "pr_off": (
        "PR failures on TD-off jobs",
        "PR-specific test failures (no failure of the file on main within 48 hours), taken at the first macOS job where the file failed in the PR: TD does not cut macOS jobs, so every test could run there. It may follow an earlier failure on a TD-on job.",
    ),
}

SIGNAL_NAMES = {
    "fail": "Failure correlation, time-decayed",
    "coedit": "Co-edit PMI",
    "filepath": "File path keywords",
    "llm": "Qwen3 embedding score",
    "profiling": "Profiling coverage map",
    "edited": "Edited by the PR",
    "mentioned": "Mentioned in the PR",
    "prev_failed": "Previously failed in the PR",
    "public_bindings": "Public bindings",
    "fail_share": "Test's failure share on main (14 days)",
    "test_seconds": "Test time",
    "is_pr": "PR job vs landed change",
    "pr_stats": "PR stats (files, lines, areas)",
}
