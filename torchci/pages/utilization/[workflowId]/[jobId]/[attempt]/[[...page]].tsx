import { fetcher } from "lib/GeneralUtils";
import { useRouter } from "next/router";
import useSWR from "swr";

const ApiData = () => {
  const router = useRouter();
  const { workflowId, jobId, attempt } = router.query;
  
  let { data, error } = useSWR(
    `/api/utilization/${workflowId}/${jobId}/${attempt}`,
    fetcher,
    {
      refreshInterval: 12 * 60 * 60 * 1000, // refresh every 12 hours
    }
  );

  if (!data) {
    return <div>loading...</div>;
  }

  return (
    <div>
      <h1>API Data</h1>
      <div>
        workflowId:{workflowId}, JobId: {jobId}, attempt: {attempt}, job_name:{" "}
        {data.metadata.job_name}, workflow_name: {data.metadata.workflow_name}
      </div>
      <div
        style={{ maxWidth: "800px", whiteSpace: "pre-wrap", overflowX: "auto" }}
      >
        <pre>{JSON.stringify(data.metadata, null, 2)}</pre>
      </div>
    </div>
  );
};
export default ApiData;
