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
import ThemeToggle from "components/ThemeToggle";

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const [theme, setTheme] = useState(() => {
    const savedTheme = localStorage.getItem("theme");
    return savedTheme ? savedTheme : "system";
  });

  useEffect(() => {
    // GA records page views on its own, but I want to see how it differs with
    // this one.
    track(router, "pageview", {});
  }, [router, router.pathname]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
      root.classList.remove("light");
    } else if (theme === "light") {
      root.classList.add("light");
      root.classList.remove("dark");
    } else {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      root.classList.add(systemTheme);
      root.classList.remove(systemTheme === "dark" ? "light" : "dark");
    }
    localStorage.setItem("theme", theme);
  }, [theme]);

  ReactGA.initialize("G-HZEXJ323ZF");
  return (
    <>
      <SessionProvider>
        <TitleProvider>
          <NavBar />
          <ThemeToggle />
          <AnnouncementBanner />
          <SevReport />
          <div style={{ margin: "20px" }}>
            <Component {...pageProps} />
            <Analytics />
          </div>
        </TitleProvider>
      </SessionProvider>
    </>
  );
}

export default MyApp;
