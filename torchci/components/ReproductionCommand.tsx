import { JobData } from "../lib/types";
import React from "react";
import CopyLink from "./CopyLink";

export default function ReproductionCommand({
  job,
  separator,
}: {
  job: JobData;
  separator: string;
}) {
  if (job === null) {
    return <></>;
  }

  if (job.conclusion === "pending") {
    return <></>;
  }

  let repro = job.jobName ?? "";

  if (repro === null) {
    return <></>;
  }

  if (!job.jobName?.includes("test")) {
    return <></>;
  }

  return (
    <span>
      {separator}
      <div>
        <a>Copy Repro</a>
        <CopyLink textToCopy={repro} />
      </div>
    </span>
  );
}
