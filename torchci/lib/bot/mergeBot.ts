import { Probot } from "probot";
import { addComment, reactOnComment } from "./botUtils";
import { getCommand, getOptions, parseComment } from "./cliParser";

function mergeBot(app: Probot): void {
    const mergeCmdPat = new RegExp(
        "^\\s*@pytorch(merge|)bot\\s+(force\\s+)?merge\\s+this\\s*(on\\s*green)?"
    );
    const revertCmdPat = new RegExp(
        "^\\s*@pytorch(merge|)bot\\s+revert\\s+this"
    );
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

        async function handleConfused() {
            await reactOnComment(ctx, "confused");
        }
        async function handleMerge(force: boolean, mergeOnGreen: boolean) {
            await dispatchEvent("try-merge", force, mergeOnGreen);
            await reactOnComment(ctx, "+1");
        }

        async function handleRevert() {
            await dispatchEvent("try-revert");
            await reactOnComment(ctx, "+1");
        }

        async function handleRebase() {
            await dispatchEvent("try-rebase");
            await reactOnComment(ctx, "+1");
        }

        async function handleHelp() {
            await addComment(
                ctx,
                "To see all options for pytorchbot, " +
                    "please refer to this [page](https://github.com/pytorch/pytorch/wiki/Bot-commands)."
            );
        }

        const match = commentBody.match(mergeCmdPat);
        if (match) {
            if (!ctx.payload.issue.pull_request) {
                // Issue, not pull request.
                await handleConfused();
                return;
            }
            await handleMerge(
                typeof match[2] === "string",
                typeof match[3] === "string"
            );
            return;
        } else if (commentBody.match(revertCmdPat)) {
            if (!ctx.payload.issue.pull_request) {
                // Issue, not pull request.
                await handleConfused();
                return;
            }
            const revertWithReasonCmdPat = new RegExp(
                "^\\s*@pytorch(merge|)bot\\s+revert\\s+this(.|\\s)*(\\s+\\w+.*){3,}"
            );
            if (commentBody.match(revertWithReasonCmdPat) === null) {
                // revert reason of 3+ words not given
                await addComment(
                    ctx,
                    "Revert unsuccessful: please retry the command and provide a revert reason, " +
                        "e.g. @pytorchbot revert this as it breaks mac tests on trunk, see {url to logs}."
                );
                return;
            }
            await handleRevert();
            return;
        } else if (
            commentBody.match(rebaseCmdPat) &&
            ((rebaseAllowList.includes(ctx.payload.comment.user.login) &&
                rebaseAllowList.includes(ctx.payload.issue.user.login)) ||
                ctx.payload.comment.user.login == ctx.payload.issue.user.login)
        ) {
            if (!ctx.payload.issue.pull_request) {
                // Issue, not pull request.
                await handleConfused();
                return;
            }
            await handleRebase();
            return;
        }

        const commentOptions = parseComment(commentBody);
        const cmd = getCommand(commentOptions);
        const option = getOptions(cmd, commentOptions);
        // TODO: Remove old way of parsing inputs
        if (cmd != null && option != null) {
            if (cmd === "revert") {
                if (
                    option["message"] == null ||
                    option["message"].split(" ").length < 3
                ) {
                    await addComment(
                        ctx,
                        "Revert unsuccessful: please retry the command and provide a revert reason, " +
                            `e.g. @pytorchbot revert -m="this breaks mac tests on trunk" -l="{failureUrl}".`
                    );
                    return;
                }
                if (option["link"] == null || option["link"].length == 0) {
                    await addComment(
                        ctx,
                        "Revert unsuccessful: please retry the command and provide a revert reason, " +
                            `e.g. @pytorchbot revert -m="this breaks mac tests on trunk" -l="{failureUrl}".`
                    );
                    return;
                }
                await handleRevert();
            } else if (cmd === "merge") {
                await handleMerge(option["force"], option["green"]);
            } else if (cmd === "rebase") {
                await handleRebase();
            } else if (cmd === "help") {
                await handleHelp();
            } else {
                await handleConfused();
            }
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
