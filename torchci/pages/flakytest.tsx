import { FlakyTestData } from "lib/types";
import { useRouter } from "next/router";
import useSWR from "swr";
import styles from "components/flakytest.module.css";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function convertWorkflowIDtoURLs(workflowIds: string[]): string[] {
  return workflowIds.map((element) => {
    return `https://github.com/pytorch/pytorch/actions/runs/${element}`;
  });
}

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
      <h2>
        Test Name: <code>{name}</code>
      </h2>
      <h2>
        Test Suite: <code>{suite}</code>
      </h2>
      <h2>
        Test File: <code>{file}</code>
      </h2>
      <em>Showing last 14 days of data.</em>
      {data === undefined ? (
        <div>Loading...</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.table}>Test Name</th>
              <th className={styles.table}>Test Suite</th>
              <th className={styles.table}>Test File</th>
              <th className={styles.table}># Green</th>
              <th className={styles.table}># Red</th>
              <th className={styles.table}>Workflow URLs</th>
              <th className={styles.table}>Workflow Names</th>
              <th className={styles.table}>Branches</th>
            </tr>
          </thead>
          <tbody>
            {(data.flakyTests as FlakyTestData[]).map((test) => {
              return (
                <tr key={`${test.name} ${test.suite}`}>
                  <td className={styles.table}>{test.name}</td>
                  <td className={styles.table}>{test.suite}</td>
                  <td className={styles.table}>{test.file}</td>
                  <td className={styles.table}>{test.numGreen}</td>
                  <td className={styles.table}>{test.numRed}</td>
                  <td className={styles.table}>
                    {convertWorkflowIDtoURLs(test.workflowIds).join("\n")}
                  </td>
                  <td className={styles.table}>{test.workflowNames.join("\n")}</td>
                  <td className={styles.table}>{test.branches.join("\n")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
