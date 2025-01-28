import { FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import { match } from "assert";

interface HighlightMenuItemProps extends React.ComponentProps<typeof MenuItem>{
    condition: boolean;
    customColor?: string;
  }

export const DEFAULT_HIGHLIGHT_MENU_ITEM_COLOR = 'yellow';

export const HighlightMenuItem = ({ condition, children, customColor = DEFAULT_HIGHLIGHT_MENU_ITEM_COLOR, ...props }: HighlightMenuItemProps) => {
    const highlightStyle = {
      backgroundColor: customColor?customColor:DEFAULT_HIGHLIGHT_MENU_ITEM_COLOR,
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

  export function isCommitStringHighlight(commit:string,commits: any[],filenameFilter:string|undefined){
    const matchedCommit = commits.find((c:any) => c.head_sha === commit);
    if (!matchedCommit) {
      return false;
    }
    return isCommitHighlight(filenameFilter,matchedCommit);
  }

  export function isCommitHighlight(filenameFilter: string | undefined, commit: any) {
    if (filenameFilter === undefined || filenameFilter == "all") {
        return false;
    }
    const found =  commit.filenames.filter((f: string) => f.includes(filenameFilter));
    return found.length > 0;
}
