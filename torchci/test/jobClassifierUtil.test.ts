import { getNameWithoutOSDC } from "../lib/JobClassifierUtil";

describe("getNameWithoutOSDC", () => {
  test.each([
    // job-id suffix strip at segment boundaries
    ["trunk / build-osdc", "trunk / build"],
    ["trunk / build-osdc (cfg)", "trunk / build (cfg)"],
    ["trunk / build", "trunk / build"],

    // don't mangle -osdc inside a longer token
    ["trunk / build-osdc-extra", "trunk / build-osdc-extra"],

    // matrix-expanded jobs line up across EC2 and OSDC variants
    [
      "trunk / test (default, 1, 3, linux.c7i.2xlarge)",
      "trunk / test (default, 1, 3, l-x86iavx512-8-64)",
    ],
    [
      "trunk / test-osdc (default, 1, 3, mt-l-x86iavx512-8-64)",
      "trunk / test (default, 1, 3, l-x86iavx512-8-64)",
    ],
    // Both of these EC2 labels map to the same ARC label (confirming
    // the mapping collapses synonymous EC2 variants too)
    [
      "trunk / test (default, 1, 3, linux.2xlarge)",
      "trunk / test (default, 1, 3, l-x86iavx512-8-64)",
    ],

    // build-and-test with ARM64 runner
    [
      "trunk / build-and-test-osdc (config, 1, 1, linux.arm64.m8g.4xlarge)",
      "trunk / build-and-test (config, 1, 1, l-arm64g4-16-62)",
    ],

    // LF-prefixed runners are not touched here (user must enable mergeLF too)
    [
      "trunk / test (default, 1, 3, lf.linux.c7i.2xlarge)",
      "trunk / test (default, 1, 3, lf.linux.c7i.2xlarge)",
    ],

    // longer EC2 labels are not eaten by shorter prefixes
    [
      "trunk / test (default, 1, 3, linux.2xlarge.amx)",
      "trunk / test (default, 1, 3, l-x86iamx-8-64)",
    ],
  ])("rewrites %j -> %j", (input, expected) => {
    expect(getNameWithoutOSDC(input)).toBe(expected);
  });
});
