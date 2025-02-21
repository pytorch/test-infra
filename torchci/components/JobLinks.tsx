import dayjs from "dayjs";
import { useSession } from "next-auth/react";
import { IssueLabelApiResponse } from "pages/api/issue/[label]";
import useSWR from "swr";
import { isFailure, IsJobInProgress } from "../lib/JobClassifierUtil";
import { isFailedJob, transformJobName } from "../lib/jobUtils";
import { IssueData, JobData } from "../lib/types";
import CopyLink from "./CopyLink";
import styles from "./JobLinks.module.css";
import ReproductionCommand from "./ReproductionCommand";
import { durationDisplay, LocalTimeHuman } from "./TimeUtils";

const DEFAULT_REPO = "pytorch/pytorch";
function getRepoFromHtmlURL(htmlUrl?: string) {
  if (htmlUrl === undefined) {
    return DEFAULT_REPO;
  }
  const repoMatch = htmlUrl.match(
    /https:\/\/github.com\/([^\/]+\/[^\/]+)\/actions/
  );
  if (repoMatch === null) {
    return DEFAULT_REPO;
  }
  return repoMatch[1];
}

export default function JobLinks({
  job,
  showCommitLink = false,
}: {
  job: JobData;
  showCommitLink?: boolean;
}) {
  const subInfo = [];
  if (job.repo === undefined) {
    job.repo = getRepoFromHtmlURL(job.htmlUrl);
  }

  if (showCommitLink) {
    subInfo.push(
      <a
        target="_blank"
        rel="noreferrer"
        href={`/${job.repo}/commit/${job.sha}#${job.id}-box`}
      >
        Commit
      </a>
    );
  }

  if (!IsJobInProgress(job.conclusion) && job.logUrl != null) {
    subInfo.push(
      <a target="_blank" rel="noreferrer" href={job.logUrl}>
        Raw logs
      </a>
    );
  }

  if (job.failureCaptures != null && job.failureLines?.length != 0) {
    subInfo.push(
      <a
        target="_blank"
        rel="noreferrer"
        href={`/failure?name=${encodeURIComponent(
          job.name as string
        )}&jobName=${encodeURIComponent(
          job.jobName as string
        )}&failureCaptures=${encodeURIComponent(
          job.failureCaptures.length == 1
            ? (job.failureCaptures[0] as string)
            : JSON.stringify(job.failureCaptures)
        )}`}
      >
        more like this
      </a>
    );
  }

  if (job.queueTimeS != null) {
    subInfo.push(
      <span>{`Queued: ${durationDisplay(Math.max(job.queueTimeS!, 0))}`}</span>
    );
  }

  if (job.durationS != null) {
    subInfo.push(<span>{`Duration: ${durationDisplay(job.durationS!)}`}</span>);
  }

  if (job.time != null) {
    subInfo.push(
      <span>
        {`Started: `}
        <LocalTimeHuman timestamp={job.time} />
      </span>
    );
  }

  if (isFailedJob(job)) {
    const revertInfoCopy = RevertInfoCopy({ job: job });
    if (revertInfoCopy != null) {
      subInfo.push(revertInfoCopy);
    }
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

  if (job.failureLines) {
    const reproComamnd = ReproductionCommand({
      job: job,
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
const unittestFailureRe = /^(?:FAIL|ERROR) \[.*\]: (test_.*) \(.*(Test.*)\)/;
const pytestFailureRe = /([\w\\\/]+\.py)::(.*)::(test_\w*)/;
export function getTestName(failureLine: string) {
  const unittestMatch = failureLine.match(unittestFailureRe);
  if (unittestMatch !== null) {
    return {
      file: null,
      testName: unittestMatch[1],
      suite: unittestMatch[2],
    };
  }
  const pytestMatch = failureLine.match(pytestFailureRe);
  if (pytestMatch !== null) {
    return {
      file: pytestMatch[1],
      testName: pytestMatch[3],
      suite: pytestMatch[2],
    };
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
  const { data: issues } = useSWR<IssueLabelApiResponse>(swrKey, fetcher, {
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
  if (issues === undefined) {
    return <span>checking for disable tests</span>;
  }

  // At this point, we should show something. Search the existing disable issues
  // for a matching one.
  const issueTitle = `DISABLED ${testName.testName} (__main__.${testName.suite})`;
  const issueBody = formatDisableTestBody(job);

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
  const swrKey = `/api/issue/${label}`;
  const { data: issues, isLoading } = useSWR<IssueLabelApiResponse>(
    swrKey,
    fetcher,
    {
      // Set a 60s cache for the request, so that lots of tooltip hovers don't
      // spam the backend. Since actually mutating the state (through filing a
      // disable issue) is a pretty heavy operation, 60s of staleness is fine.
      dedupingInterval: 60 * 1000,
      refreshInterval: 60 * 1000, // refresh every minute
    }
  );

  const jobName = transformJobName(job.name);
  // Ignore invalid job name
  if (jobName === null) {
    return null;
  }

  // If we don't yet have any data, show a loading state.
  if (isLoading) {
    return <span>checking for disable jobs</span>;
  }

  if (issues === undefined) {
    // Usually this means that it's loading but add this check just in case it
    // actually returns undefined somehow and hide it from users.
    return null;
  }

  // At this point, we should show something. Search the existing disable issues
  // for a matching one.
  const issueTitle = `UNSTABLE ${jobName}`;
  const issueBody = formatUnstableJobBody();

  const matchingIssues = issues.filter((issue) =>
    issueTitle.includes(issue.title)
  );

  if (!isFailure(job.conclusion) && matchingIssues.length == 0) {
    return null;
  }

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
  const recentThresholdHours = 14 * 24;

  let issueLink = `https://github.com/${repo}/issues/new?title=${issueTitle}&body=${issueBody}`;
  let linkText = isDisabledTest
    ? "Disable test"
    : issueTitle.includes("UNSTABLE")
    ? "Mark unstable job"
    : "Disable job";
  let buttonStyle = styles.disableTestButton;

  if (matchingIssues.length !== 0) {
    // There is a matching issue, show that in the tooltip box.
    const matchingIssue = matchingIssues[0];
    if (matchingIssue.state === "open") {
      linkText = isDisabledTest
        ? "Test is disabled"
        : issueTitle.includes("UNSTABLE")
        ? "Job is unstable"
        : "Job is disabled";
      buttonStyle = "";
    } else if (
      dayjs().diff(dayjs(matchingIssue.updated_at), "hours") <
      recentThresholdHours
    ) {
      buttonStyle = styles.closedDisableIssueButton;
      linkText = isDisabledTest
        ? "Previously disabled test"
        : issueTitle.includes("UNSTABLE")
        ? "Previously unstable job"
        : "Previously disabled job";
    }
    issueLink = matchingIssues[0].html_url;
  }

  return (
    <a target="_blank" rel="noreferrer" href={issueLink}>
      <button className={buttonStyle}>{linkText}</button>
    </a>
  );
}

function RevertInfoCopy({ job }: { job: JobData }) {
  const info = [];
  const testName = getTestName((job.failureLines && job.failureLines[0]) ?? "");
  if (testName !== null && testName.file !== null) {
    info.push(`${testName.file}::${testName.suite}::${testName.testName}`);
  }
  info.push(`[GH job link](${job.htmlUrl})`);
  info.push(
    `[HUD commit link](https://hud.pytorch.org/${job.repo}/commit/${job.sha})`
  );
  return CopyLink({
    textToCopy: info.join(" "),
    copyPrompt: "Revert Info",
    compressed: false,
    link: false,
  });
}
