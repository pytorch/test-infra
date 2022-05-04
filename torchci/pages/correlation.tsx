import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import correlationMatrix from "lib/correlation_matrix.json";

export default function Page() {
  const options: EChartsOption = {
    tooltip: {
      position: "top",
      formatter: (params: any) => {
        const x = correlationMatrix.names[params.data[0]];
        const y = correlationMatrix.names[params.data[1]];
        const value = params.data[2].toFixed(2);
        return `Correlation between:<br/>${x}<br/>${y}<br/><strong>${value}</strong>`;
      },
    },
    grid: {
      height: "50%",
      top: "10%",
    },
    xAxis: {
      type: "category",
      data: correlationMatrix.names,
      splitArea: {
        show: true,
      },
      axisLabel: {
        interval: 0,
        rotate: 45,
      },
    },
    yAxis: {
      type: "category",
      data: correlationMatrix.names,
      splitArea: {
        show: true,
      },
    },
    visualMap: {
      min: 0,
      max: 1,
      calculable: true,
      precision: 2,
      orient: "horizontal",
      left: "center",
      bottom: "15%",
      itemWidth: 20,
      itemHeight: 240,
    },
    series: [
      {
        name: "correlation",
        type: "heatmap",
        data: correlationMatrix.data,
        // label: {
        //   show: true,
        // },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: "rgba(0, 0, 0, 0.5)",
          },
        },
      },
    ],
  };
  return (
    <div style={{ height: "1200px" }}>
      <h1>Job failure correlation matrix</h1>
      <p>
        Note: this data is static. To regenerate it, run{" "}
        <code>python scripts/compute_correlation.py</code> in the{" "}
        <code>torchci/</code> directory of <code>pytorch/test-infra</code>
      </p>
      <ReactECharts
        style={{ height: "100%", width: "100%" }}
        option={options}
      />
    </div>
  );
}
