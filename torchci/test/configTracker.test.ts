import {
  CachedConfigTracker,
  CachedLabelerConfigTracker,
  LabelToLabelConfigTracker,
} from "lib/bot/utils";
import nock from "nock";
import { Probot } from "probot";
import * as utils from "./utils";

nock.disableNetConnect();

const OWNER = "pytorch";
const REPO = "pytorch";
const KEY = `${OWNER}/${REPO}`;

function pushToMain() {
  return {
    ref: "refs/heads/main",
    repository: {
      name: REPO,
      full_name: KEY,
      owner: { login: OWNER, name: OWNER },
    },
    installation: { id: 2 },
  };
}

function loadTracker<T extends CachedConfigTracker>(
  make: (app: Probot) => T
): { probot: Probot; tracker: T } {
  const probot = utils.testProbot();
  let tracker!: T;
  probot.load((app) => {
    tracker = make(app);
  });
  return { probot, tracker };
}

describe("CachedConfigTracker push-driven cache invalidation", () => {
  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("push to main invalidates the config cache without an eager fetch, next access re-fetches lazily", async () => {
    const { probot, tracker } = loadTracker(
      (app) => new CachedConfigTracker(app)
    );
    tracker.repoConfigs[KEY] = { cached: "stale" };

    // Net connections are disabled and no config interceptor is registered, so an
    // eager getContent fetch would throw; a clean resolve proves none happened.
    await probot.receive({
      name: "push",
      payload: pushToMain() as any,
      id: "1",
    });
    expect(KEY in tracker.repoConfigs).toBe(false);

    const ctx = {
      repo: () => ({ owner: OWNER, repo: REPO }),
      log: jest.fn(),
      config: jest.fn().mockResolvedValue({ fresh: true }),
    } as any;
    expect(await tracker.loadConfig(ctx)).toEqual({ fresh: true });
    expect(ctx.config).toHaveBeenCalledTimes(1);
    // Now re-cached: a subsequent access does not fetch again.
    await tracker.loadConfig(ctx);
    expect(ctx.config).toHaveBeenCalledTimes(1);
  });

  const labelerTrackers: [
    string,
    new (app: Probot) => CachedLabelerConfigTracker | LabelToLabelConfigTracker
  ][] = [
    ["CachedLabelerConfigTracker", CachedLabelerConfigTracker],
    ["LabelToLabelConfigTracker", LabelToLabelConfigTracker],
  ];

  test.each(labelerTrackers)(
    "%s push to main invalidates both the config and labels caches without an eager fetch",
    async (_name, Tracker) => {
      const { probot, tracker } = loadTracker((app) => new Tracker(app));
      tracker.repoConfigs[KEY] = { cached: "stale" };
      tracker.repoLabels[KEY] = { cached: "stale-labels" };

      await probot.receive({
        name: "push",
        payload: pushToMain() as any,
        id: "1",
      });

      // Both must be cleared: repoConfigs holds the labeler-file pointer, repoLabels
      // holds the parsed labeler data; keeping either serves stale results.
      expect(KEY in tracker.repoConfigs).toBe(false);
      expect(KEY in tracker.repoLabels).toBe(false);
    }
  );
});
