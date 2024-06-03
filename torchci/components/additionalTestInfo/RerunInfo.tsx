import { fetcher } from "lib/GeneralUtils";
import { JobData } from "lib/types";
import _ from "lodash";
import { useState } from "react";
import useSWR from "swr";
import { genMessage, isPending, RecursiveDetailsSummary } from "./TestInfo";

function groupByStatus(info: any) {
  const flaky = {};
  const failed = {};
  const succeeded = {};
  _.forIn(info, (value, build) => {
    _.forIn(value, (value, testConfig) => {
      _.forIn(value, (value, invokingFile) => {
        _.forIn(value, (value, className) => {
          _.forIn(value, (value, testName) => {
            const [failures, successes] = _.partition(value, (i) => i.failure);
            const failuresWithReruns = failures.concat(
              _(value)
                .filter((i: any) => i.rerun)
                .map((i) => {
                  if (!Array.isArray(i.rerun)) {
                    i.rerun = [i.rerun];
                  }
                  return i.rerun.map((rerun: any) => ({
                    failure: rerun,
                    job_id: i.job_id,
                  }));
                })
                .flatten()
                .value()
            );
            if (failuresWithReruns.length == 0) {
              _.set(
                succeeded,
                [build, testConfig, invokingFile, className, testName],
                failuresWithReruns.concat(successes)
              );
            } else if (successes.length > 0) {
              _.set(
                flaky,
                [build, testConfig, invokingFile, className, testName],
                failuresWithReruns.concat(successes)
              );
            } else {
              _.set(
                failed,
                [build, testConfig, invokingFile, className, testName],
                failuresWithReruns.concat(successes)
              );
            }
          });
        });
      });
    });
  });
  return {
    flaky: Object.keys(flaky).length > 0 ? flaky : undefined,
    failed: Object.keys(failed).length > 0 ? failed : undefined,
    succeeded: Object.keys(succeeded).length > 0 ? succeeded : undefined,
  };
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

  const [trackbacksToShow, setTrackbacksToShow] = useState(
    new Set<number>(failures.length == 1 ? [0] : [])
  );

  return (
    <details open={numSiblings == 1}>
      <summary>
        {name} ({failures.length + successes.length} total runs)
      </summary>
      <div style={{ paddingLeft: "1em" }}>
        {failures.map((i: any, ind: number) => {
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
                Show Traceback #{ind + 1} on
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
        {successes.map((i: any, ind: number) => {
          return (
            <div key={ind}>
              <span>Succeeded on</span>
              <a href={`#${i.job_id}-box`}> job {i.job_id}</a>
            </div>
          );
        })}
      </div>{" "}
    </details>
  );
}

export function TestRerunsInfo({
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
      ? `https://ossci-raw-job-status.s3.amazonaws.com/additional_info/reruns/${workflowId}/${runAttempt}`
      : null,
    fetcher
  );

  if (!shouldShow) {
    return <div>Workflow is still pending or there are no test jobs</div>;
  }
  const infoString = "No tests were rerun or there was trouble parsing data";

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
  const { succeeded, flaky, failed } = groupByStatus(info);

  const divSummaryStyle = {
    fontWeight: "bold",
  };

  return (
    <>
      <div style={{ fontSize: "1.17em", fontWeight: "bold", padding: "1em 0" }}>
        Info about tests that got rerun
      </div>
      {isPending(jobs) && (
        <div>Workflow is still pending. Data may be incomplete.</div>
      )}
      {flaky && (
        <div>
          <div style={divSummaryStyle}>
            The following tests were flaky: they failed, were rerun, and then
            succeeded
          </div>
          <RecursiveDetailsSummary info={flaky} level={4}>
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
      )}
      {failed && (
        <div>
          <div style={divSummaryStyle}>
            The following tests failed across all reruns
          </div>
          <RecursiveDetailsSummary info={failed} level={4}>
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
      )}
      {succeeded && (
        <div>
          <div style={divSummaryStyle}>
            The following tests succeded, but were rerun anyways, likely because
            some other test failed
          </div>
          <RecursiveDetailsSummary info={succeeded} level={4}>
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
      )}
    </>
  );
}
