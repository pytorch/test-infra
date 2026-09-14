import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { IconButton, Tooltip } from "@mui/material";

// Wide enough for a full caveat paragraph; MUI's 300px default wraps them into a
// column too narrow to read.
const TOOLTIP_MAX_WIDTH = 440;

// Every figure on this page carries a paragraph explaining what it does not
// measure, and printing them all left the page unreadable. They live behind this
// affordance instead.
//
// An IconButton rather than the bare hover target pages/flaky_trunk.tsx uses: it
// takes keyboard focus, which is what makes the tooltip openable without a
// pointer. The icon is drawn rather than left implicit — a hover region with no
// mark is not discoverable.
//
// The title is a plain string, so MUI renders it with its own tooltip styles and
// no layout of ours. aria-label restates it prefixed with the tile name, which
// the title alone cannot say, and reaches a screen reader without the tooltip
// being opened at all.
export default function InfoTooltip({
  label,
  paragraphs,
}: {
  label: string;
  paragraphs: (string | undefined)[];
}) {
  const text = paragraphs
    .filter((p): p is string => p !== undefined && p !== "")
    .join(" ");
  if (text === "") {
    return null;
  }
  return (
    <Tooltip
      title={text}
      arrow
      // Above the affordance rather than below it: the value and its sub-line sit
      // directly under the label, and the default placement covers both of them
      // with the prose that explains them. Popper flips it down where there is no
      // room above.
      placement="top"
      slotProps={{ tooltip: { sx: { maxWidth: TOOLTIP_MAX_WIDTH } } }}
    >
      <IconButton
        size="small"
        aria-label={`${label}: ${text}`}
        sx={{ color: "text.secondary" }}
      >
        <InfoOutlinedIcon fontSize="inherit" />
      </IconButton>
    </Tooltip>
  );
}
