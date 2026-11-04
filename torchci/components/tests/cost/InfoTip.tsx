import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Box, Tooltip, type TooltipProps } from "@mui/material";

// An (i) that explains what it sits beside on hover or focus, without taking
// a click meant for its row. The tooltip's text is its accessible name.
export default function InfoTip({
  title,
  size = "0.9rem",
  placement,
}: {
  title: string;
  size?: string;
  placement?: TooltipProps["placement"];
}) {
  return (
    <Tooltip
      title={title}
      enterDelay={150}
      placement={placement}
      slotProps={{ tooltip: { sx: { whiteSpace: "pre-line", maxWidth: 460 } } }}
    >
      <Box
        component="span"
        role="img"
        tabIndex={0}
        onClick={(event) => event.stopPropagation()}
        sx={{
          display: "inline-flex",
          verticalAlign: "-2px",
          ml: 0.5,
          color: "text.secondary",
          cursor: "help",
          "&:focus-visible": {
            outline: (theme) => `2px solid ${theme.palette.primary.main}`,
            borderRadius: "50%",
          },
        }}
      >
        <InfoOutlinedIcon sx={{ fontSize: size }} />
      </Box>
    </Tooltip>
  );
}
