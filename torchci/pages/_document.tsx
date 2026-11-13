import { RATES_FRAGMENT_SCRUB } from "lib/tests/cost/ratesFragment";
import { Head, Html, Main, NextScript } from "next/document";

// The app's document: Next's own, with one script in the head. It takes a
// rates fragment off the address before any of the app's code, or its
// analytics, can read it (lib/tests/cost/ratesFragment.ts).
export default function Document() {
  return (
    <Html>
      <Head>
        <script dangerouslySetInnerHTML={{ __html: RATES_FRAGMENT_SCRUB }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
