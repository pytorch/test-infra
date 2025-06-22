import { useCallback, useEffect, useMemo, useState } from "react";
import { ParsedContent } from "./types";

export const useAnimatedCounter = (targetValue: number) => {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    setDisplayValue(targetValue);
  }, [targetValue]);

  return displayValue;
};

export const useThinkingMessages = () => {
  return useMemo(
    () => [
      "Crunching numbers...",
      "Working hard...",
      "Quantum tunneling...",
      "Consulting the oracle...",
      "Training neurons...",
      "Brewing dashboard magic...",
      "Mining insights...",
      "Recalibrating flux capacitor...",
      "Untangling spaghetti code...",
      "Summoning visualization wizards...",
      "Defragmenting brain cells...",
      "Polishing pixels...",
      "Warming up GPUs...",
      "Convincing metrics to behave...",
      "Interrogating databases...",
      "Reticulating splines...",
      "Calibrating the metric-o-meter...",
      "Wrangling unruly data points...",
      "Converting caffeine to dashboards...",
      "Bending time series to my will...",
      "Calculating the meaning of metrics...",
      "Hacking the mainframe...",
      "Negotiating with stubborn algorithms...",
    ],
    []
  );
};

export const useTokenCalculator = () => {
  return useCallback((responses: ParsedContent[]) => {
    let total = 0;

    try {
      if (!Array.isArray(responses) || responses.length === 0) {
        return 0;
      }

      for (const item of responses) {
        if (item.type === "text") {
          if (
            typeof item.outputTokens === "number" &&
            isFinite(item.outputTokens)
          ) {
            const tokenCount = Math.max(0, Number(item.outputTokens));

            if (tokenCount >= 0 && tokenCount < 10000) {
              total += tokenCount;
            }
          }
        }
      }
    } catch (err) {
      console.error("Error during token calculation:", err);
      return 0;
    }

    total = Number(total);

    if (!isFinite(total) || total < 0) {
      total = 0;
    } else if (total > 20000) {
      total = 20000;
    }

    return total;
  }, []);
};

export const useAutoScroll = (
  isLoading: boolean,
  parsedResponses: ParsedContent[],
  containerRef: React.RefObject<HTMLElement>
) => {
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const scrollToBottomAndEnable = useCallback(() => {
    setAutoScrollEnabled(true);
    setShowScrollButton(false);
    if (containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [containerRef]);

  const resetAutoScroll = useCallback(() => {
    setAutoScrollEnabled(true);
    setShowScrollButton(false);
  }, []);

  useEffect(() => {
    const isAtBottom = () => {
      if (!containerRef.current) return true;
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      return scrollHeight - (scrollTop + clientHeight) <= 100;
    };

    const handleScroll = () => {
      const atBottom = isAtBottom();

      if (!atBottom) {
        if (autoScrollEnabled) {
          setAutoScrollEnabled(false);
          setShowScrollButton(true);
        }
      } else if (atBottom && showScrollButton) {
        setShowScrollButton(false);
        setAutoScrollEnabled(true);
      }
    };

    const element = containerRef.current;
    if (!element) return;
    element.addEventListener("scroll", handleScroll);
    return () => element.removeEventListener("scroll", handleScroll);
  }, [
    isLoading,
    showScrollButton,
    parsedResponses,
    autoScrollEnabled,
    containerRef,
  ]);

  useEffect(() => {
    if (!isLoading || !autoScrollEnabled || parsedResponses.length === 0)
      return;

    const hasActiveTypewriterAnimation = parsedResponses.some(
      (item) => item.isAnimating
    );
    if (hasActiveTypewriterAnimation) {
      return;
    }

    const isAtBottom = () => {
      if (!containerRef.current) return true;
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      return scrollHeight - (scrollTop + clientHeight) <= 50;
    };

    if (!isAtBottom()) {
      const scrollToBottom = () => {
        if (containerRef.current) {
          containerRef.current.scrollTo({
            top: containerRef.current.scrollHeight,
            behavior: "smooth",
          });
        }
      };

      requestAnimationFrame(scrollToBottom);
    }
  }, [parsedResponses, isLoading, autoScrollEnabled]);

  useEffect(() => {
    if (!isLoading && parsedResponses.length > 0 && autoScrollEnabled) {
      const hasActiveTypewriterAnimation = parsedResponses.some(
        (item) => item.isAnimating
      );
      if (hasActiveTypewriterAnimation) {
        return;
      }

      const finalScrollTimer = setTimeout(() => {
        if (autoScrollEnabled && containerRef.current) {
          containerRef.current.scrollTo({
            top: containerRef.current.scrollHeight,
            behavior: "smooth",
          });
        }
      }, 200);

      return () => clearTimeout(finalScrollTimer);
    }
  }, [isLoading, parsedResponses.length, autoScrollEnabled, parsedResponses]);

  return {
    autoScrollEnabled,
    showScrollButton,
    scrollToBottomAndEnable,
    resetAutoScroll,
  };
};
