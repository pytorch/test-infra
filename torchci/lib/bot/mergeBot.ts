import { Probot } from "probot";
import { addComment, reactOnComment } from "./botUtils";

function mergeBot(app: Probot): void {
    const mergeCmdPat = new RegExp(
        "^\\s*@pytorch(merge|)bot\\s+(force\\s+)?merge\\s+this\\s*(on\\s*green)?"
    );
    const revertCmdPat = new RegExp("^\\s*@pytorch(merge|)bot\\s+revert\\s+this");
    const rebaseCmdPat = new RegExp(
        "^\\s*@pytorch(merge|)bot\\s+rebase\\s+(me|this)"
    );
    const rebaseAllowList = [
        "clee2000",
        "zengk95",
        "janeyx99",
        "albanD",
        "cpuhrsch",
        "suo",
        "ngimel",
        "rohan-varma",
        "ezyang",
        "davidberard98",
    ];

    app.on("issue_comment.created", async (ctx) => {
        const commentBody = ctx.payload.comment.body;
        const owner = ctx.payload.repository.owner.login;
        const repo = ctx.payload.repository.name;
        const prNum = ctx.payload.issue.number;

        async function dispatchEvent(
            event_type: string,
            force: boolean = false,
            onGreen: boolean = false
        ) {
            let payload: any = {
                pr_num: prNum,
                comment_id: ctx.payload.comment.id,
            };

            if (force) {
                payload.force = true;
            } else if (onGreen) {
                payload.on_green = true;
            }

            await ctx.octokit.repos.createDispatchEvent({
                owner,
                repo,
                event_type: event_type,
                client_payload: payload,
            });
        }

        const match = commentBody.match(mergeCmdPat);
        if (match) {
            if (!ctx.payload.issue.pull_request) {
                // Issue, not pull request.
                await reactOnComment(ctx, "confused");
                return;
            }
            await dispatchEvent(
                "try-merge",
                typeof match[2] === "string",
                typeof match[3] === "string"
            );
            await reactOnComment(ctx, "+1");
        } else if (commentBody.match(revertCmdPat)) {
            if (!ctx.payload.issue.pull_request) {
                // Issue, not pull request.
                await reactOnComment(ctx, "confused");
                return;
            }
            const revertWithReasonCmdPat = new RegExp(
                "^\\s*@pytorch(merge|)bot\\s+revert\\s+this(.|\\s)*(\\s+\\w+){3,}"
            );
            if (commentBody.match(revertWithReasonCmdPat) === null) {
                // revert reason of 3+ words not given
                await addComment(
                    ctx,
                    "Revert unsuccessful: please retry the command explaining why the revert is necessary, " +
                    "e.g. @pytorchbot revert this as it breaks mac tests on trunk, see {url to logs}."
                );
                return;
            }
            await dispatchEvent("try-revert");
            await reactOnComment(ctx, "+1");
        } else if (
            commentBody.match(rebaseCmdPat) &&
            ((rebaseAllowList.includes(ctx.payload.comment.user.login) &&
                rebaseAllowList.includes(ctx.payload.issue.user.login)) ||
                ctx.payload.comment.user.login == ctx.payload.issue.user.login)
        ) {
            if (!ctx.payload.issue.pull_request) {
                // Issue, not pull request.
                await reactOnComment(ctx, "confused");
                return;
            }
            await dispatchEvent("try-rebase");
            await reactOnComment(ctx, "+1");
        }
    });
    app.on(
        ["pull_request_review.submitted", "pull_request_review.edited"],
        async (ctx) => {
            const reviewBody = ctx.payload.review.body;
            const owner = ctx.payload.repository.owner.login;
            const repo = ctx.payload.repository.name;
            const prNum = ctx.payload.pull_request.number;
            async function addComment(comment: string) {
                await ctx.octokit.issues.createComment({
                    issue_number: prNum,
                    body: comment,
                    owner,
                    repo,
                });
            }
            async function dispatchEvent(event_type: string) {
                await ctx.octokit.repos.createDispatchEvent({
                    owner,
                    repo,
                    event_type: event_type,
                    client_payload: {
                        pr_num: prNum,
                    },
                });
            }

            if (reviewBody?.match(mergeCmdPat)) {
                await dispatchEvent("try-merge");
                await addComment("+1"); // REST API doesn't support reactions for code reviews.
            }
        }
    );
}

export default mergeBot;
