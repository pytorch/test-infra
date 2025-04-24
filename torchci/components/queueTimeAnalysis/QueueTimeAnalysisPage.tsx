import styled from "@emotion/styled";
import QueueTimeChartPage from "./components/QueueTimeChartPage";

const QueueTimeAnalysisPageSection = styled("div")({
  fontFamily: "Roboto",
});

export const QueueTimeAnalysisPage = () => {
  return (
    <QueueTimeAnalysisPageSection>
      <QueueTimeChartPage />
    </QueueTimeAnalysisPageSection>
  );
};
