import { Button } from "@mui/material";
import styled from "@mui/system/styled";

export const UMDenseButton = styled(Button)(({ theme }) => ({
  padding: "2px 2px",
  minHeight: "20px",
  fontSize: "0.75rem",
  color: "grey",
  minWidth: "auto",
  borderRadius: 0,
  textTransform: "none", // optional: avoids uppercase
}));

