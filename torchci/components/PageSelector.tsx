import { formatHudUrlForRoute, HudParams, packHudParams } from "lib/types";
import { usePerPagePreference } from "lib/useGroupingPreference";
import Link from "next/link";
import { useRouter } from "next/router";

export default function PageSelector({
  params,
  baseUrl,
}: {
  params: HudParams;
  baseUrl: string;
}) {
  // Get the persisted perPage preference
  const [perPage] = usePerPagePreference(params.per_page);

  return (
    <>
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
      <PerPageSelector />
    </>
  );
}

/**
 * Component for selecting the number of items per page
 */
function PerPageSelector() {
  const router = useRouter();
  const params = packHudParams(router.query);

  // Get URL parameter if available
  const urlPerPage = params.per_page ? Number(params.per_page) : undefined;

  // Use the URL parameter as the initial value if available
  const [perPage, setPerPage] = usePerPagePreference(urlPerPage);

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const newValue = parseInt(event.target.value);
    setPerPage(newValue);

    // Update the URL to reflect the new per_page value
    router.push(formatHudUrlForRoute("hud", {
      ...params,
      per_page: newValue,
    }));
  };

  // Default to just showing 50 and 100 as page values, but if the
  // current perPage is set to something else then include that in
  // the list as well
  const options = [50, 100];
  if (!options.includes(perPage)) {
    options.push(perPage);
  }
  // Keep it sorted
  options.sort((a, b) => a - b);

  return (
    <div>
      <label htmlFor="per-page-select">Items per page:</label>
      <select
        id="per-page-select"
        value={perPage}
        onChange={handleChange}
      >
        {options.map((option) => (
          <option value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
