import React from "react";
import { JobData } from "../lib/types";
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
    return null;
  }

  if (job.conclusion === "pending") {
    return null;
  }

  if (!job.jobName?.includes("test")) {
    return null;
  }

  return (
    <span>
      {separator}
      <CopyLink textToCopy={testName} />
    </span>
  );
}
