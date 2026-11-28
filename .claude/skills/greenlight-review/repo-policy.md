# GreenLight review policy: pytorch/pytorch

This is the repository policy for pytorch/pytorch, read with the general policy in
`.claude/skills/greenlight-review/SKILL.md`. It is pytorch/pytorch's built-in repository
policy, served while pytorch/pytorch has no `.github/greenlight/review.md` of its own. It
defines the terms the general policy leaves to each repository and adds pytorch/pytorch's
hard stops and trivial change classes. Here the repository is pytorch/pytorch and its
checkout is `./pytorch`: where the general policy says "the repository's own" or "outside
the repository", read PyTorch's own and outside PyTorch. Every pull request you see here
comes from an approver listed in `pytorch/pytorch`'s merge rules.

## User-facing surface

Breaking the user-facing surface: removing, deprecating, or renaming something PyTorch
offers to outside code, or changing its signature, a default, a limit, or its documented
behavior; or changing the shape of output something parses. PyTorch offers outside code:

- the public Python API: a name whose import path, as users write it, has no part
  starting with an underscore, or that `docs/source` lists in an `autofunction`,
  `autoclass`, `automodule`, or `autosummary` entry;
- the C++ extension API: what `docs/cpp` and `docs/source/accelerator` document, the
  API in `torch/headeronly` and `torch/csrc/stable`, and the symbols libtorch exports;
- configuration users set, wherever it lives: config modules such as
  `torch._inductor.config`, and the environment variables PyTorch reads;
- formats users save, such as checkpoints.

Parsed output is runtime and test output (logs, reports, messages) that the repository
shows something matches, or that test-infra, the HUD, and Dr. CI read. A CI job's name
is parsed only through the workflow names `merge_rules.yaml` and
`update-viablestrict.yml` list; renaming a job otherwise moves its history and is not a
stop.
Everything else is internal and changing it is not a stop: private modules, internal
heuristics and their defaults, extension points under a private import path, and the
linkage of header-only code (hidden namespaces, visibility). What counts for the C++
API is what code written against it can name and call, and what libtorch exports.

## Merge-gating workflows

A workflow gates merges when it runs on every pull request, when the `requires` list of
`.github/workflows/update-viablestrict.yml` names it, or when such a workflow calls it.
`pull.yml` and `trunk.yml` gate PR merges and the progression of `viable/strict`.

## Lint gate

A lint gate that blocks the merge enforces formatting, line length, trailing whitespace,
and style, so the clearance **Mechanical formatting is already gated** gives under
**What to inspect** holds for pytorch/pytorch.

## Test layout

Test code is files under `test/`, and files under `torch/testing/_internal/` that only
test code imports. What decides which tests run or how their results are reported
(`test/run_test.py`, `conftest.py` files, `tools/testing/`, `run_tests` in
`common_utils`) is CI configuration, not test code.

## Hard stops

These add to **Never trivial** in the general policy. Numerics is pytorch/pytorch's own
stop; each other item names what the general item of that name covers here. Files named
here for one of the four items that stop on the path alone stop on the path alone too.

- Numerics: changes to the math — formulas, precision, dtypes, numerical tolerances (in
  code or in tests), and an accumulation order the algorithm specifies. Choosing among
  kernel configurations, tile or block sizes, autotuning candidates, or backends that
  implement the same math is performance tuning, not numerics, even when it changes
  rounding.
- Security, authentication, secrets, tokens, permissions, trust boundaries, and release or
  publish plumbing: the workflows that publish PyTorch's released artifacts are those
  publishing wheels, conda packages, docs, and release tags.
- CI privilege and merge gating: a test job added to `pull.yml` or `trunk.yml`.
  `pull.yml` and `trunk.yml` gate PR merges and the progression of `viable/strict`, so a
  new job's cost falls on every contributor, and whether it earns that — essential
  coverage, running reliably, no regression to overall workflow runtime — is not in the
  diff. A new top-level test job, or a `config:` value new to the `test-matrix` it lands
  in, is a new job; more shards of a config already there is a retune.
- Hiding CI failure: what a test or job blocks includes `viable/strict`, and the shapes
  include a job or configuration name gaining `unstable`, a workflow dropped from the
  `requires` list of `update-viablestrict.yml`, and an exit status ignored in
  `run_test.py`, a `conftest.py`, or `run_tests`.
- Moving a submodule or a commit pin of third-party code: the files under `ci_commit_pins/`
  are commit pins of third-party code.
- Text that reads as a comment but is consumed as configuration or code: a PEP 723
  `# /// script` header deciding what the `Lint` job installs.
- Executable documentation build configuration: `docs/source/conf.py` and its like is
  Python that sphinx runs in the docs job, beside a token written to `~/.netrc`.
- Merge authorization: `.github/scripts/trymerge.py`, `.github/scripts/tryrebase.py`,
  `.github/scripts/greenlight_*.py`, and the modules those scripts import from
  `.github/scripts/`.
- Code ownership: any `OWNERSHIP.yaml` file, the auto-pr-triage rosters
  (`.github/auto-pr-triage/extra_ownership_metadata.json` and `team_members.json` beside
  it), and the scripts that generate or check `CODEOWNERS` (`scripts/codeowners/`). The
  test-ownership header is a test file's `# Owner(s):` header.
- Edits at sites you have not checked: the definitions other tests are generated from
  include an OpInfo's or ModuleInfo's dtypes, devices, or samples, and the dtypes or
  devices a device-type test template is instantiated for.

## Trivial change classes

These add to **Trivial change classes** in the general policy.

### Meta-internal only

A change to code or build files that no OSS build, CI job, or wheel can observe, such as
code or a skip that takes effect only when `IS_FBCODE`, `IS_SANDCASTLE`, or `is_fbcode()`
holds, or a build file only Meta's build reads. Meta's own review covers it.
Documentation and instruction files are not code or build files, even where no OSS build
reads them.
`skip_but_pass_in_sandcastle` and its `_if` form skip in OSS, and the OSS CMake build
reads `build_variables.bzl`, so neither counts.
Not when the change edits a file one of the four path items of **Never trivial** names.

### Type annotations

An annotation added where there was none, or `Any` (including `Any | None` and a bare
generic such as `tuple`) replaced by a narrower type or by `object`; `object`, added or
substituted, counts only outside the public API. Deleting a checker suppression is the
same change and is in the class. Any other edit to an existing annotation is outside it,
even on a symbol nothing calls.
A private location clears none of the exclusions below: they are the routes by which an
annotation reaches behavior practitioners rely on.
The checker being quiet is evidence about the checker, not about the code.
Not when any of these hold, checked against the changed file and the symbol's callers:

- The diff widens a concrete annotation, removes one — an unannotated parameter defaults
  to `Tensor` under TorchScript — or silences the checker rather than informing it,
  whether by a suppression comment or a `cast`.
- The file is a stub.
- The diff adds an annotation to a name in a class body, where it may create a field.
- The symbol is a method of an `nn.Module`: scripting is invoked by callers this
  repository does not contain.
- Something reads the annotation at runtime and acts on its value — a custom op's
  schema, scripting, an overload, an argument validator, a config module, DataPipes, or
  tracing the annotated function. Merely recording it, as a plain dataclass field does,
  is not acting on it.
- The function already carries a `# type:` comment, which a real annotation replaces.
- Any other parameter of the same function remains unannotated, since annotating one
  retypes the rest. `self` and `cls` do not count as unannotated parameters.
