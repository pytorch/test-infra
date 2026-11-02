import { useEffect, useState } from "react";

// Whether the component has rendered on the client: false on the server and
// during hydration, true from the first client render on. For what the
// server must not render, the labels in the viewer's time zone above all,
// which it does not know: a component renders nothing for them until this is
// true, so the server's HTML and the first client render agree.
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}
