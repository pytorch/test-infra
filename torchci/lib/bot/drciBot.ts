import { Probot } from "probot";
import { OWNER, REPO, formDrciComment, getDrciComment, getActiveSEVs, formDrciSevBody, upsertDrCiComment } from "lib/drciUtils";
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
      const prUrl = context.payload.pull_request.html_url

      if (prState != "open") {
        context.log(`Pull request ${prNum} to ${owner}/${repo} is not open, no comment is made`);
        return;
      }

      context.log(prOwner);
      
      await upsertDrCiComment(owner, repo, prNum, context, prUrl)
    }
  );
}

