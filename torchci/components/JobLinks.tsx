import { durationHuman, LocalTimeHuman } from "./TimeUtils";
import useSWR from "swr";
import React from "react";
import { IssueData, JobData } from "../lib/types";
import styles from "./JobLinks.module.css";
import TestInsightsLink from "./TestInsights";
import ReproductionCommand from "./ReproductionCommand";
import { useSession } from "next-auth/react";
import { isFailure } from "../lib/JobClassifierUtil";
import { transformJobName } from "../lib/jobUtils";

export default function JobLinks({
  job,
  showCommitLink = false,
}: {
  job: JobData;
  showCommitLink?: boolean;
}) {
  const subInfo = [];

  if (showCommitLink) {
    subInfo.push(
      <a
        target="_blank"
        rel="noreferrer"
        href={`/pytorch/pytorch/commit/${job.sha}`}
      >
        Commit
      </a>
    );
  }

  if (job.conclusion !== "pending" && job.logUrl != null) {
    subInfo.push(
      <a target="_blank" rel="noreferrer" href={job.logUrl}>
        Raw logs
      </a>
    );
  }

  if (job.failureCaptures != null) {
    subInfo.push(
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
    );
  }

  if (job.queueTimeS != null) {
    subInfo.push(
      <span>{`Queued: ${durationHuman(Math.max(job.queueTimeS!, 0))}`}</span>
    );
  }

  if (job.durationS != null) {
    subInfo.push(<span>{`Duration: ${durationHuman(job.durationS!)}`}</span>);
  }

  if (job.time != null) {
    subInfo.push(
      <span>
        {`Started: `}
        <LocalTimeHuman timestamp={job.time} />
      </span>
    );
  }

  const testInsightsLink = TestInsightsLink({ job: job, separator: "" });
  if (testInsightsLink != null) {
    subInfo.push(testInsightsLink);
  }

  const disableTestButton = DisableTest({ job: job, label: "skipped" });
  if (disableTestButton != null) {
    subInfo.push(disableTestButton);
  }
  const authenticated = useSession().status === "authenticated";

  if (authenticated) {
    const unstableJobButton = UnstableJob({ job: job, label: "unstable" });
    if (unstableJobButton != null) {
      subInfo.push(unstableJobButton);
    }
  }

  if (authenticated && job.failureLines) {
    const reproComamnd = ReproductionCommand({
      job: job,
      separator: "",
      testName: getTestName(job.failureLines[0] ?? "", true),
    });
    if (reproComamnd != null) {
      subInfo.push(reproComamnd);
    }
  }

  return (
    <span>
      {subInfo.map((info, i) => (
        <span key={i}>
          {i > 0 && " | "}
          {info}
        </span>
      ))}
    </span>
  );
}

const fetcher = (url: string) => fetch(url).then((res) => res.json());
const unittestFailureRe = /^(?:FAIL|ERROR) \[.*\]: (test_.* \(.*Test.*\))/;
const pytestFailureRe = /^FAILED .*.py::(.*)::(test_\S*)/;
function getTestName(failureCapture: string, reproduction: boolean = false) {
  const unittestMatch = failureCapture.match(unittestFailureRe);
  if (unittestMatch !== null) {
    return unittestMatch[1];
  }
  const pytestMatch = failureCapture.match(pytestFailureRe);
  if (pytestMatch !== null) {
    if (reproduction) {
      return `python ${pytestMatch[0]}.py ${pytestMatch[1]}.${pytestMatch[2]}`;
    }
    return `${pytestMatch[2]} (__main__.${pytestMatch[1]})`;
  }
  return null;
}

function formatDisableTestBody(job: JobData) {
  const examplesURL = `https://torch-ci.com/failure?failureCaptures=${encodeURIComponent(
    JSON.stringify(job.failureCaptures)
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
    return <span>checking for disable tests</span>;
  }

  // At this point, we should show something. Search the existing disable issues
  // for a matching one.
  const issueTitle = `DISABLED ${testName}`;
  const issueBody = formatDisableTestBody(job);

  const issues: IssueData[] = data.issues;
  const matchingIssues = issues.filter((issue) => issue.title === issueTitle);
  const repo = job.repo ?? "pytorch/pytorch";

  return (
    <DisableIssue
      repo={repo}
      matchingIssues={matchingIssues}
      issueTitle={issueTitle}
      issueBody={issueBody}
      isDisabledTest={true}
    />
  );
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
    return <span>checking for disable jobs</span>;
  }

  // At this point, we should show something. Search the existing disable issues
  // for a matching one.
  const issueTitle = `UNSTABLE ${jobName}`;
  const issueBody = formatUnstableJobBody();

  const issues: IssueData[] = data.issues;
  const matchingIssues = issues.filter((issue) =>
    issueTitle.includes(issue.title)
  );
  const repo = job.repo ?? "pytorch/pytorch";

  return (
    <DisableIssue
      repo={repo}
      matchingIssues={matchingIssues}
      issueTitle={issueTitle}
      issueBody={issueBody}
      isDisabledTest={false}
    />
  );
}

function DisableIssue({
  repo,
  matchingIssues,
  issueTitle,
  issueBody,
  isDisabledTest,
}: {
  repo: string;
  matchingIssues: IssueData[];
  issueTitle: string;
  issueBody: string;
  isDisabledTest: boolean;
}) {
  let issueLink = `https://github.com/${repo}/issues/new?title=${issueTitle}&body=${issueBody}`;
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
    <a target="_blank" rel="noreferrer" href={issueLink}>
      <button className={buttonStyle}>{linkText}</button>
    </a>
  );
}
