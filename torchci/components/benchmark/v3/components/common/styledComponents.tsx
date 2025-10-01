import { ListItem, ListItemButton, ListItemText } from "@mui/material";
import { styled } from "@mui/material/styles";

export const ClickableListItemText = styled(ListItemText)(({ theme }) => ({
  cursor: "pointer",
  color: theme.palette.primary.main,
}));

interface NavListItemProps {
  primary: string;
  secondary?: string;
  onClick: () => void;
}

export function NavListItem({ primary, secondary, onClick }: NavListItemProps) {
  return (
    <ListItem divider disablePadding>
      <ListItemButton onClick={onClick}>
        <ClickableListItemText primary={primary} secondary={secondary} />
      </ListItemButton>
    </ListItem>
  );
}
