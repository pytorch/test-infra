import { UtilizationPage } from "components/utilization/UtilizationPage";
import { fetcherHandleError } from "lib/GeneralUtils";
import { useRouter } from "next/router";
import useSWRImmutable from "swr";

const Utilization = () => {
  const router = useRouter();
  const { workflowId, jobId, attempt } = router.query;

  let { data, error } = useSWRImmutable(
    `/api/utilization/${workflowId}/${jobId}/${attempt}`,
    fetcherHandleError
  );

  if (error) {
    return (
      <div>
        error: {error.message}, StatusCode: {error.status}, info: {error.info}
      </div>
    );
  }

  if (!data) {
    return <div>loading...</div>;
  }

  console.log(data?.ts_list);

  return (
    <div>
      <UtilizationPage
        workflowId={workflowId ? (workflowId as string) : ""}
        jobId={jobId ? (jobId as string) : ""}
        attempt={attempt ? (attempt as string) : ""}
        lines={data?.ts_list}
        metadata={data?.metadata}
        hardwareMetrics={data?.hardware_metrics}
      ></UtilizationPage>
    </div>
  );
};
export default Utilization;
