import { Box, Typography, useTheme } from "@mui/material";
import CostFrame from "components/tests/cost/CostFrame";
import KeyButton from "components/tests/cost/KeyButton";
import OwnerBars from "components/tests/cost/owners/OwnerBars";
import { chipText } from "components/tests/cost/trends/PickRow";
import { sideColor, sideText } from "components/tests/cost/trends/TrendBars";
import LoadError from "components/tests/LoadError";
import {
  type Compare,
  type CostOwners,
  costOwnersUrl,
  current,
  type OwnerBarsPanelProps,
  ownersEcho,
  type TrendContext,
  type TrendsQuery,
} from "lib/api/tests/cost/contracts";
import {
  OWNER_PRESETS,
  ownerBarsModel,
  ownerPresetChoices,
  ownerPresetInForce,
  ownerPresetPatch,
  togglePill,
} from "lib/tests/cost/ownerBars";
import { dataDays } from "lib/tests/cost/select";
import { useApiResource } from "lib/tests/useApiResource";
import { useMounted } from "lib/tests/useMounted";
import { usePreference } from "lib/useGroupingPreference";
import { type ReactNode, useMemo } from "react";

// The reader's fold, kept in the browser: one reader's choice, so a shared
// link never opens folded for someone else.
export const OWNER_BARS_OPEN = "costOwnerBarsOpen";

const DESCRIPTION = [
  "Test-job runner-hours of B by owner, split by machine; a file's hours split evenly among its owners.",
  "Click a row to drill in below; › lists its runners.",
];
const PRICED =
  "$: each day at that day's rate; days without one stay unpriced. ~: an average.";

// The keys on the band, through the page's URL, so A, B and the Trends
// picker move together; lit while A and B are a key's days, in any rollup.
function PresetKeys({
  context: ctx,
  query,
  compare,
  onTrendsChange,
}: {
  context: TrendContext | null;
  query: TrendsQuery;
  compare: Compare | null;
  onTrendsChange: OwnerBarsPanelProps["onTrendsChange"];
}) {
  const choices = ctx === null ? [] : ownerPresetChoices(ctx);
  return (
    <>
      {OWNER_PRESETS.map((p) => {
        const choice = choices.find((c) => c.key === p.key);
        return (
          <KeyButton
            key={p.key}
            title={choice?.title ?? "Waits for the trend"}
            active={
              choice !== undefined &&
              compare !== null &&
              ownerPresetInForce(choice, compare)
            }
            disabled={!choice?.available}
            onClick={() => {
              if (ctx !== null && choice !== undefined)
                onTrendsChange(ownerPresetPatch(choice, query, ctx));
            }}
          >
            {p.label}
          </KeyButton>
        );
      })}
    </>
  );
}

// Usage by owner over B, the page's studied period, in runner-hours or $:
// V1's horizontal bars, split by machine, with the machine key beside them. It
// has no dates of its own: it draws the drill's settled B, and its keys set
// A and B for the whole page. The heading's workflows scope it; a click on
// an owner or a machine is the drill's pill. Folded, it asks for nothing.
export default function OwnerBarsPanel(props: OwnerBarsPanelProps) {
  const {
    repo,
    workflows,
    scopeLabel,
    context: ctx,
    query,
    compare,
    settled,
    onTrendsChange,
    pricer,
    runnerHours,
    trail,
    onTrailChange,
  } = props;
  const theme = useTheme();
  const [open, setOpen] = usePreference(OWNER_BARS_OPEN, undefined, true);
  // The stored fold applies after the first render: no request before it.
  const mounted = useMounted();
  const usd = props.unit === "usd" && pricer !== null;
  const b = settled?.b ?? null;
  const hasData = ctx !== null && b !== null && dataDays(ctx, b) > 0;
  const url =
    mounted && open && repo !== undefined && b !== null && hasData
      ? costOwnersUrl(repo, workflows, b, usd ? "day" : undefined)
      : null;
  const res = useApiResource<CostOwners>(url, { keepPreviousData: true });
  const now = current(res.data, url, ownersEcho);
  // A kept answer draws dimmed meanwhile; in $ only one with day cells.
  const kept =
    res.data !== undefined && (!usd || res.data.piece === "day")
      ? res.data
      : undefined;
  const shown = url === null ? undefined : now ?? kept;
  const colored = useMemo(
    () =>
      runnerHours === undefined
        ? undefined
        : runnerHours.colored.map((m) => runnerHours.machines[m]),
    [runnerHours]
  );
  const trailKey = JSON.stringify(trail);
  const model = useMemo(
    () =>
      shown === undefined
        ? null
        : ownerBarsModel(shown, {
            pricer: usd ? pricer : null,
            colored,
            trail,
          }),
    // trail is read through its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, usd, pricer, colored, trailKey]
  );

  const live = compare === null || ctx === null ? null : compare;
  const badge =
    live === null || ctx === null
      ? undefined
      : (() => {
          const text = chipText(live.rollup, live.b, ctx);
          return (
            <Box
              component="span"
              sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}
            >
              <span>·</span>
              <Box
                component="span"
                sx={{
                  width: 16,
                  height: 16,
                  borderRadius: "3px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  fontWeight: 700,
                  color: sideText(theme, "b"),
                  backgroundColor: sideColor(theme, "b"),
                }}
              >
                B
              </Box>
              <span>
                {text.range} · {text.length}
                {text.note !== null && ` · ${text.note}`}
              </span>
            </Box>
          );
        })();

  const message = (text: string) => (
    <Typography variant="body2" sx={{ color: "text.secondary" }}>
      {text}
    </Typography>
  );
  let body: ReactNode;
  let drawn = false;
  if (url !== null && res.error !== undefined) {
    body = (
      <LoadError
        what="the usage by owner"
        error={res.error}
        onRetry={() => void res.retry()}
      />
    );
  } else if (ctx === null) body = message("Loading the trend…");
  else if (!hasData) body = message("B has no data.");
  else if (model === null) body = message("Loading usage by owner…");
  else if (model.answer.rows.length === 0)
    body = message(`No test-job runner-hours in ${scopeLabel} on B's days.`);
  else if (model.unit === "usd" && model.total.value === null)
    body = message("No rates for B's days.");
  else {
    drawn = true;
    body = (
      <OwnerBars
        model={model}
        stale={now === undefined}
        scopeLabel={scopeLabel}
        onTogglePill={(pill) => onTrailChange(togglePill(trail, pill))}
        onClear={() => onTrailChange([])}
      />
    );
  }

  return (
    <Box>
      <CostFrame
        title="Usage by owner"
        description={[...DESCRIPTION, ...(usd ? [PRICED] : [])].join("\n")}
        note={badge}
        keys={
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 0.75,
              alignItems: "center",
            }}
          >
            <PresetKeys
              context={ctx}
              query={query}
              compare={compare}
              onTrendsChange={onTrendsChange}
            />
            <Box sx={{ width: 8 }} />
            <KeyButton
              title="Runner-hours"
              active={!usd}
              onClick={() => onTrendsChange({ unit: "hours" })}
            >
              Hours
            </KeyButton>
            <KeyButton
              title={
                pricer === null
                  ? "Add a rates file to see $"
                  : `$ at ${pricer.set.file}'s rates`
              }
              active={usd}
              disabled={pricer === null}
              onClick={() => onTrendsChange({ unit: "usd" })}
            >
              $
            </KeyButton>
          </Box>
        }
        open={open}
        onOpenChange={setOpen}
        loading={url !== null && now === undefined && res.error === undefined}
      >
        {body}
      </CostFrame>
      {open && drawn && (
        <Typography
          variant="caption"
          component="p"
          sx={{ mt: 0.75, color: "text.secondary" }}
        >
          Machines from test reports; striped: estimated from runner labels;
          grey stripes: unknown. › lists a row&apos;s runners.
        </Typography>
      )}
    </Box>
  );
}
