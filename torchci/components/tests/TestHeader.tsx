import {
  Box,
  Breadcrumbs,
  Divider,
  Link,
  Skeleton,
  useTheme,
} from "@mui/material";
import TestTitle from "components/tests/TestTitle";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import type { TestRecord } from "lib/api/tests/types";
import {
  firstSeenExact,
  firstSeenLabel,
  headerCrumbs,
  LANGUAGE_COLORS,
  MONOSPACE_FONT_FAMILY,
  UNKNOWN_LANGUAGE,
  UNKNOWN_VALUE,
} from "lib/tests/header";
import { headerBandColor } from "lib/tests/headerColors";
import NextLink from "next/link";
import { ReactNode, useEffect, useState } from "react";

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

// The header's small text, the breadcrumb and the pills, is HUD's body2,
// the size of the table's captions and the view chips, and a pill is a
// chip's height. The language's mark is a dot this wide.
const SMALL_TEXT = "body2" as const;
const LANGUAGE_DOT = 10;

// When the catalog first saw the test, filled in on the client only: the
// server does not know the viewer's time zone.
function FirstSeen({ timestamp }: { timestamp: string }) {
  const [display, setDisplay] = useState<{ label: string; exact: string }>();
  useEffect(() => {
    setDisplay({
      label: firstSeenLabel(timestamp),
      exact: firstSeenExact(timestamp),
    });
  }, [timestamp]);
  return <span title={display?.exact}>{display?.label}</span>;
}

// One fact of the row, as a pill in the grey of the title's pills and the
// table's header band, a view chip's height: a mark, when the fact has
// one, a muted word in title case for what it is, "First Seen", then the
// value a step heavier; a fact that is its own word, the language, has no
// label. A value the catalog does not have is said, "Unknown", and stays
// muted, so a value that is there stands out. The pill is a plain span: it
// is read, not pressed, so it has no hover and no chevron.
function FactPill({
  mark,
  label,
  muted = false,
  children,
}: {
  mark?: ReactNode;
  label?: string;
  muted?: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        height: VIEW_CHIP_HEIGHT,
        px: 1.25,
        borderRadius: "999px",
        backgroundColor: headerBandColor(theme),
        color: "text.secondary",
        whiteSpace: "nowrap",
      }}
    >
      {mark}
      {label !== undefined && <span>{label}</span>}
      <Box
        component="span"
        sx={muted ? undefined : { color: "text.primary", fontWeight: 500 }}
      >
        {children}
      </Box>
    </Box>
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

// The header of a test's page, in three quiet lines over a hairline: where
// the test lives, as a monospace breadcrumb of links back to the list; its
// name, the headline (TestTitle); and a row of facts as pills, the
// language, when the catalog first saw the test and the owners of its file,
// each said even when unknown, so the row always has its three pills.
// Hierarchy is carried by weight and tone, not size: the breadcrumb and the
// pills in the secondary tone, the headline alone at full weight. Until the
// test arrives a skeleton holds each line's place, so nothing moves when it
// comes; with no test to show the headline says "Test" and the rest is
// left out.
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
    return (
      <Box>
        <Skeleton width="44ch" sx={{ typography: SMALL_TEXT }} />
        <Skeleton
          width="60ch"
          sx={{ fontSize: (theme) => theme.typography.h5.fontSize, mt: 1.25 }}
        />
        <Box sx={{ display: "flex", gap: 1, mt: 1.75 }}>
          {["9ch", "22ch", "16ch"].map((width) => (
            <Skeleton
              key={width}
              variant="rounded"
              width={width}
              height={VIEW_CHIP_HEIGHT}
              sx={{ borderRadius: "999px" }}
            />
          ))}
        </Box>
        <Divider sx={{ mt: 2.5 }} />
      </Box>
    );
  }
  const languageColor = LANGUAGE_COLORS[test.language];
  // A language the catalog could not tell has no dot and no name of its
  // own, so its pill says what is unknown.
  const languageUnknown = test.language === UNKNOWN_LANGUAGE;
  return (
    <Box>
      <Breadcrumbs
        separator="›"
        sx={{
          typography: SMALL_TEXT,
          fontFamily: MONOSPACE_FONT_FAMILY,
          color: "text.secondary",
          mb: 1.25,
          "& .MuiBreadcrumbs-separator": { color: "text.disabled", mx: 1.25 },
        }}
      >
        {headerCrumbs(test).map((crumb) => (
          <Link
            key={crumb.href}
            component={NextLink}
            href={crumb.href}
            prefetch={false}
            underline="hover"
            color="inherit"
          >
            {crumb.text}
          </Link>
        ))}
      </Breadcrumbs>
      <TestTitle test={test} />
      <Box
        sx={{
          typography: SMALL_TEXT,
          display: "flex",
          flexWrap: "wrap",
          gap: 1,
          mt: 1.75,
        }}
      >
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
      </Box>
      <Divider sx={{ mt: 2.5 }} />
    </Box>
  );
}
