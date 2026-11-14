# LLM test selection for pytorch's target determination

`selector.py` asks Claude which of pytorch's test files a change can break and writes one
score per named file. pytorch's target determination (TD) reads the scores through its
`LLMSelection` heuristic, one input among TD's heuristics: TD's learned scorer
(`../scorer`) calibrates each heuristic's score into a failure probability and weighs
them. Nothing here decides alone what runs.

It complements the `LLM` heuristic (`../llm`), which ranks test files by embedding
similarity to the diff: this one reads the diff and reasons about what the changed code
reaches (the OpInfo suites for a kernel change, the CPython suites for a dynamo change).

## How it plugs into TD

- pytorch's `llm_td_selection.yml` runs on `pull_request_target` for pull requests from
  branches of pytorch/pytorch. It checks out pytorch main and this repository's main,
  fetches the pull request's base and head commits, runs `selector.py` and uploads
  `llm_selection.json` as the artifact `llm_selection_<PR>_<head sha>`.
- The TD job of every test workflow run looks for that artifact of its head commit and
  hands the file to `tools/testing/target_determination/heuristics/llm_selection.py`,
  which scores the files of `scores` that are in TD's test list (times 0.25, the most
  TD's other ranking heuristics add to its sum) and raises when there is no file. A
  raised heuristic counts as "did not run" in the scorer; a file left out of `scores`
  counts as scored 0.
- The heuristic starts in trial mode in pytorch: TD logs its scores and nothing reorders
  tests. The scorer's daily refit reports what it would add (`train.CANDIDATES`), and
  it enters the model when it moves to `train.HEURISTICS`.

## The selection file

```json
{"version": 1, "base_sha": "...", "head_sha": "...", "model": "...", "effort": "medium",
 "scores": {"test_nn": 1.0, "dynamo/test_misc": 0.5}, "run_all": false, "reason": "...",
 "unknown": [], "changed_files": 12, "cost_usd": 0.31}
```

`scores` maps names of pytorch's `TESTS` (paths under `test/`, no `.py`) to a score in
(0, 1]: 1.0, 0.75 and 0.25 for a file the model names with high, medium and low
confidence, 0.5 for the other files of a directory it names, and 0.125 for every other
file when it says no file can be ruled out (`run_all`). The scorer fits a monotone
calibration table on a year of logged scores, so only the order of these values matters,
and changing one mixes two scales in that year. `unknown` lists the names the model gave
that are not test files; they are dropped.

No file is written when the change has more than 1,000 changed files, or when the model
call or its answer fails (exit 1): there is then nothing to score.

## Threat model

The title, description and diff of a pull request are untrusted. The model reads them
inside tags the prompt marks as data, it has no tools, and its answer is checked against
a schema and can only name files of the trusted test list. So the worst a crafted pull
request can do is skew its own scores, which are one bounded input of a ranking that
always runs the test files the pull request edits. Nothing of the change is executed:
the selector runs from main and reads the change through git. The job needs the Bedrock
role and no other credential.

## Running locally

Needs the `claude` CLI on `PATH` with credentials for the model, and a pytorch checkout
whose working tree is trusted (its `tools/testing/discover_tests.py` is run):

```bash
cd tools
python -P -m torchci.td.llm_select.selector --pytorch ~/pytorch \
  --base origin/main --head HEAD --out /tmp/llm_selection.json
python -P -m torchci.td.llm_select.selector --pytorch ~/pytorch --out /dev/null \
  --print-prompt | less
```

A call takes 10 to 20 seconds with the default model and effort, and cost $0.10 on
average over 150 PR heads of one day. The test list is about 13,500 tokens and sits in
the system prompt, so the provider's prompt cache serves it to the calls that follow
within a few minutes; the diff is most of the rest.
