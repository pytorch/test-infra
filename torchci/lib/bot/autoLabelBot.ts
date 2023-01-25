import { Context, Probot } from "probot";
import { addLabels, isPyTorchPyTorch } from "./utils";
import * as yaml from 'js-yaml';
import { readFile } from 'fs/promises';

const releaseNoteLabelFile = "./lib/bot/conf/releaseNotesLabelConfig.yml";
const titleRegexToLabel: [RegExp, string][] = [
  [/rocm/gi, "module: rocm"],
  [/DISABLED\s+test.*\(.*\)/g, "skipped"],
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
]

const notUserFacingPatternExceptions: RegExp[] = [
  /tools\/autograd/g,
]

// For in the specified repo, if any file path matches the given regex we will apply the label
// corresponding to that file to the PR
//
// Format: "owner/repo": [
//  [/regex-for-path1/, "label-to-apply"],
//  [/regex-for-path2/, "label-to-apply"],
// ]
const repoSpecificAutoLabels: {[repo: string]: [RegExp, string][]}  = {
  "pytorch/pytorch": [
      [/aten\/src\/ATen\/mps/gi, "ciflow/mps"],
      [/aten\/src\/ATen\/native\/mps/gi, "ciflow/mps"],
      [/test\/test_mps.py/gi, "ciflow/mps"],
  ],
  "pytorch/fake-test-repo": [
    [/somefolder/gi, "cool-label"]
  ]
}

function getRepoSpecificLabels(owner: string, repo: string): [RegExp, string][] {
  var repoKey = owner + "/" + repo;
  if (!repoSpecificAutoLabels.hasOwnProperty(repoKey)) {
    return [];
  }

  return repoSpecificAutoLabels[repoKey];
}

function myBot(app: Probot): void {
  function addLabel(
    labelSet: Set<string>,
    newLabels: string[],
    l: string
  ): void {
    if (!labelSet.has(l)) {
      newLabels.push(l);
      labelSet.add(l);
    }
  }

  function isNotUserFacing(filesChanged: string[]): boolean {
    return filesChanged.length > 0 &&
      filesChanged.every(f => (notUserFacingPatterns.some(p => f.match(p)) &&
                               !notUserFacingPatternExceptions.some(p => f.match(p))));
  }

  app.on("issues.labeled", async (context) => {
    // Careful!  For most labels, we only apply actions *when the issue
    // is added*; not if the issue is pre-existing (for example, high
    // priority label results in triage review, but if we unlabel it
    // from triage review, we shouldn't readd triage review the next
    // time the issue is labeled).

    const label = context.payload.label!.name;
    const labels: string[] = context.payload.issue.labels!.map(
      (e) => e["name"]
    );
    context.log({ label, labels });

    const labelSet = new Set(labels);
    const newLabels: string[] = [];

    // NB: Added labels here will trigger more issues.labeled actions,
    // so be careful about accidentally adding a cycle.  With just label
    // addition it's not possible to infinite loop as you will
    // eventually quiesce, beware if you remove labels though!
    switch (label) {
      case "high priority":
      case "critical":
        addLabel(labelSet, newLabels, "triage review");
        break;
    }

    if (newLabels.length) {
      await addLabels(context, newLabels);
    }
  });

  function getLabelsToAddFromTitle(
    title: string,
  ): string[] {
    const labelsToAdd: string[] = [];

    for (const [regex, label] of titleRegexToLabel) {
      if (title.match(regex)) {
        labelsToAdd.push(label);
      }
    }

    return labelsToAdd;
  }


  async function getLabelFromConfig(
      filepath: string,
      filesChanged: string[],
    ): Promise<string> {
    const configObject: any = yaml.load(await readFile(filepath, "utf8")) as string;
    const labelGlobMap = getLabelGlobMapFromObject(configObject)
    for (const file of filesChanged) {
      // check for typical matches
      for (const [label, regexList] of labelGlobMap) {
          let found = regexList.some(regex => regex.test(file));
          if(found) {
            return label;
          }
      }
    }
    return null as any;
  }

  function getTopic(
    title: string,
    labels: string[],
    filesChanged: string[],
  ): string {
    let topic: string = "untopiced";

    if (labels.includes("module: bc-breaking")) {
      // yes, there is some clowning with the - and _
      topic = "topic: bc_breaking";
    }

    if (labels.includes("module: deprecation")) {
      topic = "topic: deprecation";
    }

    // these files do not warrant a real category and mostly not user facing
    // we want to return this _before_ categorizing
    if (isNotUserFacing(filesChanged) || title.toLowerCase().includes("[codemod]")) {
      topic = "topic: not user facing";
    }

    // don't re-categorize those with existing labels: already topiced
    if (labels.some(l => l === "topic: not user facing")) {
        return  "skip";
    }
    return topic;
  }

  // https://github.com/pytorch/pytorch/blob/master/scripts/release_notes/commitlist.py#L90
  async function getReleaseNotesCategory(
    title: string,
    labels: string[],
    filesChanged: string[],
  ): Promise<string> {
    // these files do not warrant a real category and mostly not user facing
    // we want to return this _before_ categorizing
    if (isNotUserFacing(filesChanged)) {
      return "skip";
    }

    // don't re-categorize those with existing labels
    if (labels.some(l => l.startsWith("release notes:" ) || l === "topic: not user facing")) {
        return "skip";
    }

    if (filesChanged.length > 0 && filesChanged.every(f => f.includes("caffe2"))) {
      return "caffe2";
    }

    if (title.toLowerCase().includes("[codemod]")) {
      return "uncategorized";
    }

    let label = await getLabelFromConfig(releaseNoteLabelFile, filesChanged);
    if(label != null) {
      return label;
    }

    if (filesChanged.length > 0 && filesChanged.every(f => f.endsWith(".cu") || f.endsWith(".cuh"))) {
      return "release notes: cuda";
    }

    if (title.includes("[PyTorch Edge]")) {
      return "release notes: mobile";
    }

    // OpInfo related
    if (filesChanged.length === 1 &&
        (filesChanged.at(0)?.includes("torch/testing/_internal/common_methods_invocations.py") ||
        filesChanged.at(0)?.includes("torch/_torch_docs.py"))) {
          return "release notes: python_frontend";
    }

    return "uncategorized";
  }

  async function addNewLabels(existingLabels: string[], labelsToAdd: string[], context: Context): Promise<void> {
    // labelsToAdd may have duplicates, so we cannot use a filter
    const newLabels: string[] = []
    labelsToAdd.forEach(l => {
      if (!existingLabels.includes(l) && !newLabels.includes(l)) {
        newLabels.push(l);
      }
    });

    if (newLabels.length > 0) {
      await addLabels(context, newLabels);
    }
  }

  function getLabelGlobMapFromObject(
    configObject: any
  ): Map<string, RegExp[]> {
    const labelGlobs: Map<string, RegExp[]> = new Map();
    for (const label in configObject) {
      if (configObject[label] instanceof Array) {
        labelGlobs.set(label, configObject[label].map((regex: string) => {
          var parts = /\/(.*)\/(.*)/.exec(regex)!;
          return RegExp(parts[1], parts[2]);
      }));
      } else {
        throw Error(
          `found unexpected type for label ${label} (should be array of globs)`
        );
      }
    }

    return labelGlobs;
  }

  app.on(["issues.opened", "issues.edited"], async (context) => {
    const labels: string[] = context.payload.issue.labels!.map(
      (e) => e["name"]
    );
    const title = context.payload["issue"]["title"];
    context.log({ labels, title });

    const labelsToAdd = getLabelsToAddFromTitle(title);
    await addNewLabels(labels, labelsToAdd, context);
  });

  app.on(["pull_request.opened", "pull_request.edited"], async (context) => {
    const labels: string[] = context.payload.pull_request.labels.map(
      (e) => e["name"]
    );
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const title = context.payload.pull_request.title;
    const filesChangedRes = await context.octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner,
      repo,
      pull_number: context.payload.pull_request.number,
      per_page: 100,
    })
    const filesChanged = filesChangedRes.map((f: any) => f.filename);
    context.log({ labels, title, filesChanged });

    const labelsToAdd = getLabelsToAddFromTitle(title);

    // only categorize for release notes for prs in pytorch/pytorch
    if (isPyTorchPyTorch(owner, repo)) {
      const category = await getReleaseNotesCategory(title, labels, filesChanged);
      const topic = getTopic(title, labels, filesChanged);
      if (category !== "uncategorized" && category !== "skip") {
        labelsToAdd.push(category);
      }
      if (topic !== "untopiced" && topic !== "skip") {
        labelsToAdd.push(topic);
      }
    }

    // Add a repo specific labels (if any)
    var repoSpecificLabels = getRepoSpecificLabels(owner, repo);

    for (const file of filesChanged) {
      // check for typical matches
      for (const [regex, label] of repoSpecificLabels) {
        if (file.match(regex)) {
          labelsToAdd.push(label);
        }
      }
    }

    await addNewLabels(labels, labelsToAdd, context);
  });

  app.on("pull_request_review.submitted", async (context) => {
    // Apply `ciflow/trunk` to PRs in PyTorch/PyTorch that has been reviewed
    if (context.payload.review.state !== "approved") {
      return;
    }
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    if (!isPyTorchPyTorch(owner, repo)) {
      return;
    }
    // TEMP disable for 24 hours to see if it affects number of reverts / queueing
    // await addLabels(context, [CIFLOW_TRUNK_LABEL]);
  });
}

export default myBot;
