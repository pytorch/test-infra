import { Card, CardContent, CardHeader } from "@mui/material";
import { styled } from "@mui/material/styles";
import { GraphPanel } from "components/benchmark/compilers/SummaryGraphPanel";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import { SuiteConfig } from "../../../lib/benchmark/compliers/CompilerSuites";
import { BranchAndCommit } from "lib/types";

/** Mui Styles */
const GraphCardGroup = styled(Card)({
  margin: "5px",
});
/** Mui Styles */

export default function CompilerGraphGroup({
  suiteConfig,
  queryParams,
  granularity,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  suiteConfig: SuiteConfig;
}) {
  return (
    <>
      <GraphCardGroup>
        <CardHeader title={`Suite: ${suiteConfig.name}`} />
        <CardContent>
          <GraphPanel
            queryName={"compilers_benchmark_performance"}
            queryParams={queryParams}
            granularity={granularity}
            suite={suiteConfig.id}
            branch={lBranchAndCommit.branch}
            lCommit={lBranchAndCommit.commit}
            rCommit={rBranchAndCommit.commit}
          />
        </CardContent>
      </GraphCardGroup>
    </>
  );
}
