import HubSelect, { HubSelectSkeleton } from "components/tests/HubSelect";
import type { TestOptions } from "lib/api/tests/options/types";
import { labelOf } from "lib/tests/facets";
import { languagesPhrase, ranOnPhrase, TestsQuery } from "lib/tests/table";

export interface TestsChoicesProps {
  // The choices on offer, from GET /api/tests/options; undefined until it
  // answers.
  options: TestOptions | undefined;
  // The URL's query resolved against the options; undefined with them.
  query: TestsQuery | undefined;
  onQueryChange: (_query: TestsQuery) => void;
}

// The widths, in pixels, the three controls have on the page's defaults,
// "Window 3 hours", "Ran on main" and "Language All": what their
// placeholders are cut to, so nothing in the row moves when the options
// arrive on a page at its defaults. Measured, not derived: a default or a
// label changed in the API moves the row a few pixels until these follow.
const PLACEHOLDER_WIDTHS = [146, 126, 128];

// The tests page's choices, set at the right end of the tabs' row (HubTabs):
// the three that apply to the whole table, the window, the code sources and
// the languages, each a named control (HubSelect). Their values, labels and
// defaults all come from the options. The columns' own filters live in
// their headers; when the data was last refreshed is the table's own
// caption.
export default function TestsChoices({
  options,
  query,
  onQueryChange,
}: TestsChoicesProps) {
  if (options === undefined || query === undefined) {
    return (
      <>
        {PLACEHOLDER_WIDTHS.map((width, index) => (
          <HubSelectSkeleton key={index} width={width} />
        ))}
      </>
    );
  }
  return (
    <>
      <HubSelect
        label="Window"
        display={labelOf(query.window, options.window.values)}
        options={options.window.values}
        value={query.window}
        onChange={(window) => onQueryChange({ ...query, window })}
      />
      <HubSelect
        multiple
        // At least one code source stays chosen: the API requires one.
        required
        label="Ran on"
        hint="One or more"
        display={ranOnPhrase(query.ranOn, options)}
        options={options.ran_on.values}
        value={query.ranOn}
        onChange={(ranOn) => onQueryChange({ ...query, ranOn })}
      />
      <HubSelect
        multiple
        label="Language"
        hint="None chosen means all"
        display={languagesPhrase(query.languages, options)}
        options={options.language.values}
        value={query.languages}
        onChange={(languages) => onQueryChange({ ...query, languages })}
      />
    </>
  );
}
