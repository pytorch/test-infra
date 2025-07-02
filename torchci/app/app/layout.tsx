import {
  AppBar,
  CssBaseline,
  Link as MuiLink,
  Toolbar,
  Typography,
} from "@mui/material";
import Link from "next/link";

const appBarStyles = {
  backgroundColor: "#202124", // Similar dark tone as PyTorch navbar
  boxShadow: "none",
  borderBottom: "1px solid #333", // Subtle border like PyTorch's
};

const pytorchHudAppBarTitleStyles = {
  flexGrow: 1,
  color: "#EE4C2C", // PyTorch orange
  fontWeight: "bold",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <CssBaseline />
        <AppBar position="fixed" sx={appBarStyles}>
          <Toolbar>
            <Typography variant="h6" sx={pytorchHudAppBarTitleStyles}>
              Pytorch CI Hud
            </Typography>
            <MuiLink
              component={Link}
              href="/"
              color="inherit"
              underline="none"
              sx={{ mr: 2 }}
            >
              Home
            </MuiLink>
            <MuiLink
              component={Link}
              href="/app/benchmark/v3"
              color="inherit"
              underline="none"
              sx={{ mr: 2 }}
            >
              Benchmarks
            </MuiLink>
          </Toolbar>
        </AppBar>
        {/* Offset AppBar height */}
        <div style={{ marginTop: "64px" }}>{children}</div>
      </body>
    </html>
  );
}
