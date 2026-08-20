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
const PROBOT_CONFIG = "pytorch-probot.yml";
const LABELS_FILE = "labeler.yml";
const RATE_LIMITED = new Error("secondary rate limit");

function throwRateLimited(): any {
  throw RATE_LIMITED;
}

// Each entry is re-read per fetch so a test can swap a repo's reply mid-run.
function testContext(replies: { [fileName: string]: () => any }) {
  const log: any = jest.fn();
  log.error = jest.fn();
  return {
    repo: () => ({ owner: OWNER, repo: REPO }),
    log,
    config: jest.fn(async (fileName: string) => replies[fileName]()),
  } as any;
}

function expectRetainLogged(ctx: any) {
  expect(ctx.log.error).toHaveBeenCalledWith(
    expect.objectContaining({ key: KEY, err: RATE_LIMITED }),
    expect.any(String)
  );
}

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

type LabelerTrackerCtor = new (app: Probot) =>
  | CachedLabelerConfigTracker
  | LabelToLabelConfigTracker;

async function invalidate(probot: Probot) {
  await probot.receive({ name: "push", payload: pushToMain() as any, id: "1" });
}

// A tracker that has cached one good config and has since been invalidated by a
// push, i.e. the state in which the next read has to re-fetch.
async function primedConfigTracker() {
  const { probot, tracker } = loadTracker(
    (app) => new CachedConfigTracker(app)
  );
  const reply = { config: () => ({ generation: 1 } as any) };
  const ctx = testContext({ [PROBOT_CONFIG]: () => reply.config() });
  await tracker.loadConfig(ctx);
  await invalidate(probot);
  return { tracker, ctx, reply };
}

async function primedLabelsTracker(
  Tracker: LabelerTrackerCtor,
  configKey: string
) {
  const { probot, tracker } = loadTracker((app) => new Tracker(app));
  const reply = {
    config: () => ({ [configKey]: LABELS_FILE } as any),
    labels: () => ({ generation: 1 } as any),
  };
  const ctx = testContext({
    [PROBOT_CONFIG]: () => reply.config(),
    [LABELS_FILE]: () => reply.labels(),
  });
  await tracker.loadLabelsConfig(ctx);
  await invalidate(probot);
  return { tracker, ctx, reply };
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

  test("serves the retained config when the lazy re-fetch fails", async () => {
    const { tracker, ctx, reply } = await primedConfigTracker();
    reply.config = throwRateLimited;

    expect(await tracker.loadConfig(ctx)).toEqual({ generation: 1 });
    expect(ctx.config).toHaveBeenCalledTimes(2);
    expectRetainLogged(ctx);
  });

  test("keeps the key stale after a failed re-fetch so the next read tries again", async () => {
    const { tracker, ctx, reply } = await primedConfigTracker();
    reply.config = throwRateLimited;
    await tracker.loadConfig(ctx);

    reply.config = () => ({ generation: 2 });
    expect(await tracker.loadConfig(ctx)).toEqual({ generation: 2 });
    expect(ctx.config).toHaveBeenCalledTimes(3);
    // The fresh value is now the cached one.
    await tracker.loadConfig(ctx);
    expect(ctx.config).toHaveBeenCalledTimes(3);
  });

  test("throws when the fetch fails and nothing was ever cached", async () => {
    const { tracker } = loadTracker((app) => new CachedConfigTracker(app));
    const ctx = testContext({ [PROBOT_CONFIG]: throwRateLimited });

    await expect(tracker.loadConfig(ctx)).rejects.toThrow(
      "secondary rate limit"
    );
    expect(ctx.log.error).not.toHaveBeenCalled();
  });

  test("a null config is a cache hit and is retained across a failing re-fetch", async () => {
    const { probot, tracker } = loadTracker(
      (app) => new CachedConfigTracker(app)
    );
    const reply = { config: () => null as any };
    const ctx = testContext({ [PROBOT_CONFIG]: () => reply.config() });

    expect(await tracker.loadConfig(ctx)).toBeNull();
    expect(await tracker.loadConfig(ctx)).toBeNull();
    expect(ctx.config).toHaveBeenCalledTimes(1);

    await invalidate(probot);
    reply.config = throwRateLimited;
    expect(await tracker.loadConfig(ctx)).toBeNull();
    expect(ctx.config).toHaveBeenCalledTimes(2);
    expectRetainLogged(ctx);
  });

  test("force re-reads the config even on a cache hit", async () => {
    const { tracker } = loadTracker((app) => new CachedConfigTracker(app));
    const reply = { config: () => ({ generation: 1 } as any) };
    const ctx = testContext({ [PROBOT_CONFIG]: () => reply.config() });

    await tracker.loadConfig(ctx);
    await tracker.loadConfig(ctx);
    expect(ctx.config).toHaveBeenCalledTimes(1);

    reply.config = () => ({ generation: 2 });
    expect(await tracker.loadConfig(ctx, true)).toEqual({ generation: 2 });
    expect(ctx.config).toHaveBeenCalledTimes(2);
  });

  test("a forced re-read that fails serves the retained config and leaves the key stale", async () => {
    const { tracker } = loadTracker((app) => new CachedConfigTracker(app));
    const reply = { config: () => ({ generation: 1 } as any) };
    const ctx = testContext({ [PROBOT_CONFIG]: () => reply.config() });

    await tracker.loadConfig(ctx);
    reply.config = throwRateLimited;
    expect(await tracker.loadConfig(ctx, true)).toEqual({ generation: 1 });

    reply.config = () => ({ generation: 2 });
    expect(await tracker.loadConfig(ctx)).toEqual({ generation: 2 });
    expect(ctx.config).toHaveBeenCalledTimes(3);
  });

  const labelerTrackers: [string, LabelerTrackerCtor, string][] = [
    [
      "CachedLabelerConfigTracker",
      CachedLabelerConfigTracker,
      "labeler_config",
    ],
    [
      "LabelToLabelConfigTracker",
      LabelToLabelConfigTracker,
      "label_to_label_config",
    ],
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

  test.each(labelerTrackers)(
    "%s serves the retained labels when the lazy re-fetch fails",
    async (_name, Tracker, configKey) => {
      const { tracker, ctx, reply } = await primedLabelsTracker(
        Tracker,
        configKey
      );
      reply.labels = throwRateLimited;

      expect(await tracker.loadLabelsConfig(ctx)).toEqual({ generation: 1 });
      expectRetainLogged(ctx);
    }
  );

  test.each(labelerTrackers)(
    "%s serves the retained labels when the config read itself fails",
    async (_name, Tracker) => {
      const { tracker } = loadTracker((app) => new Tracker(app));
      tracker.lastKnownGoodLabels[KEY] = { generation: 1 };
      const ctx = testContext({ [PROBOT_CONFIG]: throwRateLimited });

      expect(await tracker.loadLabelsConfig(ctx)).toEqual({ generation: 1 });
      expectRetainLogged(ctx);
    }
  );

  test.each(labelerTrackers)(
    "%s keeps the labels key stale after a failed re-fetch so the next read tries again",
    async (_name, Tracker, configKey) => {
      const { tracker, ctx, reply } = await primedLabelsTracker(
        Tracker,
        configKey
      );
      reply.labels = throwRateLimited;
      await tracker.loadLabelsConfig(ctx);

      reply.labels = () => ({ generation: 2 });
      expect(await tracker.loadLabelsConfig(ctx)).toEqual({ generation: 2 });
    }
  );

  test.each(labelerTrackers)(
    "%s throws when the labels fetch fails and nothing was ever cached",
    async (_name, Tracker, configKey) => {
      const { tracker } = loadTracker((app) => new Tracker(app));
      const ctx = testContext({
        [PROBOT_CONFIG]: () => ({ [configKey]: LABELS_FILE }),
        [LABELS_FILE]: throwRateLimited,
      });

      await expect(tracker.loadLabelsConfig(ctx)).rejects.toThrow(
        "secondary rate limit"
      );
      expect(ctx.log.error).not.toHaveBeenCalled();
    }
  );

  test.each(labelerTrackers)(
    "%s null labels are a cache hit and are retained across a failing re-fetch",
    async (_name, Tracker, configKey) => {
      const { probot, tracker } = loadTracker((app) => new Tracker(app));
      const reply = { labels: () => null as any };
      const ctx = testContext({
        [PROBOT_CONFIG]: () => ({ [configKey]: LABELS_FILE }),
        [LABELS_FILE]: () => reply.labels(),
      });

      expect(await tracker.loadLabelsConfig(ctx)).toBeNull();
      expect(await tracker.loadLabelsConfig(ctx)).toBeNull();
      // One config read plus one labels read; neither repeated on the cache hit.
      expect(ctx.config).toHaveBeenCalledTimes(2);

      await invalidate(probot);
      reply.labels = throwRateLimited;
      expect(await tracker.loadLabelsConfig(ctx)).toBeNull();
      expectRetainLogged(ctx);
    }
  );

  test.each(labelerTrackers)(
    "%s force re-reads both the config and the labels file",
    async (_name, Tracker, configKey) => {
      const { tracker } = loadTracker((app) => new Tracker(app));
      const reply = { labels: () => ({ generation: 1 } as any) };
      const ctx = testContext({
        [PROBOT_CONFIG]: () => ({ [configKey]: LABELS_FILE }),
        [LABELS_FILE]: () => reply.labels(),
      });

      await tracker.loadLabelsConfig(ctx);
      await tracker.loadLabelsConfig(ctx);
      expect(ctx.config).toHaveBeenCalledTimes(2);

      reply.labels = () => ({ generation: 2 });
      expect(await tracker.loadLabelsConfig(ctx, true)).toEqual({
        generation: 2,
      });
      expect(ctx.config).toHaveBeenCalledTimes(4);
    }
  );

  test.each(labelerTrackers)(
    "%s concurrent readers share a single in-flight labels fetch",
    async (_name, Tracker, configKey) => {
      const { tracker } = loadTracker((app) => new Tracker(app));
      let release!: (_labels: any) => void;
      const inFlight = new Promise((resolve) => {
        release = resolve;
      });
      const ctx = testContext({
        [PROBOT_CONFIG]: () => ({ [configKey]: LABELS_FILE }),
        [LABELS_FILE]: () => inFlight,
      });

      const first = tracker.loadLabelsConfig(ctx);
      await new Promise((resolve) => setImmediate(resolve));
      const second = tracker.loadLabelsConfig(ctx);
      release({ generation: 1 });

      expect(await first).toEqual({ generation: 1 });
      expect(await second).toEqual({ generation: 1 });
      expect(ctx.config).toHaveBeenCalledTimes(2);
    }
  );
});
