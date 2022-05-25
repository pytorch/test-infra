import React from "react";
import { JobData } from "../lib/types";
import { ToggleButtonGroup, ToggleButton } from "@mui/material";

type JobAnnotation =
  | "infra_flake"
  | "time_out"
  | "SEV"
  | "broken_trunk"
  | "test_flake"
  | "null";

const testFailureRe = /^(?:FAIL|ERROR) \[.*\]: (test_.* \(.*Test.*\))/;

export default function JobAnnotationToggle({ job }: { job: JobData }) {
  const [state, setState] = React.useState<JobAnnotation>(
    (job.failureAnnotation ?? "null") as JobAnnotation
  );

  async function handleChange(
    _: React.MouseEvent<HTMLElement>,
    newState: JobAnnotation
  ) {
    setState(newState);
    await fetch(`/api/job_annotation/${job.repo}/${job.id}/${newState}`, {
      method: "POST",
    });
  }

  // Don't show this button if we know this is a test failure, since we do not
  // consider test failures to be infra failures.
  const isFailure = job.failureLine != null;
  const isTestFailure = isFailure && job.failureLine!.match(testFailureRe) !== null;
  if (isTestFailure) {
    return null;
  }

  return (
    <>
      Classify failure:{" "}
      <ToggleButtonGroup value={state} exclusive onChange={handleChange}>
        <ToggleButton
          value="null"
          style={{ height: "12pt", textTransform: "none" }}
        >
          None
        </ToggleButton>
        <ToggleButton
          value="infra_flake"
          style={{ height: "12pt", textTransform: "none" }}
        >
          infra flake
        </ToggleButton>
        <ToggleButton
          value="test_flake"
          style={{ height: "12pt", textTransform: "none" }}
        >
          test flake
        </ToggleButton>
        <ToggleButton
          value="timeout"
          style={{ height: "12pt", textTransform: "none" }}
        >
          timeout
        </ToggleButton>
        <ToggleButton
          value="SEV"
          style={{ height: "12pt", textTransform: "none" }}
        >
          SEV related
        </ToggleButton>
        <ToggleButton
          value="broken_trunk"
          style={{ height: "12pt", textTransform: "none" }}
        >
          broken trunk
        </ToggleButton>
      </ToggleButtonGroup>
    </>
  );
}
