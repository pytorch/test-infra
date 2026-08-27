import {
  getHelp,
  GreenlightCommandName,
  isGreenlightCommand,
  parseCommandName,
} from "./greenlightCliParser";
import { isTrustedAuthor } from "./greenlightTrustedAuthors";
import {
  GreenlightContext,
  reviewDispatcher,
  SourceRepoWriter,
  sourceRepoWriter,
} from "./greenlightWriter";
import { hasWritePermissions, isPyTorchPyTorch } from "./utils";

// GitHub label names are case-sensitive and the greenlight scanner compares the
// raw string, so this has to stay exactly as the pytorch stale bot writes it.
const STALE_LABEL = "Stale";

export const RECHECK_DEDUPE_TTL_MS = 60 * 1000;

const recentRechecks = new Map<string, number>();

function isRecheckInFlight(key: string): boolean {
  const expiresAt = recentRechecks.get(key);
  return expiresAt !== undefined && expiresAt > Date.now();
}

function markRecheckInFlight(key: string): void {
  const now = Date.now();
  for (const [k, expiresAt] of recentRechecks) {
    if (expiresAt <= now) {
      recentRechecks.delete(k);
    }
  }
  recentRechecks.set(key, now + RECHECK_DEDUPE_TTL_MS);
}

function forgetRecheckInFlight(key: string): void {
  recentRechecks.delete(key);
}

/** Clear the in-memory recheck dedupe window (useful for testing). */
export function clearRecheckDedupe(): void {
  recentRechecks.clear();
}

function ackMessage(hadStaleLabel: boolean): string {
  const removed = hadStaleLabel
    ? `Removed the \`${STALE_LABEL}\` label and asked`
    : "Asked";
  return (
    `${removed} Green Light to take another look.\n\n` +
    `Green Light will re-review this pull request if it has changed since its ` +
    `last verdict.`
  );
}

function untrustedRequesterMessage(requester: string): string {
  return (
    `Green Light only acts on rechecks from its trusted-requester list, and ` +
    `\`${requester}\` is not on it.\n\n` +
    `The list is \`TRUSTED_AUTHORS\` in ` +
    `\`greenlight/src/greenlight/review.py\` in pytorch/test-infra.`
  );
}

async function handleRecheck(
  ctx: GreenlightContext,
  writer: SourceRepoWriter
): Promise<void> {
  const issue = ctx.payload.issue;
  const owner = ctx.payload.repository.owner.login;
  const repo = ctx.payload.repository.name;
  const prNumber = issue.number;
  const requester = ctx.payload.comment.user.login;

  // Write permission is a far wider set than the list the backend will act on,
  // and a refused recheck there ends in a clean green workflow run with no
  // comment and no recorded state. Refusing here is the only place the
  // requester can be told, so it has to happen before the bot reports success.
  if (!isTrustedAuthor(requester)) {
    await writer.comment(untrustedRequesterMessage(requester));
    return;
  }

  if (issue.pull_request?.merged_at) {
    await writer.comment(
      "This pull request is already merged, so there is nothing for Green Light to review."
    );
    return;
  }
  if (issue.state !== "open") {
    await writer.comment(
      "This pull request is closed, so there is nothing for Green Light to review."
    );
    return;
  }
  if (issue.draft) {
    await writer.comment(
      "This pull request is a draft. Mark it ready for review and ask again."
    );
    return;
  }
  // The reviewer workflow this ultimately reaches, greenlight-pr-review.yml,
  // takes no repo input: it hard-codes pytorch/pytorch for both the checkout
  // and the verdict write, so a recheck dispatched from anywhere else would
  // review an unrelated pull request of the same number.
  if (!isPyTorchPyTorch(owner, repo)) {
    await writer.comment(
      "Green Light only reviews pytorch/pytorch pull requests today."
    );
    return;
  }

  const dedupeKey = `${owner}/${repo}/${prNumber}`;
  if (isRecheckInFlight(dedupeKey)) {
    ctx.log(`Skipping a repeated recheck of ${dedupeKey}`);
    return;
  }
  // No await between the test above and this mark, so two deliveries the same
  // warm instance is handling at once cannot both get past it and start
  // reviewer runs that cancel each other mid-review.
  markRecheckInFlight(dedupeKey);

  const hadStaleLabel = issue.labels.some(
    (label) => label.name === STALE_LABEL
  );
  const dispatcher = reviewDispatcher(ctx);

  try {
    // Both tokens are wanted on this path and neither depends on the other, so
    // the two mints overlap instead of adding their round trips together.
    await Promise.all([writer.ready(), dispatcher.ready()]);

    // Removing the label is what keeps the pull request under automatic review
    // afterwards: the dispatched recheck ignores the label entirely, but the
    // periodic listing scan skips a Stale-labelled pull request once its
    // recorded verdict is terminal, which is the state this recheck is about
    // to reach.
    if (hadStaleLabel) {
      try {
        await writer.removeLabel(STALE_LABEL);
      } catch (error: any) {
        // The label is only removed when the payload says it is there, so a 404
        // means someone else got to it first -- which is the state we wanted.
        if (error?.status !== 404) {
          throw error;
        }
        ctx.log(`The ${STALE_LABEL} label was already gone from ${dedupeKey}`);
      }
    }

    await dispatcher.dispatch(prNumber, requester);
  } catch (error) {
    // No run exists to deduplicate against, so holding the window shut would
    // drop the requester's retry for a minute with nothing posted to say why.
    forgetRecheckInFlight(dedupeKey);
    throw error;
  }

  // Acknowledge last. Probot answers 202 and abandons the invocation nine
  // seconds into a delivery, and GitHub never redelivers a webhook it failed to
  // process, so any step here can be the last one that runs. Commenting only
  // after the work means a truncated delivery leaves no comment claiming
  // something that never happened.
  await writer.comment(ackMessage(hadStaleLabel));
  await writer.react("+1");
}

type CommandHandler = (
  _ctx: GreenlightContext,
  _writer: SourceRepoWriter
) => Promise<void>;

// Keyed by the command union, so adding a command to GREENLIGHT_COMMANDS
// without giving it behaviour here does not compile.
const COMMAND_HANDLERS: Record<GreenlightCommandName, CommandHandler> = {
  async help(_ctx, writer) {
    await writer.comment(getHelp());
  },
  recheck: handleRecheck,
};

export async function handleGreenlightCommand(
  ctx: GreenlightContext,
  inputArgs: string
): Promise<void> {
  const writer = sourceRepoWriter(ctx);
  const name = parseCommandName(inputArgs);

  // A comment notifies everyone subscribed to the pull request, so nothing the
  // bot posts may be reachable by an arbitrary GitHub user: an unrecognized
  // command and an unauthorized commenter both get a reaction and nothing else.
  if (!isGreenlightCommand(name)) {
    await writer.react("confused");
    return;
  }
  if (!(await hasWritePermissions(ctx, ctx.payload.comment.user.login))) {
    await writer.react("confused");
    return;
  }

  await COMMAND_HANDLERS[name](ctx, writer);
}
