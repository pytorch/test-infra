import { TestStatsPage } from "components/testStats/TestStatsPage";

export default function Page() {
  return (
    <TestStatsPage
      title="ROCm Test Stats"
      jobFilter="(?i)jammy.*rocm|rocm.*jammy"
    />
  );
}
