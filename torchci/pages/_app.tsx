import { Analytics } from "@vercel/analytics/react";
import AnnouncementBanner from "components/AnnouncementBanner";
import TitleProvider from "components/DynamicTitle";
import NavBar from "components/NavBar";
import SevReport from "components/SevReport";
import { track } from "lib/track";
import { SessionProvider } from "next-auth/react";
import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import { useEffect, createContext, useState } from "react";
import ReactGA from "react-ga4";
import "styles/globals.css";

export const DarkModeContext = createContext({
  isDarkMode: false,
  toggleDarkMode: () => {},
});

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const [isDarkMode, setIsDarkMode] = useState(false);

  const toggleDarkMode = () => {
    setIsDarkMode((prevMode) => !prevMode);
  };

  useEffect(() => {
    // GA records page views on its own, but I want to see how it differs with
    // this one.
    track(router, "pageview", {});
  }, [router, router.pathname]);

  useEffect(() => {
    const darkModeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    setIsDarkMode(darkModeMediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsDarkMode(e.matches);
    };

    darkModeMediaQuery.addEventListener("change", handleChange);

    return () => {
      darkModeMediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  ReactGA.initialize("G-HZEXJ323ZF");
  return (
    <>
      <SessionProvider>
        <TitleProvider>
          <DarkModeContext.Provider value={{ isDarkMode, toggleDarkMode }}>
            <div className={isDarkMode ? "dark-mode" : ""}>
              <NavBar />
              <AnnouncementBanner />
              <SevReport />
              <div style={{ margin: "20px" }}>
                <Component {...pageProps} />
                <Analytics />
              </div>
            </div>
          </DarkModeContext.Provider>
        </TitleProvider>
      </SessionProvider>
    </>
  );
}

export default MyApp;
