---
name: release-create-tracker-issue
description: Generate (and optionally open) a PyTorch release tracker / cherry-pick tracking issue from a release announcement, like https://github.com/pytorch/pytorch/issues/180506. Triggered by mentions of "release tracker", "release tracking issue", "cherry-pick tracker", or "cut a release branch issue".
---

# Create Release Tracker Issue

Generates the body for a PyTorch **release tracker** issue (the cherry-pick tracking issue cut alongside a release branch, like https://github.com/pytorch/pytorch/issues/180506) from a release announcement that contains the milestone (key dates) schedule, then opens the issue in `pytorch/pytorch`.

## When to use this skill

Use when the user asks to:
- Create a release tracker / release tracking issue for a PyTorch release
- Create the cherry-pick tracking issue for a newly cut release branch
- Turn a "PyTorch release X.Y key dates" announcement into a tracker issue

## Instructions

### Step 1: Determine parameters

Collect these parameters. Most can be derived; ask only for what is missing.

| Parameter | Description | Example | How to obtain |
|-----------|-------------|---------|---------------|
| **Release announcement** | URL or pasted text of the "key dates" post | `https://dev-discuss.pytorch.org/t/pytorch-release-2-13-key-dates/3390` | From the user |
| **Release version** | Full version being released | `2.13.0` | From the user or announcement title |
| **Branch version** | `MAJOR.MINOR` of the release branch | `2.13` | Derived from release version (drop the patch) |
| **Previous minor** | The most recent prior minor release | `2.12` | Branch minor minus 1 (e.g. `2.13` → `2.12`) |
| **Release managers** | GitHub handles with cherry-pick dispensation | `@atalman, @malfet` | Default `@atalman, @malfet` unless told otherwise |

### Step 2: Extract milestone dates from the announcement

If given a **URL**, fetch it (the dev-discuss forum is not a GitHub URL, so use WebFetch, not `gh`):

```
WebFetch(url=<announcement_url>, prompt="Extract the M3 (release branch cut), M4 (release branch finalized / feature classifications), M4.1 (tutorial drafts submission deadline), M5 (external-facing content finalized), and M6 (release day) dates verbatim, preserving any 'week of' prefix.")
```

If given pasted **text**, parse the dates directly from it.

Map the announcement milestones to the tracker fields. Keep the date format **exactly** as written in the announcement (e.g. `DD/MM/YY`, and keep a `week of` prefix if present):

| Tracker field | Source milestone |
|---------------|------------------|
| `M3_DATE` | M3 — Release branch cut |
| `M4_DATE` | M4 — Release branch finalized / feature classifications published |
| `M4_1_DATE` | M4.1 — Tutorial drafts submission deadline |
| `M5_DATE` | M5 — External-Facing Content Finalized |
| `M6_DATE` | M6 — Release Day |
| `PHASE_CUTOFF` | **The M4 date.** If M4 is written as `week of 22/6/26`, use the bare date `22/6/26` for the phase cutoff. |

If a milestone is missing from the announcement, ask the user rather than guessing.

### Step 3: Generate the issue body

Fill the template below. Replace every `{PLACEHOLDER}`:
- `{VERSION}` → full release version (e.g. `2.13.0`)
- `{BRANCH}` → branch version (e.g. `2.13`)
- `{PREV_MINOR}` → previous minor (e.g. `2.12`)
- `{PHASE_CUTOFF}`, `{M3_DATE}`, `{M4_DATE}`, `{M4_1_DATE}`, `{M5_DATE}`, `{M6_DATE}` → dates from Step 2
- `{RELEASE_MANAGERS}` → e.g. `@atalman, @malfet`

````markdown
We cut a [release branch](https://github.com/pytorch/pytorch/tree/release/{BRANCH}) for the {VERSION} release.

Our plan from this point is roughly:

* Phase 1 (until {PHASE_CUTOFF}): work on finalizing the release branch
* Phase 2 (after {PHASE_CUTOFF}): perform extended integration/stability/performance testing based on Release Candidate builds.

This issue is for tracking cherry-picks to the release branch.

## Release dates

* M3: Release branch cut ({M3_DATE})
* M4: Release branch finalized, Announce final launch date, Feature classifications published ({M4_DATE}) - Final RC is produced.
* M4.1: Tutorial drafts submission deadline ({M4_1_DATE})
* M5: External-Facing Content Finalized ({M5_DATE})
* M6: Release Day ({M6_DATE})

## Cherry-Pick Criteria

**Phase 1 (until {PHASE_CUTOFF}):**

Only low-risk changes may be cherry-picked from main:

1. Fixes to regressions against the most recent minor release (e.g. {PREV_MINOR}.x for this release; see [module: regression issue list](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22module%3A+regression%22+))
2. Critical fixes for: [silent correctness](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+correctness+%28silent%29%22), [backwards compatibility](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+bc-breaking%22+), [crashes](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+crash%22+), [deadlocks](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+deadlock%22+), (large) [memory leaks](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+memory+usage%22+)
3. Critical fixes to new features introduced in the most recent minor release (e.g. {PREV_MINOR}.x for this release)
4. Test/CI fixes
5. Documentation improvements
6. Compilation fixes or ifdefs required for different versions of the compilers or third-party libraries
7. Release branch specific changes (e.g. change version identifiers)

Any other change requires special dispensation from the release managers (currently {RELEASE_MANAGERS} ). If this applies to your change please write "Special Dispensation" in the "Criteria Category:" template below and explain.

**Phase 2 (after {PHASE_CUTOFF}):**

Note that changes here require us to rebuild a Release Candidate and restart extended testing (likely delaying the release). Therefore, the only accepted changes are **Release-blocking** critical fixes for: [silent correctness](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+correctness+%28silent%29%22), [backwards compatibility](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+bc-breaking%22+), [crashes](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+crash%22+), [deadlocks](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+deadlock%22+), (large) [memory leaks](https://github.com/pytorch/pytorch/issues?q=is%3Aissue+is%3Aopen+label%3A%22topic%3A+memory+usage%22+)

Changes will likely require a discussion with the larger release team over VC or Slack.

## Cherry-Pick Process

1. Ensure your PR has landed in master. This does not apply for release-branch specific changes (see Phase 1 criteria).
2. Create (but do not land) a PR against the [release branch](https://github.com/pytorch/pytorch/tree/release/{BRANCH}).
   <details>

    ```bash
    # Find the hash of the commit you want to cherry pick
    # (for example, abcdef12345)
    git log

    git fetch origin release/{BRANCH}
    git checkout release/{BRANCH}
    git cherry-pick -x abcdef12345

    # Submit a PR based against 'release/{BRANCH}' either:
    # via the GitHub UI
    git push my-fork

    # via the GitHub CLI
    gh pr create --base release/{BRANCH}
    ```

    You can also use the `@pytorchbot cherry-pick` command to cherry-pick your PR. To do this, just add a comment in your merged PR. For example:

    ```
    @pytorchbot cherry-pick --onto release/{BRANCH} -c docs
    ```
    (`-c docs` - is the category of your changes - adjust accordingly):

    For more information, see [pytorchbot cherry-pick docs](https://github.com/pytorch/pytorch/wiki/Bot-commands#cherry-pick).

    </details>

3. Make a request below with the following format:

```
Link to landed trunk PR (if applicable):
* 

Link to release branch PR:
* 

Criteria Category:
* 
```

1. Someone from the release team will reply with approved / denied or ask for more information.
2. If approved, someone from the release team will merge your PR once the tests pass. **Do not land the release branch PR yourself.**

**NOTE: Our normal tools (ghstack / ghimport, etc.) do not work on the release branch.**

Please note HUD Link with branch CI status and link to the HUD to be provided here.
[HUD](https://hud.pytorch.org/hud/pytorch/pytorch/release%2F{BRANCH})

cc @seemethere @malfet @pytorch/pytorch-dev-infra 

### Versions

{VERSION}
````

### Step 4: Review, then create the issue

1. Show the rendered body to the user for confirmation. Creating a GitHub issue is an outward-facing action — do not create it until the user approves the content (or has clearly asked you to open it directly).
2. Create the issue in `pytorch/pytorch` with the exact title and labels:
   - **Title:** `[v.{VERSION}] Release Tracker` (note the `v.` prefix — e.g. `[v.2.13.0] Release Tracker`)
   - **Labels:** `release tracker`, `triaged`

```bash
gh issue create \
  --repo pytorch/pytorch \
  --title "[v.{VERSION}] Release Tracker" \
  --label "release tracker" \
  --label "triaged" \
  --body-file release_tracker_body.md
```

If `gh` is unavailable, POST to `https://api.github.com/repos/pytorch/pytorch/issues` with `{"title": ..., "labels": ["release tracker", "triaged"], "body": ...}` using an authenticated token.

3. Report the new issue URL back to the user.

## Example usage

**Example** — Create the 2.13.0 tracker from the key-dates announcement:
```
Create a release tracker issue for 2.13.0 from https://dev-discuss.pytorch.org/t/pytorch-release-2-13-key-dates/3390
```

For that announcement the milestones resolve to:

| Field | Value |
|-------|-------|
| M3 (branch cut) | week of 8/6/26 |
| M4 (finalized) | week of 22/6/26 |
| M4.1 (tutorial drafts) | 30/6/26 |
| M5 (content finalized) | 1/7/26 |
| M6 (release day) | 8/7/26 |
| Phase cutoff | 22/6/26 |
| Previous minor | 2.12 |

Producing title `[v.2.13.0] Release Tracker` with labels `release tracker`, `triaged`.

## Notes

- **Phase cutoff = the M4 date.** Both the "Phase 1 (until …)" / "Phase 2 (after …)" lines and the "Phase 1/2" cherry-pick criteria headers use the bare M4 date (strip a `week of` prefix for the cutoff, even though the M4 line in the Release dates section keeps it).
- Preserve the announcement's date format verbatim (`DD/MM/YY`). Do not reformat or convert dates.
- The `release tracker` label must already exist in the repo (it does in `pytorch/pytorch`). If creating in a repo without it, create the label first or drop it.
- Keep the trailing `cc @seemethere @malfet @pytorch/pytorch-dev-infra` line unless the user specifies different reviewers.
- The release managers handles default to `@atalman, @malfet`; update only if the user names different managers.
