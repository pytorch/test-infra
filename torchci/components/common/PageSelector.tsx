import { formatHudUrlForRoute, HudParams } from "lib/types";
import Link from "next/link";

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
          </Link>
        </span>
      ) : (
        <span>Prev</span>
      )}{" "}
      |{" "}
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
