import CopyLink from "components/CopyLink";
import JobAnnotationToggle from "components/JobAnnotationToggle";
import JobConclusion from "components/JobConclusion";
import JobFilterInput from "components/JobFilterInput";
import JobLinks from "components/JobLinks";
import LogViewer from "components/LogViewer";
import styles from "components/minihud.module.css";
import PageSelector from "components/PageSelector";
import { durationHuman, LocalTimeHuman } from "components/TimeUtils";
import { isFailedJob } from "lib/jobUtils";
import { HudParams, JobData, packHudParams, RowData } from "lib/types";
import useHudData from "lib/useHudData";
import useScrollTo from "lib/useScrollTo";
import _ from "lodash";
import { useRouter } from "next/router";
import {
  createContext,
  CSSProperties,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { SWRConfig } from "swr";

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
        setJobHoverContext(job.name!);
      }}
      onMouseLeave={() => {
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
        <CopyLink
          textToCopy={`${location.href.replace(location.hash, "")}#${job.id}`}
        />
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
      <div>
        <JobAnnotationToggle job={job} />
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
  row,
  numPending,
  showRevert,
  ttsAlert,
}: {
  row: RowData;
  numPending: number;
  showRevert: boolean;
  ttsAlert: boolean;
}) {
  const router = useRouter();
  useScrollTo();

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
          {row.commitTitle + " "}
        </a>
        <CopyLink
          textToCopy={`${location.href.replace(location.hash, "")}#${row.sha}`}
        />
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
      {ttsAlert && (
        <span style={{ float: "right" }}>
          <b>tts alert</b>
        </span>
      )}
      <CommitLinks row={row} />
    </div>
  );
}

function DurationInfo({
  jobs,
  prevRow,
  expandAllDurationInfo,
}: {
  jobs: JobData[];
  prevRow: RowData | undefined;
  expandAllDurationInfo: boolean;
}) {
  function getAggregateTestTimes(jobs: JobData[] | undefined) {
    return _.reduce(
      jobs,
      (
        prev: {
          [key: string]: {
            duration: number;
            validData: boolean;
          };
        },
        cur
      ) => {
        // filter out rocm and macos because they tend to be variable
        if (
          cur.name != undefined &&
          cur.name.includes(",") &&
          !cur.name.includes("rocm") &&
          !cur.name.includes("macos")
        ) {
          let name = cur.name.substring(0, cur.name.indexOf(","));
          if (!(name in prev)) {
            prev[name] = { duration: 0, validData: true };
          }
          if (cur.conclusion != "success" || cur.durationS === undefined) {
            prev[name].validData = false;
          } else {
            prev[name].duration += cur.durationS;
          }
        }
        return prev;
      },
      {}
    );
  }

  const prevRowJobsAggregate = _.pickBy(
    getAggregateTestTimes(prevRow?.jobs),
    (value) => value.validData
  );

  function getDurationInfo(name: string, duration: number, validData: boolean) {
    const durationString = validData ? durationHuman(duration) : "N/A";
    var color = "black";
    if (
      !validData ||
      prevRow === undefined ||
      prevRowJobsAggregate[name] === undefined
    ) {
      return {
        concerningChange: false,
        name,
        color,
        duration: durationString,
        percentChangeString: "",
        absoluteChangeString: "",
      };
    }
    const prevDuration = prevRowJobsAggregate[name].duration;

    const percentChange = duration / prevDuration;
    const percentChangeString =
      percentChange >= 1
        ? `+ ${((percentChange - 1) * 100).toFixed(2)}%`
        : `- ${((1 - percentChange) * 100).toFixed(2)}%`;
    const absoluteChange = Math.round(duration - prevDuration);
    const absoluteChangeString =
      absoluteChange >= 0
        ? `+ ${durationHuman(absoluteChange)}`
        : `- ${durationHuman(Math.abs(absoluteChange))}`;
    const concerningChange = Math.abs(absoluteChange) > 60 * 30;
    if (concerningChange) {
      color = absoluteChange > 0 ? "red" : "purple";
    }
    return {
      concerningChange,
      color,
      name,
      duration: durationString,
      percentChangeString,
      absoluteChangeString,
    };
  }

  const [concerning, notConcerning] = _.partition(
    _.map(getAggregateTestTimes(jobs), (value, key) => {
      return getDurationInfo(key, value.duration, value.validData);
    }),
    (e) => e.concerningChange
  );

  function getRow(val: {
    concerningChange: boolean;
    name: string | undefined;
    duration: string;
    color: string;
    percentChangeString: string;
    absoluteChangeString: string;
  }) {
    return (
      <tr key={`duration-row-${val.name}`} style={{ color: val.color }}>
        <td style={{ width: "750px" }}>{val.name}</td>
        <td style={{ width: "100px" }}>{val.duration}</td>
        <td style={{ width: "100px" }}>{val.percentChangeString}</td>
        <td style={{ width: "100px" }}>{val.absoluteChangeString}</td>
      </tr>
    );
  }
  return {
    ttsAlert: concerning.length > 0,
    durationJsxElement: (
      <div style={{ padding: "10px" }}>
        <table>
          <tbody>{concerning.map((val) => getRow(val))}</tbody>
        </table>
        <details open={expandAllDurationInfo}>
          <summary>See all jobs</summary>
          <table>
            <tbody>{notConcerning.map((val) => getRow(val))}</tbody>
          </table>
        </details>
      </div>
    ),
  };
}

function CommitSummary({
  row,
  prevRow,
  showDurationInfo,
  expandAllDurationInfo,
}: {
  row: RowData;
  prevRow: RowData | undefined;
  showDurationInfo: boolean;
  expandAllDurationInfo: boolean;
}) {
  const [jobFilter, _setJobFilter] = useContext(JobFilterContext);
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

  const { ttsAlert, durationJsxElement } = DurationInfo({
    jobs,
    prevRow,
    expandAllDurationInfo,
  });

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
  useScrollTo();
  return (
    <div id={row.sha} className={className}>
      <CommitSummaryLine
        row={row}
        numPending={pendingJobs.length}
        showRevert={failedJobs.length !== 0}
        ttsAlert={ttsAlert}
      />
      {!showDurationInfo && <FailedJobs failedJobs={failedJobs} />}
      {showDurationInfo && durationJsxElement}
    </div>
  );
}

function MiniHud({ params }: { params: HudParams }) {
  const data = useHudData(params);

  var paramsNextPage = { ...params };
  paramsNextPage.page = params.page + 1;
  const extraRow = useHudData(paramsNextPage);

  const [showDurationInfo, setShowDurationInfo] = useState(false);
  const [expandAllDurationInfo, setExpandAllDurationInfo] = useState(false);

  if (data === undefined) {
    return <div>Loading...</div>;
  }

  const { shaGrid } = data;

  return (
    <>
      <div>
        <input
          type="checkbox"
          id={"showDurationInfo"}
          onChange={() => setShowDurationInfo(!showDurationInfo)}
        />
        <label htmlFor={"showDurationInfo"}>show duration info</label>
        {showDurationInfo && (
          <>
            <input
              type="checkbox"
              id={"expandAllDurationInfo"}
              checked={expandAllDurationInfo}
              onChange={() => setExpandAllDurationInfo(!expandAllDurationInfo)}
            />
            <label htmlFor={"expandAllDurationInfo"}>
              expand all duration info
            </label>
          </>
        )}
      </div>
      {shaGrid.map((row: RowData, index: number, array: RowData[]) => (
        <CommitSummary
          row={row}
          prevRow={
            index + 1 >= array.length
              ? extraRow?.shaGrid[0]
              : array.at(index + 1)
          }
          key={row.sha}
          showDurationInfo={showDurationInfo}
          expandAllDurationInfo={expandAllDurationInfo}
        />
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

export default function Page() {
  const router = useRouter();
  const params = packHudParams(router.query);
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
    <SWRConfig
      value={{
        refreshInterval: 60 * 1000,
        fetcher: (resource, init) =>
          fetch(resource, init).then((res) => res.json()),
      }}
    >
      <JobFilterInput
        width="50%"
        currentFilter={jobFilter}
        handleSubmit={handleSubmit}
        handleInput={setJobFilter}
      />

      <JobFilterContext.Provider value={[jobFilter, setJobFilter]}>
        <JobHoverContext.Provider value={[jobHover, setJobHover]}>
          <div style={{ display: "grid" }}>
            {params.branch != undefined && (
              <>
                <MiniHud params={params} />
                <PageSelector params={params} baseUrl="minihud" />
              </>
            )}
          </div>
        </JobHoverContext.Provider>
      </JobFilterContext.Provider>
    </SWRConfig>
  );
}
