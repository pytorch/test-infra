import { useRouter } from "next/router";
import useSWR from "swr";
import LogViewer from "components/LogViewer";
import { FlakyTestInfoHUD } from "./api/flaky-tests/flakytest";
import JobLinks from "components/JobLinks";
import JobSummary from "components/JobSummary";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function Page() {
  const router = useRouter();
  const name = (router.query.name || "%") as string;
  const suite = (router.query.suite || "%") as string;
  const file = (router.query.file || "%") as string;

  // `useSWR` to avoid sending a garbage request to the server.
  const swrKey = `/api/flaky-tests/flakytest?name=${encodeURIComponent(
    name
  )}&suite=${encodeURIComponent(suite)}&file=${encodeURIComponent(file)}`;
  const { data } = useSWR(swrKey, fetcher);

  return (
    <div>
      <h1>PyTorch CI Test Failures and Flaky Tests</h1>
      <div>
        This shows the most recent 100 failures in CI from after March 22nd,
        2023. Data prior to this date still exists, but can only be obtained by
        parsing test report xmls. If the job was successful, it might have
        succeeded on retry. Search through the logs for the test name.
      </div>
      <h3>
        Test Name Filter: <code>{name === "%" ? "<any>" : name}</code> | Test
        Suite Filter: <code>{suite === "%" ? "<any>" : suite}</code> | Test File
        Filter: <code>{file === "%" ? "<any>" : file}</code>
      </h3>
      {data === undefined ? (
        <div>Loading...</div>
      ) : (
        (data as FlakyTestInfoHUD[]).map((test) => {
          return (
            <div key={`${test.name} ${test.classname} ${test.file}`}>
              <h1>
                <code>{`${test.name}, ${test.classname}`}</code>
              </h1>
              from file <code>{`${test.invoking_file}`}</code>
              <div>Jobs:</div>
              <ul>
                {test.jobs.map((job) => {
                  return (
                    <li key={job.id} id={job.id}>
                      <JobSummary job={job} />
                      <div>
                        <JobLinks job={job} />
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
