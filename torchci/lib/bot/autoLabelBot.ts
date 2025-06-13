import assert from "assert";
import { minimatch } from "minimatch";
import { Context, Probot } from "probot";
import {
  addLabels,
  CachedIssueTracker,
  CachedLabelerConfigTracker,
  getFilesChangedByPr,
  hasApprovedPullRuns,
  hasWritePermissions,
  isPyTorchPyTorch,
  LabelToLabelConfigTracker,
} from "./utils";

// List of regex patterns for assigning labels to both Pull Requests and Issues
const IssueAndPRRegexToLabel: [RegExp, string][] = [
  [/rocm/gi, "module: rocm"],
  [/vulkan/gi, "module: vulkan"],
];

// List of regex patterns for assigning labels to Pull Requests
const PrTitleRegexToLabel: [RegExp, string][] = [
  [/reland/gi, "ci-no-td"],
  [/revert/gi, "ci-no-td"],
  [/rocm/gi, "ciflow/rocm"],
  ...IssueAndPRRegexToLabel,
];

// List of regex patterns for assigning labels to Issues
const IssueTitleRegexToLabel: [RegExp, string][] = [
  [/UNSTABLE\s+.*\s+\/\s+.*/g, "unstable"],
  [/UNSTABLE\s+.*\s+\/\s+.*/g, "module: ci"],
  [/DISABLED\s+test.*\(.*\)/g, "skipped"],
  ...IssueAndPRRegexToLabel,
];

const filenameRegexToReleaseCategory: [RegExp, string][] = [
  // dataloader_frontend
  [/torch\/utils\/data/gi, "release notes: dataloader"],
  [/test_data(loader|pipe)/gi, "release notes: dataloader"],
  // distributed + its flavors
  [/c10d/gi, "release notes: distributed (c10d)"],
  [/distributed.*sharded/gi, "release notes: distributed (sharded)"],
  [/distributed.*ddp/gi, "release notes: distributed (ddp)"],
  [/distributed.*pipeline/gi, "release notes: distributed (pipeline)"],
  [/distributed.*fsdp/gi, "release notes: distributed (fsdp)"],
  [/distributed.*rpc/gi, "release notes: distributed (rpc)"],
  [/distributed.*elastic/gi, "release notes: distributed (torchelastic)"],
  // export
  [/torch\/export/gi, "release notes: export"],
  [/torch\/_export/gi, "release notes: export"],
  // vulkan
  [/vulkan/gi, "release notes: vulkan"],
  // foreach_frontend
  [/foreach/gi, "release notes: foreach_frontend"],
  // onnx
  [/onnx/gi, "release notes: onnx"],
  // fx
  [/torch\/fx/gi, "release notes: fx"],
  [/test_fx/gi, "release notes: fx"],
  // ao
  [/(torch|test)\/ao/gi, "release notes: AO frontend"],
  // quantization
  [/(torch|test)\/quantization/gi, "release notes: quantization"],
  [/aten\/src\/ATen\/native\/quantized/gi, "release notes: quantization"],
  [/torch\/nn\/quantiz(ed|able)/gi, "release notes: quantization"],
  // mobile
  [/torch\/csrc\/jit\/mobile/gi, "release notes: mobile"],
  [/aten\/src\/ATen\/native\/metal/gi, "release notes: mobile"],
  [/aten\/src\/ATen\/native\/mps/gi, "release notes: mps"],
  [/aten\/src\/ATen\/mps/gi, "release notes: mps"],
  [/test\/mobile/gi, "release notes: mobile"],
  [/torch\/backends\/_nnapi\//gi, "release notes: mobile"],
  [/test\/test_nnapi.py/gi, "release notes: mobile"],
  // linalg_frontend
  [
    /aten\/src\/ATen\/native\/LinearAlgebra.cpp/gi,
    "release notes: linalg_frontend",
  ],
  [/test\/test_linalg.py/gi, "release notes: linalg_frontend"],
  [/torch\/linalg/gi, "release notes: linalg_frontend"],
  // sparse_frontend
  [/aten\/src\/ATen\/native\/sparse/gi, "release notes: sparse"],
  [/torch\/sparse/gi, "release notes: sparse"],
  [/torch\/_masked\/__init__.py/gi, "release notes: sparse"],
  // nn_frontend => also did not exist
  [/test\/test_nn.py/gi, "release notes: nn"],
  [/test\/test_module.py/gi, "release notes: nn"],
  [/torch\/optim/gi, "release notes: optim"],
  [/tools\/nn\/modules/gi, "release notes: nn"],
  [/tools\/nn\/functional.py/gi, "release notes: nn"],
  // jit
  [/torch\/(csrc\/)?jit/gi, "release notes: jit"],
  // releng
  [/docker\//gi, "release notes: releng"],
  [/.circleci/gi, "release notes: releng"],
  [/.github/gi, "release notes: releng"],
  [/.jenkins/gi, "release notes: releng"],
  [/.azure_pipelines/gi, "release notes: releng"],
  // cpp_frontend
  [/torch\/(csrc|cpp)\/api/gi, "release notes: cpp"],
];

const notUserFacingPatterns: RegExp[] = [
  /\.azure_pipelines/g,
  /\.circleci/g,
  /\.github/g,
  /\.jenkins/g,
  /\.vscode/g,
  /docker/g,
  /Dockerfile/g,
  /Makefile/g,
  /mypy_plugins/g,
  /mypy(-strict)?\.ini/g,
  /scripts/g,
  /setup\.py/g,
  /test\//g,
  /third_party/g,
  /tools/g,
  /torchgen/g,
  /CODEOWNERS/g,
  /\.bazel(rc|version)/g,
  /\.buck/g,
  /\.ctags\.d/g,
  /\.git/g,
  /\.clang/g,
  /\.cmakelintrc/g,
  /\.coveragerc/g,
  /\.dockerignore/g,
  /\.flake8/g,
  /\.gdbinit/g,
  /\.isort\.cfg/g,
  /lintrunner/g,
  /[a-zA-Z]+.md/gi,
  /\.(ini|toml|txt)/g,
  /\.gdbinit/g,
];

const notUserFacingPatternExceptions: RegExp[] = [/tools\/autograd/g];

// For in the specified repo, if any file path matches the given regex we will apply the label
// corresponding to that file to the PR
//
// Format: "owner/repo": [
//  [/regex-for-path1/, "label-to-apply"],
//  [/regex-for-path2/, "label-to-apply"],
// ]
const repoSpecificAutoLabels: { [repo: string]: [RegExp, string][] } = {
  "pytorch/pytorch": [
    [/aten\/src\/ATen\/mps/gi, "ciflow/mps"],
    [/aten\/src\/ATen\/native\/mps/gi, "ciflow/mps"],
    [/torch\/_inductor\/codegen\/mps.py/gi, "ciflow/mps"],
    [/test\/test_mps.py/gi, "ciflow/mps"],
    [/test\/inductor\/test_mps_basic.py/gi, "ciflow/mps"],
  ],
  "pytorch/fake-test-repo": [[/somefolder/gi, "cool-label"]],
};

export async function getLabelsFromLabelerConfig(
  context: Context,
  labelerConfigTracker: CachedLabelerConfigTracker,
  changed_files: string[]
): Promise<string[]> {
  const config = await labelerConfigTracker.loadLabelsConfig(context);

  const labels = [];

  for (const [label, globs] of Object.entries(config)) {
    if (
      globs.some((glob: string) =>
        changed_files.some((file: string) => minimatch(file, glob))
      )
    ) {
      labels.push(label);
    }
  }
  return labels;
}

export async function getLabelsFromLabelToLabelConfig(
  context: Context,
  labelToLabelConfigTracker: LabelToLabelConfigTracker,
  existingLabels: string[],
  addedLabel: string
): Promise<string[]> {
  const config = await labelToLabelConfigTracker.loadLabelsConfig(context);
  const newLabels: string[] = [];

  for (const rule of Object.values(config)) {
    if (Object.hasOwn(rule, "any")) {
      if (rule["any"].some((label: string) => addedLabel == label)) {
        newLabels.push(...rule["then"]);
      }
    } else if (Object.hasOwn(rule, "all")) {
      if (
        rule["all"].some((label: string) => addedLabel == label) &&
        rule["all"].every((label: string) => existingLabels.includes(label))
      ) {
        newLabels.push(...rule["then"]);
      }
    }
  }
  return newLabels;
}

function getRepoSpecificLabels(
  owner: string,
  repo: string,
  changedFiles: string[]
): string[] {
  var repoKey = owner + "/" + repo;
  if (!repoSpecificAutoLabels.hasOwnProperty(repoKey)) {
    return [];
  }

  const config = repoSpecificAutoLabels[repoKey];

  const labelsToAdd: string[] = [];
  for (const file of changedFiles) {
    // check for typical matches
    for (const [regex, label] of config) {
      if (file.match(regex)) {
        labelsToAdd.push(label);
      }
    }
  }
  return labelsToAdd;
}

function TDRolloutIssueParser(rawSubsText: string): object {
  const subsText = rawSubsText.replace("\r", "");
  const subsRows = subsText.match(/^\*.+/gm);
  const authors: any = new Set();
  if (subsRows == null) {
    return authors;
  }
  subsRows.forEach((row: string) => {
    const users = row.match(/@[a-zA-Z0-9-/]+/g);
    if (users) {
      users.forEach((u) => authors.add(u.substring(1)));
    }
  });
  return authors;
}

export async function canRunWorkflows(
  context: Context<"pull_request"> | Context<"pull_request_review">
) {
  return (
    (await hasApprovedPullRuns(
      context.octokit,
      context.payload.repository.owner.login,
      context.payload.repository.name,
      context.payload.pull_request.head.sha
    )) ||
    (await hasWritePermissions(
      context,
      context.payload.pull_request.user.login
    ))
  );
}

async function filterCIFlowLabels(
  isIssue: boolean,
  labels: string[],
  context?: Context<"pull_request">,
  owner?: string,
  repo?: string
) {
  const noCIFlowLabels = labels.filter((l) => !l.startsWith("ciflow/"));
  if (noCIFlowLabels.length === labels.length) {
    return labels;
  }

  if (isIssue) {
    return noCIFlowLabels;
  }

  assert(context && owner && repo, "context, owner, and repo must be provided");

  if (!(await canRunWorkflows(context))) {
    return noCIFlowLabels;
  }
  return labels;
}

function isNotUserFacing(filesChanged: string[]): boolean {
  return (
    filesChanged.length > 0 &&
    filesChanged.every(
      (f) =>
        notUserFacingPatterns.some((p) => f.match(p)) &&
        !notUserFacingPatternExceptions.some((p) => f.match(p))
    )
  );
}

function getLabelsToAddFromIssueTitle(title: string): string[] {
  return getLabelsToAdd(title, IssueTitleRegexToLabel);
}

function getLabelsToAddFromPrTitle(title: string): string[] {
  return getLabelsToAdd(title, PrTitleRegexToLabel);
}

function getLabelsToAdd(
  title: string,
  regexToLabelList: [RegExp, string][]
): string[] {
  const labelsToAdd: string[] = [];

  for (const [regex, label] of regexToLabelList) {
    if (title.match(regex)) {
      labelsToAdd.push(label);
    }
  }

  return labelsToAdd;
}

// https://github.com/pytorch/pytorch/blob/master/scripts/release_notes/commitlist.py#L90
function getReleaseNotesCategoryAndTopic(
  title: string,
  labels: string[],
  filesChanged: string[]
): [string, string] {
  let topic: string = "untopiced";

  if (labels.includes("module: bc-breaking")) {
    topic = "topic: bc breaking";
  }

  if (labels.includes("module: deprecation")) {
    topic = "topic: deprecation";
  }

  // these files do not warrant a real category and mostly not user facing
  // we want to return this _before_ categorizing
  if (isNotUserFacing(filesChanged)) {
    return ["skip", "topic: not user facing"];
  }

  // don't re-categorize those with existing labels
  if (
    labels.some(
      (l) => l.startsWith("release notes:") || l === "topic: not user facing"
    )
  ) {
    // already topiced
    if (labels.some((l) => l.startsWith("topic:"))) {
      return ["skip", "skip"];
    }
    return ["skip", topic];
  }

  if (
    filesChanged.length > 0 &&
    filesChanged.every((f) => f.includes("caffe2"))
  ) {
    return ["caffe2", topic];
  }

  if (title.toLowerCase().includes("[codemod]")) {
    return ["uncategorized", "topic: not user facing"];
  }

  for (const file of filesChanged) {
    // check for typical matches
    for (const [regex, label] of filenameRegexToReleaseCategory) {
      if (file.match(regex)) {
        // return here since we take the first match (first category of first matching file)
        return [label, topic];
      }
    }
  }

  if (
    filesChanged.length > 0 &&
    filesChanged.every((f) => f.endsWith(".cu") || f.endsWith(".cuh"))
  ) {
    return ["release notes: cuda", topic];
  }

  if (title.includes("[PyTorch Edge]")) {
    return ["release notes: mobile", topic];
  }

  // OpInfo related
  if (
    filesChanged.length === 1 &&
    (filesChanged
      .at(0)
      ?.includes("torch/testing/_internal/common_methods_invocations.py") ||
      filesChanged.at(0)?.includes("torch/_torch_docs.py"))
  ) {
    return ["release notes: python_frontend", topic];
  }

  return ["uncategorized", topic];
}

export async function addNewLabels(
  existingLabels: string[],
  labelsToAdd: string[],
  context: Context
): Promise<void> {
  // labelsToAdd may have duplicates, so we cannot use a filter
  const newLabels: string[] = [];
  labelsToAdd.forEach((l) => {
    if (!existingLabels.includes(l) && !newLabels.includes(l)) {
      newLabels.push(l);
    }
  });

  if (newLabels.length > 0) {
    await addLabels(context, newLabels);
  }
}

function myBot(app: Probot): void {
  const TDRolloutTracker = new CachedIssueTracker(
    app,
    "TD_rollout_issue",
    TDRolloutIssueParser
  );
  const labelerConfigTracker = new CachedLabelerConfigTracker(app);
  const labelToLabelConfigTracker = new LabelToLabelConfigTracker(app);

  app.on("issues.labeled", async (context) => {
    // Careful!  For most labels, we only apply actions *when the issue
    // is added*; not if the issue is pre-existing (for example, high
    // priority label results in triage review, but if we unlabel it
    // from triage review, we shouldn't readd triage review the next
    // time the issue is labeled).

    const addedLabel = context.payload.label!.name;
    const existingLabels: string[] = context.payload.issue.labels!.map(
      (e) => e["name"]
    );
    context.log({ addedLabel, existingLabels });

    const newLabels: string[] = [];

    // NB: Added labels here will trigger more issues.labeled actions,
    // so be careful about accidentally adding a cycle.  With just label
    // addition it's not possible to infinite loop as you will
    // eventually quiesce, beware if you remove labels though!
    switch (addedLabel) {
      case "high priority":
      case "critical":
        newLabels.push("triage review");
        break;
    }

    const newLabelsFromLabelToLabelConfig =
      await getLabelsFromLabelToLabelConfig(
        context,
        labelToLabelConfigTracker,
        existingLabels,
        addedLabel
      );
    newLabels.push(...newLabelsFromLabelToLabelConfig);

    const filtered = await filterCIFlowLabels(true, newLabels);
    await addNewLabels(existingLabels, filtered, context);
  });

  app.on(["issues.opened", "issues.edited"], async (context) => {
    const existingLabels: string[] = context.payload.issue.labels!.map(
      (e) => e["name"]
    );
    const title = context.payload["issue"]["title"];
    context.log({ existingLabels, title });

    const labelsToAdd = getLabelsToAddFromIssueTitle(title);
    await addNewLabels(existingLabels, labelsToAdd, context);
  });

  app.on(
    ["pull_request.opened", "pull_request.edited", "pull_request.synchronize"],
    async (context) => {
      const labels: string[] = context.payload.pull_request.labels.map(
        (e) => e["name"]
      );
      const owner = context.payload.repository.owner.login;
      const repo = context.payload.repository.name;
      const title = context.payload.pull_request.title;
      const filesChanged = await getFilesChangedByPr(
        context.octokit,
        owner,
        repo,
        context.payload.pull_request.number
      );
      context.log({ labels, title, filesChanged });

      var labelsToAdd = getLabelsToAddFromPrTitle(title);

      // only categorize for release notes for prs in pytorch/pytorch
      if (isPyTorchPyTorch(owner, repo)) {
        const [category, topic] = getReleaseNotesCategoryAndTopic(
          title,
          labels,
          filesChanged
        );
        if (category !== "uncategorized" && category !== "skip") {
          labelsToAdd.push(category);
        }
        if (topic !== "untopiced" && topic !== "skip") {
          labelsToAdd.push(topic);
        }
      }

      // Add a repo specific labels (if any)
      var repoSpecificLabels = getRepoSpecificLabels(owner, repo, filesChanged);
      labelsToAdd.push(...repoSpecificLabels);

      var labelsFromLabelerConfig = await getLabelsFromLabelerConfig(
        context,
        labelerConfigTracker,
        filesChanged
      );
      labelsToAdd.push(...labelsFromLabelerConfig);

      if (
        isPyTorchPyTorch(owner, repo) &&
        context.payload.action === "opened"
      ) {
        // Add the ci-td-distributed label to PRs opened by authors listed in
        // the TD rollout issue
        const authors = (await TDRolloutTracker.loadIssue(
          context
        )) as Set<string>;
        if (authors.has(context.payload.pull_request.user.login)) {
          labelsToAdd.push("ci-td-distributed");
        }
      }

      // Filter ciflow/* labels if the PR author does not have write permissions
      labelsToAdd = await filterCIFlowLabels(
        false,
        labelsToAdd,
        context,
        owner,
        repo
      );

      await addNewLabels(labels, labelsToAdd, context);
    }
  );
}

export default myBot;
