import CopyLink from "components/common/CopyLink";
import { stateToQuery } from "lib/helpers/urlQuery";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";

/** Convert query object → query string */
export function queryObjectToSearchParams(
  q: Record<string, string | string[] | undefined>
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) {
      v.forEach((val) => usp.append(k, val));
    } else if (v != null) {
      usp.set(k, v);
    }
  }
  return usp.toString();
}

// ---------- Component ----------

export const UMCopyLink = ({
  params,
  excludeKeys = [],
}: {
  params: any;
  excludeKeys?: string[];
}) => {
  const router = useRouter();
  const [cleanUrl, setCleanUrl] = useState("");

  const paramsString = useMemo(
    () => queryObjectToSearchParams(stateToQuery(params, excludeKeys)),
    [params, excludeKeys]
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      setCleanUrl(`${url.origin}${url.pathname}`);
    }
  }, [router.asPath]);

  return <CopyLink textToCopy={`${cleanUrl}?${paramsString}`} />;
};

export function formUrlWithParams(url: string, params: any, excludeKeys = []) {
  const paramsString = queryObjectToSearchParams(
    stateToQuery(params, excludeKeys)
  );
  return `${url}?${paramsString}`;
}
