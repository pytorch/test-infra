import { FlakyTestData } from "lib/types";
import {getWorkflowJobNames} from "pages/api/flaky-tests/disable";
import { useRouter } from "next/router";
import useSWR from "swr";
import styles from "components/flakytest.module.css";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function convertJobIDtoURLs(jobIds: number[]): string[] {
  return jobIds.map((element) => {
    return `https://github.com/pytorch/pytorch/actions/jobs/${element}`;
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
        Test Name Filter: <code>{name === "%" ? "<any>" : name}</code>
      </h2>
      <h2>
        Test Suite Filter: <code>{suite === "%" ? "<any>" : suite}</code>
      </h2>
      <h2>
        Test File Filter: <code>{file === "%" ? "<any>" : file}</code>
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
              <th className={styles.table}>Workflow Job URLs</th>
              <th className={styles.table}>Workflow Job Names</th>
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
                  <td className={styles.table}>
                    {convertJobIDtoURLs(test.jobIds).join("\n")}
                  </td>
                  <td className={styles.table}>{getWorkflowJobNames(test)}</td>
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
