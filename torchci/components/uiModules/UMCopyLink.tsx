import CopyLink from "components/CopyLink";
import { objectToQueryString } from "components/utilization/UtilizationReportPage/hepler";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";

export const UMCopyLink = ({
  params,
  excludeKeys = [],
}: {
  params: any;
  excludeKeys?: string[];
}) => {
  const router = useRouter();
  const [cleanUrl, setCleanUrl] = useState("");

  const paramsString = `${objectToQueryString(params, excludeKeys)}`;
  useEffect(() => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      setCleanUrl(`${url.origin}${url.pathname}`);
    }
  }, [router.asPath]);
  return <CopyLink textToCopy={`${cleanUrl}?${paramsString}`} />;
};
