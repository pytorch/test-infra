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

// TODO: Find a way to mark which ones require issues vs. not
export const cherryPickClassifications: Record<
  string,
  CherryPickClassification
> = {
  regression: {
    help: "Fixes a regression",
    requiresIssue: true,
  },
  critical: {
    help: "Fixes a critical bug (generally low risk)",
    requiresIssue: true,
  },
  newfeature: {
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
