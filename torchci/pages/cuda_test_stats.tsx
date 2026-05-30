import { TestStatsPage } from "components/testStats/TestStatsPage";

export default function Page() {
  return (
    <TestStatsPage
      title="CUDA Test Stats"
      jobFilter="(?i)jammy.*cuda|cuda.*jammy"
    />
  );
}
