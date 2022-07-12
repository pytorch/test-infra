import { Octokit, App } from "octokit";

const octokit = new Octokit({
  auth: `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`,
});

// console.log(octokit);
const owner = "pytorch";
const repo = "pytorch-canary";
const prNum = 110;
octokit.rest.pulls.createReview({
  owner,
  repo,
  pull_number: prNum,
  event: "APPROVE",
});
