import { JobData } from "../lib/types";
import React from "react";
import CopyLink from "./CopyLink";

export default function ReproductionCommand({
  job,
  separator,
  testName,
}: {
  job: JobData;
  separator: string;
  testName: string | null;
}) {
  if (job === null || testName === null) {
    return <></>;
  }

  if (job.conclusion === "pending") {
    return <></>;
  }

  if (!job.jobName?.includes("test")) {
    return <></>;
  }

  return (
    <span>
      {separator}
      <a>Copy Repro</a>
      <CopyLink textToCopy={testName} />
    </span>
  );
}
