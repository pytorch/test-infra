import { jobDetailLine, parseJobName } from "lib/tests/jobName";

describe("parseJobName", () => {
  it("reads a build's test job and its matrix", () => {
    expect(
      parseJobName(
        "linux-jammy-py3.11-gcc11-debug-distributed / test (distributed, 4, 8, lf-l-x86iamx-8-64, oncall:distributed, oncall:debug-build)"
      )
    ).toEqual({
      build: "linux-jammy-py3.11-gcc11-debug-distributed",
      shard: { index: 4, total: 8 },
      runner: "lf-l-x86iamx-8-64",
      labels: ["oncall:distributed", "oncall:debug-build"],
    });
  });
  it("drops the reusable workflows a job is called through", () => {
    expect(
      parseJobName(
        "unit-test / inductor-cpu-test / test (inductor_amx, 1, 7, mt-l-x86iamx-8-64)"
      )
    ).toEqual({
      build: "inductor-cpu-test",
      shard: { index: 1, total: 7 },
      runner: "mt-l-x86iamx-8-64",
      labels: [],
    });
    expect(
      parseJobName(
        "dynamo-unittest / dynamo-test (3.11) / test (dynamo_wrapped, 2, 7, mt-l-x86iavx512-8-64)"
      ).build
    ).toBe("dynamo-test (3.11)");
  });
  it("keeps a label after the runner", () => {
    const job = parseJobName(
      "linux-noble-rocm-py3.11-mi350 / test (slow, 2, 3, amd-dpx-linux.rocm.gpu.gfx950.1, module:rocm)"
    );
    expect(job.runner).toBe("amd-dpx-linux.rocm.gpu.gfx950.1");
    expect(job.labels).toEqual(["module:rocm"]);
    expect(
      parseJobName(
        "unit-test / inductor-cpu-test / test (inductor_aoti_fallback, 2, 2, mt-l-x86iamx-8-64, unstable)"
      ).labels
    ).toEqual(["unstable"]);
  });
  it("falls back to the whole name without a matrix", () => {
    expect(parseJobName("build-and-test")).toEqual({
      build: "build-and-test",
      shard: null,
      runner: null,
      labels: [],
    });
    expect(parseJobName("lint / lintrunner")).toEqual({
      build: "lint / lintrunner",
      shard: null,
      runner: null,
      labels: [],
    });
    expect(parseJobName("test (default)")).toEqual({
      build: "test (default)",
      shard: null,
      runner: null,
      labels: [],
    });
  });
  it("leaves out a shard it cannot read", () => {
    expect(
      parseJobName("build / test (default, one, 2, runner)").shard
    ).toBeNull();
    expect(parseJobName("build / test (default, 1, 2)").runner).toBeNull();
  });
});

describe("jobDetailLine", () => {
  it("joins the shard, the runner and the labels", () => {
    expect(
      jobDetailLine(
        parseJobName(
          "linux-jammy-cuda13.2-py3-gcc11-slow-gradcheck / test (default, 3, 8, lf-l-x86aavx2-11-41-a10g, module:slowgradcheck)"
        )
      )
    ).toBe("shard 3 of 8 · lf-l-x86aavx2-11-41-a10g · module:slowgradcheck");
    expect(jobDetailLine(parseJobName("lint"))).toBeUndefined();
  });
});
