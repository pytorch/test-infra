import { CommitChoiceSection } from "./components/CommitChoiceSection";
import { Sidebar } from "./components/MainOptionSideBar";

export default function BenchmarkSideBar() {
  return (
    <aside style={{ width: 320 }}>
      <Sidebar />
      <CommitChoiceSection />
    </aside>
  );
}
