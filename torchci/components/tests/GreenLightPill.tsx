import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import { Box, ClickAwayListener, Link, useTheme } from "@mui/material";
import { alpha, keyframes } from "@mui/material/styles";
import GreenLightOutline from "components/greenlight/GreenLightOutline";
import GreenLightReportButton from "components/greenlight/GreenLightReportButton";
import FactPill from "components/tests/FactPill";
import LoadError from "components/tests/LoadError";
import { PillSkeleton } from "components/tests/PageHeader";
import type { GreenlightVerdict } from "lib/api/tests/commit/greenlight/types";
import { commitPagePath } from "lib/api/tests/pages/parameters";
import { selectMessageView } from "lib/greenlight/greenlightHudState";
import { shortSha, whenExact, whenLabel } from "lib/tests/commit";
import {
  CommitGreenlightState,
  GreenlightLamp,
  GreenlightSignal,
  greenlightSignal,
  GreenlightTone,
  GreenlightWords,
  noVerdictSignal,
  TrayPlacement,
  trayPlacement,
  UNAVAILABLE_WORDS,
} from "lib/tests/greenlight";
import { MONOSPACE_FONT_FAMILY } from "lib/tests/header";
import { lampColor, PillTone } from "lib/tests/headerColors";
import { useIsomorphicLayoutEffect } from "lib/tests/useIsomorphicLayoutEffect";
import NextLink from "next/link";
import {
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export interface GreenLightPillProps {
  // The repository as owner/name.
  repo: string;
  // The commit the page shows.
  sha: string;
  // What there is to show for GreenLight's verdict on it
  // (useCommitGreenlight).
  state: CommitGreenlightState;
}

// The pill's place while its answer is on its way: about the width of the
// pill most commits get, "Green Light No verdict".
const PLACEHOLDER_WIDTH = "26ch";

// The measures, in px: the lamp, the air between the pill and its tray, and
// the tray's corners.
const LAMP_SIZE = 8;
const TRAY_GAP = 8;
const TRAY_RADIUS = 14;

// The tray's motion: it unfolds from the pill at the pace of a sheet, quick
// off the mark and long to settle, and folds back faster than it came.
const UNFOLD = { duration: 300, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
const FOLD = { duration: 160, easing: "cubic-bezier(0.4, 0, 1, 1)" };

const arrive = keyframes`
  from { opacity: 0; transform: scale(0.94); }
  to { opacity: 1; transform: none; }
`;
const pulse = keyframes`
  from { opacity: 0.5; transform: scale(1); }
  to { opacity: 0; transform: scale(2.8); }
`;
// For a reader who asked for less motion nothing arrives or pulses.
const STILL = "@media (prefers-reduced-motion: reduce)";

// How long a pulsing lamp takes from its yellow to its green, and back, in
// ms: a ring leaves it once each way.
const LAMP_PULSE_MS = 1000;

// The pill's tone for a signal's: a status's own, and none for the facts'
// grey.
function pillTone(tone: GreenlightTone): PillTone | undefined {
  return tone === "neutral" ? undefined : tone;
}

// The keyframes of a pulsing lamp: from one light to the other.
function lampPulsing(from: string, to: string) {
  return keyframes`
    from { background-color: ${from}; }
    to { background-color: ${to}; }
  `;
}

// The pill's lamp: lit, a dot of the tone's light in a halo of it; unlit, a
// hollow ring, where there is no verdict: a review that reached none, a
// commit with none, an answer that did not come; pulsing, while a review is
// in flight, a dot that goes from the yellow of a refusal to the green of
// an approval and back, the two it may end in, a ring leaving it at each
// turn. The lamp is all that moves and all that has color there: the pill
// around it stays in the facts' grey. For a reader who asked for less
// motion it is a still yellow dot.
function Lamp({ tone, lamp }: { tone: GreenlightTone; lamp: GreenlightLamp }) {
  const theme = useTheme();
  const yellow = lampColor(theme, "caution");
  const color = lamp === "pulsing" ? yellow : lampColor(theme, pillTone(tone));
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        position: "relative",
        flex: "none",
        width: LAMP_SIZE,
        height: LAMP_SIZE,
        borderRadius: "50%",
        ...(lamp === "unlit"
          ? { boxShadow: `inset 0 0 0 1.5px ${color}` }
          : { backgroundColor: color }),
        ...(lamp === "lit"
          ? { boxShadow: `0 0 0 3px ${alpha(color, 0.22)}` }
          : {}),
        ...(lamp === "pulsing"
          ? {
              animation: `${lampPulsing(
                yellow,
                lampColor(theme, "positive")
              )} ${LAMP_PULSE_MS}ms ease-in-out infinite alternate`,
              [STILL]: { animation: "none" },
              "&::after": {
                content: '""',
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                // The dot's color, whichever it is at that moment.
                backgroundColor: "inherit",
                animation: `${pulse} ${LAMP_PULSE_MS}ms ease-out infinite`,
                [STILL]: { animation: "none", opacity: 0 },
              },
            }
          : {}),
      }}
    />
  );
}

// A link at the tray's foot, in HUD's link color.
const FOOT_LINK_SX = {
  display: "inline-flex",
  alignItems: "center",
  gap: 0.5,
  whiteSpace: "nowrap",
} as const;

// A span of code in the tray: the header's monospace, a little under the
// text's size, in the primary tone and on no ground of its own. The
// details around it are in the secondary tone, so an identifier stands out
// by its face and its ink, and a line holding six of them stays a line of
// text.
const CODE_SX = {
  fontFamily: MONOSPACE_FONT_FAMILY,
  fontSize: "0.88em",
  p: 0,
  bgcolor: "transparent",
  color: "text.primary",
} as const;

// The outline as the tray sets it. The list is GreenLightOutline's own, so
// the model's words stay the text nodes they are there; only its dress
// changes: a topic is a heading over its details, no bullet and no indent,
// and a detail hangs from a small dot, so the tray reads as a few short
// paragraphs under their titles and not as a nested list.
const OUTLINE_SX = {
  "& > ul": {
    listStyle: "none",
    m: 0,
    p: 0,
    display: "grid",
    rowGap: 1.5,
  },
  "& > ul > li > strong": { display: "block", fontWeight: 600 },
  "& > ul > li > ul": {
    listStyle: "none",
    m: 0,
    mt: 0.5,
    p: 0,
    display: "grid",
    rowGap: 0.5,
  },
  "& > ul > li > ul > li": {
    position: "relative",
    pl: "14px",
    lineHeight: 1.5,
    "&::before": {
      content: '""',
      position: "absolute",
      left: "3px",
      top: "calc(0.75em - 2px)",
      width: 4,
      height: 4,
      borderRadius: "50%",
      backgroundColor: "text.disabled",
    },
  },
  "& code": CODE_SX,
} as const;

// The tray's first line: the sentence for what the pill says and, beside it,
// the reason code when there is one.
function Lead({
  headline,
  reason = "",
}: {
  headline: string;
  reason?: string;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "4px 10px",
      }}
    >
      <Box
        component="span"
        sx={{
          fontSize: 15,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "text.primary",
        }}
      >
        {headline}
      </Box>
      {reason !== "" && (
        <Box
          component="code"
          sx={{
            ...CODE_SX,
            px: "6px",
            py: "1px",
            borderRadius: "999px",
            bgcolor: "action.hover",
            color: "text.secondary",
          }}
        >
          {reason}
        </Box>
      )}
    </Box>
  );
}

// A sentence under the first line, in the secondary tone.
function Body({ children }: { children: ReactNode }) {
  return <Box sx={{ mt: 1, color: "text.secondary" }}>{children}</Box>;
}

// What the tray holds for a verdict: the sentence the HUD says for the
// status with its reason code; the review's explanation, an outline as a
// list and anything else as the text it is (selectMessageView,
// GreenLightOutline: the model's words reach the page as text nodes and
// nothing else); and at its foot the pull request head the status is about,
// when it is not the commit shown but the head that landed as it, linking
// that commit's page, when the status was recorded, the review's job, and
// for a judgement the way to report it wrong, the HUD's own button
// (GreenLightReportButton), which shows to a reader who may file a report.
function Verdict({
  repo,
  sha,
  verdict,
  signal,
}: {
  repo: string;
  sha: string;
  verdict: GreenlightVerdict;
  signal: GreenlightSignal;
}) {
  const [owner, name] = repo.split("/");
  const message = selectMessageView(verdict.message);
  const landedFromAnotherCommit = verdict.head_sha !== sha;
  return (
    <>
      <Lead headline={signal.headline} reason={signal.reason} />
      {signal.body !== "" && <Body>{signal.body}</Body>}
      {message.kind === "outline" ? (
        <Box sx={{ mt: 1.75, ...OUTLINE_SX }}>
          <GreenLightOutline outline={message.outline} />
        </Box>
      ) : (
        message.text !== "" && (
          <Box
            component="pre"
            sx={{
              mt: 1.75,
              mb: 0,
              p: 1.5,
              borderRadius: "8px",
              bgcolor: "action.hover",
              fontFamily: MONOSPACE_FONT_FAMILY,
              fontSize: 12.5,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {message.text}
          </Box>
        )
      )}
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px 16px",
          mt: 2,
          pt: 1.5,
          borderTop: 1,
          borderColor: "divider",
          color: "text.secondary",
        }}
      >
        <span>
          {landedFromAnotherCommit && (
            <>
              PR head{" "}
              <Link
                component={NextLink}
                href={commitPagePath(repo, verdict.head_sha)}
                prefetch={false}
                underline="hover"
                title={verdict.head_sha}
                sx={{ fontFamily: MONOSPACE_FONT_FAMILY, fontSize: "0.9em" }}
              >
                {shortSha(verdict.head_sha)}
              </Link>
              <Box
                component="span"
                aria-hidden
                sx={{ color: "text.disabled", mx: 1 }}
              >
                ·
              </Box>
            </>
          )}
          {signal.timeWord}{" "}
          <span title={whenExact(verdict.updated_at)}>
            {whenLabel(verdict.updated_at)}
          </span>
        </span>
        <Box
          sx={{
            ml: "auto",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 16px",
          }}
        >
          {verdict.job_url !== null && (
            <Link
              href={verdict.job_url}
              target="_blank"
              rel="noreferrer"
              underline="hover"
              sx={FOOT_LINK_SX}
            >
              Inference job
              <OpenInNewRoundedIcon aria-hidden sx={{ fontSize: 14 }} />
            </Link>
          )}
          {signal.reportable && (
            <GreenLightReportButton
              repoOwner={owner}
              repoName={name}
              prNumber={verdict.pull_request_number}
              // The reviewed commit, never the one shown: on a landed commit
              // the two differ, and the verdict is about this one.
              sha={verdict.head_sha}
              status={verdict.status}
            />
          )}
        </Box>
      </Box>
    </>
  );
}

// The tray's shape as it unfolds: from the pill's own width at the tray's
// top edge, where the pill sits over it, to the whole tray. The two are
// given as they lie on the page, their left and right edges.
function unfolding(
  tray: { left: number; right: number },
  pill: { left: number; right: number }
): Keyframe[] {
  const left = Math.max(0, pill.left - tray.left);
  const right = Math.max(0, tray.right - pill.right);
  return [
    {
      clipPath: `inset(0px ${right}px 100% ${left}px round ${TRAY_RADIUS}px)`,
      transform: `translateY(${-TRAY_GAP}px)`,
    },
    {
      clipPath: `inset(0px 0px 0% 0px round ${TRAY_RADIUS}px)`,
      transform: "translateY(0px)",
    },
  ];
}

function prefersStill(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// GreenLight's verdict on the commit, the first pill of the header's facts:
// a lamp, "Green Light" and the verdict in a word or three, in the verdict's
// tone, green for an approval, yellow where a human is needed, the facts'
// grey where there is none: a review in flight is grey too, its lamp alone
// in color, pulsing between yellow and green (greenlightSignal). A commit
// with no verdict has the pill too, and so has one whose verdict could not
// be read: the pill says so, "No verdict", "Unavailable", and what is known
// of why is one press away. While the answer is on its way a placeholder
// holds the pill's place, so the facts after it do not move when it comes.
//
// The pill is a button. What it opens is a tray that unfolds from under it
// and lies over the page, so nothing below moves and closing it leaves the
// reader where they were: the reasons behind the verdict, the review's job
// and the way to report a wrong verdict (Verdict); for no verdict, why
// there is none; for one that could not be read, the failure and a Retry
// (LoadError). A click on the pill, a click elsewhere or Escape folds it
// back. The tray keeps to the row of pills: under the pill's left edge
// while it fits, else under its right (trayPlacement). It is as wide as
// what it holds, up to the place it is given, and as tall, and scrolls with
// the page, never within itself: a long verdict is read by scrolling the
// page, as the table under it is.
export default function GreenLightPill({
  repo,
  sha,
  state,
}: GreenLightPillProps) {
  const theme = useTheme();
  const trayId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const pillRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the tray is open, and whether it is on the page: it stays on it
  // while it folds.
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const [placement, setPlacement] = useState<TrayPlacement | null>(null);
  // The state the tray last moved to, so that a change of its place while
  // open, a window resized, is not unfolded again.
  const shown = useRef(false);
  // The tray's Retry was pressed: the pill takes the focus when it is back.
  const refocus = useRef(false);

  // What the pill says and what its tray holds, by what there is to show;
  // neither while the answer is on its way.
  let words: GreenlightWords | null = null;
  let held: ReactNode = null;
  switch (state.kind) {
    case "verdict": {
      const signal = greenlightSignal(state.verdict, new Date());
      if (signal !== null) {
        words = signal;
        held = (
          <Verdict
            repo={repo}
            sha={sha}
            verdict={state.verdict}
            signal={signal}
          />
        );
      }
      break;
    }
    case "no_verdict": {
      const signal = noVerdictSignal(state.reason);
      words = signal;
      held = (
        <>
          <Lead headline={signal.headline} />
          {signal.body !== "" && <Body>{signal.body}</Body>}
        </>
      );
      break;
    }
    case "unavailable": {
      const { retry } = state;
      words = UNAVAILABLE_WORDS;
      held = (
        <LoadError
          what="Green Light's verdict"
          error={state.error}
          onRetry={() => {
            refocus.current = true;
            retry();
          }}
        />
      );
      break;
    }
    case "loading":
      break;
  }
  const word = words?.word;

  const place = useCallback(() => {
    const pill = pillRef.current;
    const row = rootRef.current?.parentElement;
    if (pill == null || row == null) return;
    setPlacement(
      trayPlacement(pill.getBoundingClientRect(), row.getBoundingClientRect())
    );
  }, []);
  // Placed before it is painted, and again when the window's width changes
  // or the pill's own does, its words having changed under an open tray: a
  // review in flight that reached its verdict.
  useIsomorphicLayoutEffect(() => {
    if (!present) return;
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [present, place, word]);

  useIsomorphicLayoutEffect(() => {
    const card = cardRef.current;
    const pill = pillRef.current;
    if (!present || placement === null || card === null || pill === null) {
      return;
    }
    const leave = () => {
      setPresent(false);
      setPlacement(null);
    };
    if (shown.current === open) {
      // A fold cut short, by the window resized under it: off the page.
      if (!open) leave();
      return;
    }
    shown.current = open;
    if (typeof card.animate !== "function" || prefersStill()) {
      if (!open) leave();
      return;
    }
    const frames = unfolding(
      card.getBoundingClientRect(),
      pill.getBoundingClientRect()
    );
    if (open) {
      card.animate(frames, UNFOLD);
      contentRef.current?.animate(
        [
          { opacity: 0, transform: "translateY(-4px)" },
          { opacity: 1, transform: "translateY(0px)" },
        ],
        { duration: 240, delay: 60, easing: "ease-out", fill: "backwards" }
      );
      return;
    }
    // The words go first, so the tray folds as a blank sheet and no line is
    // seen cut through.
    const fading = contentRef.current?.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 90, easing: "ease-out", fill: "forwards" }
    );
    const folding = card.animate([...frames].reverse(), {
      ...FOLD,
      fill: "forwards",
    });
    folding.onfinish = leave;
    // Opened again while folding: the fold is dropped, or it would hold the
    // tray shut under the unfolding.
    return () => {
      folding.onfinish = null;
      folding.cancel();
      fading?.cancel();
    };
  }, [open, present, placement]);

  // Asked again from the tray, the pill gives way to its placeholder and the
  // key that asked has nothing to come back to: the pill takes the focus
  // when it is back.
  useEffect(() => {
    if (word !== undefined && refocus.current) {
      refocus.current = false;
      pillRef.current?.focus();
    }
  }, [word]);

  if (state.kind === "loading") {
    return <PillSkeleton width={PLACEHOLDER_WIDTH} />;
  }
  if (words === null) return null;

  const toggle = () => {
    if (!open) setPresent(true);
    setOpen(!open);
  };
  const close = () => setOpen(false);
  const dark = theme.palette.mode === "dark";
  return (
    <ClickAwayListener onClickAway={() => open && close()}>
      <Box
        ref={rootRef}
        component="span"
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (event.key !== "Escape" || !open) return;
          event.stopPropagation();
          close();
          pillRef.current?.focus();
        }}
        sx={{
          position: "relative",
          display: "inline-flex",
          // Over the summary and the table while the tray is on the page.
          zIndex: present ? theme.zIndex.speedDial : "auto",
          animation: `${arrive} 240ms ease-out`,
          [STILL]: { animation: "none" },
        }}
      >
        <FactPill
          ref={pillRef}
          tone={pillTone(words.tone)}
          mark={<Lamp tone={words.tone} lamp={words.lamp} />}
          label="Green Light"
          title={open ? undefined : words.headline}
          onClick={toggle}
          expanded={open}
          controls={trayId}
        >
          {words.word}
        </FactPill>
        {present && (
          <Box
            // Where the tray sits follows the window's width, so it is the
            // element's own style: a class would be made for every place.
            style={{
              left: placement?.left ?? 0,
              width: placement?.width ?? 0,
              // Not seen until it is placed.
              visibility: placement === null ? "hidden" : "visible",
            }}
            sx={{
              position: "absolute",
              top: `calc(100% + ${TRAY_GAP}px)`,
              // The shadow follows the tray's shape as it unfolds, which a
              // box shadow, cut off with the box, would not.
              filter: dark
                ? "drop-shadow(0 16px 32px rgba(0, 0, 0, 0.5)) drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4))"
                : "drop-shadow(0 16px 32px rgba(0, 0, 0, 0.14)) drop-shadow(0 2px 6px rgba(0, 0, 0, 0.08))",
            }}
          >
            <Box
              ref={cardRef}
              id={trayId}
              role="region"
              aria-label={`Green Light: ${words.headline}`}
              // A tray that holds little is no wider than what it holds, and
              // stays under its pill: against the edge it hangs from.
              style={{
                marginLeft:
                  placement !== null && placement.left < 0 ? "auto" : 0,
              }}
              sx={{
                boxSizing: "border-box",
                width: "fit-content",
                maxWidth: "100%",
                p: 2,
                borderRadius: `${TRAY_RADIUS}px`,
                border: 1,
                borderColor: "divider",
                bgcolor: "background.paper",
                color: "text.primary",
                whiteSpace: "normal",
                transformOrigin: "top left",
              }}
            >
              <Box ref={contentRef}>{held}</Box>
            </Box>
          </Box>
        )}
      </Box>
    </ClickAwayListener>
  );
}
