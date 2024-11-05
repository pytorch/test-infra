import AnnouncementBanner from "components/AnnouncementBanner";
import TitleProvider from "components/DynamicTitle";
import NavBar from "components/NavBar";
import SevReport from "components/SevReport";
import { UseCHContextProvider } from "components/UseClickhouseProvider";
import { track } from "lib/track";
import { SessionProvider } from "next-auth/react";
import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import { useEffect } from "react";
import ReactGA from "react-ga4";
import "styles/globals.css";
import { Analytics } from '@vercel/analytics/react';

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();
  useEffect(() => {
    // GA records page views on its own, but I want to see how it differs with
    // this one.
    track(router, "pageview", {});
  }, [router, router.pathname]);

  ReactGA.initialize("G-HZEXJ323ZF");
  return (
    <>
      <SessionProvider>
        <UseCHContextProvider>
          <TitleProvider>
            <NavBar />
            <AnnouncementBanner />
            <SevReport />
            <div style={{ margin: "20px" }}>
              <Component {...pageProps} />
              // vercel analytics start tracking visitors and page views with Web Analytics,
              <Analytics />
            </div>
          </TitleProvider>
        </UseCHContextProvider>
      </SessionProvider>

    </>
  );
}

export default MyApp;
