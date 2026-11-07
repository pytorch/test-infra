"""The dashboard's fixed text: population and signal names, what is built, methods and
caveats. Numbers are filled in from results.json by dashboard_page."""

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

INVENTORY = [
    "TD sums nine heuristics with hand-set weights (a tenth, the class-failure correlation, runs in trial mode: logged, never used) and runs the top 25% of each job's test files on PRs; main runs everything.",
    "The LLM heuristic contributed nothing over the whole window: its retrieval job never uploaded results, so TD logged no LLM part.",
    "The Profiling heuristic reads a static coverage map that is not regenerated.",
    "The daily rating job failed on several days in October and every day from October 31 to November 5, so the rating files went stale; the time-decayed failure ratings and co-edit PMI (test-infra#9325) went live on 2026-11-06.",
    "On main pushes, PreviouslyFailedInPR merges the pytest cache of many earlier main pushes, so main-push rankings are not PR-like (in October up to about 700 of 720 tests scored 1; weekly medians 458, 16 and 9).",
    "The Qwen3-Embedding-0.6B heuristic (test-infra#9333) is merged in test-infra; turning it on in pytorch CI is a separate change.",
]

METHODS = [
    "Before is TD as it runs today. On PR jobs it is the ranking TD logged. On landed changes it is a replay of today's TD as a PR would see it: the rating files live at the time, the change's own diff, its PR's failures on earlier pushes, and no LLM part.",
    "After is the end state of the TD project: the time-decayed failure and co-edit ratings rebuilt for each day from the history before it; the Qwen3 score against that month's pytorch test corpus; the unchanged heuristics, test priors and PR stats; a gradient-boosted ensemble over them, Platt-scaled; a risk model on PR stats, file risk and author history that scales each change's budget (its cutoff between 15% and 35%, over the mean cutoff); and 5% of each budget spent on tests drawn below the cut.",
    "After ranks by expected failures per second of test time and stops at a test-time budget: T% of the change's test time times its risk multiplier (the green line, T from 5% to 100%), or the test time TD spends on that same change today times the multiplier (the headline). That is a design proposal, not part of any task yet: the project plans a cut by share of files.",
    "Cost is test time: a file's test-times.json seconds (summed test-case seconds) plus 15 seconds per file for process start, imports and collection, from a regression of PR job durations on their files' test time and count (12-24 seconds in these units). Every job also has 10-16 minutes of fixed time that no policy saves, so a share of test time is not a share of job time.",
    "Models are refit every week on an expanding window and score only the weeks after their data, with a 3-day gap so every training label has settled. Evaluation weeks start 2026-08-17.",
    "A test counts as a negative for training only where it ran: every test runs on main; on TD-off PR jobs, the tests found in that config's test results at that head.",
    "Reds kept off main, central estimate: the reverted false greens a policy catches beyond TD's replay under the same rule, times how often a breaking test that ran on its PR failed there (an assumption: measured on reds that landed), minus the PR failures TD catches today that the policy gives up, converted at the rate TD's PR misses became false greens. High estimate: false greens change in proportion to how a policy changes TD's misses on PR failures on TD-off jobs.",
]

CAVEATS = [
    "After is a simulation: the ratings are rebuilt, the LLM corpus is monthly, landed changes stand in for their PRs, and the per-file overhead is an estimate (the sensitivity table shows what other values change).",
    "PR failures on TD-off jobs still lean toward TD's own order: those jobs run tests in TD's order and stop at their first failing file, which flatters Before.",
    "PR bodies and linked issues were read at the end of the window, so After's MentionedInPR on PR jobs sees the final text (a small effect: the signal carries almost no weight).",
    "Reverted breakages are few (n on each chart), and a PR contributes several TD-off units: read every rate with its interval, and the PR-clustered intervals for the differences.",
    "TD-on PR failures are censored (only tests inside TD's cut ran): they enter only as the share of TD's PR catches a policy keeps, never as recall.",
    "The ensemble ranks well but its probabilities are not calibrated on landed changes (see calibration); the risk model separates breaking changes only weakly.",
    "False greens before 2026-09-12 are an upper bound: new tests could not be told from TD skips then.",
]
