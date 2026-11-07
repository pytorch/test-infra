"""The analysis's fixed choices: windows, cutoffs, budget bounds, label rules, caps.

TD's scope and its cut come from `torchci.td.llm`, which follows pytorch's run_test.py.
"""

from datetime import datetime

from torchci.td.llm.events_sql import (  # noqa: F401  (re-exported for the steps)
    SETTINGS as QUERY_SETTINGS,
    TD_WORKFLOW_PREFIXES,
    TD_WORKFLOWS,
)
from torchci.td.llm.replay import CUT_PERCENT  # noqa: F401


WINDOW_START = datetime(2026, 7, 15)
WINDOW_STOP = datetime(2026, 11, 7)
# Landed changes and new failures on main go back further than the PR and gold windows:
# their data (pushes, jobs, failed tests) is kept for over a year.
MAIN_START = datetime(2025, 11, 10)
# Failure history read before the main window, for the ratings a day early in it would
# have been generated from (the generators read 90 days).
HISTORY_START = datetime(2025, 8, 12)
# First Monday that gets out-of-sample predictions; every later week up to the stop too.
EVAL_START = datetime(2026, 8, 17)
# New failures on main are evaluated from this Monday, after 8 weeks of training data.
SILVER_EVAL_START = datetime(2026, 1, 5)
# Before this day pytorch's tests.all_test_runs_by_name cannot tell a new test from a
# TD skip, so gold false greens before it are an upper bound.
GOLD_EXACT_FROM = datetime(2026, 9, 12)

CUTOFFS = (5, 10, 15, 20, 25, 30, 35, 40, 50, 75, 100)
BUDGET_MIN, BUDGET_MAX = 15, 35
BUDGET_TARGETS = (20, 25)
EXPLORE_SHARE = 0.05

# Silver: a newly failing file must fail again within this many later pushes where its
# config reported; units with more newly failing files are evaluated, not trained on.
SILVER_CONFIRM_PUSHES = 3
SILVER_MAX_TRAIN_FILES = 50
# The prior of how often a test fails on main, by job completion time.
FAIL_SHARE_DAYS = 14
# Training stops this long before the week it predicts: silver looks 3 pushes ahead and
# the PR-specific rule looks 48 hours around a failure.
TRAIN_GAP_DAYS = 3
# PR failures that failed in at least this many jobs or heads count as confirmed.
CONFIRMED_MIN = 2

# Diff paths whose lines do not count as significant LOC.
NON_SIGNIFICANT_PREFIXES = ("test/", "docs/", "third_party/", ".github/")
NON_SIGNIFICANT_SUFFIXES = (".md", ".rst", ".txt", ".ipynb", ".expect")
# Path prefixes of the areas a PR can touch, for the PR-stats features.
AREAS = {
    "core_cpp": ("aten/", "c10/", "torch/csrc/"),
    "inductor": ("torch/_inductor/",),
    "dynamo": ("torch/_dynamo/",),
    "distributed": ("torch/distributed/",),
    "build": ("cmake/", "CMakeLists.txt", "setup.py", "pyproject.toml", "requirements"),
    "ci": (".github/", ".ci/"),
}

# A test file's cost is its test-times.json seconds plus this per-file overhead (process
# start, imports, collection). test-times.json sums test-case seconds over the ~3 test
# processes a job runs at once; a regression of PR job durations on their files' test time
# and file count gave 4-7 wall seconds per file, 12-24 seconds in those summed units.
FILE_OVERHEAD_SECONDS = 15.0

# Threads for model fitting and parallel scoring: the host also runs other services.
N_JOBS = 32
# A cache file holds data from public PRs; author logins are kept only as this keyed hash.
AUTHOR_HASH_BYTES = 8
