import { useEffect, useState } from "react";
import { JobData } from "../lib/types";
import CopyLink from "./CopyLink";
import { getTestName } from "./JobLinks";

export default function ReproductionCommand({ job }: { job: JobData }) {
  const [reproComamnd, setReproCommand] = useState<string | null>("");
  useEffect(() => {
    setReproCommand(getReproCommand(job));
  }, [job.failureCaptures, job.jobName]);

  if (
    job === null ||
    job.conclusion === "pending" ||
    !job.jobName?.includes("test") ||
    reproComamnd === null
  ) {
    return null;
  }

  return (
    <span>
      <CopyLink textToCopy={reproComamnd} link={false} />
    </span>
  );
}

function getReproCommand(job: JobData) {
  if (
    job === null ||
    job.failureLines === null ||
    job.failureLines === undefined
  ) {
    return null;
  }
  const testName = getTestName(job.failureLines[0] ?? "");
  if (testName === null) {
    return null;
  }
  const { file, testName: name } = testName;
  if (file === null) {
    return null;
  }
  const command = `python ${file} -k ${name}`;
  // dynamo getting renamed to dynamo_wrapped
  if (job.jobName?.includes("dynamo") || job.jobName?.includes("dynamo_wrapped")) {
    return `PYTORCH_TEST_WITH_DYNAMO=1 ${command}`;
  }
  if (job.jobName?.includes("inductor")) {
    return `PYTORCH_TEST_WITH_INDUCTOR=1 ${command}`;
  }
  if (job.jobName?.includes("slow")) {
    return `PYTORCH_TEST_WITH_SLOW=1 ${command}`;
  }
  return command;
}
