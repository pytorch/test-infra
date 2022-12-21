import nock from "nock";
import * as utils from "./utils";
import myProbotApp from "../lib/bot/retryBot";
import { handleScope, requireDeepCopy } from "./common";
import { Probot } from "probot";

nock.disableNetConnect();

describe("retry-bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("rerun when one job fails", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "pull";
    const workflow_jobs = requireDeepCopy("./fixtures/workflow_jobs.json");
    workflow_jobs.jobs[0].conclusion = "failure";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const attempt_number = event.payload.workflow_run.run_attempt;
    const run_id = event.payload.workflow_run.id;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=1&per_page=100`
      )
      .reply(200, workflow_jobs)
      .post(
        `/repos/${owner}/${repo}/actions/jobs/${workflow_jobs.jobs[0].id}/rerun`
      )
      .reply(200);

    await probot.receive(event);
    handleScope(scope);
  });

  test("rerun when workflow name starts with a valid prefix", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "linux-binary-manywheel";
    const workflow_jobs = requireDeepCopy("./fixtures/workflow_jobs.json");
    workflow_jobs.jobs[0].conclusion = "failure";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const attempt_number = event.payload.workflow_run.run_attempt;
    const run_id = event.payload.workflow_run.id;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=1&per_page=100`
      )
      .reply(200, workflow_jobs)
      .post(
        `/repos/${owner}/${repo}/actions/jobs/${workflow_jobs.jobs[0].id}/rerun`
      )
      .reply(200);

    await probot.receive(event);
    handleScope(scope);
  });

  test("rerun lint if no nonretryable step failed", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "Lint";
    const workflow_jobs = requireDeepCopy("./fixtures/workflow_jobs.json");
    workflow_jobs.jobs[0].conclusion = "failure";
    workflow_jobs.jobs[1].conclusion = "failure";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const attempt_number = event.payload.workflow_run.run_attempt;
    const run_id = event.payload.workflow_run.id;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=1&per_page=100`
      )
      .reply(200, workflow_jobs)
      .post(`/repos/${owner}/${repo}/actions/runs/${run_id}/rerun-failed-jobs`)
      .reply(200);

    await probot.receive(event);
    handleScope(scope);
  });

  test("don't rerun lint if nonretryable step failed", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "Lint";
    const workflow_jobs = requireDeepCopy("./fixtures/workflow_jobs.json");
    workflow_jobs.jobs[3].conclusion = "failure";
    workflow_jobs.jobs[3].steps[0].name = "Do the lints (nonretryable)"
    workflow_jobs.jobs[3].steps[0].conclusion = "failure"

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const attempt_number = event.payload.workflow_run.run_attempt;
    const run_id = event.payload.workflow_run.id;
    
    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=1&per_page=100`
      )
      .reply(200, workflow_jobs)

    await probot.receive(event);
    handleScope(scope);
  });

  test("dont rerun if failed at test step if possible", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "pull";
    const workflow_jobs = requireDeepCopy("./fixtures/workflow_jobs.json");
    workflow_jobs.jobs[0].conclusion = "failure";
    workflow_jobs.jobs[4].conclusion = "failure";
    workflow_jobs.jobs[4].steps[0].conclusion = "failure";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const attempt_number = event.payload.workflow_run.run_attempt;
    const run_id = event.payload.workflow_run.id;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=1&per_page=100`
      )
      .reply(200, workflow_jobs)
      .post(`/repos/${owner}/${repo}/actions/jobs/${workflow_jobs.jobs[0].id}/rerun`)
      .reply(200);

    await probot.receive(event);
    handleScope(scope);
  });

  test("dont rerun if has already been rerun", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "pull";
    event.payload.workflow_run.run_attempt = 2;

    const scope = nock("https://api.github.com")

    await probot.receive(event);
    handleScope(scope);
  });


  test("get more pages of workflow_jobs", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "Lint";
    const workflow_jobs1 = requireDeepCopy("./fixtures/workflow_jobs.json");
    const workflow_jobs2 = requireDeepCopy("./fixtures/workflow_jobs.json");
    workflow_jobs2.jobs[0].conclusion = "failure";
    workflow_jobs2.jobs[1].conclusion = "failure";
    workflow_jobs1["total_count"] = 140;
    workflow_jobs2["total_count"] = 140;

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const attempt_number = event.payload.workflow_run.run_attempt;
    const run_id = event.payload.workflow_run.id;


    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=1&per_page=100`
      )
      .reply(200, workflow_jobs1)
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=2&per_page=100`
      )
      .reply(200, workflow_jobs2)
      .post(`/repos/${owner}/${repo}/actions/runs/${run_id}/rerun-failed-jobs`)
      .reply(200);

    await probot.receive(event);
    handleScope(scope);
  });
});
