import { MenuItem } from "@mui/material";

interface HighlightMenuItemProps extends React.ComponentProps<typeof MenuItem> {
  condition: boolean;
  customColor?: string;
}

export const DEFAULT_HIGHLIGHT_MENU_ITEM_COLOR = "yellow";

export const HighlightMenuItem = ({
  condition,
  children,
  customColor = DEFAULT_HIGHLIGHT_MENU_ITEM_COLOR,
  ...props
}: HighlightMenuItemProps) => {
  const highlightStyle = {
    backgroundColor: customColor
      ? customColor
      : DEFAULT_HIGHLIGHT_MENU_ITEM_COLOR,
  };
  return (
    <MenuItem
      {...props}
      sx={{
        ...(condition && highlightStyle),
      }}
    >
      {children}
    </MenuItem>
  );
};

export function isCommitStringHighlight(
  commit: string,
  commits: any[],
  filenameFilterList: string[] | undefined
) {
  const matchedCommit = commits.find((c: any) => c.head_sha === commit);
  if (!matchedCommit) {
    return false;
  }
  return isCommitHighlight(filenameFilterList, matchedCommit);
}

export function isCommitHighlight(
  filenameFilterList: string[] | undefined,
  commit: any
) {
  if (filenameFilterList === undefined || filenameFilterList.length == 0) {
    return false;
  }

  if (!commit || !commit.filenames) {
    return false;
  }
  return isStringMatchedAll(filenameFilterList, commit.filenames.join(","));
}

export function getMatchedFilters(
  filenameFilterList: string[] | undefined,
  commit: any
) {
  if (filenameFilterList === undefined || filenameFilterList.length == 0) {
    return [];
  }

  if (!commit || !commit.filenames) {
    return [];
  }
  return getMatchedList(commit.filenames.join(","), filenameFilterList);
}

function getMatchedList(text: string, substrings: string[]): string[] {
  let matched = [];
  for (const substring of substrings) {
    if (text.includes(substring)) {
      matched.push(substring);
    }
  }
  return matched;
}

function isStringMatchedAll(substrings: string[], text: string) {
  return substrings.every((substring) => text.includes(substring));
}
