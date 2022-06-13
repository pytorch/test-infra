import { formatHudUrlForRoute, HudParams } from "lib/types";
import Link from "next/link";
import React from "react";

export default function PageSelector({
  params,
  baseUrl,
}: {
  params: HudParams;
  baseUrl: string;
}) {
  return (
    <div>
      Page {params.page}:{" "}
      {params.page > 1 ? (
        <span>
          <Link
            prefetch={false}
            href={formatHudUrlForRoute(baseUrl, {
              ...params,
              page: params.page - 1,
            })}
          >
            Prev
          </Link>{" "}
          |{" "}
        </span>
      ) : null}
      <Link
        prefetch={false}
        href={formatHudUrlForRoute(baseUrl, {
          ...params,
          page: params.page + 1,
        })}
      >
        Next
      </Link>
    </div>
  );
}
