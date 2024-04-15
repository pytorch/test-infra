export const revertClassifications = {
  nosignal: "No Signal",
  ignoredsignal: "Ignored Signal",
  landrace: "Land Race",
  weird: "Weird",
  ghfirst: "Github First",
};

interface CherryPickClassification {
  help: string;
  requiresIssue: boolean;
}

export const cherryPickClassifications: Record<
  string,
  CherryPickClassification
> = {
  regression: {
    help: "Fixes a regression against the most recent release",
    requiresIssue: true,
  },
  critical: {
    help: "Fixes a critical bug (generally low risk)",
    requiresIssue: true,
  },
  fixnewfeature: {
    help: "Fixes a new feature introduced in the current release",
    requiresIssue: true,
  },
  docs: {
    help: "Fixes documentation",
    requiresIssue: false,
  },
  release: {
    help: "Fixes that are specific to the release branch",
    requiresIssue: false,
  },
};

export const workflowRelatedPatterns: RegExp[] = [
  /\.azure_pipelines/g,
  /\.circleci/g,
  /\.github/g,
  /\.jenkins/g,
  /docker/g,
  /Dockerfile/g,
  /Makefile/g,
  /mypy_plugins/g,
  /mypy(-strict)?\.ini/g,
  /scripts/g,
  /setup\.py/g,
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
  /lintrunner/g,
];

export const notUserFacingPatterns: RegExp[] = workflowRelatedPatterns.concat([
  /\.vscode/g,
  /test\//g,
  /[a-zA-Z]+.md/gi,
  /\.(ini|toml|txt)/g,
  /\.isort\.cfg/g,
  /\.gdbinit/g,
]);
