import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { useRouter } from "next/router";
import { useEffect, useRef } from "react";

export function BackToMainButton() {
  const router = useRouter();
  const renderGroupId = useDashboardSelector((s) => s.renderGroupId);
  const { prevRef, currentRef } = useRouteHistory();

  const handleClick = () => {
    if (prevRef.current) {
      router.back();
    } else {
      const { renderGroupId, ...rest } = router.query as Record<string, any>;
      const nextMainQuery = { ...rest, renderGroupId: "main" };

      // push the main page
      router.push(
        { pathname: router.pathname, query: nextMainQuery },
        undefined,
        { shallow: false }
      );
    }
  };

  if (renderGroupId === "main") {
    return null;
  }

  return (
    <Tooltip title="Back to previous main view">
      <IconButton onClick={handleClick} size="small">
        <ArrowBackIcon />
      </IconButton>
    </Tooltip>
  );
}

/**
 * record the route history, mainly used to decide if go back use router history or create a main page url
 */
export function useRouteHistory() {
  const router = useRouter();
  const prevRef = useRef<string | null>(null);
  const currentRef = useRef<string>(router.asPath);
  const hasInitialized = useRef(false);

  useEffect(() => {
    const handleRouteChangeComplete = (url: string) => {
      // skip the very first hydration event
      if (!hasInitialized.current) {
        hasInitialized.current = true;
        return;
      }

      prevRef.current = currentRef.current;
      currentRef.current = url;
    };

    router.events.on("routeChangeComplete", handleRouteChangeComplete);
    return () => {
      router.events.off("routeChangeComplete", handleRouteChangeComplete);
    };
  }, [router]);

  return { prevRef, currentRef };
}
