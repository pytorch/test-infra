import { getOctokit } from "lib/github";
import { Octokit } from "octokit";
import fetchRecentWorkflows from "lib/fetchRecentWorkflows";
import { RecentWorkflowsData } from "lib/types";
import * as drciUtils from "lib/drciUtils";


export async function fetchWorkflows() {
    const recentWorkflows: RecentWorkflowsData[] = await fetchRecentWorkflows(
        drciUtils.NUM_MINUTES + ""
    );
}

export async function updateCommentWithWorkflow(
    workflow: RecentWorkflowsData,
    octokit: Octokit
): Promise<void> {

    const { pr_number, owner_login } = workflow;
    if (!drciUtils.POSSIBLE_USERS.includes(owner_login)) {
        console.log("did not make a comment");
        return;
    }
    const { id, body } = await getDrciComment(
        pr_number,
        owner_login,
        drciUtils.REPO
    );

    const drciComment = drciUtils.formDrciComment(pr_number);

    if (id === 0) {
        return;
    }
    if (body === drciComment) {
        return;
    }
    await octokit.rest.issues.updateComment({
        body: body,
        owner: owner_login,
        repo: drciUtils.REPO,
        comment_id: id,
    });
}

async function getDrciComment(
    prNum: number,
    owner: string,
    repo: string
): Promise<{ id: number; body: string }> {

    const octokit = await getOctokit(owner, repo);
    const commentsRes = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNum,
    });
    for (const comment of commentsRes.data) {
        if (comment.body!.includes(drciUtils.DRCI_COMMENT_START)) {
            return { id: comment.id, body: comment.body! };
        }
    }
    return { id: 0, body: "" };
}
