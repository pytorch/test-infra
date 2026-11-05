import { Grid } from "@mui/material";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import {
  landingsMissing,
  NOTHING_TO_MEASURE,
  TD_CUT_PCT,
  TdParams,
} from "lib/targetDeterminator";
import {
  mergeChunks,
  sectionChunks,
  useChunkedTdQuery,
} from "lib/targetDeterminatorChunks";
import { type RankRow, ratio } from "lib/targetDeterminatorRows";
import { TdSection } from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

export default function RankingSection({
  params,
  charts,
}: {
  params: TdParams;
  charts: TdChartsState;
}) {
  const now = Date.now();
  const { spec, chunks, range } = sectionChunks("ranks", params, now);
  const states = useChunkedTdQuery<RankRow>(spec.query, chunks);
  const ranks = mergeChunks(spec.query, chunks, states, spec);
  const landings = ranks.total?.landings ?? 0;
  const insideCut = ranks.total?.inside_cut ?? 0;

  return (
    <TdSection
      title="Is TD picking the right tests?"
      range={range}
      intro={
        "TD ranks every test by how likely it is to fail and runs the top " +
        `${TD_CUT_PCT}% on PRs. Main runs every test, so when a landed PR ` +
        "breaks tests on main we can see where TD had ranked them: if TD had " +
        "run on that trunk commit, would it have caught the breakage? A " +
        "landing counts as caught when any one of its failing tests is inside " +
        "the cut, and a landing that broke many tests counts once."
      }
    >
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Trunk breakages TD would have caught"
          {...tileToggle(charts, "caught")}
          loading={ranks.loading}
          error={ranks.tileError}
          value={
            landings === 0 ? "-" : percentFormatter(ratio(insideCut, landings))
          }
          sub={landings === 0 ? NOTHING_TO_MEASURE : undefined}
          caveat="When a change broke tests on main, how often a failing test was in the quarter of tests chosen to run for that change. Higher is better."
        />
      </Grid>
      <TdCharts
        charts={charts}
        keys={["caught"]}
        sources={{
          ranks: {
            ...ranks,
            window: range,
            note: landingsMissing(states)
              ? `Some landings are missing from this chart: the query lists only the newest ones of each ${spec.cellDays} days it reads.`
              : undefined,
          },
        }}
      />
    </TdSection>
  );
}
