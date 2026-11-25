import type { SvgIconComponent } from "@mui/icons-material";
import ChecklistRoundedIcon from "@mui/icons-material/ChecklistRounded";
import ReceiptLongOutlinedIcon from "@mui/icons-material/ReceiptLongOutlined";
import { Box, Link, Skeleton, useTheme } from "@mui/material";
import { testsPagePath } from "lib/api/tests/pages/parameters";
import { costPagePath } from "lib/tests/cost/query";
import { MONOSPACE_FONT_FAMILY } from "lib/tests/header";
import { accentTextColor, headerRuleColor } from "lib/tests/headerColors";
import NextLink from "next/link";
import type { ReactNode } from "react";

// The pages a repository has in the hub, in the order the tabs set them.
// A page added to the hub for a repository is one more entry here.
export type HubPage = "tests" | "cost";

const PAGES: readonly {
  id: HubPage;
  label: string;
  icon: SvgIconComponent;
  // The page's path for a repository given as owner/name, with no
  // parameters: the page as a reader arrives on it.
  path: (_repo: string) => string;
}[] = [
  {
    id: "tests",
    label: "Tests",
    icon: ChecklistRoundedIcon,
    path: testsPagePath,
  },
  {
    id: "cost",
    label: "Cost",
    icon: ReceiptLongOutlinedIcon,
    path: costPagePath,
  },
];

// The height of the tabs' line in pixels: the row's hairline is its bottom
// edge, and the page's own tab is ruled on it.
const TABS_HEIGHT = 52;
// The space, in pixels, on either side of a tab's icon and name.
const TAB_PADDING = 8;

// Out of sight and still read out: the page's heading.
const VISUALLY_HIDDEN = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

export interface HubTabsProps {
  // The repository as owner/name; undefined until the router knows it, when
  // the tabs hold their places and lead nowhere yet.
  repo: string | undefined;
  // The page the tabs are on.
  current: HubPage;
  // A tab was clicked, before the browser follows it: the page's own tab
  // too, which leads to the page without its parameters.
  onNavigate?: (_page: HubPage) => void;
  // The page's choices, the ones that apply to all it shows, as controls
  // (HubSelect) at the row's right end; none for a page without any.
  children?: ReactNode;
}

// The top of a repository's pages in the hub, one row: the repository, then
// one tab per page, Tests and Cost, so each page says the others exist, and
// at the row's right end the page's own choices (`children`). The row is
// the page's title: the page's tab says what the page is and the controls
// say over what, so no sentence under the row repeats them. The page's
// heading, "Tests of pytorch/pytorch", is there for assistive technology
// and hidden from the eye.
//
// The tabs are links, not the tabs of a tab panel: each leads to another
// page, opens in a new tab with the modifier keys, and the page's own is
// marked for assistive technology as the current page. The page's own tab
// leads to the page without parameters, which on the tests page is the way
// back to the list's defaults. Bold on purpose, a rule under the page's own
// in the accent and its name in the accent: quieter tabs were missed.
//
// The controls are on the tabs' line while the row has room for both and
// drop under it, still against the row's right end, when it does not. The
// hairline stays under the tabs' line either way, where the page's own tab
// is ruled on it.
export default function HubTabs({
  repo,
  current,
  onNavigate,
  children,
}: HubTabsProps) {
  const theme = useTheme();
  const accentText = accentTextColor(theme);
  // The page the row is on, as the tabs list it.
  const own = PAGES.find((each) => each.id === current);
  return (
    <Box
      sx={{
        position: "relative",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: 2,
        rowGap: 1.25,
        // The hairline, drawn before the tabs so that the rule of the
        // page's own tab lies on it.
        "&::before": {
          content: '""',
          position: "absolute",
          left: 0,
          right: 0,
          top: TABS_HEIGHT - 1,
          height: "1px",
          backgroundColor: theme.palette.divider,
        },
      }}
    >
      {own !== undefined && (
        <Box component="h1" sx={VISUALLY_HIDDEN}>
          {repo === undefined ? own.label : `${own.label} of ${repo}`}
        </Box>
      )}
      <Box
        component="nav"
        aria-label="Pages"
        sx={{
          display: "flex",
          alignItems: "stretch",
          height: TABS_HEIGHT,
          // The hairline's pixel: the tabs end on it.
          pb: "1px",
        }}
      >
        {repo === undefined ? (
          <Skeleton
            variant="text"
            sx={{ alignSelf: "center", width: "16ch", fontSize: 13.5 }}
          />
        ) : (
          <Link
            component={NextLink}
            href={testsPagePath(repo)}
            prefetch={false}
            underline="none"
            onClick={() => onNavigate?.("tests")}
            sx={{
              display: "flex",
              alignItems: "center",
              fontFamily: MONOSPACE_FONT_FAMILY,
              fontSize: 13.5,
              whiteSpace: "nowrap",
              color: theme.palette.text.secondary,
              transition: theme.transitions.create("color", {
                duration: theme.transitions.duration.shortest,
              }),
              "&:hover": { color: theme.palette.text.primary },
              "&:focus-visible": {
                outline: `2px solid ${theme.palette.primary.main}`,
                outlineOffset: 2,
                borderRadius: "4px",
              },
            }}
          >
            {repo}
          </Link>
        )}
        <Box
          aria-hidden
          sx={{
            alignSelf: "center",
            flex: "none",
            width: "1px",
            height: 22,
            ml: 2.5,
            mr: 2,
            backgroundColor: theme.palette.divider,
          }}
        />
        <Box sx={{ display: "flex", gap: 2.5 }}>
          {PAGES.map((page) => {
            const here = page.id === current;
            const Icon = page.icon;
            const tabSx = {
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: "9px",
              // Room around the words for the keyboard's focus ring, which is
              // drawn inside the tab so the row's hairline stays whole.
              px: `${TAB_PADDING}px`,
              fontSize: 16,
              fontWeight: 500,
              whiteSpace: "nowrap",
              color: here ? accentText : theme.palette.text.secondary,
              transition: theme.transitions.create("color", {
                duration: theme.transitions.duration.shortest,
              }),
              "&:hover": {
                color: here ? accentText : theme.palette.text.primary,
              },
              // The rule under a tab, on the row's hairline: the accent under
              // the page's own, grey under the one the pointer is on.
              "&::after": {
                content: '""',
                position: "absolute",
                left: TAB_PADDING - 2,
                right: TAB_PADDING - 2,
                bottom: -1,
                height: 3,
                borderRadius: "3px 3px 0 0",
                backgroundColor: here
                  ? theme.palette.primary.main
                  : headerRuleColor(theme),
                transform: here ? "none" : "scaleX(0)",
                transition: theme.transitions.create("transform", {
                  duration: theme.transitions.duration.shorter,
                }),
              },
              "&:hover::after": { transform: "none" },
              "@media (prefers-reduced-motion: reduce)": {
                "&, &::after": { transition: "none" },
              },
              "&:focus-visible": {
                outline: `2px solid ${theme.palette.primary.main}`,
                outlineOffset: -2,
                borderRadius: "4px",
              },
            } as const;
            const content = (
              <>
                <Icon aria-hidden sx={{ fontSize: 20 }} />
                {page.label}
              </>
            );
            // Until the repository is known a tab has nowhere to lead.
            return repo === undefined ? (
              <Box key={page.id} component="span" sx={tabSx}>
                {content}
              </Box>
            ) : (
              <Link
                key={page.id}
                component={NextLink}
                href={page.path(repo)}
                prefetch={false}
                underline="none"
                aria-current={here ? "page" : undefined}
                onClick={() => onNavigate?.(page.id)}
                sx={tabSx}
              >
                {content}
              </Link>
            );
          })}
        </Box>
      </Box>
      {children !== undefined && (
        <Box
          role="group"
          aria-label="Page choices"
          sx={{
            ml: "auto",
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 1,
          }}
        >
          {children}
        </Box>
      )}
    </Box>
  );
}
