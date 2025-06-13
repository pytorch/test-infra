import { Highlight } from "lib/types";
import { useRef, useState } from "react";
import styles from "./TooltipTarget.module.css";

export default function TooltipTarget({
  sha,
  name,
  pinnedId,
  setPinnedId,
  tooltipContent,
  children,
}: {
  sha: string;
  name: string;
  pinnedId: Highlight;
  setPinnedId: any;
  tooltipContent: React.ReactNode;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const timeoutId = useRef<NodeJS.Timeout | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const isPinned = pinnedId.sha == sha && pinnedId.name == name;

  function handleMouseOver() {
    if (pinnedId.sha !== undefined && pinnedId.name !== undefined) {
      return;
    }
    clearTimeout(timeoutId.current!);
    timeoutId.current = setTimeout(() => {
      setVisible(true);
    }, 5);
  }

  function handleMouseLeave() {
    setVisible(false);
    if (timeoutId.current !== null) {
      clearTimeout(timeoutId.current!);
    }
  }
  function handleClick(e: React.MouseEvent) {
    if (pinnedId.sha !== undefined || pinnedId.name !== undefined) {
      return;
    }
    // Capture this click to avoid it being propagated to the global click
    // handler, which we use to reset the pinned id.
    e.stopPropagation();
    setPinnedId({ sha: sha, name: name });
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
    <div className={styles.target} ref={targetRef}>
      <div
        onMouseOver={handleMouseOver}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        className={styles.targetContent}
      >
        {children}
      </div>
      {content}
    </div>
  );
}
