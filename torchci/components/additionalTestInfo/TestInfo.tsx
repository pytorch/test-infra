import styled from "@emotion/styled";
import { Link } from "@mui/material";
import { fetcher } from "lib/GeneralUtils";
import { runWorkflow } from "lib/githubFunctions";
import { IsJobInProgress } from "lib/JobClassifierUtil";
import { JobData } from "lib/types";
import { useSession } from "next-auth/react";
import { useState } from "react";
import useSWR from "swr";
import { TestRerunsInfo } from "./RerunInfo";
import { TestCountsInfo } from "./TestCounts";
import styles from "./TestInfo.module.css";

const WorkflowLevelUtilizationSection = styled("div")(({}) => ({
  margin: "10px",
}));

export function genMessage({
  infoString,
  pending = false,
  error,
}: {
  infoString: string;
  pending?: boolean;
  error?: any;
}) {
  let errorString = "";
  if (pending) {
    errorString +=
      "Workflow is still pending. Consider generating info in the corresponding tab.  If you have already done this, ";
    infoString = infoString.charAt(0).toLowerCase() + infoString.slice(1);
  }
  errorString += infoString;
  if (error) {
    errorString += ` (${error})`;
  }
  return errorString.trim();
}

export function isPending(jobs: JobData[]) {
  return jobs.some((job) => IsJobInProgress(job.conclusion));
}

export function RecursiveDetailsSummary({
  info,
  level,
  summaryFunction = (name: any, _info: any) => <>{name}</>,
  bodyFunction,
  children,
}: {
  info: any;
  level: number;
  summaryFunction?: (_name: any, _info: any) => JSX.Element;
  children: (_name: any, _info: any, _numSiblings: number) => JSX.Element;
  bodyFunction?: (_name: any, _info: any) => JSX.Element;
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

function TDInfo({
  workflowId,
  jobs,
  runAttempt,
}: {
  workflowId: string;
  jobs: JobData[];
  runAttempt: string;
}) {
  const shouldShow = jobs.some((job) => job.name!.includes("/ test "));
  const { data: info, error } = useSWR(
    shouldShow
      ? `https://ossci-raw-job-status.s3.amazonaws.com/additional_info/td_exclusions/${workflowId}/${runAttempt}`
      : null,
    fetcher
  );

  if (!shouldShow) {
    return <div>Workflow is still pending or there are no test jobs</div>;
  }

  const infoString =
    "No test files were excluded or there was trouble parsing data";

  if (error) {
    if (isPending(jobs)) {
      return (
        <div>
          {genMessage({
            infoString: infoString,
            pending: true,
            error: error,
          })}
        </div>
      );
    }
    return <div>Error retrieving data {`${error}`}</div>;
  }

  if (!info) {
    return <div>Loading...</div>;
  }

  if (Object.keys(info).length == 0) {
    if (isPending(jobs)) {
      return (
        <div>
          {genMessage({
            infoString: infoString,
            pending: true,
          })}
        </div>
      );
    }
    return <div>{infoString}</div>;
  }
  return (
    <div>
      <div
        style={{ fontSize: "1.17em", fontWeight: "bold", paddingTop: "1em" }}
      >
        Excluded test files by job
      </div>
      <div>This shows the files excluded by TD.</div>
      {isPending(jobs) && (
        <div>Workflow is still pending. Data may be incomplete.</div>
      )}
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

function RegenerateInfo({
  workflowId,
  runAttempt,
  jobs,
}: {
  workflowId: string;
  runAttempt: string;
  jobs: JobData[];
}) {
  const session = useSession();
  const [status, setStatus] = useState("");
  if (session.status !== "authenticated") {
    return (
      <div>
        You must be logged in with write permissions to regenerate test data
      </div>
    );
  }
  return (
    <div>
      <div>
        If you are logged in and have write permissions, this can be used to
        regenerate the info in each of the tabs. This can be helpful if you
        believe any data is missing or incorrect, and also if the scripts to
        generate information have been updated since the last time the data was
        generated. This will also work even if the jobs are still pending but
        will result in incomplete data. This may take a few minutes to run.
      </div>
      {status == "" && (
        <button
          onClick={async () => {
            runWorkflow({
              workflowName: "upload_test_stats_intermediate.yml",
              body: {
                workflow_id: workflowId,
                workflow_run_attempt: runAttempt,
              },
              owner: "pytorch",
              repo: "pytorch",
              accessToken: session.data?.accessToken,
              onComplete: setStatus,
            });
          }}
          disabled={status !== ""}
          style={{
            backgroundColor: "white",
          }}
        >
          Click here to regenerate data
        </button>
      )}
      <div>{status}</div>
      {status == "Workflow triggered successfully" && (
        <div>
          The data is being regenerated. It may take a few minutes for the new
          data to show up. You can see the progress of the workflow{" "}
          <a
            href={`https://github.com/pytorch/pytorch/actions/workflows/upload_test_stats_intermediate.yml`}
          >
            here
          </a>
          .
        </div>
      )}
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

  function ButtonSelector({ name }: { name: string }) {
    return (
      <button
        onClick={() => setShowInfo(name)}
        className={showInfo === name ? styles.active : ""}
      >
        {name}
      </button>
    );
  }

  return (
    <>
      <WorkflowLevelUtilizationSection>
        <div>
          {" "}
          See workflow level utilization summary for linux tests:
          <span>
            {" "}
            <Link href={`/utilization/${workflowId}`}>
              {" "}
              utilization report
            </Link>{" "}
          </span>
        </div>
      </WorkflowLevelUtilizationSection>
      <div className={styles.tab}>
        <ButtonSelector name="Reruns Info" />
        <ButtonSelector name="TD Info" />
        <ButtonSelector name="Test Counts Info" />
        <ButtonSelector name="Regenerate Info" />
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
        {showInfo == "Regenerate Info" && (
          <RegenerateInfo
            workflowId={workflowId}
            jobs={jobs}
            runAttempt={runAttempt}
          />
        )}
      </div>
    </>
  );
}
