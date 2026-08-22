import {
  IssuesLabeledEvent,
  PullRequestLabeledEvent,
} from "@octokit/webhooks-types";
import { Context, Probot } from "probot";
import { parseSubscriptions } from "./subscriptions";
import { CachedIssueTracker, isPyTorchbotSupportedOrg } from "./utils";

function myBot(app: Probot): void {
  const tracker = new CachedIssueTracker(
    app,
    "tracking_issue",
    parseSubscriptions
  );

  async function loadSubscriptions(context: Context): Promise<object> {
    return tracker.loadIssue(context);
  }

  async function runBotForLabels(
    context: Context,
    payloadType: string
  ): Promise<void> {
    const payload = context.payload as
      | PullRequestLabeledEvent
      | IssuesLabeledEvent;
    context.log(
      {
        repo_slug: `${payload.repository.owner.login}/${payload.repository.name}`,
        payload_type: payloadType,
      },
      "Started processing"
    );
    const subscriptions = await loadSubscriptions(context);
    // @ts-ignore
    const labels = payload[payloadType].labels.map((e) => e.name);
    context.log({ labels });
    const cc = new Set<string>();
    labels.forEach((l: string) => {
      if (l in subscriptions) {
        // @ts-ignore
        subscriptions[l].forEach((u: string) => cc.add(u));
      }
    });
    context.log({ cc: Array.from(cc) }, "from subscriptions");
    // Remove self from subscription
    // @ts-ignore
    const author = payload[payloadType].user.login;
    if (cc.delete(author)) {
      context.log({ author: author }, "Removed self from subscriptions");
    }
    // @ts-ignore
    const body = payload[payloadType]["body"];
    const reExplicitCC = /(^|\n)(cc( +@[a-zA-Z0-9-/]+)+)/g;
    const reAutoCC = /(^|\n)(auto-cc( +@[a-zA-Z0-9-/]+)+)/;
    const explicitCC = new Set<string>();
    const reUsername = /@([a-zA-Z0-9-/]+)/g;
    let m;
    while ((m = reExplicitCC.exec(body ?? "")) !== null) {
      let usernameMatch;
      while ((usernameMatch = reUsername.exec(m[2])) !== null) {
        explicitCC.add(usernameMatch[1]);
      }
    }
    if (explicitCC.size) {
      explicitCC.forEach((u) => cc.delete(u));
      context.log(
        { explicitCC: Array.from(explicitCC) },
        "excluding explicit ccs"
      );
    }

    const oldAutoCCMatch = body ? body.match(reAutoCC) : null;
    const oldAutoCCString = oldAutoCCMatch ? oldAutoCCMatch[2] : null;
    if (oldAutoCCString) {
      context.log({ oldAutoCCString }, "previous auto-cc string");
    }
    let newAutoCCString: string | null = null;
    if (cc.size) {
      newAutoCCString = "auto-cc";
      cc.forEach((u) => {
        newAutoCCString += ` @${u}`;
      });
    }
    if (oldAutoCCString !== newAutoCCString) {
      let newBody = body ?? "";
      if (body && oldAutoCCMatch) {
        newBody = newAutoCCString
          ? body.replace(reAutoCC, `${oldAutoCCMatch[1]}${newAutoCCString}`)
          : body.replace(reAutoCC, "").replace(/\n+$/, "");
      } else if (newAutoCCString) {
        newBody = body ? `${body}\n\n${newAutoCCString}` : newAutoCCString;
      }
      context.log({ newBody });
      if (payloadType === "issue") {
        await context.octokit.issues.update(context.issue({ body: newBody }));
      } else if (payloadType === "pull_request") {
        await context.octokit.pulls.update(
          context.pullRequest({ body: newBody })
        );
      }
    } else {
      if (cc.size) {
        context.log("no action: no change from existing auto-cc list on issue");
      } else {
        context.log("no action: cc list from subscription is empty");
      }
    }
  }

  app.on("issues.labeled", async (context) => {
    const owner = context.payload.repository.owner.login;
    if (!isPyTorchbotSupportedOrg(owner)) {
      context.log(`${__filename} isn't enabled on ${owner}'s repos`);
      return;
    }
    await runBotForLabels(context, "issue");
  });

  app.on("pull_request.labeled", async (context) => {
    const owner = context.payload.repository.owner.login;
    if (!isPyTorchbotSupportedOrg(owner)) {
      context.log(`${__filename} isn't enabled on ${owner}'s repos`);
      return;
    }
    await runBotForLabels(context, "pull_request");
  });
}

export default myBot;
