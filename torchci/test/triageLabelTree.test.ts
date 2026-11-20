import { githubSelectionUrl } from "lib/triage/issueTriage";
import {
  buildLabelTree,
  labelSelection,
  matchingLabels,
  treeRows,
} from "lib/triage/labelTree";
import { parseLabelParents } from "pages/api/triage/label_parents";

// A slice of label_parents from pytorch/pytorch's OWNERSHIP.yaml.
const tree = buildLabelTree({
  "module: dynamo": "oncall: pt2",
  "module: inductor": "oncall: pt2",
  "module: pt2-dispatcher": "oncall: pt2",
  "module: custom-operators": "module: pt2-dispatcher",
  "module: opcheck": "module: custom-operators",
  "module: tvm": "module: dynamo",
});

test("descendants and closure", () => {
  expect(tree.descendants("module: pt2-dispatcher")).toEqual([
    "module: custom-operators",
    "module: opcheck",
  ]);
  expect(tree.descendants("module: opcheck")).toEqual([]);
  expect(tree.hasChildren("oncall: pt2")).toBe(true);
  expect(tree.hasChildren("module: tvm")).toBe(false);
  // Every (descendant, ancestor) pair once: opcheck has 3 ancestors.
  const pairs = tree.closure.descendants.map(
    (d, i) => `${d} < ${tree.closure.ancestors[i]}`
  );
  expect(pairs.filter((p) => p.startsWith("module: opcheck <"))).toEqual([
    "module: opcheck < module: custom-operators",
    "module: opcheck < module: pt2-dispatcher",
    "module: opcheck < oncall: pt2",
  ]);
  expect(new Set(pairs).size).toEqual(pairs.length);
});

test("a cycle in bad input does not hang", () => {
  const cyclic = buildLabelTree({
    "module: a": "module: b",
    "module: b": "module: a",
  });
  expect(cyclic.descendants("module: a")).toEqual(["module: b"]);
});

describe("labelSelection", () => {
  test("a parent includes its children by default", () => {
    expect(labelSelection(["module: pt2-dispatcher"], true, tree)).toEqual({
      includeLabels: [
        "module: custom-operators",
        "module: opcheck",
        "module: pt2-dispatcher",
      ],
      ownLabels: [],
      ownExcludes: [],
    });
  });

  test("without children, a parent counts only its own issues", () => {
    expect(
      labelSelection(["module: pt2-dispatcher", "module: nn"], false, tree)
    ).toEqual({
      includeLabels: ["module: nn"],
      ownLabels: ["module: pt2-dispatcher"],
      ownExcludes: [["module: custom-operators", "module: opcheck"]],
    });
  });
});

test("matchingLabels", () => {
  const selection = labelSelection(
    ["module: tvm", "module: pt2-dispatcher"],
    false,
    tree
  );
  expect(
    matchingLabels(["oncall: pt2", "module: tvm", "module: cuda"], selection)
  ).toEqual(["module: tvm"]);
  // pt2-dispatcher only matches without any of its children on the issue.
  expect(
    matchingLabels(["module: pt2-dispatcher", "module: opcheck"], selection)
  ).toEqual([]);
  expect(matchingLabels(["module: pt2-dispatcher"], selection)).toEqual([
    "module: pt2-dispatcher",
  ]);
});

describe("treeRows", () => {
  const order = [
    "oncall: pt2",
    "module: inductor",
    "module: dynamo",
    "module: tvm",
    "module: opcheck",
    "module: nn",
  ];
  const compare = (a: string, b: string) => order.indexOf(a) - order.indexOf(b);
  const labels = [...order].reverse();

  test("collapsed: only top-level rows", () => {
    expect(treeRows(labels, tree, new Set(), compare)).toEqual([
      { label: "oncall: pt2", depth: 0, hasChildren: true },
      { label: "module: nn", depth: 0, hasChildren: false },
    ]);
  });

  test("expanded, skipping ancestors with no row", () => {
    // module: opcheck's parents custom-operators and pt2-dispatcher have no
    // row, so it sits directly under oncall: pt2.
    expect(
      treeRows(
        labels,
        tree,
        new Set(["oncall: pt2", "module: dynamo"]),
        compare
      )
    ).toEqual([
      { label: "oncall: pt2", depth: 0, hasChildren: true },
      { label: "module: inductor", depth: 1, hasChildren: false },
      { label: "module: dynamo", depth: 1, hasChildren: true },
      { label: "module: tvm", depth: 2, hasChildren: false },
      { label: "module: opcheck", depth: 1, hasChildren: false },
      { label: "module: nn", depth: 0, hasChildren: false },
    ]);
  });
});

describe("parseLabelParents", () => {
  test("reads label_parents", () => {
    expect(
      parseLabelParents(
        'sections: [a]\nlabel_parents:\n  "module: tvm": "module: dynamo"\n'
      )
    ).toEqual({ "module: tvm": "module: dynamo" });
  });

  test("missing is empty, malformed throws", () => {
    expect(parseLabelParents("sections: [a]\n")).toEqual({});
    expect(() => parseLabelParents("label_parents: [a, b]\n")).toThrow();
    expect(() =>
      parseLabelParents('label_parents:\n  "module: a": [x]\n')
    ).toThrow();
  });
});

describe("githubSelectionUrl", () => {
  const q = (url: string) => new URL(url).searchParams.get("q")!;

  test("with children: only the selected labels", () => {
    const query = q(githubSelectionUrl(["module: pt2-dispatcher"], true, tree));
    expect(query).toContain('label:"module: pt2-dispatcher" ');
    expect(query).not.toContain("custom-operators");
  });

  test("without children: every label below is excluded", () => {
    const query = q(
      githubSelectionUrl(["module: pt2-dispatcher"], false, tree, "2026-10-02")
    );
    expect(query).toContain('label:"module: pt2-dispatcher" ');
    expect(query).toContain('-label:"module: custom-operators"');
    expect(query).toContain('-label:"module: opcheck"');
    expect(query).toContain("created:>=2026-10-02");
  });

  test("a selected child is not excluded by its selected parent", () => {
    const query = q(
      githubSelectionUrl(["oncall: pt2", "module: dynamo"], false, tree)
    );
    expect(query).toContain('label:"oncall: pt2","module: dynamo" ');
    expect(query).toContain('-label:"module: tvm"');
    expect(query).not.toContain('-label:"module: dynamo"');
  });
});
