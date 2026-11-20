import { Button } from "@mui/material";
import { ReleaseStepTable } from "components/release/ReleaseStepTable";
import type {
  ReleaseBoard,
  ReleaseMilestoneItems,
} from "lib/api/releases/types";
import type { ReleaseResource } from "lib/releasePortal/api";
import { act, create, ReactTestRenderer } from "react-test-renderer";

const noMilestone: ReleaseResource<ReleaseMilestoneItems> = {
  data: {
    version: "2.16.0",
    milestone: null,
    branch: "release/2.16",
    branch_cut: null,
    issues: null,
    by_reason: {},
    outstanding: [],
    last_checked: null,
  },
  error: undefined,
  isLoading: false,
  retry: async () => {},
};

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
    renderer = create(
      <ReleaseStepTable milestone={noMilestone} phases={phases} />
    );
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

const milestonePhases: ReleaseBoard["phases"] = [
  {
    id: 2,
    name: "RC build and validation",
    collapsed: false,
    steps: [
      {
        ...phases[0].steps[0],
        id: "2.9",
        name: "Cherry-pick requests triaged",
        status: "blocked",
        blocking: true,
      },
    ],
  },
];

function milestoneResource(
  data: ReleaseMilestoneItems | undefined,
  error: unknown = undefined,
  retry: () => Promise<void> = async () => {}
): ReleaseResource<ReleaseMilestoneItems> {
  return {
    data,
    error,
    isLoading: data === undefined && error === undefined,
    retry,
  };
}

function milestoneItems(): ReleaseMilestoneItems {
  return {
    version: "2.16.0",
    milestone: 71,
    branch: "release/2.16",
    branch_cut: true,
    issues: 2,
    by_reason: { open: 1, not_on_release_branch: 1 },
    outstanding: [
      {
        number: 123,
        kind: "issue",
        title: "Open release blocker",
        url: "https://github.com/pytorch/pytorch/issues/123",
        state: "open",
        reason: "open",
      },
      {
        number: 456,
        kind: "pull_request",
        title: "Backport required before release",
        url: "javascript:alert(1)",
        state: "closed",
        reason: "not_on_release_branch",
      },
    ],
    last_checked: "2026-12-01T10:00:00.000Z",
  };
}

test("shows safe milestone item details only after expanding the related step", () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ReleaseStepTable
        milestone={milestoneResource(milestoneItems())}
        phases={milestonePhases}
      />
    );
  });
  const detailButton = () =>
    renderer.root
      .findAllByType(Button)
      .find(
        (button) =>
          button.props["aria-label"] ===
          "Outstanding milestone items for step 2.9"
      )!;

  expect(detailButton().props["aria-expanded"]).toBe(false);
  expect(JSON.stringify(renderer.toJSON())).not.toContain(
    "Open release blocker"
  );
  act(() => detailButton().props.onClick());

  const details = JSON.stringify(renderer.toJSON());
  expect(detailButton().props["aria-expanded"]).toBe(true);
  expect(details).toContain("Outstanding milestone items");
  expect(details).toContain("Open release blocker");
  expect(details).toContain("pull request");
  expect(details).toContain("not on release branch");
  expect(details).toContain("https://github.com/pytorch/pytorch/issues/123");
  expect(details).not.toContain("javascript:");
  act(() => renderer.unmount());
});

test("explains unavailable milestone details and retries a failed request", () => {
  const retry = jest.fn(async () => {});
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ReleaseStepTable
        milestone={milestoneResource(
          undefined,
          { info: "The database is busy" },
          retry
        )}
        phases={milestonePhases}
      />
    );
  });
  const detailButton = () =>
    renderer.root
      .findAllByType(Button)
      .find(
        (button) =>
          button.props["aria-label"] ===
          "Outstanding milestone items for step 2.9"
      )!;
  act(() => detailButton().props.onClick());

  expect(JSON.stringify(renderer.toJSON())).toContain(
    "Could not load outstanding milestone items"
  );
  const retryButton = renderer.root
    .findAllByType(Button)
    .find((button) => button.props.children === "Retry")!;
  act(() => retryButton.props.onClick());
  expect(retry).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

test("distinguishes pending, unscanned, and empty milestone details", () => {
  const cases: Array<{
    milestone: ReleaseResource<ReleaseMilestoneItems>;
    message: string;
  }> = [
    {
      milestone: milestoneResource(undefined),
      message: "Loading outstanding milestone items",
    },
    {
      milestone: noMilestone,
      message: "Outstanding milestone items have not been scanned yet",
    },
    {
      milestone: milestoneResource({
        ...milestoneItems(),
        issues: 0,
        by_reason: {},
        outstanding: [],
      }),
      message: "No outstanding milestone items",
    },
  ];

  for (const { milestone, message } of cases) {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ReleaseStepTable milestone={milestone} phases={milestonePhases} />
      );
    });
    const detailButton = renderer.root
      .findAllByType(Button)
      .find(
        (button) =>
          button.props["aria-label"] ===
          "Outstanding milestone items for step 2.9"
      )!;
    act(() => detailButton.props.onClick());

    expect(JSON.stringify(renderer.toJSON())).toContain(message);
    act(() => renderer.unmount());
  }
});
