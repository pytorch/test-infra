import { durationHuman, LocalTimeHuman } from "./TimeUtils";
import useSWR from "swr";
import React from "react";
import { IssueData, JobData } from "../lib/types";
import styles from "./JobLinks.module.css";
import TestInsightsLink from "./TestInsights";
import ReproductionCommand from "./ReproductionCommand";
import { useSession } from "next-auth/react";
import { isFailure } from "../lib/JobClassifierUtil";

export default function JobLinks({ job }: { job: JobData }) {
  const rawLogs =
    job.conclusion !== "pending" ? (
      <span>
        <a target="_blank" rel="noreferrer" href={job.logUrl}>
          Raw logs
        </a>
      </span>
    ) : null;

  const queueTimeS =
    job.queueTimeS != null ? (
      <span>{` | Queued: ${durationHuman(Math.max(job.queueTimeS!, 0))}`}</span>
    ) : null;

  const durationS =
    job.durationS != null ? (
      <span>{` | Duration: ${durationHuman(job.durationS!)}`}</span>
    ) : null;

  const eventTime =
    job.time != null ? (
      <span>
        {` | Started: `}
        <LocalTimeHuman timestamp={job.time} />
      </span>
    ) : null;

  const failureCaptures =
    job.failureCaptures != null ? (
      <span>
        {" | "}
        <a
          target="_blank"
          rel="noreferrer"
          href={`/failure?name=${encodeURIComponent(
            job.name as string
          )}&jobName=${encodeURIComponent(
            job.jobName as string
          )}&failureCaptures=${encodeURIComponent(
            JSON.stringify(job.failureCaptures)
          )}`}
        >
          more like this
        </a>
      </span>
    ) : null;

  const authenticated = useSession().status === "authenticated";
  return (
    <span>
      {rawLogs}
      {failureCaptures}
      {queueTimeS}
      {durationS}
      {eventTime}
      <TestInsightsLink job={job} separator={" | "} />
      <DisableTest job={job} label={"skipped"} />
      {authenticated && <UnstableJob job={job} label={"unstable"} />}
      {authenticated && job.failureLines && (
        <ReproductionCommand
          job={job}
          separator={" | "}
          testName={getTestName(job.failureLines[0] ?? "")}
        />
      )}
    </span>
  );
}

const fetcher = (url: string) => fetch(url).then((res) => res.json());
const unittestFailureRe = /^(?:FAIL|ERROR) \[.*\]: (test_.* \(.*Test.*\))/;
const pytestFailureRe = /^FAILED .*.py::(.*)::(test_\S*)/;

function getTestName(failureCapture: string) {
  const unittestMatch = failureCapture.match(unittestFailureRe);
  if (unittestMatch !== null) {
    return unittestMatch[1];
  }
  const pytestMatch = failureCapture.match(pytestFailureRe);
  if (pytestMatch !== null) {
    return `${pytestMatch[2]} (__main__.${pytestMatch[1]})`;
  }
  return null;
}

function formatDisableTestBody(failureCaptures: string[]) {
  const examplesURL = `http://torch-ci.com/failure/${encodeURIComponent(
    failureCaptures.join(",")
  )}`;
  return encodeURIComponent(`Platforms: <fill this in or delete. Valid labels are: asan, linux, mac, macos, rocm, win, windows.>

This test was disabled because it is failing on main branch ([recent examples](${examplesURL})).`);
}

function DisableTest({ job, label }: { job: JobData; label: string }) {
  const hasFailureClassification =
    job.failureLines != null && job.failureLines.every((line) => line !== null);
  const swrKey = hasFailureClassification ? `/api/issue/${label}` : null;
  const { data } = useSWR(swrKey, fetcher, {
    // Set a 60s cache for the request, so that lots of tooltip hovers don't
    // spam the backend. Since actually mutating the state (through filing a
    // disable issue) is a pretty heavy operation, 60s of staleness is fine.
    dedupingInterval: 60 * 1000,
    refreshInterval: 60 * 1000, // refresh every minute
  });

  // Null states. Don't show an issue disable link if:
  // - We don't have a failure classification
  if (!hasFailureClassification) {
    return null;
  }

  const testName =
    job.failureLines && job.failureLines[0]
      ? getTestName(job.failureLines[0] ?? "")
      : null;
  // - The failure classification is not a python unittest or pytest failure.
  if (testName === null) {
    return null;
  }
  // - If we don't yet have any data, show a loading state.
  if (data === undefined) {
    return <span>{" | "} checking for disable tests</span>;
  }

  // At this point, we should show something. Search the existing disable issues
  // for a matching one.
  const issueTitle = `DISABLED ${testName}`;
  const issueBody = formatDisableTestBody(job.failureCaptures!);

  const issues: IssueData[] = data.issues;
  const matchingIssues = issues.filter((issue) => issue.title === issueTitle);

  return (
    <DisableIssue
      matchingIssues={matchingIssues}
      issueTitle={issueTitle}
      issueBody={issueBody}
      isDisabledTest={true}
    />
  );
}

const jobNameRe = /^(.*) \(([^,]*),.*\)/;
function transformJobName(jobName?: string) {
  if (jobName == undefined) {
    return null;
  }

  // We want to have the job name in the following format WORKFLOW / JOB (CONFIG)
  const jobNameMatch = jobName.match(jobNameRe);
  if (jobNameMatch !== null) {
    return `${jobNameMatch[1]} (${jobNameMatch[2]})`;
  }

  return jobName;
}

function formatUnstableJobBody() {
  return encodeURIComponent(
    "> Please provide a brief reason on why you need to mark this job as unstable."
  );
}

function UnstableJob({ job, label }: { job: JobData; label: string }) {
  const swrKey = isFailure(job.conclusion) ? `/api/issue/${label}` : null;
  const { data } = useSWR(swrKey, fetcher, {
    // Set a 60s cache for the request, so that lots of tooltip hovers don't
    // spam the backend. Since actually mutating the state (through filing a
    // disable issue) is a pretty heavy operation, 60s of staleness is fine.
    dedupingInterval: 60 * 1000,
    refreshInterval: 60 * 1000, // refresh every minute
  });

  if (!isFailure(job.conclusion)) {
    return null;
  }

  const jobName = transformJobName(job.name);
  // Ignore invalid job name
  if (jobName === null) {
    return null;
  }

  // If we don't yet have any data, show a loading state.
  if (data === undefined) {
    return <span>{" | "} checking for disable jobs</span>;
  }

  // At this point, we should show something. Search the existing disable issues
  // for a matching one.
  const issueTitle = `UNSTABLE ${jobName}`;
  const issueBody = formatUnstableJobBody();

  const issues: IssueData[] = data.issues;
  const matchingIssues = issues.filter((issue) =>
    issueTitle.includes(issue.title)
  );

  return (
    <DisableIssue
      matchingIssues={matchingIssues}
      issueTitle={issueTitle}
      issueBody={issueBody}
      isDisabledTest={false}
    />
  );
}

function DisableIssue({
  matchingIssues,
  issueTitle,
  issueBody,
  isDisabledTest,
}: {
  matchingIssues: IssueData[];
  issueTitle: string;
  issueBody: string;
  isDisabledTest: boolean;
}) {
  let issueLink = `https://github.com/pytorch/pytorch/issues/new?title=${issueTitle}&body=${issueBody}`;
  let linkText = isDisabledTest
    ? "Disable test"
    : issueTitle.includes("UNSTABLE")
    ? "Mark unstable job"
    : "Disable job";
  let buttonStyle = "";

  if (matchingIssues.length !== 0) {
    // There is a matching issue, show that in the tooltip box.
    const matchingIssue = matchingIssues[0];
    if (matchingIssue.state === "open") {
      linkText = isDisabledTest
        ? "Test is disabled"
        : issueTitle.includes("UNSTABLE")
        ? "Job is unstable"
        : "Job is disabled";
    } else {
      buttonStyle = styles.closedDisableIssueButton;
      linkText = isDisabledTest
        ? "Previously disabled test"
        : issueTitle.includes("UNSTABLE")
        ? "Previously unstable job"
        : "Previously disabled job";
    }
    issueLink = matchingIssues[0].html_url;
  } else {
    // No matching issue, show a link to create one.
    buttonStyle = styles.disableTestButton;
  }

  return (
    <span>
      {" | "}
      <a target="_blank" rel="noreferrer" href={issueLink}>
        <button className={buttonStyle}>{linkText}</button>
      </a>
    </span>
  );
}
