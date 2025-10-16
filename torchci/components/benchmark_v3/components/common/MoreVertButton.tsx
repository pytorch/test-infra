import MoreVertIcon from "@mui/icons-material/MoreVert";
import { Box, IconButton } from "@mui/material";

export function MoreVertButton({
  onClick = () => {},
}: {
  onClick?: () => void;
}) {
  return (
    <Box>
      <IconButton
        size="small"
        onClick={(e) => {
          e.stopPropagation(); // safe if inside clickable rows
          onClick();
        }}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}
