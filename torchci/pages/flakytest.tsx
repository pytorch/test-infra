import { useRouter } from "next/router";
import { useEffect } from "react";
import { encodeParams } from "./tests/search";

export default function Page() {
  const router = useRouter();
  const name = (router.query.name || "") as string;
  const suite = (router.query.suite || "") as string;
  const file = (router.query.file || "") as string;

  useEffect(() => {
    if (router.isReady) {
      window.location.href = `/tests/search?${encodeParams({
        name,
        suite,
        file,
      })}`;
    }
  }, [router.isReady]);
  return <div></div>;
}
