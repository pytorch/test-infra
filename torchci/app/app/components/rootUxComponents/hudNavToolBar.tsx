import { Link as MuiLink, Toolbar, Typography } from "@mui/material";
import Link from "next/link";

const pytorchHudAppBarTitleStyles = {
  flexGrow: 1,
  color: "#EE4C2C", // PyTorch orange
  fontWeight: "bold",
};

export default function HudNavToolBar() {
  return (
    <Toolbar>
      <Typography variant="h6" sx={pytorchHudAppBarTitleStyles}>
        Pytorch CI Hud
      </Typography>
      {HudNavToolBarElement("Home", "/", "home_nav_link")}
      {HudNavToolBarElement(
        "Benchmarks",
        "/app/benchmark/v3",
        "benchmark_v3_nav_link"
      )}
    </Toolbar>
  );
}

export function HudNavToolBarElement(
  displayname: string,
  navRoute: string,
  id: string = ""
) {
  return (
    <MuiLink
      component={Link}
      href={navRoute}
      color="inherit"
      underline="none"
      sx={{ mr: 2 }}
      id={id}
    >
      {displayname}
    </MuiLink>
  );
}
