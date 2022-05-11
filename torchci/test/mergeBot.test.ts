import nock from "nock";
import * as probot from "probot";
import * as utils from "./utils";
import mergeBot from "../lib/bot/mergeBot";

nock.disableNetConnect();

describe("merge-bot", () => {
    let probot: probot.Probot;

    beforeEach(() => {
        probot = utils.testProbot();
        probot.load(mergeBot);
    });

    afterEach(() => {
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    test("random pr comment no reaction", async () => {
        const event = require("./fixtures/pull_request_comment.json");
        const scope = nock("https://api.github.com");
        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("random issue comment no event", async () => {
        const event = require("./fixtures/issue_comment.json");
        const scope = nock("https://api.github.com");
        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("random pull request reivew no event", async () => {
        const event = require("./fixtures/pull_request_review.json");
        const scope = nock("https://api.github.com");
        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("quoted merge/revert command no event", async () => {
        const merge_event = require("./fixtures/issue_comment.json");
        merge_event.payload.comment.body = "> @pytorchbot merge this";
        const revert_event = require("./fixtures/issue_comment.json");
        revert_event.payload.comment.body = "> @pytorchbot revert this";
        const rebase_event = require("./fixtures/issue_comment.json");
        rebase_event.payload.comment.body = "> @pytorchbot rebase this";
        const scope = nock("https://api.github.com");
        await probot.receive(merge_event);
        await probot.receive(revert_event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("merge this comment on issue triggers confused reaction", async () => {
        const event = require("./fixtures/issue_comment.json");
        event.payload.comment.body = "@pytorchbot merge this";

        const owner = event.payload.repository.owner.login;
        const repo = event.payload.repository.name;
        const comment_number = event.payload.comment.id;
        const scope = nock("https://api.github.com")
            .post(
                `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
                (body) => {
                    expect(JSON.stringify(body)).toContain(
                        '{"content":"confused"}'
                    );
                    return true;
                }
            )
            .reply(200, {});

        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("merge this comment on pull request triggers dispatch and like", async () => {
        const event = require("./fixtures/pull_request_comment.json");

        event.payload.comment.body = "@pytorchbot merge this";

        const owner = event.payload.repository.owner.login;
        const repo = event.payload.repository.name;
        const pr_number = event.payload.issue.number;
        const comment_number = event.payload.comment.id;
        const scope = nock("https://api.github.com")
            .post(
                `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
                (body) => {
                    expect(JSON.stringify(body)).toContain('{"content":"+1"}');
                    return true;
                }
            )
            .reply(200, {})
            .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
                expect(JSON.stringify(body)).toContain(
                    `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number}}}`
                );
                return true;
            })
            .reply(200, {});

        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("force merge this comment on pull request triggers dispatch and like", async () => {
        const event = require("./fixtures/pull_request_comment.json");

        event.payload.comment.body = "@pytorchbot    force  merge this";

        const owner = event.payload.repository.owner.login;
        const repo = event.payload.repository.name;
        const pr_number = event.payload.issue.number;
        const comment_number = event.payload.comment.id;
        const scope = nock("https://api.github.com")
            .post(
                `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
                (body) => {
                    expect(JSON.stringify(body)).toContain('{"content":"+1"}');
                    return true;
                }
            )
            .reply(200, {})
            .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
                expect(JSON.stringify(body)).toContain(
                    `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"force":true}}`
                );
                return true;
            })
            .reply(200, {});

        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("merge this on green comment on pull request triggers dispatch and like", async () => {
        const event = require("./fixtures/pull_request_comment.json");

        event.payload.comment.body = "@pytorchbot merge this on green";

        const owner = event.payload.repository.owner.login;
        const repo = event.payload.repository.name;
        const pr_number = event.payload.issue.number;
        const comment_number = event.payload.comment.id;
        const scope = nock("https://api.github.com")
            .post(
                `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
                (body) => {
                    expect(JSON.stringify(body)).toContain('{"content":"+1"}');
                    return true;
                }
            )
            .reply(200, {})
            .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
                expect(JSON.stringify(body)).toContain(
                    `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"on_green":true}}`
                );
                return true;
            })
            .reply(200, {});
        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });
    test("revert this comment w/o explanation on pull request triggers comment only", async () => {
        const event = require("./fixtures/pull_request_comment.json");

        event.payload.comment.body = "@pytorchbot  revert this";
        const owner = event.payload.repository.owner.login;
        const repo = event.payload.repository.name;
        const pr_number = event.payload.issue.number;

        const scope = nock("https://api.github.com")
            .post(
                `/repos/${owner}/${repo}/issues/${pr_number}/comments`,
                (body) => {
                    expect(JSON.stringify(body)).toContain(
                        "Revert unsuccessful: please retry the command explaining why the revert is " +
                        "necessary, e.g. @pytorchbot revert this as it breaks mac tests on trunk, see {url to logs}."
                    );
                    return true;
                }
            )
            .reply(200);

        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("revert this comment w/ explanation on pull request triggers dispatch and like", async () => {
        const event = require("./fixtures/pull_request_comment.json");

        event.payload.comment.body =
            "@pytorchbot  revert this--\n\nbreaks master: " +
            "https://hud.pytorch.org/minihud?name_filter=trunk%20/%20ios-12-5-1-x86-64-coreml%20/%20build";

        const owner = event.payload.repository.owner.login;
        const repo = event.payload.repository.name;
        const pr_number = event.payload.issue.number;
        const comment_number = event.payload.comment.id;
        const scope = nock("https://api.github.com")
            .post(
                `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
                (body) => {
                    expect(JSON.stringify(body)).toContain('{"content":"+1"}');
                    return true;
                }
            )
            .reply(200, {})
            .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
                expect(JSON.stringify(body)).toContain(
                    `{"event_type":"try-revert","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number}}}`
                );
                return true;
            })
            .reply(200, {});

        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("rebase this comment on pull request triggers dispatch and like", async () => {
        const event = require("./fixtures/pull_request_comment.json");

        event.payload.comment.body = "@pytorchbot rebase this";
        event.payload.comment.user.login = "clee2000";
        event.payload.issue.user.login = "clee2000";

        const owner = event.payload.repository.owner.login;
        const repo = event.payload.repository.name;
        const pr_number = event.payload.issue.number;
        const comment_number = event.payload.comment.id;
        const scope = nock("https://api.github.com")
            .post(
                `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
                (body) => {
                    expect(JSON.stringify(body)).toContain(`{"content":"+1"}`);
                    return true;
                }
            )
            .reply(200, {})
            .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
                expect(JSON.stringify(body)).toContain(
                    `{"event_type":"try-rebase","client_payload":{"pr_num":${pr_number}`
                );
                return true;
            })
            .reply(200, {});

        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("merge this pull request review triggers dispatch and +1 comment", async () => {
        const event = require("./fixtures/pull_request_review.json");

        event.payload.review.body = "@pytorchbot merge this";

        const owner = event.payload.repository.owner.login;
        const repo = event.payload.repository.name;
        const pr_number = event.payload.pull_request.number;
        const scope = nock("https://api.github.com")
            .post(
                `/repos/${owner}/${repo}/issues/${pr_number}/comments`,
                (body) => {
                    expect(JSON.stringify(body)).toContain('{"body":"+1"}');
                    return true;
                }
            )
            .reply(200, {})
            .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
                expect(JSON.stringify(body)).toContain(
                    `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number}}}`
                );
                return true;
            })
            .reply(200, {});

        await probot.receive(event);
        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });
});
