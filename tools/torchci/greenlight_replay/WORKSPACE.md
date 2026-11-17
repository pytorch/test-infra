# greenlight_replay workspaces

What a sweep keeps under `--workdir`, what each reviewer slot holds, and how the
reviewed repo's own policy reaches it. The rest of the tool is in
[README.md](README.md).

## Staging the repo's policy

The general policy reads one repository policy, the slot
`.claude/skills/greenlight-review/repo-policy.md`; in the policy tree it holds
pytorch/pytorch's built-in. A policy tree with
`.claude/hooks/greenlight/repo-policy.py` is replayed with the workflow's gates
around it, from the same script and with the same canned verdicts:

- **Staging, once per sweep.** The policy's `.claude` is copied to
  `<workdir>/<policy>/staged-policy/.claude` and the script's `stage` runs on it
  with the workflow's arguments: the repo, the trusted tree and that `.claude`.
  Every slot copies the staged tree. `staged=false` (anything but exactly
  `staged=true`) gives every pull request the tree's `no-policy-verdict.json`,
  and neither its diff nor anything else of it is read. A non-zero exit, which
  fails CI's job, stops the sweep.
- **The diff gate, per pull request**, only when staged: the diff alone is
  fetched and the script's `touches` run on it. Anything but exactly
  `touches=false` gives the tree's `greenlight-files-verdict.json`. Its metadata
  and stack context are never read, so a fault there cannot cost the verdict.
  Collect runs the diff gate too, and a row it declines is collected from its
  diff alone, so its context can never fail collection. Collect has no trusted
  tree and cannot know staging's outcome, so a row staging will decline still
  has its context read there.
- **The size gate** comes after both, as in the workflow, on the full inputs.

Both canned files come from the policy tree under test, beside
`too-large-verdict.json`, and are held to the tree's schema when it is loaded; a
tree with the script but without either file is refused. They are recorded like
the size gate's verdict, with the `too_large` outcome. A policy tree without the
script, a base arm from before it, copies its `.claude` into the slots as it is
and gates only on size.

The diff the gate judged is the one the row's inputs are built from: it is
fetched once and handed on, so the gate and the reviewer see one snapshot even
when the compare's answer changes between calls.

Production rows declined by any of the three gates carry their canned text and
are dropped from the frame under the `canned` funnel stage (`canned.py`).

## The trusted tree

`--trusted-ref`, a full 40-hex commit of `--repo`, pins the sparse checkout of
`.claude/skills` and `.github/greenlight` the sanitize step restores from and
the staging step reads; CI's plan job resolves pytorch/pytorch's main once and
passes it to every arm, so both stage from the same repo policy. Without it the
tree is the repo's main as fetched.

It stays a git checkout because the script reads the repo's policy from its git
objects, never through the filesystem. It is keyed by commit:
`<name>-trusted-<sha>` with `--trusted-ref`, `<name>-main-trusted` without; a
pinned tree is reused only when its cone, a clean status and HEAD all match, and
a tree at another commit is refused rather than reused.

## Scratch layout

```
<workdir>/pr-8830/policy/          the materialized policy tree
<workdir>/pr-8830/runs/<pr>/       diff, metadata, stack JSON and directory, settings, verdict
<workdir>/pr-8830/checkpoint.jsonl
<workdir>/pr-8830/<name>.git       bare clone of --repo, with the reviewer slots beside it
<workdir>/pr-8830/<name>-trusted-<sha>/  sparse checkout of it at --trusted-ref for the sanitize and staging steps
<workdir>/pr-8830/<name>-main-trusted/   the same at its main, without --trusted-ref
<workdir>/pr-8830/staged-policy/   the policy's .claude with the repo's policy staged, which every slot copies
```

Stack context lands in the run directory as `greenlight-stack.json`, with each
sibling's diff at `greenlight-stack/<n>.diff`. The JSON's `diff` fields keep CI's
`/tmp/greenlight-stack/<n>.diff` spelling, and the remap hook points the reviewer
at the run's copies: `/tmp/greenlight-stack.json` as it does the diff and the
metadata, and the `/tmp/greenlight-stack` directory matched on a path boundary, so
`/tmp/greenlight-stackX` is left alone. A path under the directory maps to the
same relative path under `<run_dir>/greenlight-stack`, and one whose `..` would
climb out of it is not rewritten at all; the read sandbox denies any `..`
regardless. Both are removed from a reused run directory before a pull request's
inputs are fetched, so an earlier sweep's stack never reaches a later review.

`run_review` holds the files to the remap before the model is invoked, so a
mismatch costs nothing. Besides the diff and the metadata sitting where the remap
points, it refuses a stack JSON anywhere but `<run_dir>/greenlight-stack.json`, a
`diff` entry the remap does not rewrite or that does not exist where it points,
and stack files left on disk when no stack was built. Each would otherwise be
silent: the reviewer would read a missing file, or an earlier sweep's stack, and
return a verdict that looks real.

The reviewer's workspace root is **a pool slot**, not the policy tree: a slot
holds the checkout at `pytorch` for pytorch/pytorch, or `target` for any other
repo, and a per-slot *copy* of the policy's `.claude` beside it, which is the
whole of what `restrict-read.py` will let it read.

`runs/` is a sibling of the slots rather than a child, and that is load-bearing.
Each run directory is passed to the reviewer as its own `--add-dir`, and
`--restricted` confines the file tools to those roots — which is what isolates
one concurrent run from another. Nest the run directories under a slot and adding
that slot would cover all of them at once. `restrict-read.py` is no help here: it
allows anything under the `/tmp/greenlight-` prefix, other pull requests' run
directories included.

That prefix is also why `--workdir` should stay under `/tmp/greenlight-*`, and the
sweep refuses a root that is not. Today this is defence in depth rather than
load-bearing: the PreToolUse hooks judge the *un-remapped* path, which is always
allowed, so reads succeed wherever the run directory lives. It keeps the design
correct against a CLI that chains `updatedInput` between hooks, where a run
directory outside the prefix would instead deny every read.
