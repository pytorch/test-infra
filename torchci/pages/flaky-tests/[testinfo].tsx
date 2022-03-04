import { FlakyTestData } from "lib/types";
import { useRouter } from "next/router";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function convertWorkflowIDtoURLs(workflowIds: string[]): string[] {
  return workflowIds.map((element) => {
    return `https://github.com/pytorch/pytorch/actions/runs/${element}`;
  });
}

export default function Page() {
  const router = useRouter();
  // Expect testinfo to be /testName%20testSuite%20testFile
  const testinfo = router.query.testinfo;

  // `useSWR` to avoid sending a garbage request to the server.
  const swrKey =
    testinfo !== undefined
      ? `/api/flaky-tests/${encodeURIComponent(testinfo as string)}`
      : "/api/flaky-tests/test";
  const { data } = useSWR(swrKey, fetcher);

  return (
    <div>
      <h1>PyTorch CI Flaky Tests</h1>
      <h2>
        <code>{testinfo}</code>
      </h2>
      <em>Showing last 14 days of data.</em>
      {data === undefined ? (
        <div>Loading...</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Test Name</th>
              <th>Test Suite</th>
              <th>Test File</th>
              <th># Green</th>
              <th># Red</th>
              <th>Workflow URLs</th>
              <th>Workflow Names</th>
              <th>Branches</th>
            </tr>
          </thead>
          <tbody>
            {(data.flakyTests as FlakyTestData[]).map((test) => {
              return (
                <tr key={`${test.name} ${test.suite}`}>
                  <td>{test.name}</td>
                  <td>{test.suite}</td>
                  <td>{test.file}</td>
                  <td>{test.numGreen}</td>
                  <td>{test.numRed}</td>
                  <td>
                    {convertWorkflowIDtoURLs(test.workflowIds).join("\n")}
                  </td>
                  <td>{test.workflowNames.join("\n")}</td>
                  <td>{test.branches.join("\n")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
