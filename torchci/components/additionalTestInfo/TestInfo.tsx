import { JobData } from "lib/types";
import { useState } from "react";
import _ from "lodash";
import styles from "./TestInfo.module.css";
import useSWR from "swr";
import { fetcher } from "lib/GeneralUtils";
import { TestCountsInfo } from "./TestCounts";

export function RecursiveDetailsSummary({
  info,
  level,
  summaryFunction = (name: any, info: any) => <>{name}</>,
  bodyFunction,
  children,
}: {
  info: any;
  level: number;
  summaryFunction?: (name: any, info: any) => JSX.Element;
  children: (name: any, info: any, numSiblings: number) => JSX.Element;
  bodyFunction?: (name: any, info: any) => JSX.Element;
}) {
  const keysInInfo = Object.keys(info);
  if (level == 0) {
    return (
      <ul style={{ paddingLeft: "0em" }}>
        {keysInInfo.map((config) => (
          <li style={{ listStyleType: "none" }} key={config}>
            {children(config, info[config], keysInInfo.length)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <>
      {bodyFunction && bodyFunction("All", info)}
      <ul style={{ paddingLeft: "0em" }}>
        {keysInInfo.map((config) => (
          <li style={{ listStyleType: "none" }} key={config}>
            <details open={!bodyFunction && keysInInfo.length == 1}>
              <summary>{summaryFunction(config, info[config])}</summary>
              <div style={{ paddingLeft: "1em" }}>
                {bodyFunction && bodyFunction(config, info[config])}
                <RecursiveDetailsSummary
                  key={config}
                  summaryFunction={summaryFunction}
                  info={info[config]}
                  level={level - 1}
                >
                  {children}
                </RecursiveDetailsSummary>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </>
  );
}

function TestRerunsInfoIndividiual({
  info,
  name,
  numSiblings,
}: {
  info: any;
  name: any;
  numSiblings: number;
}) {
  const [failures, successes] = _.partition(info, (i) => i.failure);

  const failuresWithReruns = failures.concat(
    _(info)
      .filter((i: any) => i.rerun)
      .map((i) => i.rerun.map((rerun: any) => ({ ...rerun, job_id: i.job_id })))
      .flatten()
      .value()
  );

  const [trackbacksToShow, setTrackbacksToShow] = useState(
    new Set<number>(failures.length == 1 ? [0] : [])
  );

  return (
    <details open={numSiblings == 1}>
      <summary>
        {name} (
        {successes.length > 0 ? "Flaky/Succeeded after reruns" : "Failed"}) (
        {failuresWithReruns.length} reruns)
      </summary>
      <div style={{ paddingLeft: "1em" }}>
        {failuresWithReruns.map((i: any, ind: number) => {
          return (
            <div key={ind}>
              <span
                onClick={() => {
                  if (trackbacksToShow.has(ind)) {
                    const newSet = new Set(trackbacksToShow);
                    newSet.delete(ind);
                    setTrackbacksToShow(newSet);
                  } else {
                    setTrackbacksToShow(new Set(trackbacksToShow).add(ind));
                  }
                }}
              >
                Show Trackback #{ind + 1} on
              </span>
              <a href={`#${i.job_id}-box`}> job {i.job_id}</a>
              {trackbacksToShow.has(ind) && (
                <div
                  style={{
                    overflowY: "auto",
                    maxHeight: "50vh",
                    borderColor: "black",
                    borderStyle: "solid",
                    borderWidth: "1px",
                    padding: "0em 0.5em",
                  }}
                >
                  <pre>{i.failure.text}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>{" "}
    </details>
  );
}

function TestRerunsInfo({
  workflowId,
  jobs,
  runAttempt,
}: {
  workflowId: string;
  jobs: JobData[];
  runAttempt: string;
}) {
  const shouldShow =
    jobs.every((job) => job.conclusion !== "pending") &&
    jobs.some((job) => job.name!.includes("/ test "));

  const { data: info, error } = useSWR(
    shouldShow
      ? `https://ossci-raw-job-status.s3.amazonaws.com/additional_info/reruns/${workflowId}/${runAttempt}`
      : null,
    fetcher
  );

  if (!shouldShow) {
    return <div>Workflow is still pending or there are no test jobs</div>;
  }

  if (error) {
    return <div>Error retrieving data {`${error}`}</div>;
  }

  if (!info) {
    return <div>Loading...</div>;
  }
  if (Object.keys(info).length == 0) {
    return <div>No tests were rerun or there was trouble parsing data</div>;
  }

  return (
    <>
      <div
        style={{ fontSize: "1.17em", fontWeight: "bold", paddingTop: "1em" }}
      >
        Info about tests that got rerun
      </div>
      <div>
        <RecursiveDetailsSummary info={info} level={4}>
          {(name: any, info: any, numSiblings: number) => (
            <TestRerunsInfoIndividiual
              key={name}
              info={info}
              name={name}
              numSiblings={numSiblings}
            />
          )}
        </RecursiveDetailsSummary>
      </div>
    </>
  );
}

function TDInfo({
  workflowId,
  jobs,
  runAttempt,
}: {
  workflowId: string;
  jobs: JobData[];
  runAttempt: string;
}) {
  const shouldShow =
    jobs.every((job) => job.conclusion !== "pending") &&
    jobs.some((job) => job.name!.includes("/ test "));
  const { data: info, error } = useSWR(
    shouldShow
      ? `https://ossci-raw-job-status.s3.amazonaws.com/additional_info/td_exclusions/${workflowId}/${runAttempt}`
      : null,
    fetcher
  );

  if (!shouldShow) {
    return <div>Workflow is still pending or there are no test jobs</div>;
  }

  if (error) {
    return <div>Error retrieving data {`${error}`}</div>;
  }

  if (!info) {
    return <div>Loading...</div>;
  }

  if (Object.keys(info).length == 0) {
    return (
      <div>No test files were excluded or there was trouble parsing data</div>
    );
  }
  return (
    <div>
      <div
        style={{ fontSize: "1.17em", fontWeight: "bold", paddingTop: "1em" }}
      >
        Excluded test files by job
      </div>
      <RecursiveDetailsSummary
        info={info}
        level={1}
        summaryFunction={(name: any, info: any) => {
          const count = Object.values(info).reduce(
            (prev: number, curr: any) => curr.length + prev,
            0
          );
          return (
            <>
              {name} ({count})
            </>
          );
        }}
      >
        {(config: any, configInfo: any, numSiblings: number) => (
          <details open={numSiblings == 1} key={config}>
            <summary>
              {config} ({configInfo.length})
            </summary>
            <div style={{ paddingLeft: "1em" }}>
              <div
                style={{
                  overflowY: "auto",
                  maxHeight: "50vh",
                  borderColor: "black",
                  borderStyle: "solid",
                  borderWidth: "1px",
                  padding: "0em 0.5em",
                }}
              >
                {Array.from(configInfo).map((file: any) => {
                  return <div key={file}>{file}</div>;
                })}
              </div>
            </div>
          </details>
        )}
      </RecursiveDetailsSummary>
    </div>
  );
}

export function TestInfo({
  workflowId,
  runAttempt,
  jobs,
}: {
  workflowId: string;
  runAttempt: string;
  jobs: JobData[];
}) {
  const [showInfo, setShowInfo] = useState("Reruns Info");

  function setShowInfoHelper(info: string) {
    if (showInfo === info) {
      setShowInfo("none");
    } else {
      setShowInfo(info);
    }
  }

  function ButtonSelector({ name }: { name: string }) {
    return (
      <button
        onClick={() => setShowInfoHelper(name)}
        className={showInfo === name ? styles.active : ""}
      >
        {name}
      </button>
    );
  }

  return (
    <>
      <div className={styles.tab}>
        <ButtonSelector name="Reruns Info" />
        <ButtonSelector name="TD Info" />
        <ButtonSelector name="Test Counts Info" />
      </div>
      <div className={styles.tabcontent}>
        {showInfo == "TD Info" && (
          <TDInfo workflowId={workflowId} jobs={jobs} runAttempt={runAttempt} />
        )}
        {showInfo == "Reruns Info" && (
          <TestRerunsInfo
            workflowId={workflowId}
            jobs={jobs}
            runAttempt={runAttempt}
          />
        )}
        {showInfo == "Test Counts Info" && (
          <TestCountsInfo
            workflowId={workflowId}
            jobs={jobs}
            runAttempt={runAttempt}
          />
        )}
      </div>
    </>
  );
}
