import { Highlight } from "lib/types";
import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    // find the last child of the ref
    const target = targetRef.current;

    const targetContent = target?.lastElementChild;
    const child = targetContent?.firstElementChild as HTMLElement;

    if (!child) {
      return;
    }

    // get bounding box of target content
    const targetRect = targetContent?.getBoundingClientRect();

    if (targetRect === undefined) {
      return;
    }

    // calculate width of child element content to be used for positioning
    const childWidth = child.getBoundingClientRect().width;

    const xTargetContent = targetRect.x;

    // if on the right side of the screen, position tooltip to the left if width is smaller than half of the screen
    if (xTargetContent + childWidth > window.innerWidth) {
      child.style.left = `calc(100% - ${childWidth}px)`;
    } // if on the left side of the screen, position tooltip to the right if width is smaller than half of the screen
    else if (xTargetContent < 0 && childWidth < window.innerWidth / 2) {
      child.style.left = "0";
    } else {
      // otherwise we make sure it doens't go off the screen
      child.style.left = "0";
    }
  }, [isPinned, targetRef.current]);

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
