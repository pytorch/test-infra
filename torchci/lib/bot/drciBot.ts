import { Probot } from "probot";
import { OWNER, REPO, formDrciComment, getDrciComment, getActiveSEVs, formDrciSevBody } from "lib/drciUtils";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";


export default function drciBot(app: Probot): void {
  app.on(
    ["pull_request.opened", "pull_request.synchronize"],
    async (context) => {
      // https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#pull_request
      const owner = context.payload.repository.owner.login;
      const repo = context.payload.repository.name;
      const prNum = context.payload.pull_request.number;
      const prOwner = context.payload.pull_request.user.login;
      const prState = context.payload.pull_request.state;

      if (prState != "open") {
        context.log(`Pull request ${prNum} to ${owner}/${repo} is not open, no comment is made`);
        return;
      }

      // Dr.CI only supports pytorch/pytorch at the moment
      if (owner != OWNER || repo != REPO) {
        context.log(`Pull request to ${owner}/${repo} is not supported by Dr.CI bot, no comment is made`);
        return;
      }

      context.log(prOwner);

      const existingDrciData = await getDrciComment(
        context.octokit,
        owner,
        repo,
        prNum
      );
      const existingDrciID = existingDrciData.id;
      const existingDrciComment = existingDrciData.body;
      const sev = getActiveSEVs(await fetchIssuesByLabel("ci: sev"));
      const drciComment = formDrciComment(prNum, "", formDrciSevBody(sev));

      if (existingDrciComment === drciComment) {
        return;
      }

      if (existingDrciID === 0) {
        await context.octokit.issues.createComment({
          body: drciComment,
          owner: owner,
          repo: repo,
          issue_number: prNum,
        });
        context.log(
          `Commenting with "${drciComment}" for pull request ${context.payload.pull_request.html_url}`
        );
      } else {
        await context.octokit.issues.updateComment({
          body: drciComment,
          owner: owner,
          repo: repo,
          comment_id: existingDrciID,
        });
        context.log(
          `Updated comment with "${drciComment}" for pull request ${context.payload.pull_request.html_url}`
        );
      }
    }
  );
}
