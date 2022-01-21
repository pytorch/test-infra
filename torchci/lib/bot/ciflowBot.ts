import { Context, Probot } from "probot";
import minimist from "minimist";
import { CachedIssueTracker } from "./utils";

const ciflowCommentStart = "<!-- ciflow-comment-start -->";
const ciflowCommentEnd = "<!-- ciflow-comment-end -->";

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
      elements.length === 1 ? CIFlowBot.defaultLabels : elements.slice(1);
    userConfigMap.set(login, {
      optOut: false,
      defaultLabels,
    });
  });
  return userConfigMap;
}

// The CIFlowBot helps to dispatch labels and signal GitHub Action workflows to run.
// For more details about the design, please refer to the RFC: https://github.com/pytorch/pytorch/issues/61888
// Currently it supports strong validation and slow rollout, and it runs through a pipeline of dispatch strategies.
export default class CIFlowBot {
  // Constructor required
  readonly ctx: Context;
  readonly tracker: CachedIssueTracker;

  // Static readonly configurations
  static readonly command_ciflow = "ciflow";
  static readonly command_ciflow_rerun = "rerun";
  static readonly allowed_commands: string[] = [CIFlowBot.command_ciflow];

  static readonly bot_assignee = "pytorchbot";
  static readonly event_issue_comment = "issue_comment";
  static readonly event_pull_request = "pull_request";
  static readonly pr_label_prefix = "ciflow/";

  static readonly strategy_add_default_labels = "strategy_add_default_labels";
  static readonly defaultLabels = ["ciflow/default"];

  // Stateful instance variables
  command = "";
  // @ts-ignore
  command_args: minimist.ParsedArgs;
  comment_id = 0;
  comment_author = "";
  comment_author_permission = "";
  comment_body = "";
  confusing_command = false;
  dispatch_labels: string[] = [];
  dispatch_strategies = [CIFlowBot.strategy_add_default_labels];
  default_labels = CIFlowBot.defaultLabels;
  event = "";
  owner = "";
  pr_author = "";
  pr_labels: string[] = [];
  pr_number = 0;
  repo = "";

  constructor(ctx: Context, tracker: CachedIssueTracker) {
    this.ctx = ctx;
    this.tracker = tracker;
  }

  valid(): boolean {
    if (
      this.event !== CIFlowBot.event_pull_request &&
      this.event !== CIFlowBot.event_issue_comment
    ) {
      this.ctx.log.error({ ctx: this.ctx }, "Unknown webhook event");
      return false;
    }

    // validate the issue_comment event
    if (this.event === CIFlowBot.event_issue_comment) {
      if (!CIFlowBot.allowed_commands.includes(this.command)) {
        return false;
      }

      if (
        this.comment_author !== this.pr_author &&
        !(
          this.comment_author_permission === "admin" ||
          this.comment_author_permission === "write"
        )
      ) {
        return false;
      }
    }

    // validate the pull_request event, so far we just return true
    return true;
  }

  async getUserPermission(username: string): Promise<string> {
    const res = await this.ctx.octokit.repos.getCollaboratorPermissionLevel(
      this.ctx.repo({
        username,
      })
    );
    return res?.data?.permission;
  }

  async getUserLabels(): Promise<string[]> {
    const userConfigMap: Map<string, IUserConfig> =
      this.tracker != null
        ? ((await this.tracker.loadIssue(this.ctx)) as Map<string, IUserConfig>)
        : new Map<string, IUserConfig>();

    // rollout to everyone if no config is found
    if (!userConfigMap.has(this.pr_author)) {
      return CIFlowBot.defaultLabels;
    }

    // respect opt-out users
    // @ts-ignore
    if (userConfigMap.get(this.pr_author).optOut) {
      return [];
    }

    return (
      // @ts-ignore
      userConfigMap.get(this.pr_author).defaultLabels || CIFlowBot.defaultLabels
    );
  }

  async dispatch(): Promise<void> {
    if (this.confusing_command) {
      await this.postReaction();
      this.ctx.log.info(
        {
          event: this.event,
          owner: this.owner,
          command_args: this.command_args,
        },
        "ciflow dispatch is confused!"
      );
      return;
    }
    // Dispatch_strategies is like a pipeline of functions we can apply to
    // change `this.dispatch_labels`. We can add other dispatch algorithms
    // based on the ctx or user instructions.
    // The future algorithms can manipulate the `this.dispatch_labels`, and
    // individual workflows that can build up `if` conditions on the labels
    // can be found in `.github/workflows` of pytorch/pytorch repo.
    this.dispatch_strategies.map(this.dispatchStrategyFunc.bind(this));

    // Signal the dispatch to GitHub
    await this.setLabels();
    await this.signalGithub();

    // Logging of the dispatch
    this.ctx.log.info(
      {
        dispatch_labels: this.dispatch_labels,
        dispatch_strategies: this.dispatch_strategies,
        event: this.event,
        owner: this.owner,
        pr_number: this.pr_number,
        pr_labels: this.pr_labels,
        repo: this.repo,
      },
      "ciflow dispatch success!"
    );
  }

  dispatchStrategyFunc(strategyName: string): void {
    switch (strategyName) {
      case CIFlowBot.strategy_add_default_labels:
        // strategy_add_default_labels: just make sure the we add `default_labels` to the existing set of pr_labels
        if (this.dispatch_labels.length === 0) {
          this.dispatch_labels = this.pr_labels;
        }

        // respect author's ciflow labels before PR is made
        if (this.hasLabelsBeforePR()) {
          break;
        }

        this.dispatch_labels = this.default_labels.concat(this.dispatch_labels);
        break;
      default: {
        this.ctx.log.error({ strategyName }, "Unknown dispatch strategy");
        break;
      }
    }
  }

  // triggerGHADispatch sends a signal to GitHub to trigger the dispatch
  // The logic here is leverage some event that's rarely triggered by other users or bots,
  // thus we pick "assign/unassign" to begin with. See details from the CIFlow RFC:
  // https://github.com/pytorch/pytorch/issues/61888
  async triggerGHADispatch(): Promise<void> {
    await this.ctx.octokit.issues.addAssignees(
      this.ctx.repo({
        issue_number: this.pr_number,
        assignees: [CIFlowBot.bot_assignee],
      })
    );

    await this.ctx.octokit.issues.removeAssignees(
      this.ctx.repo({
        issue_number: this.pr_number,
        assignees: [CIFlowBot.bot_assignee],
      })
    );
  }

  async postReaction(): Promise<void> {
    if (this.event === CIFlowBot.event_issue_comment) {
      await this.ctx.octokit.reactions.createForIssueComment(
        this.ctx.repo({
          comment_id: this.comment_id,
          content: this.confusing_command ? "confused" : "+1",
        })
      );
    }
  }

  // signalGithub triggers a dispatch (if needed) as well as reacts to the comment
  async signalGithub(): Promise<void> {
    if (
      this.event === CIFlowBot.event_pull_request &&
      this.default_labels.length === CIFlowBot.defaultLabels.length &&
      this.default_labels.every(
        (val, idx) => val === CIFlowBot.defaultLabels[idx]
      )
    ) {
      this.ctx.log.info(
        {
          dispatch_labels: this.dispatch_labels,
          default_labels: this.default_labels,
          event: this.event,
          owner: this.owner,
          pr_number: this.pr_number,
          pr_labels: this.pr_labels,
          repo: this.repo,
        },
        "skipping pull request dispatch for defaultLabel"
      );
    } else {
      await this.triggerGHADispatch();
    }

    await this.postReaction();

    await new Ruleset(
      this.ctx,
      this.owner,
      this.repo,
      this.pr_number,
      this.dispatch_labels
    ).upsertRootComment();
  }

  hasLabelsBeforePR(): boolean {
    return (
      this.event === CIFlowBot.event_pull_request &&
      this.pr_labels.some((l) => l.startsWith(CIFlowBot.pr_label_prefix))
    );
  }

  isRerunCommand(): boolean {
    return (
      this.event === CIFlowBot.event_issue_comment &&
      this.command_args.length > 0 &&
      this.command_args._[0] === CIFlowBot.command_ciflow_rerun
    );
  }

  logSkipLabels(message: string): void {
    this.ctx.log.info(
      {
        dispatch_labels: this.dispatch_labels,
        default_labels: this.default_labels,
        event: this.event,
        owner: this.owner,
        pr_number: this.pr_number,
        pr_labels: this.pr_labels,
        repo: this.repo,
      },
      message
    );
  }

  async setLabels(): Promise<void> {
    if (this.hasLabelsBeforePR()) {
      this.logSkipLabels("do not set labels as it'll override users choice.");
      return;
    }

    if (this.isRerunCommand() && typeof this.command_args.l === undefined) {
      this.logSkipLabels(
        "Do not set labels for rerun comments without -l option."
      );
      return;
    }

    const labels = this.dispatch_labels.filter((label) =>
      label.startsWith(CIFlowBot.pr_label_prefix)
    );
    const labelsToDelete = this.pr_labels.filter((l) => !labels.includes(l));
    const labelsToAdd = labels.filter((l) => !this.pr_labels.includes(l));
    for (const label of labelsToDelete) {
      await this.ctx.octokit.issues.removeLabel(
        this.ctx.repo({
          issue_number: this.pr_number,
          name: label,
        })
      );
    }

    // skip addLabels if there's no label to add
    if (labelsToAdd.length > 0) {
      await this.ctx.octokit.issues.addLabels(
        this.ctx.repo({
          issue_number: this.pr_number,
          labels: labelsToAdd,
        })
      );
    }
    this.dispatch_labels = labels;
  }

  parseCommandArgs(): boolean {
    switch (this.command) {
      case CIFlowBot.command_ciflow: {
        if (this.command_args._.length === 0) {
          return false;
        }
        const commandArgsLength = Object.keys(this.command_args).length;
        const subCommand = this.command_args._[0];
        if (subCommand !== CIFlowBot.command_ciflow_rerun) {
          return false;
        }
        // `rerun` command is confusing if it has any other subcommand
        if (this.command_args._.length !== 1) {
          this.confusing_command = true;
        }
        const lType = typeof this.command_args.l;
        // `rerun` does not accept any other options but "-l"
        // So, mark command as confusing if it has any other arguments than l
        if (lType === "undefined") {
          this.confusing_command =
            this.confusing_command || commandArgsLength !== 1;
          break;
        }
        this.confusing_command =
          this.confusing_command || commandArgsLength !== 2;
        if (lType !== "object") {
          // Arg can be string, integer or boolean
          this.command_args.l = [this.command_args.l];
        }
        for (const label of this.command_args.l) {
          if (typeof label !== "string") {
            this.confusing_command = true;
            continue;
          }
          if (!label.startsWith(CIFlowBot.pr_label_prefix)) {
            this.confusing_command = true;
          }
          this.dispatch_labels.push(label);
        }
        break;
      }
      default:
        return false;
    }

    return true;
  }

  parseComment(): boolean {
    // skip if the comment edit event is from the bot comment itself
    if (
      this.command.includes(ciflowCommentStart) ||
      this.command.includes(ciflowCommentEnd)
    ) {
      return false;
    }

    // considering the `m` multi-line comment match
    const re = new RegExp(
      `^.*@${CIFlowBot.bot_assignee}\\s+(\\w+)\\s+(.*)$`,
      "m"
    );

    const found = this.comment_body?.match(re);
    if (!found) {
      return false;
    }

    if (found.length >= 2) {
      this.command = found[1];
    }
    if (found.length === 3) {
      this.command_args = minimist(found[2].trim().split(/\s+/));
    }

    return this.parseCommandArgs();
  }

  async setContext(): Promise<boolean> {
    this.event = this.ctx.name;
    // @ts-expect-error (we know these are available because we only use PR and issue triggers)
    const pr = this.ctx.payload?.pull_request || this.ctx.payload?.issue;
    this.pr_number = pr?.number;
    this.pr_author = pr?.user?.login;
    this.pr_labels = pr?.labels
      ?.filter((label: any) => label.name.startsWith(CIFlowBot.pr_label_prefix))
      ?.map((label: any) => label.name);
    this.owner = this.ctx.repo().owner;
    this.repo = this.ctx.repo().repo;

    if (this.event === CIFlowBot.event_issue_comment) {
      // @ts-expect-error we check this above
      this.comment_author = this.ctx.payload?.comment?.user?.login;
      // @ts-expect-error we check this above
      this.comment_body = this.ctx.payload?.comment?.body;
      // @ts-expect-error we check this above
      this.comment_id = this.ctx.payload?.comment?.id;

      // if parseComment returns false, we don't need to do anything
      if (!this.parseComment()) {
        return false;
      }

      const permission = await this.getUserPermission(this.comment_author);
      this.comment_author_permission = permission;
    }

    return this.valid();
  }

  async handler(): Promise<void> {
    const isValid = await this.setContext();
    this.default_labels = await this.getUserLabels();

    this.ctx.log.info(
      {
        command: this.command,
        command_args: this.command_args,
        comment_author: this.comment_author,
        comment_author_permission: this.comment_author_permission,
        dispatch_labels: this.dispatch_labels,
        dispatch_strategies: this.dispatch_strategies,
        event: this.event,
        owner: this.owner,
        pr_author: this.pr_author,
        pr_labels: this.pr_labels,
        pr_number: this.pr_number,
        repo: this.repo,
        default_labels: this.default_labels,
        confusing_command: this.confusing_command,
        valid: isValid,
      },
      "ciflow dispatch started!"
    );

    if (!isValid || this.default_labels.length === 0) {
      return;
    }
    await this.dispatch();
  }

  static main(app: Probot): void {
    const tracker = new CachedIssueTracker(
      app,
      "ciflow_tracking_issue",
      parseCIFlowIssue
    );
    const webhookHandler = async (ctx: Context): Promise<void> => {
      await new CIFlowBot(ctx, tracker).handler();
    };
    app.on("pull_request.opened", webhookHandler);
    app.on("pull_request.reopened", webhookHandler);
    app.on("pull_request.synchronize", webhookHandler);
    app.on("issue_comment.created", webhookHandler);
    app.on("issue_comment.edited", webhookHandler);
  }
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
    readonly owner: string,
    readonly repo: string,
    readonly pr_number: number,
    readonly labels: string[]
  ) {}

  async fetchRulesetJson(): Promise<IRulesetJson | null> {
    const prRes = await this.ctx.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: this.pr_number,
    });
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
    const commentsRes = await this.ctx.octokit.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: this.pr_number,
      per_page: perPage,
    });
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

    body += `
<br/>
You can add a comment to the PR and tag @pytorchbot with the following commands:
<br/>

\`\`\`sh
# ciflow rerun, "ciflow/default" will always be added automatically
@pytorchbot ciflow rerun

# ciflow rerun with additional labels "-l <ciflow/label_name>", which is equivalent to adding these labels manually and trigger the rerun
@pytorchbot ciflow rerun -l ciflow/scheduled -l ciflow/slow
\`\`\`

<br/>

For more information, please take a look at the [CI Flow Wiki](https://github.com/pytorch/pytorch/wiki/Continuous-Integration#using-ciflow).
</details>`;

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
      const res = await this.ctx.octokit.issues.createComment({
        body,
        owner: this.owner,
        repo: this.repo,
        issue_number: this.pr_number,
      });
      commentId = res.data.id;
    } else {
      await this.ctx.octokit.issues.updateComment({
        body,
        owner: this.owner,
        repo: this.repo,
        comment_id: commentId,
      });
    }
  }
}
