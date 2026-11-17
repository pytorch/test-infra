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

### Check types

| Type | Parameters | The step is done when |
| --- | --- | --- |
| `manual_link` | `what_to_check`, `link` | never observed; the board shows what to check and where |
| `url_exists` | `url` | the URL answers 200 |
| `github_issue_state` | `repo`, `issue`, `expect` (`open` or `closed`) | the issue is in that state |
| `milestone_outstanding_items` | `repo`, `milestone`, `max_outstanding` | the milestone has at most `max_outstanding` outstanding items (below) |
| `reverts_missing_from_branch` | `repo`, `branch` | no revert on main is missing from the release branch (below) |
| `github_ref_exists` | `repos`, `ref`, `kind` (`branch` or `tag`) | the ref exists in every repo |
| `github_workflow_run` | `repo`, `workflow`, `ref` | the latest run on the ref succeeded |
| `index_listing` | `index` (`download.pytorch.org`, `pypi`, `dockerhub`), `channel` (`test`, `release`), `package_types` | every expected artifact is present; the detail is in the artifact matrix |
| `crcr_summary` | none | downstream CI results for the RC (phase 2 of the portal) |
| `nightly_binaries` | `repo`, `branch` | the wheel, libtorch and docker builds of the latest finished nightly of `repo` are green (below) |
| `triton_release_branch` | none | `triton-lang/triton` has the release branch `release/X.Y.x` of `versions.triton`, and the triton pin of pytorch is on it (below) |
| `pypi_release` | `package`, `version` | `version` of the package is on PyPI |
| `dev_discuss_post` | `title_regex` (one pattern, or one per release type), `carries_dates` (optional) | a post whose title matches exists in the Release Announcements category of dev-discuss (below) |

A new check type needs a collector implementation, an entry in `CHECK_TYPES` in the
validator, and a row here.

`milestone_outstanding_items` is checked all the time. Before the branch is cut, an
outstanding item is an open issue or PR in the milestone. After the cut, it is also a closed
issue whose fix landed on main after the cut but is not on the release branch (an
unpicked cherry-pick), as `--missing-in-branch` in `tools/analytics/github_analyze.py`
computes it. Issues labelled `release-feature-request` and the release's own tracker and
validation issues are not counted. It works for a patch release too: 2.15.1 and 2.16.0 each
have their own milestone, so both are checked at the same time.

Once the release is out (its `v<version>` tag exists) these steps are done whatever is left in
the milestone, and the evidence still lists the leftover items. The milestone of a shipped
release is often left open, so the daily job scans a shipped release of the latest release
lines until its milestone is closed, and the step does not stay at what the last scan before
the release found.

`dev_discuss_post` is checked by `tools/analytics/dev_discuss_scan.py`, the `dev-discuss-scan`
job of GitHub Analytics Daily, for every release in flight (an open milestone of the latest
release lines with no `v<version>` tag yet). The announcement steps are 1.13 key dates, 1.14
branch cut, 2.14 RC1, 3.10 final RC and 4.7 GA; each is to do until its post exists. The key
dates post (`carries_dates: true`) also holds the planned dates, read from its milestone table
(M3, M4 and M6 of a minor release; M3 and M4 of a patch release). The step is done only when
`dates` in the release file are the post's; otherwise it is in progress and the job fails,
printing the `dates` block to put in the file. A release in flight without a release file
fails the job too.

`reverts_missing_from_branch` is only meaningful between the branch cut and the release, so
its step has a `window` (below). It finds the reverts on main that are not on the release
branch, as `--analyze-missing-reverts-from-branch` does, and the step is done unless one of
them is of a commit that was in a release candidate. Only those reverts, the ones to
cherry-pick, are listed in the recorded `details`; the others (already cherry-picked, or of a
commit the branch never had) are only counted by status.

`nightly_binaries` is checked by `tools/analytics/nightly_scan.py`, the `nightly-scan` job of GitHub
Analytics Daily, for every release in flight that is before its branch cut (`release/X.Y` does not
exist yet; after it the step is not written any more and its last result stands). It reads the
newest commit of the `nightly` branch whose workflow runs have all finished, like the
[nightly HUD page](https://hud.pytorch.org/hud/pytorch/pytorch/nightly/1?per_page=50) shows it. A job
counts for its category: the jobs of the Build Official Docker Images workflow are docker, the jobs
named `libtorch-*` are libtorch, and the other jobs are wheel builds. The step is done when every
category has jobs and none of them failed, and in progress otherwise (the evidence says which
category failed, and `details` lists the failed jobs). The newest row of the step is what the board
shows, so each day's result replaces the earlier ones. Only pytorch is read, not the domain
libraries.

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
