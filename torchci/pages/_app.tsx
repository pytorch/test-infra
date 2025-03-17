import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { Analytics } from "@vercel/analytics/react";
import AnnouncementBanner from "components/AnnouncementBanner";
import TitleProvider from "components/DynamicTitle";
import NavBar from "components/NavBar";
import SevReport from "components/SevReport";
import { DarkModeProvider } from "lib/DarkModeContext";
import { track } from "lib/track";
import { SessionProvider } from "next-auth/react";
import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import { useEffect } from "react";
import ReactGA from "react-ga4";
import { useAppTheme } from "styles/MuiThemeOverrides";
import "styles/globals.css";
import("lib/chartTheme");

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();
  useEffect(() => {
    // GA records page views on its own, but I want to see how it differs with
    // this one.
    track(router, "pageview", {});
  }, [router, router.pathname]);

  ReactGA.initialize("G-HZEXJ323ZF");

  // Wrap everything in DarkModeProvider
  return (
    <>
      <SessionProvider>
        <DarkModeProvider>
          <AppContent Component={Component} pageProps={pageProps} />
        </DarkModeProvider>
      </SessionProvider>
    </>
  );
}

// Separate component to use the dark mode hooks
function AppContent({
  Component,
  pageProps,
}: {
  Component: any;
  pageProps: any;
}) {
  const theme = useAppTheme();

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <TitleProvider>
        <NavBar />
        <AnnouncementBanner />
        <SevReport />
        <div style={{ margin: "20px" }}>
          <Component {...pageProps} />
          <Analytics />
        </div>
      </TitleProvider>
    </ThemeProvider>
  );
}

export default MyApp;
