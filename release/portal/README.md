# PyTorch Release Portal: config

The portal shows the state of a PyTorch release step by step. This directory defines the
steps. A scheduled collector workflow reads the resolved config, runs each step's check,
and appends what it finds to ClickHouse (`misc.release_event`,
`misc.release_artifact_observation`). HUD renders it. The portal is read-only: it never
changes the state of a step.

```
release/portal/config/
  steps.yml            the phases and steps every release shares
  releases/<ver>.yml   what changes for one release (dates, links, step changes)
```

The ClickHouse tables are in `clickhouse_db_schema/misc.release_event` and
`misc.release_artifact_observation`. The loader and validator are
`tools/torchci/release_portal_config.py`.

The config is read twice, and both read the files from this directory: the collector
resolves it with that module, and HUD fetches the files from GitHub (`main`) and merges
them in TypeScript with the same rules. A change merged here shows on HUD without a
deploy. A release's board is always drawn from the config as it is on `main`, so a step
removed from `steps.yml` later also disappears from the boards of past releases, unless
that release's own file adds it back.

## Check it

From `tools/`:

```sh
python3 -m torchci.release_portal_config                              # validate every file
python3 -m torchci.release_portal_config --release 2.16.0 --print     # the resolved config as JSON
python3 -m torchci.release_portal_config --release 2.16.0 --discover  # find its milestone and issues on GitHub
python3 -m pytest torchci/tests/test_release_portal_config.py
```

## steps.yml

```yaml
version: 1
phases:
  - {id: 2, name: RC build and validation}
steps:
  - id: "2.3"                    # "<phase>.<n>", unique, a string
    phase: 2
    name: Build RC binaries
    tier: A                      # how the work is done today: A, S, K or M (below)
    owner: release-manager       # a role
    rc_scoped: true              # optional. A separate state for each RC. Default false
    informational: true          # optional. Shown as information, not as work to do. Default false
    cancels_release: true        # optional, patch releases only (types: [patch]). Once done, the release is cancelled. Default false
    depends_on: ["2.1"]          # optional. Step ids
    due: {anchor: ga, offset_days: -3}   # optional. branch_cut, final_rc or ga
    runbook: {script: release/promote.sh}   # optional. One of script, skill, url
    check: {type: github_workflow_run, repo: pytorch/pytorch, workflow: pull.yml, ref: "{branch}"}
```

**Tier** is how the work is done today, and **check** is how the portal observes the
step. They are independent: a manual step can have an automatic check (a person tags the
release, the portal sees the tag), and a step the portal cannot observe uses
`manual_link`.

| Tier | The work is |
| --- | --- |
| A | automated |
| S | scripted: a person runs a script |
| K | skill-assisted: an agent skill does most of it |
| M | manual |

An **informational** step is on the board for the reader, not for the portal's counts: it is
shown as "info" instead of a state, it is not counted in the steps done or the total, it never
blocks, and it does not keep a phase or the release in progress. Use it for what release
engineering validates by itself, outside the portal.

A step with **cancels_release** ends a patch release that will not ship (step 1.15, the
dev-discuss post "No PyTorch X.Y.Z release"): once it is done, the index shows the release as
cancelled and not in flight, and its other steps no longer count. It needs `types: [patch]`; a
minor release is never cancelled this way. The post is found by the daily dev-discuss scan,
which only scans releases whose milestone is open, so close the milestone after that scan has
run (or run the "GitHub Analytics Daily" workflow by hand once the post is up).

### Check types

| Type | Parameters | The step is done when |
| --- | --- | --- |
| `manual_link` | `what_to_check`, `link` | never observed; the board shows what to check and where |
| `url_exists` | `url` | the URL answers 200 |
| `github_issue_state` | `repo`, `issue`, `expect` (`open` or `closed`) | the issue is in that state |
| `milestone_outstanding_items` | `repo`, `milestone`, `max_outstanding` | the milestone has at most `max_outstanding` outstanding items (below) |
| `milestone_prs_on_branch` | `repo`, `milestone` | every closed PR of the milestone that landed on main after the branch cut is on the release branch (below) |
| `reverts_missing_from_branch` | `repo`, `branch` | no revert on main is missing from the release branch (below) |
| `release_only_changes` | `repo`, `title_regex` | a pull request into the release branch whose title matches `title_regex` is merged (below) |
| `github_ref_exists` | `repos`, `ref`, `kind` (`branch` or `tag`) | the ref exists in every repo |
| `github_workflow_run` | `repo`, `workflow`, `ref` | the latest run on the ref succeeded |
| `index_listing` | `index` (`download.pytorch.org`, `pypi`, `dockerhub`), `channel` (`test`, `release`), `package_types` | every expected artifact is present; the detail is in the artifact matrix |
| `crcr_summary` | none | downstream CI results for the RC (phase 2 of the portal) |
| `nightly_binaries` | `repo`, `branch` | the wheel, libtorch and docker builds of the latest finished nightly of `repo` are green (below) |
| `viable_strict_lag` | `repo`, `branch`, `base`, `max_hours` | `branch` is less than `max_hours` hours behind `base` by the commit time of their heads (below) |
| `rc_binaries` | `repo` | the wheel, libtorch and docker builds of the newest release candidate tag of the release are green (below) |
| `triton_release_branch` | none | `triton-lang/triton` has the release branch `release/X.Y.x` of `versions.triton`, and the triton pin of pytorch is on it (below) |
| `pypi_release` | `package`, `version` | `version` of the package is on PyPI |
| `dev_discuss_post` | `title_regex` (one pattern, or one per release type), `carries_dates` (optional) | a post whose title matches exists in the Release Announcements category of dev-discuss (below) |

A new check type needs a collector implementation, an entry in `CHECK_TYPES` in the
validator, and a row here.

`milestone_outstanding_items` is checked all the time. Before the branch is cut, an
outstanding item is an open issue or PR in the milestone. After the cut, it is also a closed
issue whose fix landed on main after the cut but is not on the release branch (an
unpicked cherry-pick), as `--missing-in-branch` in `tools/analytics/github_analyze.py`
computes it. Issues labelled `release-feature-request`, and the issues that stay open until the release
is out (an `[RFC]`, the release tracker and the validation issue, found by their titles), are
not counted. It works for a patch release too: 2.15.1 and 2.16.0 each
have their own milestone, so both are checked at the same time.

Once the release is out (its `v<version>` tag exists) these steps are done whatever is left in
the milestone, and the evidence still lists the leftover items. The milestone of a shipped
release is often left open, so the daily job scans a shipped release of the latest release
lines until its milestone is closed, and the step does not stay at what the last scan before
the release found.

`milestone_prs_on_branch` reads the same scan of the milestone as `milestone_outstanding_items`,
and only looks at its pull requests: the step is done when none of the closed PRs landed on
main after the branch cut without being on the release branch (`not_on_release_branch`, which
lists them). The open issues of the milestone, such as an `[RFC]`, the release tracker and the
validation issue, are not looked at (they are listed in `details`); open PRs are left to
`milestone_outstanding_items`. Before the cut there is nothing to pick, so the step is to do,
and once the release is out it is done whatever is left, like the milestone step.

`dev_discuss_post` is checked by `tools/analytics/dev_discuss_scan.py`, the `dev-discuss-scan`
job of GitHub Analytics Daily, for every release in flight (an open milestone of the latest
release lines with no `v<version>` tag yet). The announcement steps are 1.13 key dates, 1.14
branch cut, 2.14 RC1, 3.10 final RC and 4.7 GA; each is to do until its post exists. The key
dates post (`carries_dates: true`) also holds the planned dates, read from its milestone table
(M3, M4 and M6 of a minor release; M3 and M4 of a patch release). The step is done only when
`dates` in the release file are the post's; otherwise it is in progress and the job fails,
printing the `dates` block to put in the file. A release in flight without a release file
fails the job too.

`release_only_changes` is checked by `tools/analytics/github_analyze.py --in-flight`, the `github-analyze` job
of GitHub Analytics Daily, once the release branch is cut (a release that has shipped is scanned
too, until its milestone is closed). The release-only changes PR is the one that changes the
workflows from `main` to the release branch, like pytorch/pytorch#199819 for 2.15; it is found by
its base (the release's branch) and its title (`title_regex`), and the step is done once it is
merged, and in progress until then (the evidence says whether the PR is open, closed unmerged, or
not there yet). `--release X.Y.Z --release-only-changes` runs the scan for one release, with
`--write-to-clickhouse` to record it.

`reverts_missing_from_branch` is only meaningful between the branch cut and the release, so
its step has a `window` (below). It finds the reverts on main that are not on the release
branch, as `--analyze-missing-reverts-from-branch` does, and the step is done unless one of
them is of a commit that was in a release candidate. Only those reverts, the ones to
cherry-pick, are listed in the recorded `details`; the others (already cherry-picked, or of a
commit the branch never had) are only counted by status.

`nightly_binaries` is checked by `tools/analytics/nightly_scan.py`, the `nightly-scan` job of GitHub
Analytics Daily, for every release in flight that is before its branch cut (`release/X.Y` does not
exist yet; after it the step is not written any more and its last result stands). It reads the
newest commit of the `nightly` branch, like the
[nightly HUD page](https://hud.pytorch.org/hud/pytorch/pytorch/nightly/1?per_page=50) shows it:
when its workflow runs have all finished, as they are; while some are still running (or being
re-run), a job of it that has already failed makes the step not green at once, and if nothing
has failed yet the result of the latest finished commit stands. A job that is re-run counts by
its latest attempt. A job
counts for its category: the jobs of the Build Official Docker Images workflow are docker, the jobs
named `libtorch-*` are libtorch, and the other jobs are wheel builds. The step is done when every
category has jobs and none of them failed, and blocked otherwise (the evidence says which
category failed, and `details` lists the failed jobs); it stays in progress only while the newest
runs are going and nothing has failed yet. The newest row of the step is what the board
shows, so each day's result replaces the earlier ones. Only pytorch is read, not the domain
libraries.

`viable_strict_lag` is checked by the same script. It reads the head commits of `branch`
(viable/strict) and `base` (main) of `repo` and takes the difference of their commit times: the
step is done when viable/strict is less than `max_hours` behind main, and blocked at `max_hours` or
more (`details` has `hours_behind`). viable/strict only advances when trunk CI is green, so a
branch that is far behind means a red trunk, and a release branch cut from it would not be
green. The check runs once a day with the rest of the scan, so it is the lag at that moment.

`rc_binaries` is checked by the same script, for every release in flight that has a release
candidate tag `v<version>-rc<N>` (it uses the newest), until the release tag exists. A tag push
starts the same binary workflows as the nightly, on the commit of the release branch the tag
points at, which is why
[the HUD page of the release branch](https://hud.pytorch.org/hud/pytorch/pytorch/release%2F2.15/1?per_page=50)
shows them. The runs read are those of the tag, from the workflows `generated-*binary*.yml` and
`docker-release.yml` (the other workflows a tag starts, like the manywheel docker image builds,
are not binary builds), and are judged as the nightly is: the step is done when the wheel,
libtorch and docker builds all ran and none failed, and blocked otherwise, so a red candidate
shows in red on the board. It is RC-scoped: the row is the newest candidate's, and a new candidate
starts the step again.

A **blocked** step is the red flag: the collector writes it with the blocking flag, the board
counts it in the blocking steps, shows the row in red and shows the release as blocked. A step
with `blocks_until_branch_cut: true` (needs `types: [minor]`; steps 1.4 and 1.5) stops being
flagged once the pytorch release branch exists (the step that checks the `{branch}` branch of
pytorch is done); its collector stops writing at the same moment, so after the cut the last
status stands, without the red.

`triton_release_branch` and `pypi_release` are checked by `tools/analytics/triton_scan.py`, the
`triton-scan` job of GitHub Analytics Daily, for every release in flight, from `versions.triton`
of its release file (a release without it leaves both steps to do and the job warns). The
branch is `release/<major>.<minor>.x` of the triton version (`release/3.9.x` for `3.9.0`). The pin
is `.ci/docker/ci_commit_pins/triton.txt` of pytorch's release branch, or of `main` before the
branch is cut; the step is done when the pin is on the triton release branch, and in progress
while the branch exists without it.

### Steps that apply only some of the time

- `types: [minor]` limits a step to minor releases (the default is both). A patch release
  has no branch cut, so those steps are left out of its resolved config, and any step that
  depended on them stops depending on them.
- `window: {opens: branch_cut, closes: ga}` limits when a step is live, by what can be
  observed: `branch_cut` is when the release branch exists, `ga` when the release tag
  `v<version>` exists. Either may be left out. Before it opens the step is to do and its
  check is not run; after it closes the step is done and its check is not run.

### Resources

`resources` in `steps.yml` lists the links a release's board shows besides its milestone,
tracker issue and validation issue: the wheels, libtorch, docs, release notes and build
matrix. A value is a URL, or `{test, release}` for one that moves when the release is out;
`{version}`, `{minor}` and `{branch}` are filled in.

### Template variables

Check parameters can use `{version}`, `{minor}`, `{branch}`, `{rc}`, `{tracker_issue}`,
`{validation_issue}`, `{milestone}`, `{tracker_issue_url}` and `{validation_issue_url}`.
The last four come from the release file. `{triton_version}` is `versions.triton`. Any other
`{name}` is an error.

## releases/&lt;version&gt;.yml

```yaml
release: "2.16.0"            # matches the file name; the only required field
dates: {branch_cut: 2026-11-30, final_rc: 2026-12-07, ga: 2026-12-17}   # planned, or null
versions: {triton: "3.9.0", torchvision: "0.30.0", torchaudio: null}    # what ships (below)
remove: []                   # shared step ids to drop
override: {}                 # step id -> fields to replace (null drops a field)
add: []                      # complete steps for this release only
# Optional, only to override what is derived or discovered:
# type: minor                # derived: X.Y.0 is minor, X.Y.Z is patch
# branch: release/2.16       # derived: release/X.Y
# links: {milestone: "2.16.0", tracker_issue: 123456, validation_issue: 123457}
```

The resolved config applies the file to `steps.yml` in this order: `remove`, then
`override`, then `add`. An override cannot change `id` or `phase`. The result is
validated as a whole, so removing a step another step depends on is an error.

### What is found on GitHub, and what is configured

A release file does not name the release's GitHub objects. The `discovery` block in
`steps.yml` finds them:

| Object | Rule |
| --- | --- |
| Milestone | the milestone in `pytorch/pytorch` titled exactly with the version, e.g. `2.16.0` |
| Tracker issue | an issue with the `release tracker` label titled `[v2.16.0] Release Tracker` (a dot after the `v` is accepted) |
| Validation issue | for a minor release, `Release 2.16 validations ...` or `Release 2.16.0 validations ...`; for a patch release, `Release 2.15.1 validations ...` |

The collector finds them for its own checks, and HUD finds them again when it draws a
release, from the same rules. If several issues match, the newest wins. If none matches, the link is empty and the steps
that need it show as to do, which is also how "tracker issue created" is observed. A
patch release does not pick up its minor release's validation issue. The rules were
checked against 2.9.0, 2.9.1, 2.12.1, 2.14.0, 2.14.1 and 2.15.0 and against 2.16.0, whose
milestone exists and whose tracker does not yet.

The planned **dates** are the one thing GitHub does not have: milestones carry no due
date. Actual dates come from the history of the branch and the tags. A link set in the
release file is used as is, for the case where a rule picks the wrong object.

### Versions

`versions` records what ships with the release besides pytorch itself:

```yaml
versions:
  triton: "3.9.0"        # required when `versions` is set
  torchvision: "0.29.2"  # a version, or null (or left out) when the release does not ship it
  torchaudio: "2.11.1"
```

The three versions are not derived from the pytorch version, and a release may ship
without torchvision or torchaudio, so they are written down. `versions` itself is
optional: a release whose versions are not decided yet leaves it out, and the resolved
config then has `null` for all three. Only these three names are allowed, and a version
is `X.Y.Z`. The resolved config and the release API carry them as `versions`. No step
uses them yet: today's checks for the domain libraries (1.9, 2.2) still look for
`release/{minor}` and `v{version}-{rc}` in torchvision and torchaudio, which do not exist
for a release whose libraries have their own version numbers.

## Changing the process

The steps are expected to change from release to release, and to shrink as steps are
automated. Change `steps.yml` in a pull request when the change should apply to every
future release, and a release file when it applies to one.
