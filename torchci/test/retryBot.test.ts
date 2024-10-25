import nock from "nock";
import { Probot } from "probot";
import myProbotApp from "../lib/bot/retryBot";
import * as clickhouse from "../lib/clickhouse";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

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
      .reply(200)
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(
        200,
        '{retryable_workflows: ["pull", "trunk", "linux-binary", "windows-binary"]}'
      );

    const mock = jest.spyOn(clickhouse, "queryClickhouseSaved");
    mock.mockImplementation(() => Promise.resolve([]));

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
      .reply(200)
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(
        200,
        '{retryable_workflows: ["pull", "trunk", "linux-binary", "windows-binary"]}'
      );

    const mock = jest.spyOn(clickhouse, "queryClickhouseSaved");
    mock.mockImplementation(() => Promise.resolve([]));

    await probot.receive(event);

    handleScope(scope);
  });

  test("dont rerun if failed at test step", async () => {
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
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(
        200,
        '{retryable_workflows: ["pull", "trunk", "linux-binary", "windows-binary"]}'
      )
      .post(
        `/repos/${owner}/${repo}/actions/jobs/${workflow_jobs.jobs[0].id}/rerun`
      )
      .reply(200);

    const mock = jest.spyOn(clickhouse, "queryClickhouseSaved");
    mock.mockImplementation(() => Promise.resolve([]));

    await probot.receive(event);

    handleScope(scope);
  });

  test("dont rerun unstable jobs", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "pull";
    const workflow_jobs = requireDeepCopy("./fixtures/workflow_jobs.json");
    workflow_jobs.jobs[4].name = `${workflow_jobs.jobs[0].name} (unstable)`;
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
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(
        200,
        '{retryable_workflows: ["pull", "trunk", "linux-binary", "windows-binary"]}'
      );

    const mock = jest.spyOn(clickhouse, "queryClickhouseSaved");
    mock.mockImplementation(() => Promise.resolve([]));

    await probot.receive(event);

    handleScope(scope);
  });

  test("rerun previous workflow if it has more than one flaky jobs in trunk", async () => {
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
    const prev_run_id = 1;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=1&per_page=100`
      )
      .reply(200, workflow_jobs)
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(
        200,
        '{retryable_workflows: ["pull", "trunk", "linux-binary", "windows-binary"]}'
      )
      .post(
        `/repos/${owner}/${repo}/actions/runs/${prev_run_id}/rerun-failed-jobs`
      ) // Retry previous workflow
      .reply(200)
      .post(
        `/repos/${owner}/${repo}/actions/jobs/${workflow_jobs.jobs[0].id}/rerun` // Retry eligible jobs in the current workflow
      )
      .reply(200);

    // 2 out of 3 previous jobs are flaky
    const mock = jest.spyOn(clickhouse, "queryClickhouseSaved");
    mock.mockImplementation(() =>
      Promise.resolve([
        { workflow_id: prev_run_id, job_id: 1 },
        { workflow_id: prev_run_id, job_id: 3 },
      ])
    );

    await probot.receive(event);

    handleScope(scope);
  });

  test("rerun previous job if it is flaky in trunk", async () => {
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
    const prev_run_id = 1;
    const prev_job_id = 1;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=1&per_page=100`
      )
      .reply(200, workflow_jobs)
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(
        200,
        '{retryable_workflows: ["pull", "trunk", "linux-binary", "windows-binary"]}'
      )
      .post(
        `/repos/${owner}/${repo}/actions/runs/${prev_run_id}/rerun-failed-jobs`
      ) // Retry previous workflow
      .reply(200)
      .post(
        `/repos/${owner}/${repo}/actions/jobs/${workflow_jobs.jobs[0].id}/rerun` // Retry eligible jobs in the current workflow
      )
      .reply(200);

    const mock = jest.spyOn(clickhouse, "queryClickhouseSaved");
    // Only the first job are flaky
    mock.mockImplementation(() =>
      Promise.resolve([{ workflow_id: prev_run_id, job_id: prev_job_id }])
    );

    await probot.receive(event);

    handleScope(scope);
  });

  test("Check the previous job whether the current one fails or not", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.conclusion = "success";
    event.payload.workflow_run.name = "pull";
    const workflow_jobs = requireDeepCopy("./fixtures/workflow_jobs.json");

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const attempt_number = event.payload.workflow_run.run_attempt;
    const run_id = event.payload.workflow_run.id;
    const prev_run_id = 1;
    const prev_job_id = 1;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/actions/runs/${run_id}/attempts/${attempt_number}/jobs?page=1&per_page=100`
      )
      .reply(200, workflow_jobs)
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(
        200,
        '{retryable_workflows: ["pull", "trunk", "linux-binary", "windows-binary"]}'
      )
      .post(
        `/repos/${owner}/${repo}/actions/runs/${prev_run_id}/rerun-failed-jobs`
      ) // Retry previous workflow
      .reply(200);

    const mock = jest.spyOn(clickhouse, "queryClickhouseSaved");
    // Only the first job are flaky
    mock.mockImplementation(() =>
      Promise.resolve([{ workflow_id: prev_run_id, job_id: prev_job_id }])
    );

    await probot.receive(event);

    handleScope(scope);
  });

  test("dont rerun if has already been rerun", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "pull";
    event.payload.workflow_run.run_attempt = 2;

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(
        200,
        '{retryable_workflows: ["pull", "trunk", "linux-binary", "windows-binary"]}'
      );

    await probot.receive(event);

    handleScope(scope);
  });

  test("get more pages of workflow_jobs", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "Pull";
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
      .reply(200)
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(
        200,
        '{retryable_workflows: ["pull", "trunk", "linux-binary", "windows-binary"]}'
      );

    const mock = jest.spyOn(clickhouse, "queryClickhouseSaved");
    mock.mockImplementation(() => Promise.resolve([]));

    await probot.receive(event);

    handleScope(scope);
  });

  test("dont re-run unless retryable_workflows is specified in .github/pytorch-probot.yml", async () => {
    const event = requireDeepCopy("./fixtures/workflow_run.completed.json");
    event.payload.workflow_run.name = "pull";
    event.payload.workflow_run.run_attempt = 1;

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, "{foo: bar}");

    await probot.receive(event);

    handleScope(scope);
  });
});
