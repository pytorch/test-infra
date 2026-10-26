// Text in a cell that acts on a click can still be selected and copied: a
// drag across it selects it, and the click that ends the drag must not act,
// or the table would reload under the selection the reader just made.

// What the check reads of a click: its type, how many clicks it was (0 for a
// click the keyboard made) and the element it was on.
export interface ClickLike {
  type: string;
  detail: number;
  currentTarget: EventTarget | null;
}

// What the check reads of the document's selection.
export type SelectionLike = Pick<Selection, "isCollapsed" | "containsNode">;

function documentSelection(): SelectionLike | null {
  return typeof window === "undefined" ? null : window.getSelection();
}

// Whether a click ends a drag that selected text in the element it was on.
// A click from the keyboard (Enter or Space) never does: a selection made
// earlier and left standing is not what the reader means by pressing the
// control. The selection is read from the document unless given.
export function endsTextSelection(
  event: ClickLike,
  selection: SelectionLike | null = documentSelection()
): boolean {
  if (event.type !== "click" || event.detail === 0) {
    return false;
  }
  if (
    selection === null ||
    selection.isCollapsed ||
    event.currentTarget === null
  ) {
    return false;
  }
  return selection.containsNode(event.currentTarget as Node, true);
}
