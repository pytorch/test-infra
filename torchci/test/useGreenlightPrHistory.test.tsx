// The PR page renders the verdict panel and the commit picker together, and the
// two deliberately share one SWR key so the page polls GreenLight once a minute
// rather than twice. useClickHouseAPI builds that key as the query name plus
// JSON.stringify of the parameters, so the two agree on the key exactly when
// they agree on those.
//
// What keeps them agreeing is a single conditional in CommitInfo: it hands the
// panel a committer date only on the commit page, because only that page views
// trunk commits. Drop it and the panel starts naming a commit the picker cannot,
// the keys part, and the page quietly polls twice -- both halves still returning
// correct data, nothing failing. So the first test below renders CommitInfo
// itself rather than calling the hook twice with the same arguments, which would
// hold for any deterministic hook and guard nothing.
//
// The mock replaces lib/GeneralUtils wholesale rather than spreading the real
// one over it: that module sits in an import cycle with the HUD page, and
// requireActual on it from here throws.

import { CommitInfo } from "components/commit/CommitInfo";
import { useGreenlightPrHistory } from "lib/greenlight/useGreenlightPrHistory";
import { renderToStaticMarkup } from "react-dom/server";

const mockCalls: {
  name: string;
  parameters: Record<string, unknown>;
  condition: boolean;
}[] = [];

const mockPr = 197977;
const mockTrunk = {
  sha: "82b29a21c4095bc78784e2eb5bd6b664132c45d1",
  committedAt: "2026-09-21T18:07:03Z",
};

jest.mock("lib/GeneralUtils", () => ({
  useClickHouseAPI: (
    name: string,
    parameters: Record<string, unknown>,
    condition: boolean
  ) => {
    mockCalls.push({ name, parameters, condition });
    return { data: undefined };
  },
}));

// CommitInfo's own reads and its job grid are not what these assertions are
// about; only the verdict panel underneath them is left real.
jest.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: {
      commit: {
        sha: mockTrunk.sha,
        time: mockTrunk.committedAt,
        prNum: mockPr,
        diffNum: null,
        commitUrl: "",
        commitTitle: "a title",
        commitMessageBody: "a title",
        author: "someone",
        authorUrl: null,
      },
      jobs: [],
      workflowIdsByName: {},
    },
  }),
}));
jest.mock("components/commit/CommitStatus", () => ({
  __esModule: true,
  default: () => null,
}));

/** The picker's call: three arguments, no commit to name. */
function Picker({ prNumber }: { prNumber: number | null }) {
  useGreenlightPrHistory("pytorch", "pytorch", prNumber);
  return null;
}

function onlyCall() {
  expect(mockCalls).toHaveLength(1);
  return mockCalls[0];
}

function pickerCall(prNumber: number | null) {
  mockCalls.length = 0;
  renderToStaticMarkup(<Picker prNumber={prNumber} />);
  return onlyCall();
}

function commitInfoCall(isCommitPage: boolean) {
  mockCalls.length = 0;
  renderToStaticMarkup(
    <CommitInfo
      repoOwner="pytorch"
      repoName="pytorch"
      sha={mockTrunk.sha}
      isCommitPage={isCommitPage}
    />
  );
  return onlyCall();
}

/** The part of the SWR key that varies between callers. */
function keyed(call: { name: string; parameters: Record<string, unknown> }) {
  return `${call.name}?${JSON.stringify(call.parameters)}`;
}

describe("useGreenlightPrHistory", () => {
  test("on the PR page the panel and the picker land on one key", () => {
    // isCommitPage is false there, so CommitInfo withholds the date and the
    // panel asks for exactly what the picker asks for.
    expect(keyed(commitInfoCall(false))).toBe(keyed(pickerCall(mockPr)));
  });

  test("on the commit page the panel names the commit being viewed", () => {
    expect(commitInfoCall(true).parameters).toEqual({
      repo: "pytorch/pytorch",
      owner: "pytorch",
      project: "pytorch",
      prNumber: mockPr,
      sha: mockTrunk.sha,
      committedAt: mockTrunk.committedAt,
    });
  });

  test("a caller with no trunk commit sends the empty pair, not nothing", () => {
    // An absent key serialises differently from an empty one, which would be the
    // same split by another route; and the query reads '' as "recover nothing".
    expect(pickerCall(mockPr).parameters).toEqual({
      repo: "pytorch/pytorch",
      owner: "pytorch",
      project: "pytorch",
      prNumber: mockPr,
      sha: "",
      committedAt: "",
    });
    expect(pickerCall(mockPr).name).toBe("greenlight_pr_state_history");
  });

  test("a commit with no PR asks for nothing", () => {
    expect(pickerCall(null).condition).toBe(false);
  });
});
