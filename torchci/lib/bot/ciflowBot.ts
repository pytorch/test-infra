import { Context, Probot } from "probot";
import { CachedIssueTracker } from "./utils";

const ciflowCommentStart = "<!-- ciflow-comment-start -->";
const ciflowCommentEnd = "<!-- ciflow-comment-end -->";
const DEFAULT_LABELS = ["ciflow/default"];

interface IUserConfig {
  optOut: boolean;
  defaultLabels?: string[];
}

// parseCIFlowIssue parses the issue body for default labels and opt-out users
export function parseCIFlowIssue(rawText: string): Map<string, IUserConfig> {
  const [optIn, optOut] = ["@", "-@"];
  const rows = rawText.replace("\r", "").split("\n");
  const userConfigMap: Map<string, IUserConfig> = new Map();
  rows.forEach((row: string) => {
    const elements = row
      .trim()
      .replace(/^-\s*@/, "-@")
      .split(" ");
    if (
      elements.length < 1 ||
      elements[0].length < 1 ||
      !(elements[0].startsWith(optIn) || elements[0].startsWith(optOut))
    ) {
      return;
    }

    // opt-out users
    if (elements[0].startsWith(optOut)) {
      const login = elements[0].substring(2);
      userConfigMap.set(login, {
        optOut: true,
      });
      return;
    }

    // users with custom labels
    const login = elements[0].substring(1);
    const defaultLabels =
      elements.length === 1 ? DEFAULT_LABELS : elements.slice(1);
    userConfigMap.set(login, {
      optOut: false,
      defaultLabels,
    });
  });
  return userConfigMap;
}

async function getUserLabels(
  context: Context<"pull_request.opened">,
  tracker: CachedIssueTracker
): Promise<string[]> {
  // @ts-ignore
  const userConfigMap: Map<string, IUserConfig> = await tracker.loadIssue(
    context
  );

  const prAuthor = context.payload.pull_request.user.login;

  // rollout to everyone if no config is found
  if (!userConfigMap.has(prAuthor)) {
    return DEFAULT_LABELS;
  }

  // respect opt-out users
  // @ts-ignore
  if (userConfigMap.get(prAuthor).optOut) {
    return [];
  }

  return (
    // @ts-ignore
    userConfigMap.get(prAuthor).defaultLabels || CIFlowBot.defaultLabels
  );
}

export default function ciflowBot(app: Probot): void {
  // When a pull request is open, add an initial set of labels based on the
  // user's config, and add the ruleset comment.
  app.on("pull_request.opened", async (context) => {
    // Add labels based on user configuration.
    const tracker = new CachedIssueTracker(
      app,
      "ciflow_tracking_issue",
      parseCIFlowIssue
    );
    const prNumber = context.payload.pull_request.number;
    const labels = await getUserLabels(context, tracker);
    if (labels.length !== 0) {
      await context.octokit.issues.addLabels(
        context.repo({
          issue_number: prNumber,
          labels: labels,
        })
      );
    }

    // Add CIFlowBot comment.
    await new Ruleset(context, prNumber, labels).upsertRootComment();
  });

  // When a user tries to talk to ciflow, respond by telling them they don't
  // need to do that anymore.
  app.on("issue_comment.created", async (context) => {
    const re = new RegExp(`^.*@pytorchbot\\s+(\\w+)\\s+(.*)$`, "m");
    const found = context.payload.comment.body.match(re);
    if (!found) {
      return;
    }
    const command = found[1];
    if (command !== "ciflow") {
      return;
    }

    const prNumber = context.payload.issue.number;
    await context.octokit.issues.createComment(
      context.repo({
        body:
          "<strong>This command didn't do anything.</strong>\n" +
          "You don't need to manually issue ciflow rerun commands anymore. " +
          "Just adding a `ciflow/` label will trigger the workflow.",
        issue_number: prNumber,
      })
    );
  });
}

interface IRulesetJson {
  version: string;
  label_rules: { [key: string]: string[] };
}

// Ruleset is a class that represents the configuration of ciflow rules
// defined by in the pytorch/pytorch repo (.github/generated-ciflow-ruleset.json)
// Its purpose here for the CIFlowBot is to explicitly visualize the ruleset on PR
export class Ruleset {
  static readonly ruleset_json_path = ".github/generated-ciflow-ruleset.json";

  // @ts-ignore
  ruleset_json_link: string;

  constructor(
    readonly ctx: Context,
    readonly pr_number: number,
    readonly labels: string[]
  ) {}

  async fetchRulesetJson(): Promise<IRulesetJson | null> {
    const prRes = await this.ctx.octokit.pulls.get(
      this.ctx.repo({
        pull_number: this.pr_number,
      })
    );
    const head = prRes?.data?.head;
    const contentRes = await this.ctx.octokit.repos.getContent({
      ref: head.sha,
      owner: head.repo!.owner.login,
      repo: head.repo!.name,
      path: Ruleset.ruleset_json_path,
    });

    if ("content" in contentRes.data) {
      // @ts-ignore
      this.ruleset_json_link = contentRes?.data?.html_url;
      return JSON.parse(
        Buffer.from(contentRes?.data?.content, "base64").toString("utf-8")
      );
    }
    return null;
  }

  async fetchRootComment(perPage = 10): Promise<[number, string]> {
    const commentsRes = await this.ctx.octokit.issues.listComments(
      this.ctx.repo({
        issue_number: this.pr_number,
        per_page: perPage,
      })
    );
    for (const comment of commentsRes.data) {
      if (comment.body!.includes(ciflowCommentStart)) {
        return [comment.id, comment.body!];
      }
    }
    return [0, ""];
  }

  genRootCommentBody(ruleset: IRulesetJson, labels: Set<string>): string {
    let body = "\n<details><summary>CI Flow Status</summary><br/>\n";
    body += "\n## :atom_symbol: CI Flow";
    body += `\nRuleset - Version: \`${ruleset.version}\``;
    body += `\nRuleset - File: ${this.ruleset_json_link}`;
    body += `\nPR ciflow labels: \`${Array.from(labels)}\``;

    body +=
      "\n<strong>Add ciflow labels to this PR to trigger more builds:</strong>";

    const workflowToLabelMap: any = {};

    for (const l in ruleset.label_rules) {
      for (const w of ruleset.label_rules[l]) {
        workflowToLabelMap[w] = workflowToLabelMap[w] || new Set<string>();
        workflowToLabelMap[w].add(l);
      }
    }

    const triggeredRows = [];
    const skippedRows = [];
    for (const w in workflowToLabelMap) {
      let enabled = false;
      for (const l of Array.from(workflowToLabelMap[w])) {
        if (labels.has(l as string)) {
          enabled = true;
          break;
        }
      }

      const ls = Array.from(workflowToLabelMap[w]);
      const rowLabels = (ls as string[])
        .sort((a, b) => a.localeCompare(b))
        .map((l) => {
          return labels.has(l) ? `**\`${l}\`**` : `\`${l}\``;
        });

      if (enabled) {
        triggeredRows.push([w, rowLabels, ":white_check_mark: triggered"]);
      } else {
        skippedRows.push([w, rowLabels, ":no_entry_sign: skipped"]);
      }
    }
    // @ts-ignore
    triggeredRows.sort((a, b) => a[0].localeCompare(b[0]));
    // @ts-ignore
    skippedRows.sort((a, b) => a[0].localeCompare(b[0]));

    body += "\n| Workflows | Labels (bold enabled) | Status  |";
    body += "\n| :-------- | :-------------------- | :------ |";
    body += "\n|             **Triggered Workflows**           |";
    for (const row of triggeredRows) {
      // @ts-ignore
      body += `\n| ${row[0]} | ${row[1].join(", ")} | ${row[2]} |`;
    }
    body += "\n|             **Skipped Workflows**           |";
    for (const row of skippedRows) {
      // @ts-ignore
      body += `\n| ${row[0]} | ${row[1].join(", ")} | ${row[2]} |`;
    }

    body += "</details>";

    return body;
  }

  async upsertRootComment(): Promise<void> {
    const ruleset = await this.fetchRulesetJson();
    if (!ruleset) {
      this.ctx.log.error(
        { pr_number: this.pr_number },
        "failed to fetchRulesetJson"
      );
      return;
    }

    // eslint-disable-next-line prefer-const
    let [commentId, commentBody] = await this.fetchRootComment();

    let body = this.genRootCommentBody(ruleset, new Set(this.labels));
    if (commentBody.includes(ciflowCommentStart)) {
      body = commentBody.replace(
        new RegExp(`${ciflowCommentStart}(.*?)${ciflowCommentEnd}`, "s"),
        `${ciflowCommentStart}${body}${ciflowCommentEnd}`
      );
    } else {
      body = `${commentBody}\n${ciflowCommentStart}${body}${ciflowCommentEnd}`;
    }

    if (commentId === 0) {
      const res = await this.ctx.octokit.issues.createComment(
        this.ctx.repo({
          body,
          issue_number: this.pr_number,
        })
      );
      commentId = res.data.id;
    } else {
      await this.ctx.octokit.issues.updateComment(
        this.ctx.repo({
          body,
          comment_id: commentId,
        })
      );
    }
  }
}