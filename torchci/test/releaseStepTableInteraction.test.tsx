import { Button } from "@mui/material";
import { ReleaseStepTable } from "components/release/ReleaseStepTable";
import type { ReleaseBoard } from "lib/api/releases/types";
import { act, create, ReactTestRenderer } from "react-test-renderer";

const phases: ReleaseBoard["phases"] = [
  {
    id: 1,
    name: "Branch cut",
    collapsed: true,
    steps: [
      {
        id: "1.1",
        name: "Branch cut complete",
        tier: "A",
        owner: "release-manager",
        rc: null,
        status: "done",
        informational: false,
        blocking: false,
        depends_on: [],
        due: null,
        runbook: { script: "release/cut-release-branch.sh" },
        evidence: null,
        manual: null,
        last_checked: null,
      },
    ],
  },
];

test("completed phases can be expanded and folded again", () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ReleaseStepTable phases={phases} />);
  });
  const phaseButton = () => renderer.root.findByType(Button);

  expect(phaseButton().props["aria-expanded"]).toBe(false);
  expect(JSON.stringify(renderer.toJSON())).not.toContain(
    "Branch cut complete"
  );
  act(() => phaseButton().props.onClick());
  expect(phaseButton().props["aria-expanded"]).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain("Branch cut complete");
  expect(JSON.stringify(renderer.toJSON())).not.toContain(
    "release/cut-release-branch.sh"
  );
  act(() => phaseButton().props.onClick());
  expect(phaseButton().props["aria-expanded"]).toBe(false);
  expect(JSON.stringify(renderer.toJSON())).not.toContain(
    "Branch cut complete"
  );
  act(() => renderer.unmount());
});
