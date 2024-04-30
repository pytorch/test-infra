import { useRouter } from "next/router";
import { useCallback, useContext, useEffect, useState } from "react";
import { formatHudUrlForRoute, HudParams } from "./types";
import { PinnedTooltipContext } from "../pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";

export default function useTableFilter(params: HudParams) {
  const router = useRouter();

  const [jobFilter, setJobFilter] = useState<string | null>(null);
  // null and empty string both correspond to no filter; otherwise lowercase it
  // to make the filter case-insensitive.
  const normalizedJobFilter =
    jobFilter === null || jobFilter === "" ? null : jobFilter.toLowerCase();

  const [pinnedId] = useContext(PinnedTooltipContext);

  useEffect(() => {
    const sha = pinnedId.sha;
    const listener = (e) => {
      if (e.code === "Escape") {
        setJobFilter(null);
        router.push(formatHudUrlForRoute("hud", params), undefined, {
          shallow: true,
        });
      }
    };
    if (!sha) {
      document.addEventListener("keydown", listener);
      return () => {
        document.removeEventListener("keydown", listener);
      };
    }
  }, [pinnedId.sha]);
  const handleInput = useCallback(
    (f: any) => {
      setJobFilter(f);
      router.push(
        formatHudUrlForRoute("hud", {
          ...params,
          nameFilter: f ?? undefined,
        }),
        undefined,
        {
          shallow: true,
        }
      );
    },
    [params, router]
  );
  const handleSubmit = () => {};

  // We have to use an effect hook here because query params are undefined at
  // static generation time; they only become available after hydration.
  useEffect(() => {
    const filterValue = (router.query.name_filter as string) || "";
    setJobFilter(filterValue);
  }, [router.query.name_filter]);

  return { jobFilter, handleSubmit, handleInput, normalizedJobFilter };
}
