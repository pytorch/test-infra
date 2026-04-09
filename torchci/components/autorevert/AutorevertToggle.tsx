import { formatHudUrlForRoute } from "lib/types";
import styles from "./autorevert.module.css";

interface AutorevertToggleProps {
  active: boolean;
  onToggle: (active: boolean) => void;
  repoOwner: string;
  repoName: string;
  branch: string;
  page: number;
  per_page: number;
}

/**
 * HUD / Autorevert toggle switch.
 * Handles URL updates when switching between views.
 */
export default function AutorevertToggle({
  active,
  onToggle,
  repoOwner,
  repoName,
  branch,
  page,
  per_page,
}: AutorevertToggleProps) {
  return (
    <div className={styles.toggleWrapper}>
      <button
        className={`${styles.toggleOption} ${
          !active ? styles.toggleOptionActive : ""
        }`}
        onClick={() => {
          onToggle(false);
          const hudUrl = formatHudUrlForRoute("hud", {
            repoOwner,
            repoName,
            branch,
            page: page || 1,
            per_page: per_page || 50,
          } as any);
          const url = new URL(hudUrl, window.location.origin);
          for (const key of ["autorevert", "ar_ts", "ar_wf", "ar_sf"]) {
            url.searchParams.delete(key);
          }
          window.history.replaceState({}, "", url.toString());
        }}
      >
        HUD
      </button>
      <button
        className={`${styles.toggleOption} ${
          active ? styles.toggleOptionActive : ""
        }`}
        onClick={() => {
          onToggle(true);
          const base = `/hud/${repoOwner}/${repoName}/${encodeURIComponent(branch)}/autorevert`;
          const url = new URL(base, window.location.origin);
          const current = new URLSearchParams(window.location.search);
          for (const key of ["ar_ts", "ar_wf", "ar_sf"]) {
            const val = current.get(key);
            if (val) url.searchParams.set(key, val);
          }
          window.history.replaceState({}, "", url.toString());
        }}
      >
        Autorevert
      </button>
    </div>
  );
}

/**
 * Check if the autorevert view should be active based on URL.
 * Call from useState initializer in the HUD page.
 */
export function isAutorevertActive(routerQuery: any): boolean {
  const pageSegment = routerQuery.page;
  const isAutorevertRoute =
    (Array.isArray(pageSegment) && pageSegment[0] === "autorevert") ||
    pageSegment === "autorevert";
  if (isAutorevertRoute) return true;
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    return (
      params.get("autorevert") === "1" ||
      params.has("ar_ts") ||
      params.has("ar_wf") ||
      params.has("ar_sf")
    );
  }
  return false;
}
