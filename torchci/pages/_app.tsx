import AnnouncementBanner from "components/AnnouncementBanner";
import NavBar from "components/NavBar";
import SevReport from "components/SevReport";
import { track } from "lib/track";
import { SessionProvider } from "next-auth/react";
import type { AppProps } from "next/app";
import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect } from "react";
import "styles/globals.css";
import ReactGA from "react-ga4";

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();
  useEffect(() => {
    // GA records page views on its own, but I want to see how it differs with
    // this one.
    track(router, "pageview", {});
  }, [router.pathname]);

  ReactGA.initialize("G-HZEXJ323ZF");
  return (
    <>
      <SessionProvider>
        <Head>
          <title>PyTorch CI HUD</title>
        </Head>
        <NavBar />
        <AnnouncementBanner />
        <SevReport />
        <div style={{ margin: "20px" }}>
          <Component {...pageProps} />
        </div>
      </SessionProvider>
    </>
  );
}

export default MyApp;
