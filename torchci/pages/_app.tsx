import { Analytics } from "@vercel/analytics/react";
import AnnouncementBanner from "components/AnnouncementBanner";
import TitleProvider from "components/DynamicTitle";
import NavBar from "components/NavBar";
import SevReport from "components/SevReport";
import { track } from "lib/track";
import { SessionProvider } from "next-auth/react";
import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import ReactGA from "react-ga4";
import "styles/globals.css";

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const [isDarkMode, setIsDarkMode] = useState(
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    // GA records page views on its own, but I want to see how it differs with
    // this one.
    track(router, "pageview", {});
  }, [router, router.pathname]);

  useEffect(() => {
    const darkModeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => setIsDarkMode(e.matches);
    darkModeMediaQuery.addEventListener("change", handleChange);
    return () => darkModeMediaQuery.removeEventListener("change", handleChange);
  }, []);

  ReactGA.initialize("G-HZEXJ323ZF");
  return (
    <>
      <SessionProvider>
        <TitleProvider>
          <NavBar />
          <AnnouncementBanner />
          <SevReport />
          <div style={{ margin: "20px" }}>
            <button onClick={() => setIsDarkMode(!isDarkMode)}>
              Toggle Dark Mode
            </button>
            <Component {...pageProps} isDarkMode={isDarkMode} />
            <Analytics />
          </div>
        </TitleProvider>
      </SessionProvider>
    </>
  );
}

export default MyApp;
