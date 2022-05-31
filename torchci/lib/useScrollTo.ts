import { useRouter } from "next/router";
import { useEffect } from "react";

export default function useScrollTo() {
  const router = useRouter();
  useEffect(() => {
    const id = router.asPath.split("#")[1];
    if (id != null) {
      const job = document.getElementById(id);
      window.scrollTo({ top: job?.offsetTop, behavior: "smooth" });
    }
  }, [router.asPath]);
}
