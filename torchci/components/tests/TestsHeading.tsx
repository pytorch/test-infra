import { Box, Skeleton, Typography } from "@mui/material";
import InlineSelect from "components/tests/InlineSelect";
import type { TestOptions } from "lib/api/tests/options/types";
import { labelOf, menuOrder } from "lib/tests/facets";
import { languagesPhrase, ranOnPhrase, TestsQuery } from "lib/tests/table";

export interface TestsHeadingProps {
  // The repository as owner/name; undefined until the router knows it.
  repo: string | undefined;
  // The choices on offer, from GET /api/tests/options; undefined until it
  // answers.
  options: TestOptions | undefined;
  // The URL's query resolved against the options; undefined with them.
  query: TestsQuery | undefined;
  onQueryChange: (_query: TestsQuery) => void;
}

// Holds a pill's place in the sentence until the options arrive.
function PillPlaceholder({ width }: { width: string }) {
  return (
    <Skeleton
      variant="rounded"
      sx={{
        display: "inline-block",
        width,
        height: "1.15em",
        borderRadius: "999px",
        verticalAlign: "text-bottom",
      }}
    />
  );
}

// The title is a sentence saying what the table shows, and the three choices
// in it are the controls that change it: the window, the code sources and
// the languages. Their values, labels and defaults all come from the
// options. The columns' own filters live in their headers; when the data was
// last refreshed is the table's own caption.
export default function TestsHeading({
  repo,
  options,
  query,
  onQueryChange,
}: TestsHeadingProps) {
  if (repo === undefined) {
    return (
      <Typography variant="h4" component="h1">
        Tests
      </Typography>
    );
  }
  const choices =
    options !== undefined && query !== undefined ? { options, query } : null;

  return (
    <Typography variant="h4" component="h1" sx={{ lineHeight: 1.5 }}>
      Tests in{" "}
      <Box component="span" sx={{ color: "text.secondary" }}>
        {repo}
      </Box>{" "}
      that ran within the last{" "}
      {choices === null ? (
        <PillPlaceholder width="5ch" />
      ) : (
        <InlineSelect
          label="Window"
          display={labelOf(choices.query.window, choices.options.window.values)}
          options={choices.options.window.values}
          value={choices.query.window}
          onChange={(window) => onQueryChange({ ...choices.query, window })}
        />
      )}{" "}
      on{" "}
      {choices === null ? (
        <PillPlaceholder width="4ch" />
      ) : (
        <InlineSelect
          multiple
          label="Code sources"
          display={ranOnPhrase(choices.query.ranOn, choices.options)}
          // At least one code source stays chosen: the API requires one, so
          // the last one cannot be unchecked.
          options={choices.options.ran_on.values.map(({ value, label }) => ({
            value,
            label,
            disabled:
              choices.query.ranOn.length === 1 &&
              choices.query.ranOn[0] === value,
          }))}
          value={choices.query.ranOn}
          onChange={(ranOn) =>
            onQueryChange({
              ...choices.query,
              ranOn: menuOrder(ranOn, choices.options.ran_on.values),
            })
          }
        />
      )}{" "}
      in{" "}
      {choices === null ? (
        <PillPlaceholder width="9ch" />
      ) : (
        <InlineSelect
          multiple
          label="Languages"
          display={languagesPhrase(choices.query.languages, choices.options)}
          options={choices.options.language.values}
          value={choices.query.languages}
          onChange={(languages) =>
            onQueryChange({
              ...choices.query,
              languages: menuOrder(languages, choices.options.language.values),
            })
          }
        />
      )}
    </Typography>
  );
}
