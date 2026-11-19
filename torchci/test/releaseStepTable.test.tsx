import { ReleaseStepTable } from "components/release/ReleaseStepTable";
import type {
  ReleaseBoard,
  ReleaseMilestoneItems,
  ReleaseStep,
} from "lib/api/releases/types";
import type { ReleaseResource } from "lib/releasePortal/api";
import { renderToStaticMarkup } from "react-dom/server";

const milestone: ReleaseResource<ReleaseMilestoneItems> = {
  data: {
    version: "2.16.0",
    milestone: 71,
    branch: "release/2.16",
    branch_cut: true,
    issues: 0,
    by_reason: {},
    outstanding: [],
    last_checked: "2026-12-01T10:00:00.000Z",
  },
  error: undefined,
  isLoading: false,
  retry: async () => {},
};

const complete: ReleaseStep = {
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
};

const phases: ReleaseBoard["phases"] = [
  { id: 1, name: "Branch cut", collapsed: true, steps: [complete] },
  {
    id: 2,
    name: "Validation",
    collapsed: false,
    steps: [
      {
        ...complete,
        id: "2.1",
        name: "Validate binaries",
        rc: "rc3",
        status: "blocked",
        blocking: true,
        depends_on: ["1.1", "2.2"],
        runbook: { script: "release/validate.sh" },
        evidence: {
          text: "One artifact missing",
          url: "https://example.com/evidence",
        },
      },
      {
        ...complete,
        id: "2.2",
        name: "Manual validation",
        tier: "M",
        status: "todo",
        runbook: { url: "https://example.com/runbook" },
        manual: {
          what_to_check: "Check the validation issue",
          link: "https://example.com/validation",
        },
      },
      {
        ...complete,
        id: "2.3",
        name: "Performance results",
        informational: true,
        status: "todo",
        runbook: null,
        manual: null,
      },
    ],
  },
];

describe("release step table", () => {
  test("shows one table with phase headings and unfinished-step guidance", () => {
    const html = renderToStaticMarkup(
      <ReleaseStepTable milestone={milestone} phases={phases} />
    );

    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).toContain("Phase 1: Branch cut");
    expect(html).toContain("1/1 done");
    expect(html).not.toContain("Branch cut complete");
    expect(html).toContain("Phase 2: Validation");
    expect(html).toContain("0/2 done");
    expect(html).toContain("Validate binaries");
    expect(html).toContain("RC3");
    expect(html).toContain("One artifact missing");
    expect(html).toContain('href="https://example.com/evidence"');
    expect(html).toContain("max-width:360px");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("Automation tier A");
    expect(html).toContain("Blocked");
    expect(html).toContain("script release/validate.sh");
    expect(html).toContain("Waits for 2.2");
    expect(html).not.toContain("Waits for 1.1");
    expect(html).toContain("Check the validation issue");
    expect(html).toContain('href="https://example.com/validation"');
    expect(html).toContain('href="https://example.com/runbook"');
    expect(html).toContain("Performance results");
    expect(html).toContain(">info<");
  });
});
