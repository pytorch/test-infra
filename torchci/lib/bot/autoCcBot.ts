import { parseSubscriptions } from "./subscriptions";
import { CachedIssueTracker } from "./utils";
import { Probot, Context } from "probot";

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
    const subscriptions = await loadSubscriptions(context);
    context.log("payload_type=", payloadType);
    // @ts-ignore
    const labels = context.payload[payloadType].labels.map((e) => e.name);
    context.log({ labels });
    const cc = new Set();
    labels.forEach((l: string) => {
      if (l in subscriptions) {
        // @ts-ignore
        subscriptions[l].forEach((u) => cc.add(u));
      }
    });
    context.log({ cc: Array.from(cc) }, "from subscriptions");
    if (cc.size) {
      // @ts-ignore
      const body = context.payload[payloadType]["body"];
      const reCC = /cc( +@[a-zA-Z0-9-/]+)+/;
      const oldCCMatch = body ? body.match(reCC) : null;
      const prevCC = new Set();
      if (oldCCMatch) {
        const oldCCString = oldCCMatch[0];
        context.log({ oldCCString }, "previous cc string");
        let m;
        const reUsername = /@([a-zA-Z0-9-/]+)/g;
        while ((m = reUsername.exec(oldCCString)) !== null) {
          prevCC.add(m[1]);
          cc.add(m[1]);
        }
        context.log({ prevCC: Array.from(prevCC) }, "pre-existing ccs");
      }
      // Invariant: prevCC is a subset of cc
      if (prevCC.size !== cc.size) {
        let newCCString = "cc";
        cc.forEach((u) => {
          newCCString += ` @${u}`;
        });
        const newBody = body
          ? oldCCMatch
            ? body.replace(reCC, newCCString)
            : `${body}\n\n${newCCString}`
          : newCCString;
        context.log({ newBody });
        if (payloadType === "issue") {
          await context.octokit.issues.update(context.issue({ body: newBody }));
        } else if (payloadType === "pull_request") {
          // @ts-ignore
          await context.octokit.pulls.update(context.issue({ body: newBody }));
        }
      } else {
        context.log("no action: no change from existing cc list on issue");
      }
    } else {
      context.log("no action: cc list from subscription is empty");
    }
  }

  app.on("issues.labeled", async (context) => {
    await runBotForLabels(context, "issue");
  });
  app.on("pull_request.labeled", async (context) => {
    await runBotForLabels(context, "pull_request");
  });
}

export default myBot;
