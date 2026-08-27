import { Context } from "probot";
import {
  DISPATCH_PERMISSIONS,
  mintScopedOctokit,
  SOURCE_REPO_PERMISSIONS,
} from "./greenlightAppAuth";

export type GreenlightContext = Context<"issue_comment.created">;

export type Reaction = "+1" | "confused";

const DISPATCH_OWNER = "pytorch";
const DISPATCH_REPO = "test-infra";
const DISPATCH_WORKFLOW = "greenlight-review.yml";
const DISPATCH_REF = "main";

function memoize<T>(build: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending === undefined) {
      pending = build();
    }
    return pending;
  };
}

export interface SourceRepoWriter {
  /** Mint the token now, so an unrelated mint can be in flight at the same time. */
  ready: () => Promise<void>;
  comment: (_body: string) => Promise<void>;
  react: (_content: Reaction) => Promise<void>;
  removeLabel: (_name: string) => Promise<void>;
}

/**
 * The bot's write surface on the repo the comment came from. The scoped token is
 * minted at most once per delivery, and only if something is actually written.
 */
export function sourceRepoWriter(ctx: GreenlightContext): SourceRepoWriter {
  const owner = ctx.payload.repository.owner.login;
  const repo = ctx.payload.repository.name;
  const octokit = memoize(() =>
    mintScopedOctokit(
      owner,
      repo,
      SOURCE_REPO_PERMISSIONS,
      ctx.payload.installation?.id
    )
  );

  return {
    async ready() {
      await octokit();
    },

    async comment(body: string) {
      ctx.log(`Commenting on ${ctx.payload.issue.html_url}`);
      await (
        await octokit()
      ).rest.issues.createComment({
        owner,
        repo,
        issue_number: ctx.payload.issue.number,
        body,
      });
    },

    async react(content: Reaction) {
      ctx.log(
        `Reacting with "${content}" to comment ${ctx.payload.comment.html_url}`
      );
      await (
        await octokit()
      ).rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: ctx.payload.comment.id,
        content,
      });
    },

    async removeLabel(name: string) {
      ctx.log(`Removing the ${name} label from ${ctx.payload.issue.html_url}`);
      await (
        await octokit()
      ).rest.issues.removeLabel({
        owner,
        repo,
        issue_number: ctx.payload.issue.number,
        name,
      });
    },
  };
}

export interface ReviewDispatcher {
  /** Mint the token now, so an unrelated mint can be in flight at the same time. */
  ready: () => Promise<void>;
  dispatch: (_prNumber: number, _requester: string) => Promise<void>;
}

/** Starts the Green Light reviewer workflow that lives in pytorch/test-infra. */
export function reviewDispatcher(ctx: GreenlightContext): ReviewDispatcher {
  const octokit = memoize(() =>
    mintScopedOctokit(DISPATCH_OWNER, DISPATCH_REPO, DISPATCH_PERMISSIONS)
  );

  return {
    async ready() {
      await octokit();
    },

    async dispatch(prNumber: number, requester: string) {
      ctx.log(
        `Dispatching ${DISPATCH_WORKFLOW} for pull request ${prNumber} on ` +
          `behalf of ${requester}`
      );
      await (
        await octokit()
      ).rest.actions.createWorkflowDispatch({
        owner: DISPATCH_OWNER,
        repo: DISPATCH_REPO,
        workflow_id: DISPATCH_WORKFLOW,
        ref: DISPATCH_REF,
        // The workflow appends --timeout-minutes to the CLI whatever its input
        // holds, and argparse parses that one as an int, so sending it as an
        // empty string exits 2 and reds the run. Only --max and the two sent
        // here are guarded by a non-empty test. Leaving it out makes
        // workflow_dispatch substitute the default the workflow declares.
        inputs: {
          pr: String(prNumber),
          requester,
        },
      });
    },
  };
}
