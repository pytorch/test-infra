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
import {
  HudParams,
  JobData,
  packHudParams,
  RowData,
  TTSChange,
} from "lib/types";
import useHudData from "lib/useHudData";
import useScrollTo from "lib/useScrollTo";
import _ from "lodash";
import { useSession } from "next-auth/react";
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

function RevertButton({ prNum, sha }: { prNum: number; sha: string }) {
  const router = useRouter();
  const { repoName, repoOwner } = router.query;
  const session = useSession();

  if (session.status == "loading" || session.status == "unauthenticated") {
    return null;
  }
  return (
    <span className={styles.shaTitleElement}>
      <a
        target="_blank"
        href={`/${repoName}/${repoOwner}/pull/revert/${prNum}?sha=${sha}`}
      >
        <button className={styles.revertButton}>Revert</button>
      </a>
    </span>
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
      {showRevert && row.prNum != null && (
        <RevertButton prNum={row.prNum} sha={row.sha} />
      )}
      {ttsAlert && (
        <span style={{ float: "right" }}>
          <b>TTS Alert </b>
          <ShowDurationInfoCheckbox sha={row.sha} />
        </span>
      )}
      <CommitLinks row={row} />
    </div>
  );
}

function getTTSChanges(jobs: JobData[], prevJobs: JobData[] | undefined) {
  function getAggregateTestTimes(jobs: JobData[] | undefined) {
    return _.reduce(
      jobs,
      (
        prev: {
          [key: string]: {
            duration: number;
            availableData: boolean;
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
            prev[name] = { duration: 0, availableData: true };
          }
          if (cur.conclusion != "success" || cur.durationS === undefined) {
            prev[name].availableData = false;
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
    getAggregateTestTimes(prevJobs),
    (value) => value.availableData
  );

  function getDurationInfo(
    name: string,
    duration: number,
    availableData: boolean
  ) {
    const durationString = availableData ? durationHuman(duration) : "N/A";
    let color = "black";
    if (
      !availableData ||
      prevJobs === undefined ||
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
        ? `+ ${((percentChange - 1) * 100).toFixed(0)}%`
        : `- ${((1 - percentChange) * 100).toFixed(0)}%`;
    const absoluteChange = Math.round(duration - prevDuration);
    const absoluteChangeString =
      absoluteChange >= 0
        ? `+ ${durationHuman(absoluteChange)}`
        : `- ${durationHuman(Math.abs(absoluteChange))}`;
    const concerningChange = Math.abs(absoluteChange) > 60 * 30;
    if (concerningChange) {
      color = absoluteChange > 0 ? "red" : "green";
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

  const [concerningTTS, notConcerningTTS] = _.partition(
    _.map(getAggregateTestTimes(jobs), (value, key) => {
      return getDurationInfo(key, value.duration, value.availableData);
    }),
    (e) => e.concerningChange
  );

  return { concerningTTS, notConcerningTTS };
}

function DurationInfo({
  concerning,
  notConcerning,
  expandAllDurationInfo,
}: {
  concerning: TTSChange[];
  notConcerning: TTSChange[];
  expandAllDurationInfo: boolean;
}) {
  function Row({
    name,
    duration,
    color,
    percentChangeString,
    absoluteChangeString,
  }: {
    name: string | undefined;
    duration: string;
    color: string;
    percentChangeString: string;
    absoluteChangeString: string;
  }) {
    return (
      <tr style={{ color }}>
        <td style={{ width: "750px" }}>{name}</td>
        <td style={{ width: "150px" }}>{duration}</td>
        <td style={{ width: "100px" }}>{percentChangeString}</td>
        <td style={{ width: "100px" }}>{absoluteChangeString}</td>
      </tr>
    );
  }
  return (
    <div style={{ padding: "10px" }}>
      <table>
        <tbody>
          {concerning.map((val) => (
            <Row {...val} key={`duration-row-${val.name}`} />
          ))}
        </tbody>
      </table>
      <details open={expandAllDurationInfo}>
        <summary>See all jobs</summary>
        <table>
          <tbody>
            {notConcerning.map((val) => (
              <Row {...val} key={`duration-row-${val.name}`} />
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function CommitSummary({
  row,
  prevRow,
  expandAllDurationInfo,
}: {
  row: RowData;
  prevRow: RowData | undefined;
  expandAllDurationInfo: boolean;
}) {
  const [jobFilter, _setJobFilter] = useContext(JobFilterContext);
  const [showDurationInfo] = useContext(ShowDurationContext);
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

  const { concerningTTS, notConcerningTTS } = getTTSChanges(
    jobs,
    // also filter the previous jobs
    jobFilter === null
      ? prevRow?.jobs
      : prevRow?.jobs.filter((job) =>
          includesCaseInsensitive(job.name!, jobFilter)
        )
  );

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
      <div
        className={concerningTTS.length > 0 ? styles.workflowBoxTTSAlert : ""}
      >
        <CommitSummaryLine
          row={row}
          numPending={pendingJobs.length}
          showRevert={failedJobs.length !== 0}
          ttsAlert={concerningTTS.length > 0}
        />
        {!showDurationInfo && <FailedJobs failedJobs={failedJobs} />}
        {showDurationInfo && (
          <DurationInfo
            concerning={concerningTTS}
            notConcerning={notConcerningTTS}
            expandAllDurationInfo={expandAllDurationInfo}
          />
        )}
      </div>
    </div>
  );
}

function ShowDurationInfoCheckbox({ sha }: { sha: string | null }) {
  const [showDurationInfo, setShowDurationInfo] =
    useContext(ShowDurationContext);
  const id = `showDurationInfoCheckbox-${sha ? sha : "top"}`;
  return (
    <>
      <input
        type="checkbox"
        id={id}
        checked={showDurationInfo}
        onChange={() => setShowDurationInfo(!showDurationInfo)}
      />
      <label htmlFor={id}>Show duration info</label>
    </>
  );
}

function MiniHud({ params }: { params: HudParams }) {
  const data = useHudData(params);

  let paramsNextPage = { ...params };
  paramsNextPage.page = params.per_page * params.page + 1;
  paramsNextPage.per_page = 1;
  const extraRow = useHudData(paramsNextPage);
  const [showDurationInfo] = useContext(ShowDurationContext);
  const [expandAllDurationInfo, setExpandAllDurationInfo] = useState(false);

  if (data === undefined) {
    return <div>Loading...</div>;
  }

  const { shaGrid } = data;

  return (
    <>
      <div>
        <ShowDurationInfoCheckbox sha={null} />
        {showDurationInfo && (
          <>
            <input
              type="checkbox"
              id={"expandAllDurationInfo"}
              checked={expandAllDurationInfo}
              onChange={() => setExpandAllDurationInfo(!expandAllDurationInfo)}
            />
            <label htmlFor={"expandAllDurationInfo"}>
              Expand all duration info
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

const ShowDurationContext = createContext<[boolean, (name: boolean) => void]>([
  false,
  (_n) => {},
]);

export default function Page() {
  const router = useRouter();
  const params = packHudParams(router.query);
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [jobHover, setJobHover] = useState<string | null>(null);
  const [showDurationInfo, setShowDurationInfo] = useState<boolean>(false);

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
          <ShowDurationContext.Provider
            value={[showDurationInfo, setShowDurationInfo]}
          >
            <div style={{ display: "grid" }}>
              {params.branch != undefined && (
                <>
                  <MiniHud params={params} />
                  <PageSelector params={params} baseUrl="minihud" />
                </>
              )}
            </div>
          </ShowDurationContext.Provider>
        </JobHoverContext.Provider>
      </JobFilterContext.Provider>
    </SWRConfig>
  );
}
