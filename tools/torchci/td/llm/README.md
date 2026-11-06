# LLM heuristic for pytorch's target determination

This package scores pytorch's test files against the diff of a PR with a self-hosted
code-embedding model, for the `LLM` heuristic of pytorch's target determination (TD). It
holds the indexer and the retriever that pytorch's CI runs, and an evaluation harness that
picks the model and its settings and measures the change against TD's logged rankings.

## How it plugs into TD

pytorch runs two workflows that use this package:

- `target-determination-indexer.yml` (nightly): `index.py` embeds the test corpus of
  pytorch main and publishes a bundle to
  `s3://target-determinator-assets/indexes/v2/latest/bundle.tar`.
- `llm_td_retrieval.yml` (every PR): `retrieve.py` downloads the bundle, embeds the PR's
  diff and writes `mappings/indexer-files-gitdiff-output.json`, zipped as
  `mappings.zip` into the `llm_results` artifact.

The artifact is the contract with `tools/testing/target_determination/heuristics/llm.py`
in pytorch, which is unchanged: a JSON object mapping `<path under test/>.py` to a float.
`llm.py` keeps the keys in TD's test list, averages per file and scales the scores so the
largest is 0.25 (`normalize_ratings`, which raises on any score <= 0, so the retriever
writes finite scores > 0 only). An empty diff writes `{}`.

The modules: `models.py` (the model registry with committed file hashes, download and
loading), `corpus.py` (test units), `diff.py` (query chunks and base resolution),
`scoring.py` (file scores and the output transform), `bundle.py` (bundle format and
checks), `index.py` and `retrieve.py` (the CLIs), and the harness: `events.py`,
`metrics.py`, `replay.py`, `cache.py`, `pytorch_repo.py`, `report.py`, `evaluate.py`.

## Build an index and retrieve locally

Python 3.12. Install a CPU torch first, then the pinned requirements and this package:

```bash
pip install -r tools/torchci/td/llm/requirements-torch.txt \
  --index-url https://download.pytorch.org/whl/cpu
pip install -r tools/torchci/td/llm/requirements.txt
pip install -e tools/torchci
```

Index a pytorch checkout, check the bundle, and score the checkout's HEAD against main:

```bash
python -P -m torchci.td.llm.index --pytorch ~/pytorch --out bundle.tar --threads 16
python -P -m torchci.td.llm.bundle verify bundle.tar
python -P -m torchci.td.llm.retrieve --pytorch ~/pytorch --bundle bundle.tar \
  --out out/mappings/indexer-files-gitdiff-output.json
```

`retrieve.py` also takes `--pr-number`, `--base-ref`, `--base-sha` and `--github-ref`, as
the workflow passes them from the event.

## The bundle and its checks

One uncompressed tar: `meta.json` first (format version, model key and revision, query
prompt, token limit, row count, dimension, pytorch commit, creation time, and the sha256 of
every other member), `embeddings.npy` (float16, L2-normalized, one row per corpus unit),
`tests.json` (the test file of each row), and `model/` (exactly the files whose hashes and
sizes `models.py` commits for the model, plus `model/LICENSE`, the Apache-2.0 text of
`LICENSE-MODELS`).

The retriever reads the tar in one pass, accepts only regular members with expected names
under size caps, streams each into a fresh file while hashing it, and loads only those
files. It checks every hash against `meta.json`, the model files against the hashes and
sizes committed in `models.py`, the `.npy` header before loading it (no pickle), and dtype,
shape and finiteness. The query prompt and token limit come from the registry. The model
loads offline with sentence-transformers >= 6, `trust_remote_code=False` and safetensors.

## Threat model

The member hashes in `meta.json` catch a download torn by a concurrent nightly upload; they
do not stop a forger. Whoever can write the bucket can publish a consistent bundle and so
steer the LLM part of every PR's ranking. They cannot run code: the weights must match the
hashes committed here, and nothing is unpickled or imported from the bundle. The damage is
bounded: `llm.py` caps the LLM part at 0.25 of a test's score, and TD cuts tests only on
PRs, never on main. The TD counter-indicators on HUD (the rank of failing tests on PR jobs
and the CI time saved) are the detector.

The retrieval job must hold no credentials beyond a read-only `GITHUB_TOKEN`: the
download is anonymous, and only the indexer's upload job, which installs nothing and runs
no code from this package, can assume the bucket role.

## Operations

- **Restore the previous bundle.** The upload job writes each bundle to `latest` with a
  `bundle-sha256` object metadata entry, the sha256 of the bundle it checked. Before an
  upload it copies the current `latest` to `indexes/v2/previous/bundle.tar` only when that
  object carries such an entry, so only a bundle this job published becomes `previous`. To
  roll back, someone with write access to the bucket downloads `previous`, runs
  `python -P -m torchci.td.llm.bundle verify` on it, and copies it over
  `indexes/v2/latest/bundle.tar`.
- **The shipped configuration** is `models.DEFAULT_MODEL`, `index.CORPUS_WITH_FUNCTIONS`,
  `scoring.AGGREGATION` and `scoring.TRANSFORM`.
- **Format bumps and model changes.** The retriever accepts any registry model with
  committed hashes, so changing the default model breaks nothing until the next nightly.
  After a change of `bundle.FORMAT_VERSION`, or of a model's committed hashes, dispatch the
  indexer workflow at once: until it runs, the retriever rejects the published bundle and
  every PR runs without the LLM part.

## The diff base

The retriever diffs HEAD against the same base as TD's `get_merge_base`: the PR number
comes from the `pull_request` event or a `ciflow/<label>/<N>` tag ref; the PR's base ref
and sha from the event, else from the GitHub API; the base is the merge base with the
first of `origin/<base ref>` and the base sha that git resolves, else with `origin/main`.
With no PR (pushes to main, schedules) it is the merge base with `origin/main`, or `HEAD^`
on main itself. Where it differs from TD, it diffs against main instead:

- TD then asks GitHub's compare API; this does not. That step matters for a ciflow-tag
  push of a ghstack PR restacked after the tag, and for a release-branch PR whose base sha
  is not in the checkout (CI checks out only the PR's head and main).
- A base ref or sha from the event that is not a valid git ref is ignored, with a warning.

## The evaluation harness

The harness answers which model, corpus, aggregation and query instruction give the best
signal for their cost, and shows what the LLM part does inside TD's current sum. The replay
adds the new part to each logged TD score, as `llm.py` would weigh it, and subtracts
nothing. That is valid only for rankings
logged while no LLM part reached TD: the old retriever's artifact upload had failed for
months, and no v2 bundle existed before `replay.NO_LLM_PART_BEFORE`. A ranking logged after
the first v2 bundle holds the shipped LLM part, which the replay would have to subtract,
so `run` leaves every ranking logged from that day on out of the replay (an E1 main-push
ranking by its own time, an E2 failure by its day). Once the first v2 bundle ships, set
`replay.NO_LLM_PART_BEFORE` to its day before replaying any later events.

### Events

`evaluate fetch` reads HUD ClickHouse once, read-only, and writes a snapshot, because the
TD rank metric (`td_test_failure_stats_v2`) keeps only 90 days:

- **E1, trunk breakages**: the saved `td_trunk_breakages` query, in windows of at most 90
  days, with the logged main-push rankings of each landing for its breaking files.
  Standalone metrics diff `landing~stack_size..landing`; the replay diffs
  `landing^..landing`, what TD's main-push ranking saw.
- **E2, PR failures**: per (PR, test file), the first failing job's ranking, from PR runs:
  `pull_request` runs and ciflow-tag runs (the metric records no PR number for those; it
  comes from the tag). A failure counts only if the file did not fail on main
  (`head_branch = 'main'`) within 48 hours. The base is the PR's base sha: from the run
  itself for `pull_request` runs, and for ciflow-tag runs from a `pull_request` run at the
  same head sha (so a ghstack PR diffs only its own change, as in production). Only when
  neither exists does it fall back to `default.merge_bases` (the merge base with main); the
  report counts events by base source.

E2 uses the 48-hour main rule rather than the merge-base rule of `td/utils.filter_tests`
because most merge bases have no CI run of their own, so that rule cannot tell whether a
failure predates the PR; a failure of the same file on main around the same time can.

The candidates for standalone ranks are TD's `TESTS`, computed by each corpus snapshot's own
`tools/testing/discover_tests.py` (run with an empty C++ test directory), so the blocklists
and extra tests of that commit apply. One corpus snapshot per calendar month: main's last
commit before the month starts.

### Decision rules

Applied in order on the selection slice (events up to 2026-09-30); the primary metric is
per-PR recall at 25% on the E2 failures the PR's diff does not edit, with paired bootstrap
intervals (seed 0, 10,000 resamples) over PRs:

1. corpus (on Qwen3-Embedding-0.6B): `skeleton` unless `skeleton+functions` is superior
   (the interval's lower bound > 0), not worse on E1, and within rule 4's gates;
2. aggregation: `max` unless `mean` is superior by the same rule;
3. query instruction: with, unless without is superior;
4. model, from the registry's smallest by committed size: a bigger model replaces the
   incumbent only if it is superior, not worse on E1, and ahead on the confirmation slice
   too; the pick must be within the gates (estimated per-PR job <= 330 s, bundle <= 12 GB
   for the upload runner's 14 GB disk, nightly build <= 90 min on 16 vCPUs).

The report names the picked configuration. The replay inside TD's aggregate is reported
per transform, for information, and picks nothing: E1 caught, logged against replayed,
with McNemar (single-commit landings get their own line); the E2 kept rate; and the cut's
estimated test time. Where TD cut a job's tests, a test outside the cut never ran, so
those E2 failures lie mostly inside the logged cut and can show losses but hardly any
gains. The E2 TD-off columns count the failures whose first failing job had no cut
(`replay.cut_applied`: macOS, XPU and ONNX jobs; in practice macOS), where every test
ran, and `scoring.TRANSFORM` was chosen on them. They are still biased against the cut:
an event is classified by its first failing job, and a failure inside the cut usually
fails first on a TD-on job, so the inside-cut failures that also failed on a TD-off job
count as TD-on. Jobs with TD off for reasons no row shows (a PR's `ci-no-td` label,
`force-no-td` jobs, workflows passing `tests-to-include`, empty TD results) count as cut.

### Running it

The harness needs the packages above plus `Pillow` and `torchvision` (sentence-transformers
6.2 imports them to load EmbeddingGemma-2, even for text) and torchci's own
`requirements.txt` (for `fetch`):

```bash
pip install -r tools/torchci/requirements.txt
pip install --no-deps pillow==13.0.0 torchvision==0.29.1 \
  --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple
```

A bare clone of pytorch serves the diffs and corpus snapshots. The harness writes to it only
to fetch missing commits by sha, and never moves a ref or HEAD:

```bash
git clone --bare https://github.com/pytorch/pytorch.git "$PYTORCH_GIT"
```

Snapshot the events (read-only HUD ClickHouse credentials in `CLICKHOUSE_ENDPOINT`,
`CLICKHOUSE_USERNAME` and `CLICKHOUSE_PASSWORD`):

```bash
python -m torchci.td.llm.evaluate fetch --start 2026-07-13 --stop 2026-11-05 \
  --cache-dir "$CACHE"
```

`run` reads only that snapshot and needs no ClickHouse credentials. It fetches each model
once into `$CACHE/models/<key>` (a directory already holding exactly the model's committed
files is verified and used as it is). Run it detached, under a memory cap:

```bash
systemd-run --user --unit=td-llm-harness -p MemoryMax=64G -p Nice=10 \
  --setenv=HF_HOME="$HF_HOME" --setenv=TOKENIZERS_PARALLELISM=false \
  "$VENV/bin/python" -m torchci.td.llm.evaluate run --pytorch-git "$PYTORCH_GIT" \
  --cache-dir "$CACHE" --models qwen3-0.6b,gemma2,qwen3-4b,qwen3-8b \
  --out "$OUT/report.md" --procs 2 --threads 16
journalctl --user -u td-llm-harness -f
```

Then, on Qwen3-Embedding-0.6B, the alternatives the first rules compare:

```bash
... run ... --models qwen3-0.6b --with-functions
... run ... --models qwen3-0.6b --no-instruction    # plus --with-functions if rule 1 picked it
```

If rule 1 or 3 picks functions or no instruction, rerun all models with those flags so rule
4 compares them on the winning settings. Each run scores both aggregations and every
transform, adds its results under `$CACHE/results/all/configs/`, measures the cost of each
model and corpus once (`costs.py`: a bundle built from the latest snapshot, ten real PR
diffs retrieved end to end in their own processes at 16 threads, peak RSS, corpus tokens
per second), and rewrites the report (`report.md` and `report.json`) from every result
stored so far.

`--procs` embedding processes of `--threads` threads each run per model; size them to the
memory cap (an 8B model takes about 16 GB per process). Embeddings are cached by model,
revision, kind, prompt, token limit and text, written as each shard of 256 texts completes,
so a rerun resumes where it stopped. Only one harness process may use a cache directory at
a time. `--sample-prs N --seed S` scores a sample of E2 PRs (for smoke runs) and keeps its
results apart, under `$CACHE/results/sample-N-seed-S/`, and its report says it compares
models on a sample.
