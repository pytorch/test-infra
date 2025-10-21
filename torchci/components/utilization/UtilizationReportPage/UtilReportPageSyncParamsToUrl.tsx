import { useRouter } from "next/router";
import { useEffect } from "react";
import { useUtilizationReportContext } from "./UtilizationReportContext";

export const UtilReportPageSyncParamsToUrl = () => {
  const router = useRouter();
  const { values } = useUtilizationReportContext();

  useEffect(() => {
    if (!router.isReady) return;

    router.replace(
      {
        pathname: router.pathname,
        query: values, // overwrite the whole query string
      },
      undefined,
      { shallow: true }
    );
  }, [router.isReady, values]);

  return null;
};
