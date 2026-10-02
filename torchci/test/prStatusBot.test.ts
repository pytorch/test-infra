import prStatusBot from "lib/bot/prStatusBot";
import { upsertPrStatusSection } from "lib/drciUtils";
import nock from "nock";
import { Probot } from "probot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

// The status refresh is covered elsewhere; here it only shows the event fell
// through to it.
jest.mock("lib/drciUtils", () => ({ upsertPrStatusSection: jest.fn() }));

function labeledEvent(label: string, labels: string[]) {
  const payload = requireDeepCopy("./fixtures/pull_request.labeled.json");
  payload.repository.owner.login = "pytorch";
  payload.repository.name = "pytorch";
  payload.repository.full_name = "pytorch/pytorch";
  payload.label.name = label;
  payload.pull_request.labels = labels.map((name) => ({ name }));
  return { name: "pull_request", payload, id: "2" } as any;
}

describe("prStatusBot opt-out", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(prStatusBot);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test.each(["no automated review", "in progress"])(
    "moves a PR with both labels to ready for review when %s arrives",
    async (label) => {
      const event = labeledEvent(label, ["in progress", "no automated review"]);
      const prNumber = event.payload.pull_request.number;
      const add = utils.mockAddLabels(
        ["ready for review"],
        "pytorch/pytorch",
        prNumber
      );
      // Add before remove, so the PR always has a status label
      const remove = nock("https://api.github.com")
        .delete(
          `/repos/pytorch/pytorch/issues/${prNumber}/labels/in%20progress`
        )
        .reply(() => {
          expect(add.isDone()).toBe(true);
          return [200, []];
        });

      await probot.receive(event);
      handleScope([add, remove]);
    }
  );

  test("refreshes the status of an in-progress PR that has not opted out", async () => {
    // Any label write fails the test, since net connect is disabled
    await probot.receive(labeledEvent("in progress", ["in progress"]));
    expect(upsertPrStatusSection).toHaveBeenCalled();
  });

  test("leaves a PR that is not in progress alone", async () => {
    // Any GitHub call fails the test, since net connect is disabled
    await probot.receive(
      labeledEvent("no automated review", ["no automated review"])
    );
  });
});
