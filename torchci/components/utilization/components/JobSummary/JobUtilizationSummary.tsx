import { Paper, styled } from "@mui/material";
import { Metrics } from "lib/utilization/types";
import { useEffect, useState } from "react";
import DoubleRingChart from "./DoubleRingChart";
import RoundChart from "./RoundChart";

const RingGroupSection = styled("div")({
  display: "flex",
});

const NumericGroupSection = styled("div")({
    display: "flex",
    flexWrap: "wrap",
    width: "550px",
    borderRight: "1px solid #ccc",
    marginRight: "20px",
});

const RingChart = styled("div")({
  display: "flex",
  width: "350px",
})

const NumericRingChart = styled("div")({
    display: "flex",
    width: "250px",
    height: "200px",
})


const Divider = styled("div")({
  borderBottom: "1px solid #ccc",
  margin: "20px 0",
});

const hardwareName = ["gpu", "cpu", "memory"];

const JobUtilizationSummary = ({ hardwareMetrics,otherMetrics }: { hardwareMetrics: Metrics[], otherMetrics:Metrics[]}) => {
  const [groups, setGroups] = useState<{ name: string; metircType:string, metrics: Metrics[]}[]>(
    []
  );
  const [singleValues, setSingleValues] = useState<{ name: string; metrics?: Metrics}[]>([]);

  useEffect(() => {
    if (!hardwareMetrics || !otherMetrics) return;
    const groups = hardwareName.map((name) => {
      const filteredGroup = hardwareMetrics.filter((metric) =>
        metric.name.includes(name) && metric.metric == "mean"
      );
      return {
        name: name,
        metrics: filteredGroup,
        metircType: "mean",
      };
    });
    setGroups(groups);

    const items = otherMetrics.map((metrics) => {
        return {
            name: metrics.name,
            metrics:metrics
        }
      });

      setGroups(groups);
      setSingleValues(items);
  }, [otherMetrics,hardwareMetrics]);

  return (
    <div>
      <h1> Utilization Summary</h1>
      <Paper></Paper>
      <Divider></Divider>
      <div>
        <RingGroupSection>
        <NumericGroupSection>
            {singleValues.map((item) => {
            return (
                item.metrics && (
                <NumericRingChart>
                  <RoundChart data={item.metrics} key={item.name} />
                </NumericRingChart>
              )
            );
          })}
          </NumericGroupSection>
        {groups.map((group) => {
            return (
            group.metrics.length > 0 && (
                <div>
                <h4> {group.name}</h4>
                <div> {group.metircType} of totoal {group.name} utilization.</div>
                <RingChart>
                    <DoubleRingChart data={group.metrics} key={group.name} />
                </RingChart>
                </div>

            )
            );
        })}
        </RingGroupSection>
      </div>
    </div>
  );
};
export default JobUtilizationSummary;
