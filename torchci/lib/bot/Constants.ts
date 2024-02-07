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
