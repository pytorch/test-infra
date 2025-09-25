import { GlobalStyles } from "@mui/material";

export function highlightUntilClick(el: HTMLElement) {
  if (!el) return;

  // add highlight
  el.classList.add("pulse-highlight");

  // one-time listener: remove on first click anywhere
  const removeHighlight = () => {
    el.classList.remove("pulse-highlight");
    document.removeEventListener("click", removeHighlight, true);
  };

  document.addEventListener("click", removeHighlight, true);
}

export function HighlightStyles() {
  return (
    <GlobalStyles
      styles={{
        "@keyframes pulse": {
          "0%": { boxShadow: "0 0 0 0 rgba(25,118,210,0.5)" },
          "70%": { boxShadow: "0 0 0 6px rgba(25,118,210,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(25,118,210,0)" },
        },
        ".pulse-highlight": {
          outline: "2px solid #1976d2",
          borderRadius: 4,
          background: "rgba(25,118,210,0.08)",
          animation: "pulse 1.2s ease-out infinite",
        },
      }}
    />
  );
}
