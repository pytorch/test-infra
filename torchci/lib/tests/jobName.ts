// A GitHub job's name taken apart for the commit page's Job cell. PyTorch's
// test jobs are named by the reusable test workflow after the build they
// test and their place in its matrix: "linux-jammy-py3.11-gcc11 / test
// (default, 2, 7, lf-l-x86aavx2-11-41-l4)" is the second of seven shards of
// the default config on that runner; a job called through other reusable
// workflows carries their names first, "unit-test / inductor-cpu-test /
// test (inductor_amx, 1, 7, mt-l-x86iamx-8-64)", and a matrix can add labels
// after the runner, "module:rocm, oncall:distributed" or "unstable". Free
// of React.

export interface JobName {
  // The build the job tests, the segment before "test (…)": the whole name
  // when the name is not in that form.
  build: string;
  // The shard's number and the shards in all; null without a matrix.
  shard: { index: number; total: number } | null;
  // The runner label the matrix names; null without a matrix.
  runner: string | null;
  // The matrix's labels after the runner, "module:rocm"; empty without.
  labels: string[];
}

const SEGMENT_SEPARATOR = " / ";
const MATRIX = /^test \((.*)\)$/;

export function parseJobName(name: string): JobName {
  const segments = name.split(SEGMENT_SEPARATOR);
  const matrix =
    segments.length > 1 ? MATRIX.exec(segments[segments.length - 1]) : null;
  if (matrix === null) {
    return { build: name, shard: null, runner: null, labels: [] };
  }
  const build = segments[segments.length - 2];
  // The config, which the Test Config column already shows, the shard, the
  // shards in all, the runner, then any labels.
  const [, shardText, totalText, runner = null, ...labels] = matrix[1]
    .split(",")
    .map((part) => part.trim());
  const index = Number(shardText);
  const total = Number(totalText);
  const shard =
    Number.isInteger(index) && Number.isInteger(total) && index > 0 && total > 0
      ? { index, total }
      : null;
  return { build, shard, runner: runner === "" ? null : runner, labels };
}

// The Job cell's second line: "shard 2 of 7 · lf-l-x86aavx2-11-41-l4", with
// the labels after, "· unstable"; undefined when the name has no matrix.
export function jobDetailLine(job: JobName): string | undefined {
  const parts = [
    ...(job.shard === null
      ? []
      : [`shard ${job.shard.index} of ${job.shard.total}`]),
    ...(job.runner === null ? [] : [job.runner]),
    ...job.labels,
  ];
  return parts.length === 0 ? undefined : parts.join(" · ");
}
