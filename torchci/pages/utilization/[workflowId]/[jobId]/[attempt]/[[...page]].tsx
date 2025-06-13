import LoadingPage from "components/LoadingPage";
import { JobUtilizationPage } from "components/utilization/JobUtilizationPage/JobUtilizationPage";
import { fetcherHandleError } from "lib/GeneralUtils";
import { UtilizationAPIResponse } from "lib/utilization/types";
import { useRouter } from "next/router";
import useSWRImmutable from "swr/immutable";

const JobUtilization = () => {
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
    return <LoadingPage />;
  }

  return (
    <div>
      <JobUtilizationPage
        workflowId={workflowId ? (workflowId as string) : ""}
        jobId={jobId ? (jobId as string) : ""}
        attempt={attempt ? (attempt as string) : ""}
        data={data as UtilizationAPIResponse}
      ></JobUtilizationPage>
    </div>
  );
};
export default JobUtilization;
