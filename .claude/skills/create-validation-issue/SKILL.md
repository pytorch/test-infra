---
name: create-validation-issue
description: Generate a PyTorch release validation checklist issue by pulling open/closed issues from a GitHub milestone and cherry-picks from a release tracker issue. Triggered by mentions of "validation issue", "validation checklist", "release validation", or "release checklist".
---

# Create Validation Issue

Generates the markdown body for a PyTorch release validation checklist issue (like https://github.com/pytorch/pytorch/issues/172576) by aggregating data from a GitHub milestone and a cherry-picks release tracker issue.

## When to use this skill

Use when the user asks to:
- Create a validation issue or validation checklist for a PyTorch release
- Generate release validation content from a milestone
- Build a release checklist from milestone issues and cherry-picks

## Instructions

### Step 1: Determine parameters

Collect these parameters from the user. If not provided, ask.

| Parameter | Description | Example |
|-----------|-------------|---------|
| **Release version** | The PyTorch version being released | `2.11` |
| **Milestone number** | GitHub milestone number in pytorch/pytorch | `61` |
| **Cherry-picks issue** | GitHub issue number tracking cherry-picks | `175093` |

### Step 2: Fetch all milestone issues (open + closed)

Fetch ALL issues (both open and closed) from the milestone. Paginate through all pages since milestones can have 100+ items.

```bash
# Fetch open issues (paginate with page=1,2,3... until empty)
gh api --paginate 'repos/pytorch/pytorch/issues?milestone={MILESTONE}&state=open&per_page=100' \
  --jq '.[] | {number, title, html_url, labels: [.labels[].name], user: .user.login, is_pr: (.pull_request != null)}'

# Fetch closed issues (paginate similarly)
gh api --paginate 'repos/pytorch/pytorch/issues?milestone={MILESTONE}&state=closed&per_page=100' \
  --jq '.[] | {number, title, html_url, labels: [.labels[].name], user: .user.login, is_pr: (.pull_request != null)}'
```

If `gh` is not available or not authenticated, use WebFetch against the GitHub API with small page sizes (15-30) and multiple paginated requests to avoid truncation.

### Step 3: Fetch cherry-picks from the release tracker

Search for all PRs targeting the release branch to get the complete list of cherry-picks:

```bash
# Search for all PRs against the release branch
gh api --paginate 'search/issues?q=repo:pytorch/pytorch+is:pr+base:release/{VERSION}+sort:created-asc&per_page=50' \
  --jq '.items[] | {number, title, user: .user.login, state}'
```

Also fetch comments on the cherry-picks issue to cross-reference:

```bash
gh api --paginate 'repos/pytorch/pytorch/issues/{CHERRY_PICKS_ISSUE}/comments' \
  --jq '.[] | {user: .user.login, body: .body}'
```

### Step 4: Filter and classify issues

Apply these rules to each issue/PR:

1. **Skip [RFC] and [RFD] issues**: If the title starts with `[RFC]` or `[RFD]`, exclude it entirely
2. **Skip [release-only] items**: Exclude items with `[release-only]` or `[RELEASE X.XX]` in the title — these are internal release branch housekeeping
3. **Skip routine pin updates**: Exclude items like "Update vLLM pinned commit", "Update pinned commit" — these are routine version bumps with no validation signal
4. **Skip cherry-pick reverts**: Exclude cherry-pick PRs whose title matches `[cherry-pick] Revert "..."` — these are reverts of previously cherry-picked changes and don't need validation tracking (e.g., `[cherry-pick] Revert "[fix] DISABLED test_index ..."`, `[cherry-pick] Revert "[CI] Enable TIMM pretrained model caching ..."`)
5. **Skip the release tracker itself**: Do not include the release tracker issue
6. **Identify cherry-picks**: If the PR targets the release branch, or the title contains `[cherry-pick]`, prepend `[cherry-pick]` to the line
7. **Identify high priority**: If the issue has a label `high priority` or the title contains `[hi-pri]`, prepend `[hi-pri]` to the line
8. **Link issues to fixing PRs**: If a PR fixes an issue (check PR body for "Fixes #NNNNN" or "Closes #NNNNN"), combine them into a single line with the issue listed first, then the PR URL appended with ` | `
9. **Assign PR author**: Append `- @{author}` at the end of each line using the PR/issue author's GitHub username. **IMPORTANT: Never use bot accounts (`@pytorchbot`, `@Copilot`, `@facebook-github-bot`) as the author.** Cherry-pick PRs are typically created by `pytorchbot` but the real author is the person who wrote the original trunk PR. To find the real author:
   - Look at the cherry-pick PR's `head.ref` branch name which follows the pattern `cherry-pick-{ORIGINAL_PR_NUMBER}-by-...`
   - Fetch the original trunk PR and use its author
   - For `@Copilot`-authored PRs, use the assigned reviewer or maintainer

### Step 5: Format the output

Generate a markdown checklist organized into sections. The header should include a description, links to the milestone, release tracker, release branch, and HUD CI status.

**Section ordering (items placed in the FIRST matching section):**

1. **High Priority** — all `[hi-pri]` items AND all vLLM-related items (titles containing `vllm` or `vLLM`, labels containing `module: vllm`)
2. **ONNX** — items with `[ONNX]` in title, `module: onnx` label, or ONNX-related content (e.g., onnxscript, ONNX export)
3. **MPS** — items with `[MPS]` in title, `module: mps` label, or `release notes: mps` label
4. **ROCm** — items with `[ROCm]` in title, labels containing `rocm`
5. **XPU** — items with `[XPU]` or `[xpu]` in title, `module: xpu` label
6. **Milestone Issues** — remaining non-cherry-pick items from the milestone
7. **Cherry-picks** — remaining cherry-pick PRs not already placed in a category section above

**Header format:**
```markdown
# Release {VERSION} validations checklist and cherry-picks

This issue tracks validation items and cherry-picks for the PyTorch {VERSION} release.

Content is sourced from:
- [Milestone {VERSION}.0](https://github.com/pytorch/pytorch/milestone/{MILESTONE}) open and closed issues (excluding [RFC] issues)
- [Release Tracker #{CHERRY_PICKS_ISSUE}](https://github.com/pytorch/pytorch/issues/{CHERRY_PICKS_ISSUE}) cherry-picks to the [release/{VERSION}](https://github.com/pytorch/pytorch/tree/release/{VERSION}) branch

Release branch CI status: [HUD](https://hud.pytorch.org/hud/pytorch/pytorch/release%2F{VERSION})
```

**Item formatting rules:**
- Every item starts with `- [ ]` (unchecked checkbox)
- Prefixes appear in square brackets: `[cherry-pick]`, `[hi-pri]`
- Multiple prefixes are stacked: `[cherry-pick] [hi-pri]`
- Issue URL comes after the title
- If a PR fixes the issue, append PR URL with ` | `: `issue_url | pr_url`
- Author is appended with ` - @username`

**Example lines:**
```
- [ ] [hi-pri] [cuda 13.0 torch 2.10] [torch 2.11] umbrella issue - vLLM CI failures https://github.com/pytorch/pytorch/issues/175426 - @atalman
- [ ] [ONNX] Support complex initializers https://github.com/pytorch/pytorch/issues/170054 | https://github.com/pytorch/pytorch/pull/170231 - @justinchuby
- [ ] [cherry-pick] [MPS] Fix 2-pass SDPA memory corruption by forcing float accumulators https://github.com/pytorch/pytorch/pull/175580 - @hvaara
- [ ] [cherry-pick] [ROCm] forward fix #174087, take 4 https://github.com/pytorch/pytorch/pull/175159 - @jeffdaily
```

### Step 6: Output

Output the full markdown text to a file (e.g., `issue_tracker.txt`) so the user can review and copy it into a new GitHub issue. Do NOT create the issue automatically — just generate the text content.

## Example usage

**Example 1** — Generate for a specific release:
```
Create validation issue for PyTorch 2.11 using milestone 61 and cherry-picks from issue 175093
```

**Example 2** — Quick reference:
```
Generate release validation checklist for 2.11
```
Then the skill will ask for the milestone number and cherry-picks issue if not provided.

## Notes

- If `gh` CLI is not available or not authenticated, use WebFetch against `api.github.com` with small page sizes (15-30 per page) to avoid AI-summarization truncation
- Milestones can have hundreds of issues; always paginate
- Cherry-pick PRs may appear both in the milestone AND in the cherry-picks tracker — place them in the most specific category section (ONNX, MPS, ROCm, XPU) rather than the generic Cherry-picks section
- Some items may be both `[hi-pri]` and `[cherry-pick]` — show both prefixes
- The output is meant to be pasted into a GitHub issue body, so use GitHub-flavored markdown
