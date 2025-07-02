import { AppBar, CssBaseline } from "@mui/material";
import HudNavToolBar from "./components/rootUxComponents/hudNavToolBar";

const appBarStyles = {
  backgroundColor: "#202124", // Similar dark tone as PyTorch navbar
  boxShadow: "none",
  borderBottom: "1px solid #333", // Subtle border like PyTorch's
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
          <HudNavToolBar />
        </AppBar>
        {/* Offset AppBar height */}
        <div style={{ marginTop: "64px" }}>{children}</div>
      </body>
    </html>
  );
}
