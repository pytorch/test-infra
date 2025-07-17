import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { Analytics } from "@vercel/analytics/react";
import GitHubIncidentBanner from "components/githubIncident/GithubIncident";
import AnnouncementBanner from "components/layout/AnnouncementBanner";
import TitleProvider from "components/layout/DynamicTitle";
import NavBar from "components/layout/NavBar";
import SevReport from "components/sevReport/SevReport";
import { DarkModeProvider } from "lib/DarkModeContext";
import { setupGAAttributeEventTracking } from "lib/tracking/eventTrackingHandler";
import { initGaAnalytics, trackRouteEvent } from "lib/tracking/track";
import { SessionProvider } from "next-auth/react";
import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import { useEffect } from "react";
import { useAppTheme } from "styles/MuiThemeOverrides";
import "styles/globals.css";
import("lib/chartTheme");

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();

  useEffect(() => {
    // initializes the GA with session id
    initGaAnalytics(true);
  }, []);

  useEffect(() => {
    // globally tracking the ga automatically if the attribute is set.
    const teardown = setupGAAttributeEventTracking(["click"]);
    return teardown; // cleanup on unmount
  }, []);


  useEffect(() => {
    if (typeof window !== "undefined") {
      trackRouteEvent(router, "pageview", {});
    }
  }, [router.asPath]);


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
        <GitHubIncidentBanner />
        <div style={{ margin: "20px" }}>
          <Component {...pageProps} />
          <Analytics />
        </div>
      </TitleProvider>
    </ThemeProvider>
  );
}

export default MyApp;
