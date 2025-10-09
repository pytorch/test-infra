import { Box } from "@mui/system";
import { useEffect, useRef, useState } from "react";

export type StickyBarProps = {
  children: React.ReactNode;
  height?: number;
  offset?: number;
  zIndex?: number;
  onMount?: (h: number) => void;
  onUnmount?: (h: number) => void;
  /** Horizontal alignment of content inside the bar */
  align?: "left" | "center" | "right";
  /** Should children keep their natural width ("fit") or stretch ("full") */
  contentMode?: "fit" | "full";
};

export const StickyBar: React.FC<StickyBarProps> = ({
  children,
  height = 48,
  offset,
  zIndex = 900,
  onMount,
  onUnmount,
  align = "left",
  contentMode = "fit",
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isSticky, setIsSticky] = useState(false);

  // Let parent know about mount/unmount (for stacking offset logic)
  useEffect(() => {
    onMount?.(height);
    return () => onUnmount?.(height);
  }, [height, onMount, onUnmount]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        // < 0.99
        setIsSticky(entry.intersectionRatio < 0.99);
      },
      {
        threshold: Array.from({ length: 101 }, (_, i) => i / 100),
        // 0,0.01,0.02,...,1，
      }
    );

    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  const justify =
    align === "center"
      ? "center"
      : align === "right"
      ? "flex-end"
      : "flex-start";

  return (
    <>
      {/* Sentinel keeps layout height stable */}
      <div ref={ref} style={{ height }} />
      {/* Outer bar: full width, sticky */}
      <Box
        sx={{
          position: isSticky ? "sticky" : "static",
          top: offset,
          zIndex,
          borderColor: "divider",
          height,
          width: 1, // full width of parent
          display: "flex",
          alignItems: "center",
          justifyContent: justify,
          px: 2,
          boxSizing: "border-box",
        }}
      >
        {/* Inner container: controls how children size themselves */}
        <Box
          sx={{
            width: contentMode === "fit" ? "fit-content" : "100%",
            maxWidth: "100%",
            display: "inline-flex",
            alignItems: "center",
            gap: 1,
            "& > *": { flex: "0 0 auto", minWidth: "auto" }, // don’t stretch children
          }}
        >
          {children}
        </Box>
      </Box>
      <div ref={ref} style={{ height }} />
    </>
  );
};
