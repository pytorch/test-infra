import { Card, CardContent, CardHeader } from "@mui/material";
import { styled } from "@mui/material/styles";
import { GraphPanel } from "components/benchmark/compilers/SummaryGraphPanel";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import { BranchAndCommit } from "lib/types";
import { SuiteConfig } from "../../../lib/benchmark/compliers/CompilerSuites";

/** Mui Styles */
const GraphCardGroup = styled(Card)({
  margin: "5px",
});
/** Mui Styles */

export default function CompilerGraphGroup({
  dashboard,
  suiteConfig,
  queryParams,
  granularity,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  dashboard: string;
  suiteConfig: SuiteConfig;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  // TODO (huydhn): Remove this once TorchInductor dashboard is migrated to the
  // new database schema
  const queryName =
    dashboard === "torchao"
      ? "torchao_query"
      : "compilers_benchmark_performance";

  return (
    <>
      <GraphCardGroup>
        <CardHeader title={`Suite: ${suiteConfig.name}`} />
        <CardContent>
          <GraphPanel
            queryName={queryName}
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
