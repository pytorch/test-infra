import { Box, Skeleton } from "@mui/material";
import FactPill from "components/tests/FactPill";
import {
  FactsRow,
  HeaderCrumbs,
  HeaderRule,
  HeaderSkeleton,
} from "components/tests/PageHeader";
import TestTitle from "components/tests/TestTitle";
import type { TestRecord } from "lib/api/tests/types";
import {
  firstSeenExact,
  firstSeenLabel,
  headerCrumbs,
  LANGUAGE_COLORS,
  UNKNOWN_LANGUAGE,
  UNKNOWN_VALUE,
} from "lib/tests/header";
import { useMounted } from "lib/tests/useMounted";

export interface TestHeaderProps {
  // The test shown; undefined while there is none to show.
  test: TestRecord | undefined;
  // The owner labels of its file, as the API gives them; empty for none.
  owners: readonly string[];
  // The test's language as the options label it, "Python"; undefined until
  // the options have arrived, when a skeleton holds its place.
  languageLabel: string | undefined;
  // With no test: whether one is on its way, so the header holds its
  // place, or there is none, so it says only what the page is.
  loading?: boolean;
}

// The language's mark is a dot this wide.
const LANGUAGE_DOT = 10;

// When the catalog first saw the test, filled in on the client only: the
// server does not know the viewer's time zone.
function FirstSeen({ timestamp }: { timestamp: string }) {
  const mounted = useMounted();
  if (!mounted) return <span />;
  return (
    <span title={firstSeenExact(timestamp)}>{firstSeenLabel(timestamp)}</span>
  );
}

// The language's mark: a dot in GitHub's color for the language, which
// readers know from its repository listings (LANGUAGE_COLORS). The name
// beside it says what it is, so the dot is hidden from assistive technology.
function LanguageDot({ color }: { color: string }) {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        width: LANGUAGE_DOT,
        height: LANGUAGE_DOT,
        borderRadius: "50%",
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

// The header of a test's page, set from the hub's header pieces
// (PageHeader): where the test lives, as a monospace breadcrumb of links
// back to the list; its name, the headline (TestTitle); and a row of facts
// as pills, the language, when the catalog first saw the test and the
// owners of its file, each said even when unknown, so the row always has
// its three pills. Until the test arrives a skeleton holds each line's
// place, so nothing moves when it comes; with no test to show the headline
// says "Test" and the rest is left out.
export default function TestHeader({
  test,
  owners,
  languageLabel,
  loading = false,
}: TestHeaderProps) {
  if (test === undefined) {
    if (!loading) {
      return <TestTitle test={undefined} />;
    }
    return <HeaderSkeleton pillWidths={["9ch", "22ch", "16ch"]} />;
  }
  const languageColor = LANGUAGE_COLORS[test.language];
  // A language the catalog could not tell has no dot and no name of its
  // own, so its pill says what is unknown.
  const languageUnknown = test.language === UNKNOWN_LANGUAGE;
  return (
    <Box>
      <HeaderCrumbs crumbs={headerCrumbs(test)} />
      <TestTitle test={test} />
      <FactsRow>
        <FactPill
          mark={
            languageColor === null ? undefined : (
              <LanguageDot color={languageColor} />
            )
          }
          label={languageUnknown ? "Language" : undefined}
          muted={languageUnknown}
        >
          {languageLabel ?? (
            <Skeleton width="6ch" sx={{ display: "inline-block" }} />
          )}
        </FactPill>
        <FactPill label="First Seen">
          <FirstSeen timestamp={test.first_seen_at} />
        </FactPill>
        <FactPill
          label={owners.length > 1 ? "Owners" : "Owner"}
          muted={owners.length === 0}
        >
          {owners.length === 0 ? UNKNOWN_VALUE : owners.join(" · ")}
        </FactPill>
      </FactsRow>
      <HeaderRule />
    </Box>
  );
}
