import { Context, Probot } from "probot";

const regexToLabel: [RegExp, string][] = [
  [/rocm/gi, "module: rocm"],
  [/DISABLED\s+test.*\(.*\)/g, "skipped"],
];

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
      await context.octokit.issues.addLabels(
        context.issue({ labels: newLabels })
      );
    }
  });

  async function addLabelsFromTitle(
    existingLabels: string[],
    title: string,
    context: Context
  ): Promise<void> {
    const labelSet = new Set(existingLabels);
    const newLabels: string[] = [];

    for (const [regex, label] of regexToLabel) {
      if (title.match(regex)) {
        addLabel(labelSet, newLabels, label);
      }
    }

    if (newLabels.length) {
      await context.octokit.issues.addLabels(
        context.issue({ labels: newLabels })
      );
    }
  }

  app.on(["issues.opened", "issues.edited"], async (context) => {
    const labels: string[] = context.payload.issue.labels!.map(
      (e) => e["name"]
    );
    const title = context.payload["issue"]["title"];
    context.log({ labels, title });
    await addLabelsFromTitle(labels, title, context);
  });

  app.on(["pull_request.opened", "pull_request.edited"], async (context) => {
    const labels: string[] = context.payload.pull_request.labels.map(
      (e) => e["name"]
    );
    const title = context.payload.pull_request.title;
    context.log({ labels, title });

    await addLabelsFromTitle(labels, title, context);
  });
}

export default myBot;
