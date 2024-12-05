import { Card, CardContent, CardHeader } from "@mui/material";
import { styled } from "@mui/material/styles";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import { GraphPanel } from "components/benchmark/compilers/SummaryGraphPanel";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import { BranchAndCommit } from "lib/types";

/** Mui Styles */
const GraphCardGroup = styled(Card)({
  margin: "5px",
});
/** Mui Styles */

export default function CompilerGraphGroup({
  suite,
  queryParams,
  granularity,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  suite: string;
}) {
  return (
    <>
      <GraphCardGroup>
        <CardHeader title={`Suite: ${SUITES[suite]}`} />
        <CardContent>
          <GraphPanel
            queryName={"compilers_benchmark_performance"}
            queryParams={queryParams}
            granularity={granularity}
            suite={suite}
            branch={lBranchAndCommit.branch}
            lCommit={lBranchAndCommit.commit}
            rCommit={rBranchAndCommit.commit}
          />
        </CardContent>
      </GraphCardGroup>
    </>
  );
}
