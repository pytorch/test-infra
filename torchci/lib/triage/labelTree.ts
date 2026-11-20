// The module:/oncall: label hierarchy, from `label_parents` in pytorch/pytorch's
// OWNERSHIP.yaml (child label -> parent label). pytorch-bot applies parent
// labels to new issues automatically; older issues may only carry the child,
// so queries work out ancestors from this tree rather than trusting labels.

export type LabelParents = Record<string, string>;

export type LabelTree = {
  parentOf: (_label: string) => string | undefined;
  children: (_label: string) => string[];
  hasChildren: (_label: string) => boolean;
  // Every label below `label`, at any depth.
  descendants: (_label: string) => string[];
  // (descendant, ancestor) pairs of the transitive closure, as parallel arrays
  // for the ClickHouse queries.
  closure: { descendants: string[]; ancestors: string[] };
};

export function buildLabelTree(parents: LabelParents): LabelTree {
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of Object.entries(parents)) {
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
  }
  const descendants = (label: string): string[] => {
    const out: string[] = [];
    const seen = new Set([label]); // guards against a cycle in bad input
    const stack = [...(childrenOf.get(label) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (!seen.has(next)) {
        seen.add(next);
        out.push(next);
        stack.push(...(childrenOf.get(next) ?? []));
      }
    }
    return out.sort();
  };
  const closure = { descendants: [] as string[], ancestors: [] as string[] };
  for (const ancestor of Array.from(childrenOf.keys()).sort()) {
    for (const d of descendants(ancestor)) {
      closure.descendants.push(d);
      closure.ancestors.push(ancestor);
    }
  }
  return {
    parentOf: (label) => parents[label],
    children: (label) => [...(childrenOf.get(label) ?? [])].sort(),
    hasChildren: (label) => childrenOf.has(label),
    descendants,
    closure,
  };
}

export const EMPTY_LABEL_TREE = buildLabelTree({});

// Query parameters selecting the issues of the chosen labels. With
// `includeChildren`, a label counts with all its descendants; without, a
// parent counts only issues with the label and none of its descendants.
// Leaves behave the same either way. Empty arrays everywhere select every
// issue.
export type LabelSelection = {
  includeLabels: string[];
  ownLabels: string[];
  ownExcludes: string[][];
};

export function labelSelection(
  selected: string[],
  includeChildren: boolean,
  tree: LabelTree
): LabelSelection {
  const include = new Set<string>();
  const ownLabels: string[] = [];
  const ownExcludes: string[][] = [];
  for (const label of selected) {
    if (!includeChildren && tree.hasChildren(label)) {
      ownLabels.push(label);
      ownExcludes.push(tree.descendants(label));
    } else {
      include.add(label);
      tree.descendants(label).forEach((d) => include.add(d));
    }
  }
  return {
    includeLabels: Array.from(include).sort(),
    ownLabels,
    ownExcludes,
  };
}

// Labels on an issue that put it in the selection, for the "Labels" column.
export function matchingLabels(
  issueLabels: string[],
  selection: LabelSelection
): string[] {
  return issueLabels.filter(
    (l) =>
      selection.includeLabels.includes(l) ||
      selection.ownLabels.some(
        (own, i) =>
          own === l &&
          !selection.ownExcludes[i].some((x) => issueLabels.includes(x))
      )
  );
}

export type TreeRow = { label: string; depth: number; hasChildren: boolean };

// Rows of the label table as an outline. A label sits under its nearest
// ancestor that is among `labels` (a parent with no issues in range is
// skipped), siblings are ordered by `compare`, and children only show under
// an expanded parent.
export function treeRows(
  labels: string[],
  tree: LabelTree,
  expanded: Set<string>,
  compare: (_a: string, _b: string) => number
): TreeRow[] {
  const present = new Set(labels);
  const displayParent = (label: string): string | undefined => {
    let p = tree.parentOf(label);
    const seen = new Set<string>();
    while (p !== undefined && !present.has(p) && !seen.has(p)) {
      seen.add(p);
      p = tree.parentOf(p);
    }
    return p !== undefined && present.has(p) ? p : undefined;
  };
  const kids = new Map<string | undefined, string[]>();
  for (const label of labels) {
    const p = displayParent(label);
    kids.set(p, [...(kids.get(p) ?? []), label]);
  }
  const out: TreeRow[] = [];
  const visit = (parent: string | undefined, depth: number) => {
    for (const label of [...(kids.get(parent) ?? [])].sort(compare)) {
      const hasChildren = kids.has(label);
      out.push({ label, depth, hasChildren });
      if (hasChildren && expanded.has(label)) {
        visit(label, depth + 1);
      }
    }
  };
  visit(undefined, 0);
  return out;
}
