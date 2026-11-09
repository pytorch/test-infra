import {
  clearConfigCache,
  CONFIG_TTL_MS,
  fillTemplate,
  loadReleaseConfig,
  loadSharedConfig,
  minorOf,
  releaseType,
  resolveRelease,
} from "lib/api/releases/config";
import { ReleaseConfigSchema } from "lib/api/releases/types";
import { committedFetch, SHARED, step } from "./fixtures";

describe("resolving a release", () => {
  test("a version says its type and branch", () => {
    expect(releaseType("2.16.0")).toBe("minor");
    expect(releaseType("2.15.1")).toBe("patch");
    expect(minorOf("2.15.1")).toBe("2.15");
    const resolved = resolveRelease(SHARED, null, "2.15.1");
    expect(resolved).toMatchObject({ type: "patch", branch: "release/2.15" });
  });

  test("a patch release leaves out the minor-only steps and the dependencies on them", () => {
    const patch = resolveRelease(SHARED, null, "2.15.1");
    expect(patch.steps.map((s) => s.id)).toEqual(["1.2", "2.1", "2.2"]);
    expect(patch.steps.find((s) => s.id === "2.1")?.depends_on).toEqual([
      "1.2",
    ]);
    const minor = resolveRelease(SHARED, null, "2.16.0");
    expect(minor.steps.map((s) => s.id)).toEqual(["1.1", "1.2", "2.1", "2.2"]);
    expect(minor.steps.find((s) => s.id === "2.1")?.depends_on).toEqual([
      "1.1",
      "1.2",
    ]);
  });

  test("remove, override and add, in that order", () => {
    const resolved = resolveRelease(
      SHARED,
      {
        release: "2.16.0",
        remove: ["1.1"],
        override: { "2.1": { owner: "docs-team" }, "1.2": { tier: null } },
        add: [step({ id: "2.3", name: "Extra" })],
      },
      "2.16.0"
    );
    const byId = Object.fromEntries(resolved.steps.map((s) => [s.id, s]));
    expect(Object.keys(byId)).toEqual(["1.2", "2.1", "2.2", "2.3"]);
    expect(byId["2.1"].owner).toBe("docs-team");
    expect("tier" in byId["1.2"]).toBe(false);
    expect(byId["2.3"].name).toBe("Extra");
    expect(byId["2.1"].depends_on).toEqual(["1.2"]);
  });

  test("never changes the shared config", () => {
    const before = JSON.stringify(SHARED);
    resolveRelease(
      SHARED,
      {
        release: "2.16.0",
        remove: ["1.1"],
        override: { "2.1": { owner: "x" } },
      },
      "2.16.0"
    );
    expect(JSON.stringify(SHARED)).toBe(before);
  });

  test("dates and links default to null", () => {
    const resolved = resolveRelease(SHARED, null, "2.16.0");
    expect(resolved.dates).toEqual({
      branch_cut: null,
      final_rc: null,
      ga: null,
    });
    expect(resolved.links).toEqual({
      milestone: null,
      tracker_issue: null,
      validation_issue: null,
    });
  });
});

describe("fillTemplate", () => {
  test("fills what it has and gives null when a value is missing", () => {
    expect(
      fillTemplate("https://x/{minor}/{rc}", { minor: "2.16", rc: "rc1" })
    ).toBe("https://x/2.16/rc1");
    expect(fillTemplate("https://x/{rc}", { rc: null })).toBeNull();
    expect(fillTemplate("https://x/{nope}", {})).toBeNull();
    expect(fillTemplate("https://x/none", {})).toBe("https://x/none");
  });
});

describe("the committed config", () => {
  beforeEach(() => {
    clearConfigCache();
    global.fetch = committedFetch() as unknown as typeof fetch;
  });

  test("resolves for 2.16.0 and 2.15.1, and matches the response schema", async () => {
    const minor = (await loadReleaseConfig("2.16.0")).config;
    const patch = (await loadReleaseConfig("2.15.1")).config;
    expect(ReleaseConfigSchema.parse(minor)).toEqual(minor);
    expect(ReleaseConfigSchema.parse(patch)).toEqual(patch);
    expect(minor.steps).toHaveLength(46);
    expect(patch.steps).toHaveLength(34);
    expect(minor.dates).toEqual({
      branch_cut: "2026-11-30",
      final_rc: "2026-12-07",
      ga: "2026-12-17",
    });
    expect(patch.dates).toEqual({ branch_cut: null, final_rc: null, ga: null });
    expect(minor).toMatchObject({ type: "minor", branch: "release/2.16" });
    expect(patch).toMatchObject({ type: "patch", branch: "release/2.15" });
  });

  test("a patch release has no branch cut and the milestone check applies to both", async () => {
    const patch = (await loadReleaseConfig("2.15.1")).config;
    const ids = patch.steps.map((s) => s.id);
    expect(ids).not.toContain("1.8");
    expect(ids).toContain("1.2");
    expect(ids).toContain("2.13");
    const step21 = patch.steps.find((s) => s.id === "2.1");
    expect(step21?.depends_on).toEqual([]);
    const minor = (await loadReleaseConfig("2.16.0")).config;
    expect(minor.steps.find((s) => s.id === "2.1")?.depends_on).toEqual([
      "1.11",
    ]);
  });

  test("every dependency names a step of the same release", async () => {
    for (const version of ["2.16.0", "2.15.1"]) {
      const { steps } = (await loadReleaseConfig(version)).config;
      const ids = new Set(steps.map((s) => s.id));
      for (const s of steps) {
        for (const d of s.depends_on ?? [])
          expect({ version, d, ok: ids.has(d) }).toEqual({
            version,
            d,
            ok: true,
          });
      }
    }
  });

  test("the reverts step is live between the branch cut and the release; the milestone steps always", async () => {
    const { steps } = (await loadReleaseConfig("2.16.0")).config;
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId["2.13"].window).toEqual({ opens: "branch_cut", closes: "ga" });
    for (const id of ["1.2", "2.9", "3.1"]) {
      expect(byId[id].check.type).toBe("milestone_outstanding_items");
      expect(byId[id].window).toBeUndefined();
    }
  });

  test("a release without a file resolves from the shared steps", async () => {
    const { config, hasFile } = await loadReleaseConfig("2.99.0");
    expect(hasFile).toBe(false);
    expect(config).toMatchObject({
      release: "2.99.0",
      type: "minor",
      branch: "release/2.99",
    });
    expect(config.steps).toHaveLength(46);
  });
});

describe("fetching the config", () => {
  beforeEach(() => clearConfigCache());
  afterEach(() => jest.useRealTimers());

  test("keeps a file for the TTL and asks again after it", async () => {
    jest.useFakeTimers({ now: new Date("2026-12-01T00:00:00Z") });
    const fetcher = committedFetch();
    global.fetch = fetcher as unknown as typeof fetch;
    await loadSharedConfig();
    await loadSharedConfig();
    expect(fetcher).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + CONFIG_TTL_MS + 1);
    await loadSharedConfig();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("uses the last copy when GitHub cannot be reached", async () => {
    jest.useFakeTimers({ now: new Date("2026-12-01T00:00:00Z") });
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const good = committedFetch();
    global.fetch = good as unknown as typeof fetch;
    const first = await loadSharedConfig();
    global.fetch = jest.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    jest.setSystemTime(Date.now() + CONFIG_TTL_MS + 1);
    expect(await loadSharedConfig()).toEqual(first);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("fails when there is no copy and GitHub cannot be reached", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(loadSharedConfig()).rejects.toThrow("network down");
  });

  test("a server error is not a missing file", async () => {
    global.fetch = jest.fn(
      async () => new Response("boom", { status: 502 })
    ) as unknown as typeof fetch;
    await expect(loadSharedConfig()).rejects.toThrow("502");
  });

  test("a missing steps.yml is an error", async () => {
    global.fetch = committedFetch({
      "steps.yml": null,
    }) as unknown as typeof fetch;
    await expect(loadSharedConfig()).rejects.toThrow("steps.yml is missing");
  });

  test("a config that does not parse is an error naming the file", async () => {
    global.fetch = committedFetch({
      "steps.yml": "version: 1\nsteps: nope\n",
    }) as unknown as typeof fetch;
    await expect(loadSharedConfig()).rejects.toThrow(
      /steps\.yml is not a valid release config/
    );
  });

  test("a release file for another release is an error", async () => {
    global.fetch = committedFetch({
      "releases/2.16.0.yml": 'release: "2.17.0"\n',
    }) as unknown as typeof fetch;
    await expect(loadReleaseConfig("2.16.0")).rejects.toThrow(
      "is for release 2.17.0"
    );
  });

  test("dates stay text, as YAML would otherwise turn them into dates", async () => {
    global.fetch = committedFetch({
      "releases/2.16.0.yml":
        'release: "2.16.0"\ndates:\n  ga: 2026-12-17\n  branch_cut: null\n',
    }) as unknown as typeof fetch;
    const { config } = await loadReleaseConfig("2.16.0");
    expect(config.dates.ga).toBe("2026-12-17");
    expect(config.dates.branch_cut).toBeNull();
  });
});
