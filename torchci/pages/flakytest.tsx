import JobLinks from "components/JobLinks";
import JobSummary from "components/JobSummary";
import LogViewer from "components/LogViewer";
import { ParamSelector } from "lib/ParamSelector";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { FlakyTestInfoHUD } from "./api/flaky-tests/flakytest";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function setURL(name: string, suite: string, file: string, limit: string) {
  window.location.href = `/flakytest?name=${encodeURIComponent(
    name
  )}&suite=${encodeURIComponent(suite)}&file=${encodeURIComponent(
    file
  )}&limit=${encodeURIComponent(limit)}`;
}

export default function Page() {
  const router = useRouter();
  const name = (router.query.name || "%") as string;
  const suite = (router.query.suite || "%") as string;
  const file = (router.query.file || "%") as string;
  const limit = (router.query.limit || "100") as string;
  const [hasSearch, setHasSearch] = useState(true);
  useEffect(() => {
    console.log(name, suite, file);
    if (name === "%" && suite === "%" && file === "%") {
      setHasSearch(false);
    } else {
      setHasSearch(true);
    }
    console.log(hasSearch);
  }, [name, suite, file]);

  // `useSWR` to avoid sending a garbage request to the server.
  const swrKey = `/api/flaky-tests/flakytest?name=${encodeURIComponent(
    name
  )}&suite=${encodeURIComponent(suite)}&file=${encodeURIComponent(
    file
  )}&limit=${encodeURIComponent(limit)}`;
  const { data } = useSWR(hasSearch && swrKey, fetcher);

  return (
    <div>
      <h1>PyTorch CI Test Failures and Flaky Tests</h1>
      <div>
        {/* The March 22 date refers to https://github.com/pytorch/pytorch/pull/97304 */}
        This shows the most recent failures in CI from after March 22nd, 2023
        (100 by default). Data prior to this date still exists, but can only be
        obtained by parsing test report xmls. If the job was successful, it
        might have succeeded on retry. Search through the logs for the test
        name.
      </div>
      <h3>
        Test Name Filter:{" "}
        <ParamSelector
          value={name}
          handleSubmit={(e) => setURL(e, suite, file, limit)}
        />{" "}
        | Test Suite Filter:{" "}
        <ParamSelector
          value={suite}
          handleSubmit={(s) => setURL(name, s, file, limit)}
        />{" "}
        | Test File Filter:{" "}
        <ParamSelector
          value={file}
          handleSubmit={(s) => setURL(name, suite, s, limit)}
        />
      </h3>
      {!hasSearch ? (
        <div>
          Please click the blue boxes with '%' and enter a test name/class/file
          to search for a specific test.
        </div>
      ) : data === undefined ? (
        <div>Loading...</div>
      ) : (
        (data as FlakyTestInfoHUD[]).map((test) => {
          return (
            <div key={`${test.name} ${test.classname} ${test.file}`}>
              <h1>
                <code>{`${test.name}, ${test.classname}`}</code>
              </h1>
              from file <code>{`${test.invoking_file}`}</code>
              <div>Jobs ({test.jobs.length} matches):</div>
              <ul>
                {test.jobs.map((job) => {
                  return (
                    <li key={job.id} id={job.id}>
                      <JobSummary
                        job={job}
                        highlight={job.branch == "main"}
                        unstableIssues={[]}
                      />
                      <div>
                        <JobLinks job={job} showCommitLink={true} />
                      </div>
                      <LogViewer job={job} />
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}
    </div>
  );
}
