import NavBar from "components/NavBar";
import SevReport from "components/SevReport";
import type { AppProps } from "next/app";
import Head from "next/head";
import "styles/globals.css";

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>PyTorch CI HUD</title>
      </Head>
      <NavBar />
      <SevReport />
      <div style={{ margin: "20px" }}>
        <Component {...pageProps} />
      </div>
    </>
  );
}

export default MyApp;
