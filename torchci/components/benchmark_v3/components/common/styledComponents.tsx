import { ListItem, ListItemButton, ListItemText } from "@mui/material";
import Alert, { type AlertProps } from "@mui/material/Alert";
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
    <ListItem>
      <ListItemButton onClick={onClick}>
        <ClickableListItemText primary={primary} secondary={secondary} />
      </ListItemButton>
    </ListItem>
  );
}

export const DenseAlert = styled((props: AlertProps) => <Alert {...props} />)(
  ({ theme }) => ({
    width: "100%",
    wordBreak: "break-word",
    whiteSpace: "normal",
    padding: theme.spacing(0.5),

    "& .MuiAlert-message": {
      fontSize: "0.7rem",
      lineHeight: 1.4,
    },

    "& .MuiAlert-icon": {
      padding: theme.spacing(0.5),
      "& svg": { fontSize: 20 },
    },
  })
);
