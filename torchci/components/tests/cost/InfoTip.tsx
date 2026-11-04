import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Box, Tooltip } from "@mui/material";

// An (i) beside a label that explains it on hover or focus, without taking
// the label's click.
export default function InfoTip({ title }: { title: string }) {
  return (
    <Tooltip
      title={title}
      enterDelay={150}
      slotProps={{ tooltip: { sx: { whiteSpace: "pre-line", maxWidth: 360 } } }}
    >
      <Box
        component="span"
        tabIndex={0}
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        sx={{
          display: "inline-flex",
          verticalAlign: "-2px",
          ml: 0.5,
          color: "text.secondary",
          cursor: "help",
          "&:focus-visible": { outline: "2px solid", borderRadius: "50%" },
        }}
      >
        <InfoOutlinedIcon sx={{ fontSize: "0.9rem" }} />
      </Box>
    </Tooltip>
  );
}
