import {
  formatHudUrlForFetch,
  formatHudUrlForRoute,
  HudParams,
  packHudParams,
  parseTriState,
  resolveTriState,
} from "../lib/types";

describe("parseTriState", () => {
  test.each([
    ["true", "on"],
    [true, "on"],
    ["false", "off"],
    [false, "off"],
    [undefined, "default"],
    [null, "default"],
    ["", "default"],
    ["garbage", "default"],
  ])("parseTriState(%p) === %p", (input, expected) => {
    expect(parseTriState(input)).toBe(expected);
  });
});

describe("resolveTriState", () => {
  test("on/off from the URL override stored and server defaults", () => {
    expect(resolveTriState("on", false, false)).toBe(true);
    expect(resolveTriState("off", true, true)).toBe(false);
  });

  test("default falls back to the stored value when present", () => {
    expect(resolveTriState("default", true, false)).toBe(true);
    expect(resolveTriState("default", false, true)).toBe(false);
  });

  test("default falls back to the server default when nothing is stored", () => {
    expect(resolveTriState("default", undefined, true)).toBe(true);
    expect(resolveTriState("default", undefined, false)).toBe(false);
  });
});

const BASE_QUERY = {
  repoOwner: "pytorch",
  repoName: "pytorch",
  branch: "main",
  page: "1",
  per_page: "50",
};

describe("packHudParams tri-state options", () => {
  test("absent option keys resolve to default", () => {
    const params = packHudParams(BASE_QUERY);
    expect(params.hideUnstable).toBe("default");
    expect(params.hideGreenColumns).toBe("default");
    expect(params.hideNonViableStrict).toBe("default");
    expect(params.hideAlwaysSkipped).toBe("default");
    expect(params.useGrouping).toBe("default");
    expect(params.monsterFailures).toBe("default");
    expect(params.mergeEphemeralLF).toBe("default");
    expect(params.mergeOSDC).toBe("default");
  });

  test("true/false query values become on/off", () => {
    const params = packHudParams({
      ...BASE_QUERY,
      hide_unstable: "true",
      hide_green: "false",
      hide_non_viable_strict: "true",
      grouped: "false",
    });
    expect(params.hideUnstable).toBe("on");
    expect(params.hideGreenColumns).toBe("off");
    expect(params.hideNonViableStrict).toBe("on");
    expect(params.useGrouping).toBe("off");
  });

  test("malformed query values fall back to default", () => {
    const params = packHudParams({ ...BASE_QUERY, hide_unstable: "yes" });
    expect(params.hideUnstable).toBe("default");
  });
});

function makeParams(overrides: Partial<HudParams> = {}): HudParams {
  return {
    repoOwner: "pytorch",
    repoName: "pytorch",
    branch: "main",
    page: 1,
    per_page: 50,
    filter_reruns: false,
    filter_unstable: false,
    useGrouping: "default",
    monsterFailures: "default",
    hideUnstable: "default",
    hideGreenColumns: "default",
    hideNonViableStrict: "default",
    hideAlwaysSkipped: "default",
    mergeEphemeralLF: "default",
    mergeOSDC: "default",
    ...overrides,
  };
}

describe("formatHudUrlForRoute serialization", () => {
  test("default options are omitted from the URL", () => {
    const url = formatHudUrlForRoute("hud", makeParams());
    expect(url).toBe("/hud/pytorch/pytorch/main/1?per_page=50");
  });

  test("the literal string 'default' never appears in a URL", () => {
    const url = formatHudUrlForRoute(
      "hud",
      makeParams({
        hideUnstable: "on",
        hideGreenColumns: "off",
        useGrouping: "default",
      })
    );
    expect(url).not.toContain("default");
  });

  test("on serializes to =true and off serializes to =false", () => {
    const url = formatHudUrlForRoute(
      "hud",
      makeParams({ hideUnstable: "on", hideGreenColumns: "off" })
    );
    expect(url).toContain("hide_unstable=true");
    expect(url).toContain("hide_green=false");
  });

  test("round trips pack(format(...)) for on/off, dropping default", () => {
    const params = makeParams({
      hideUnstable: "on",
      hideNonViableStrict: "off",
      mergeOSDC: "on",
      hideAlwaysSkipped: "default",
    });
    const url = formatHudUrlForRoute("hud", params);
    // Reparse the query portion the way Next.js would hand it to packHudParams.
    const query = Object.fromEntries(
      new URLSearchParams(url.split("?")[1]).entries()
    );
    const reparsed = packHudParams({
      repoOwner: "pytorch",
      repoName: "pytorch",
      branch: "main",
      ...query,
    });
    expect(reparsed.hideUnstable).toBe("on");
    expect(reparsed.hideNonViableStrict).toBe("off");
    expect(reparsed.mergeOSDC).toBe("on");
    expect(reparsed.hideAlwaysSkipped).toBe("default");
  });
});

describe("formatHudUrlForFetch serialization", () => {
  test("only fetch-relevant (merge) options are serialized", () => {
    const url = formatHudUrlForFetch(
      "api/hud",
      makeParams({
        hideUnstable: "on", // client-only, should NOT appear
        mergeEphemeralLF: "on", // fetch-relevant, should appear
        mergeOSDC: "off",
      })
    );
    expect(url).toContain("mergeEphemeralLF=true");
    expect(url).toContain("mergeOSDC=false");
    expect(url).not.toContain("hide_unstable");
  });

  test("client-only toggles don't change the fetch URL", () => {
    const withToggle = formatHudUrlForFetch(
      "api/hud",
      makeParams({ hideUnstable: "on", hideGreenColumns: "off" })
    );
    const without = formatHudUrlForFetch("api/hud", makeParams());
    expect(withToggle).toBe(without);
  });
});
