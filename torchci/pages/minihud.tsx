import { GetStaticProps } from "next";
import { SWRConfig } from "swr";
import {
  createContext,
  CSSProperties,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/router";

import fetchHud from "lib/fetchHud";
import { formatHudUrlForFetch, HudParams, JobData, RowData } from "lib/types";
import styles from "components/minihud.module.css";
import JobLinks from "components/JobLinks";
import { LocalTimeHuman } from "components/TimeUtils";
import JobConclusion from "components/JobConclusion";
import JobFilterInput from "components/JobFilterInput";
import useHudData from "lib/useHudData";
import { isFailedJob } from "lib/jobUtils";
import LogViewer from "components/LogViewer";
import CopyLink from "components/CopyLink";

function getOrigin() {
  return typeof window !== "undefined" && window.location.origin
    ? window.location.origin
    : "";
}

function includesCaseInsensitive(value: string, pattern: string): boolean {
  if (pattern === "") {
    return true;
  }
  return value.toLowerCase().includes(pattern.toLowerCase());
}

function FailedJob({ job }: { job: JobData }) {
  const [jobFilter, setJobFilter] = useContext(JobFilterContext);
  const [jobHoverContext, setJobHoverContext] = useContext(JobHoverContext);
  const [highlighted, setHighlighted] = useState(false);
  const [thisJobHovered, setThisJobHovered] = useState(false);

  const router = useRouter();

  useEffect(() => {
    const onHashChanged = () => {
      if (window.location.hash === "") {
        return;
      }
      const hash = window.location.hash.slice(1);
      setHighlighted(hash === job.id?.toString());
    };
    onHashChanged();

    window.addEventListener("hashchange", onHashChanged);

    return () => {
      window.removeEventListener("hashchange", onHashChanged);
    };
  }, [job.id]);

  function toggleJobFilter() {
    if (jobFilter === job.name) {
      router.push("/minihud", undefined, { shallow: true });
      setJobFilter(null);
    } else {
      router.push(`/minihud?name_filter=${job.name}`, undefined, {
        shallow: true,
      });
      setJobFilter(job.name!);
    }
  }

  const linkStyle: CSSProperties = { cursor: "pointer", marginRight: "0.5em" };
  if (job.name === jobHoverContext) {
    linkStyle.backgroundColor = "khaki";
  }
  let jobStyle = styles.failedJob;
  if (highlighted) {
    jobStyle = `${styles.failedJob} ${styles.failedJobHighlighted}`;
  }
  return (
    <div
      className={jobStyle}
      id={job.id}
      onMouseEnter={() => {
        setThisJobHovered(true);
        setJobHoverContext(job.name!);
      }}
      onMouseLeave={() => {
        setThisJobHovered(false);
        setJobHoverContext(null);
      }}
    >
      <div>
        <JobConclusion conclusion={job.conclusion} />
        <a
          target="_blank"
          rel="noreferrer"
          style={linkStyle}
          href={job.htmlUrl}
        >
          {" "}
          {job.name}
        </a>
        <CopyLink textToCopy={`${getOrigin()}${router.pathname}#${job.id}`} />
      </div>
      <div className={styles.failedJobLinks}>
        <input
          type="checkbox"
          id="setfilterbox"
          checked={jobFilter === job.name}
          onChange={() => toggleJobFilter()}
        />
        <label htmlFor="setfilterbox">Set filter | </label>
        <JobLinks job={job} />
      </div>
      <LogViewer job={job} />
    </div>
  );
}

function FailedJobs({ failedJobs }: { failedJobs: JobData[] }) {
  if (failedJobs.length === 0) {
    return null;
  }
  return (
    <ul className={styles.failedJobList}>
      {failedJobs.map((job) => (
        <li key={job.id}>
          <FailedJob job={job} />
        </li>
      ))}
    </ul>
  );
}

function CommitLinks({ row }: { row: RowData }) {
  return (
    <div>
      <span className={`${styles.metadataLink} ${styles.extraShaInfo}`}>
        Commit:
        <span className={`${styles.sha}`}>
          <a target="_blank" rel="noreferrer" href={row.commitUrl}>
            {` ${row.sha.substring(0, 7)}`}
          </a>
        </span>
      </span>
      {row.prNum !== null && (
        <span className={`${styles.metadataLink} ${styles.extraShaInfo}`}>
          Pull:
          <a
            target="_blank"
            rel="noreferrer"
            href={`https://github.com/pytorch/pytorch/pull/${row.prNum}`}
          >
            {` #${row.prNum}`}
          </a>
        </span>
      )}
      {row.diffNum !== null && (
        <span className={`${styles.metadataLink} ${styles.extraShaInfo}`}>
          Diff:
          <a
            target="_blank"
            rel="noreferrer"
            href={`https://www.internalfb.com/diff/${row.diffNum}`}
          >
            {` ${row.diffNum}`}
          </a>
        </span>
      )}
      {row.author !== null && (
        <span className={`${styles.metadataLink} ${styles.extraShaInfo}`}>
          Author:{" "}
          {row.authorUrl !== null ? (
            <a target="_blank" rel="noreferrer" href={row.authorUrl}>
              {row.author}
            </a>
          ) : (
            <>{row.author}</>
          )}
        </span>
      )}
    </div>
  );
}

function CommitSummaryLine({
  showAnchorLink,
  row,
  numPending,
  showRevert,
}: {
  showAnchorLink: boolean;
  row: RowData;
  numPending: number;
  showRevert: boolean;
}) {
  const router = useRouter();

  return (
    <div>
      <span className={`${styles.shaTitleElement} ${styles.timestamp}`}>
        <LocalTimeHuman timestamp={row.time} />
      </span>
      <span className={`${styles.shaTitleElement} ${styles.commitTitle}`}>
        {/* here, we purposefully do not use Link/. The prefetch behavior
          (even with prefetch disabled) spams our backend).*/}
        <a
          target="_blank"
          rel="noreferrer"
          href={`/pytorch/pytorch/commit/${row.sha}`}
        >
          {row.commitTitle}{" "}
        </a>
        <CopyLink textToCopy={`${getOrigin()}${router.pathname}#${row.sha}`} />
      </span>

      {numPending > 0 && (
        <span className={styles.shaTitleElement}>
          <em>{numPending} pending</em>
        </span>
      )}
      {showRevert && row.diffNum != null && (
        <span className={styles.shaTitleElement}>
          <a
            target="_blank"
            rel="noreferrer"
            href={`https://www.internalfb.com/intern/test/bouncycastle/?arcanist_name=fbsource&revision_or_diff_id=${row.diffNum}`}
          >
            <button className={styles.revertButton}>Revert</button>
          </a>
        </span>
      )}
      {showAnchorLink && (
        <span className={`${styles.shaTitleElement} ${styles.extraShaInfo}`}>
          <a href={`#${row.sha}`}>link to this commit</a>
        </span>
      )}
      <CommitLinks row={row} />
    </div>
  );
}

function CommitSummary({ row }: { row: RowData }) {
  const [jobFilter, _setJobFilter] = useContext(JobFilterContext);
  const [hover, setHover] = useState(false);
  const [highlighted, setHighlighted] = useState(false);

  const existingJobs = row.jobs.filter((job) => job.conclusion !== undefined);
  const jobs =
    jobFilter === null
      ? existingJobs
      : existingJobs.filter((job) =>
          includesCaseInsensitive(job.name!, jobFilter)
        );

  const failedJobs = jobs.filter(isFailedJob);
  const pendingJobs = jobs.filter((job) => job.conclusion === "pending");

  let className;
  if (jobs.length === 0) {
    className = styles.workflowBoxNone;
  } else if (failedJobs.length !== 0) {
    className = styles.workflowBoxFail;
  } else if (pendingJobs.length === 0) {
    className = styles.workflowBoxSuccess;
  } else {
    className = styles.workflowBoxPending;
  }

  if (highlighted) {
    className += " " + styles.workflowBoxHighlight;
  }

  useEffect(() => {
    const onHashChanged = () => {
      if (window.location.hash === "") {
        return;
      }
      const hash = window.location.hash.slice(1);
      setHighlighted(hash === row.sha);
    };
    onHashChanged();

    window.addEventListener("hashchange", onHashChanged);

    return () => {
      window.removeEventListener("hashchange", onHashChanged);
    };
  }, [row.sha]);

  return (
    <div
      id={row.sha}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={className}
    >
      <CommitSummaryLine
        row={row}
        numPending={pendingJobs.length}
        showRevert={failedJobs.length !== 0}
        showAnchorLink={hover}
      />
      <FailedJobs failedJobs={failedJobs} />
    </div>
  );
}

function MiniHud() {
  const params: HudParams = {
    branch: "master",
    repoOwner: "pytorch",
    repoName: "pytorch",
    page: 0,
  };
  const data = useHudData(params);
  if (data === undefined) {
    return <div>Loading...</div>;
  }

  const { shaGrid } = data;

  return (
    <>
      {shaGrid.map((row: RowData) => (
        <CommitSummary row={row} key={row.sha} />
      ))}
    </>
  );
}

const JobFilterContext = createContext<
  [null | string, (name: null | string) => void]
>([null, (_n) => {}]);

const JobHoverContext = createContext<
  [null | string, (name: null | string) => void]
>([null, (_n) => {}]);

export default function Page({ fallback }: any) {
  const router = useRouter();
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [jobHover, setJobHover] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    if (jobFilter === "") {
      router.push(`/minihud`, undefined, { shallow: true });
    } else {
      router.push(`/minihud?name_filter=${jobFilter}`, undefined, {
        shallow: true,
      });
    }
  }, [router, jobFilter]);

  // We have to use an effect hook here because query params are undefined at
  // static generation time; they only become available after hydration.
  useEffect(() => {
    const filterValue = (router.query.name_filter as string) || null;
    setJobFilter(filterValue);
  }, [router.query.name_filter]);

  return (
    <SWRConfig value={{ fallback }}>
      <JobFilterInput
        width="50%"
        currentFilter={jobFilter}
        handleSubmit={handleSubmit}
        handleInput={setJobFilter}
      />

      <JobFilterContext.Provider value={[jobFilter, setJobFilter]}>
        <JobHoverContext.Provider value={[jobHover, setJobHover]}>
          <div style={{ display: "grid" }}>
            <MiniHud />
          </div>
        </JobHoverContext.Provider>
      </JobFilterContext.Provider>
    </SWRConfig>
  );
}

export const getStaticProps: GetStaticProps = async () => {
  const params: HudParams = {
    branch: "master",
    repoOwner: "pytorch",
    repoName: "pytorch",
    page: 0,
  };
  return {
    props: {
      fallback: {
        [formatHudUrlForFetch("api/hud", params)]: await fetchHud(params),
      },
    },
    revalidate: 60,
  };
};
