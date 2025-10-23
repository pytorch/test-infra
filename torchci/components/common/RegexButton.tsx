import { Button, Tooltip } from "@mui/material";

/**
 * RegexButton component for toggling regex search.  Example can be seen on the
 * HUD main page in the job filter.
 * @param isRegex Whether the regex search is enabled
 * @param setIsRegex Function to toggle the regex search state
 * @returns
 */
export default function RegexButton({
  isRegex,
  setIsRegex,
}: {
  isRegex: boolean;
  setIsRegex: (value: boolean) => void;
}) {
  return (
    <Tooltip title={isRegex ? "Disable regex search" : "Enable regex search"}>
      <Button
        size="small"
        style={{
          minWidth: 0,
          textTransform: "none",
          borderColor: "transparent",
          fontFamily: "monospace",
          color: "inherit",
          backgroundColor: isRegex ? "rgba(182, 196, 223, 0.33)" : "transparent",
        }}
        variant="outlined"
        onClick={() => setIsRegex(!isRegex)}
      >
        .*
      </Button>
    </Tooltip>
  );
}
