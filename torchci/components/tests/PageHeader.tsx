import { Box, Breadcrumbs, Divider, Link, Skeleton } from "@mui/material";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import { Crumb, MONOSPACE_FONT_FAMILY } from "lib/tests/header";
import NextLink from "next/link";
import { ReactNode } from "react";

// The pieces a hub page's header is set from, shared by the test page
// (TestHeader) and the commit page (CommitHeader): three quiet lines over a
// hairline, where the thing lives as a monospace breadcrumb of links, its
// headline (HEADLINE_SX in lib/tests/header.ts), and a row of facts as
// pills (FactPill). Hierarchy is carried by weight and tone, not size: the
// breadcrumb and the pills in the secondary tone, the headline alone at
// full weight.

// The header's small text, the breadcrumb and the pills, is HUD's body2,
// the size of the table's captions and the view chips, and a pill is a
// chip's height.
const HEADER_SMALL_TEXT = "body2" as const;

// Where the page's subject lives, as links back up the hub: "pytorch/pytorch
// › test/foo.py › TestFoo".
export function HeaderCrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <Breadcrumbs
      separator="›"
      sx={{
        typography: HEADER_SMALL_TEXT,
        fontFamily: MONOSPACE_FONT_FAMILY,
        color: "text.secondary",
        mb: 1.25,
        "& .MuiBreadcrumbs-separator": { color: "text.disabled", mx: 1.25 },
      }}
    >
      {crumbs.map((crumb) =>
        crumb.href === undefined ? (
          <span key={crumb.text}>{crumb.text}</span>
        ) : (
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
        )
      )}
    </Breadcrumbs>
  );
}

// The row of fact pills under the headline, wrapping when the page is
// narrow.
export function FactsRow({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        typography: HEADER_SMALL_TEXT,
        display: "flex",
        flexWrap: "wrap",
        gap: 1,
        mt: 1.75,
      }}
    >
      {children}
    </Box>
  );
}

// The hairline that closes the header.
export function HeaderRule() {
  return <Divider sx={{ mt: 2.5 }} />;
}

// A pill's place while its fact is on its way, at the width given, "9ch".
export function PillSkeleton({ width }: { width: string }) {
  return (
    <Skeleton
      variant="rounded"
      width={width}
      height={VIEW_CHIP_HEIGHT}
      sx={{ borderRadius: "999px" }}
    />
  );
}

// The header's place while its subject is on its way, so nothing moves when
// it comes: a line for the breadcrumb, one for the headline, and a pill for
// each fact, at the widths given, "9ch".
export function HeaderSkeleton({
  pillWidths,
}: {
  pillWidths: readonly string[];
}) {
  return (
    <Box>
      <Skeleton width="44ch" sx={{ typography: HEADER_SMALL_TEXT }} />
      <Skeleton
        width="60ch"
        sx={{ fontSize: (theme) => theme.typography.h5.fontSize, mt: 1.25 }}
      />
      <Box sx={{ display: "flex", gap: 1, mt: 1.75 }}>
        {pillWidths.map((width, index) => (
          <PillSkeleton key={index} width={width} />
        ))}
      </Box>
      <HeaderRule />
    </Box>
  );
}
