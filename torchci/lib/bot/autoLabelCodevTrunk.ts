// Bot that adds ciflow/trunk label to PRs in pytorch/pytorch that are codev
// that have been approved or imported.  Can be viewed as a sub-bot of
// autoLabelBot, put into its own file for clarity and easier testing.
import { Context, Probot } from "probot";
import { addNewLabels, canRunWorkflows } from "./autoLabelBot";
import { CODEV_INDICATOR } from "./codevNoWritePermBot";
import { isPyTorchPyTorch } from "./utils";

const CIFLOW_TRUNK_LABEL = "ciflow/trunk";

async function doCodevLabeling(
  context: Context<"pull_request" | "pull_request_review">
) {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const prAuthor = context.payload.pull_request.user.login;
  const body = context.payload.pull_request.body;
  const existingLabels = context.payload.pull_request.labels.map(
    (e) => e["name"]
  );

  if (!isPyTorchPyTorch(owner, repo)) {
    return;
  }

  // only apply label to codev diffs.
  if (!body?.match(CODEV_INDICATOR)) {
    return;
  }

  // Casting context to any is used to get around "type too complex to
  // represent" typechecking errors
  if (!(await canRunWorkflows(context as any))) {
    return;
  }

  await addNewLabels(existingLabels, [CIFLOW_TRUNK_LABEL], context as any);
}

function myBot(app: Probot): void {
  app.on("pull_request_review.submitted", async (context) => {
    if (context.payload.review.state !== "approved") {
      return;
    }
    await doCodevLabeling(context);
  });

  app.on("pull_request.edited", async (context) => {
    // Apply `ciflow/trunk` to PRs that have just been imported.
    if (context.payload.changes.body?.from.match(CODEV_INDICATOR)) {
      // Already exists, no need to add again
      return;
    }
    await doCodevLabeling(context);
  });
}

export default myBot;
