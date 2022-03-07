import { useRouter } from "next/router";
import { useCallback, useEffect, useState } from "react";
import { formatHudUrlForRoute, HudParams } from "./types";

export default function useTableFilter(params: HudParams) {
  const router = useRouter();

  const [jobFilter, setJobFilter] = useState<string | null>(null);
  // null and empty string both correspond to no filter; otherwise lowercase it
  // to make the filter case-insensitive.
  const normalizedJobFilter =
    jobFilter === null || jobFilter === "" ? null : jobFilter.toLowerCase();

  useEffect(() => {
    document.addEventListener("keydown", (e) => {
      if (e.code === "Escape") {
        setJobFilter(null);
      }
    });
  }, []);
  const handleInput = useCallback((f) => {
    setJobFilter(f);
  }, []);
  const handleSubmit = useCallback(() => {
    if (jobFilter === "") {
      router.push(formatHudUrlForRoute("hud", params), undefined, {
        shallow: true,
      });
    } else {
      router.push(
        formatHudUrlForRoute("hud", {
          ...params,
          nameFilter: jobFilter ?? undefined,
        }),
        undefined,
        {
          shallow: true,
        }
      );
    }
  }, [params, router, jobFilter]);

  // We have to use an effect hook here because query params are undefined at
  // static generation time; they only become available after hydration.
  useEffect(() => {
    const filterValue = (router.query.name_filter as string) || "";
    setJobFilter(filterValue);
    handleInput(filterValue);
  }, [router.query.name_filter, handleInput]);

  return { jobFilter, handleSubmit, handleInput, normalizedJobFilter };
}
