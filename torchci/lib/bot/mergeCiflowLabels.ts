import { Octokit } from "octokit";
import { getLabelsNeededByFiles, LabelerLog } from "./labelerConfigUtils";
import { getFilesChangedByPr, getOpenStackPrs, StackPr } from "./utils";

export const CIFLOW_LABELS_KEPT_PER_PR = ["ciflow/docker"];

/**
 * At merge, for each path-based ciflow label that the merged PR or an open PR
 * below it in its stack needs, adds the label to the topmost such PR, unless
 * a PR from the merged one down to it already carries the label. A ciflow
 * run on a PR tests every PR below it, so one labeled PR covers the rest.
 * Failures are logged and never thrown.
 */
export async function addCiflowLabelsAtMerge(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  addedLabels: string[];
  loadLabelerConfig: () => Promise<object>;
  log: LabelerLog & { error: LabelerLog };
}): Promise<void> {
  const { octokit, owner, repo, prNumber, addedLabels, log } = params;
  try {
    const config = (await params.loadLabelerConfig()) as Record<
      string,
      unknown
    >;
    const ciflowLabels = Object.keys(config ?? {}).filter(
      (label) =>
        label.startsWith("ciflow/") &&
        !CIFLOW_LABELS_KEPT_PER_PR.includes(label)
    );
    if (ciflowLabels.length === 0) {
      return;
    }

    const pr = (
      await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
    ).data;
    const merged: StackPr = {
      number: prNumber,
      isDraft: pr.draft ?? false,
      labels: [...new Set([...pr.labels.map((l) => l.name), ...addedLabels])],
      files: await getFilesChangedByPr(octokit, owner, repo, prNumber),
    };
    const below = await getOpenStackPrs(
      octokit,
      owner,
      repo,
      {
        number: prNumber,
        body: pr.body,
        headRef: pr.head.ref,
        isCrossRepository: pr.head.repo?.full_name !== pr.base.repo.full_name,
        stack: (pr as any).stack,
      },
      "below"
    );
    const chain = [merged, ...(below.kind === "stack" ? below.prs : [])];
    const needed = chain.map(
      (p) => new Set(getLabelsNeededByFiles(config, p.files, p.isDraft, log))
    );

    const toAdd = new Map<number, string[]>();
    for (const label of ciflowLabels) {
      const target = needed.findIndex((labels) => labels.has(label));
      if (target === -1) {
        continue;
      }
      const covered = chain
        .slice(0, target + 1)
        .some((p) => p.labels.includes(label));
      if (covered) {
        continue;
      }
      const number = chain[target].number;
      toAdd.set(number, [...(toAdd.get(number) ?? []), label]);
    }
    for (const [number, labels] of toAdd) {
      try {
        await octokit.rest.issues.addLabels({
          owner,
          repo,
          issue_number: number,
          labels,
        });
      } catch (error) {
        log.error(
          { err: error, owner, repo, prNumber, labeledPr: number, labels },
          "addCiflowLabelsAtMerge: failed to add ciflow labels to a PR"
        );
      }
    }
  } catch (error) {
    log.error(
      { err: error, owner, repo, prNumber },
      "addCiflowLabelsAtMerge: failed to add ciflow labels at merge"
    );
  }
}
