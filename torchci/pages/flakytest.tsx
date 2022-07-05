import { FlakyTestData } from "lib/types";
import { useRouter } from "next/router";
import useSWR from "swr";
import LogViewer from "components/LogViewer";
import { getFlakyTestCapture } from "./api/flaky-tests/flakytest";

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
      <h1>PyTorch CI Flaky Tests</h1>
      <h3>
        Test Name Filter: <code>{name === "%" ? "<any>" : name}</code> | Test
        Suite Filter: <code>{suite === "%" ? "<any>" : suite}</code> | Test File
        Filter: <code>{file === "%" ? "<any>" : file}</code>
      </h3>
      <em>Showing last 30 days of data.</em>
      {data === undefined ? (
        <div>Loading...</div>
      ) : (
        (data.flakyTests as FlakyTestData[]).map((test) => {
          const samples = data.flakySamples[getFlakyTestCapture(test)];
          console.log(samples);
          return (
            <div key={`${test.name} ${test.suite} ${test.file}`}>
              <h1>
                <code>{`${test.name}, ${test.suite}`}</code>
              </h1>
              from file <code>{`${test.file}`}</code>
              <div>
                <h4> Test workflow job URLs: </h4>
                <ul>
                  {test.workflowNames.map((value, index) => {
                    return (
                      <li key={index}>
                        <a
                          href={`https://github.com/pytorch/pytorch/runs/${test.jobIds[index]}`}
                        >{`${value} / ${test.jobNames[index]}`}</a>{" "}
                        on branch {test.branches[index]}
                      </li>
                    );
                  })}
                </ul>
              </div>
              {samples?.length > 0 && (
                <div>
                  <p>Example logs: </p> <LogViewer job={samples[0]} />
                </div>
              )}
              <h4>Debugging instructions:</h4>
              <p>
                As flaky tests will soon show as green, it will be harder to
                parse the logs. To find relevant log snippets:
              </p>
              <ol>
                <li>
                  Click on any of the workflow job links above, for example{" "}
                  <a
                    href={`https://github.com/pytorch/pytorch/runs/${test.jobIds[0]}`}
                  >{`${test.workflowNames[0]} / ${test.jobNames[0]}`}</a>
                </li>
                <li>
                  Click on the Test step of the job so that it is expanded.
                  Otherwise, the grepping will not work.
                </li>
                <li>
                  Grep for <code>{test.name}</code>
                </li>
                <li>
                  There should be several instances run (as flaky tests are
                  rerun in CI) from which you can study the logs.
                </li>
              </ol>
            </div>
          );
        })
      )}
    </div>
  );
}
