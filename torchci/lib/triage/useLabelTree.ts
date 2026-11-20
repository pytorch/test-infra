import { fetcher } from "lib/GeneralUtils";
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
  if (data !== undefined) {
    return { tree: buildLabelTree(data), ready: true };
  }
  return { tree: EMPTY_LABEL_TREE, ready: error !== undefined };
}
