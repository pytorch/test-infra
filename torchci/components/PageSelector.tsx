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
            Newer
          </Link>
        </span>
      ) : (
        <span>Newer</span>
      )}{" "}
      |{" "}
      <Link
        prefetch={false}
        href={formatHudUrlForRoute(baseUrl, {
          ...params,
          page: params.page + 1,
        })}
      >
        Older
      </Link>
    </div>
  );
}
