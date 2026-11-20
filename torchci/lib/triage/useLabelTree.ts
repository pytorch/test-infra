import { fetcher } from "lib/GeneralUtils";
import { useMemo } from "react";
import useSWRImmutable from "swr/immutable";
import {
  buildLabelTree,
  EMPTY_LABEL_TREE,
  LabelParents,
  LabelTree,
} from "./labelTree";

// The label hierarchy from /api/triage/label_parents. If it cannot be loaded
// the page still works, with every label treated as a leaf.
export function useLabelTree(): { tree: LabelTree; ready: boolean } {
  const { data, error } = useSWRImmutable<LabelParents>(
    "/api/triage/label_parents",
    fetcher
  );
  // Built once per load: the tree and its closure feed every query's params.
  const tree = useMemo(
    () => (data !== undefined ? buildLabelTree(data) : EMPTY_LABEL_TREE),
    [data]
  );
  return { tree, ready: data !== undefined || error !== undefined };
}
