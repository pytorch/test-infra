import { useRef, useState } from "react";
import styles from "./TooltipTarget.module.css";

export default function TooltipTarget({
  id,
  pinnedId,
  setPinnedId,
  tooltipContent,
  children,
}: {
  id: string;
  pinnedId: string | null;
  setPinnedId: any;
  tooltipContent: React.ReactNode;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const timeoutId = useRef<NodeJS.Timeout | null>(null);
  const isInteractive = pinnedId !== null;
  const isPinned = pinnedId === id;

  function handleMouseOver() {
    if (isInteractive) {
      return;
    }
    clearTimeout(timeoutId.current!);
    timeoutId.current = setTimeout(() => {
      setVisible(true);
    }, 10);
  }
  function handleMouseLeave() {
    setVisible(false);
    if (timeoutId.current !== null) {
      clearTimeout(timeoutId.current!);
    }
  }
  function handleClick(e: React.MouseEvent) {
    if (isInteractive) {
      return;
    }
    // Capture this click to avoid it being propagated to the global click
    // handler, which we use to reset the pinned id.
    e.stopPropagation();
    setPinnedId(id);
  }

  const content =
    visible || isPinned ? (
      <div
        className={styles.container}
        // Don't propagate any clicks to the tooltip itself.
        onClick={(e) => e.stopPropagation()}
      >
        <div className={isPinned ? styles.contentPinned : styles.content}>
          {tooltipContent}
        </div>
      </div>
    ) : null;

  return (
    <div
      onMouseOver={handleMouseOver}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      className={styles.target}
    >
      {content}
      {children}
    </div>
  );
}
