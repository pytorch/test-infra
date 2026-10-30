// The hub's one status palette: a big and a small pill for every hue in
// both modes, the grid's cells reading the small pills and ringing
// themselves in the big pills' ink, and the small fills staying on the
// blocks' backgrounds except where they deviate on purpose.

import { createTheme } from "@mui/material/styles";
import { hueColors, PILL_COLORS, smallPillColors } from "lib/tests/blockColors";
import { cellFill, cellHoverColors, cellStroke } from "lib/tests/gridColors";

const light = createTheme({ palette: { mode: "light" } });
const dark = createTheme({ palette: { mode: "dark" } });
const COLOR = /^(#[0-9a-f]{6}|rgba?\([0-9., ]+\))$/;

describe("the pill palette", () => {
  test("has a big and a small pill for every hue in both modes", () => {
    expect(Object.keys(PILL_COLORS).sort()).toEqual([
      "green",
      "purple",
      "red",
      "yellow",
    ]);
    for (const modes of Object.values(PILL_COLORS)) {
      for (const mode of ["light", "dark"] as const) {
        const { big, small } = modes[mode];
        expect(Object.keys(big).sort()).toEqual(["background", "text"]);
        expect(Object.keys(small).sort()).toEqual([
          "edge",
          "fill",
          "hoverFill",
        ]);
        for (const value of [...Object.values(big), ...Object.values(small)]) {
          expect(value).toMatch(COLOR);
        }
      }
    }
  });

  test("gives a cell the small pill of its status and the block's ink as its ring", () => {
    for (const theme of [light, dark]) {
      expect(cellFill(theme, "failed")).toBe(
        smallPillColors(theme, "red").fill
      );
      expect(cellStroke(theme, "flaky")).toBe(
        smallPillColors(theme, "yellow").edge
      );
      expect(cellFill(theme, "passed")).toBe(
        smallPillColors(theme, "green").fill
      );
      expect(cellHoverColors(theme, "skipped")).toEqual({
        fill: smallPillColors(theme, "purple").hoverFill,
        stroke: hueColors(theme, "purple").text,
      });
      expect(cellFill(theme, "other")).toBe("none");
      expect(cellStroke(theme, "other")).toBe(theme.palette.text.disabled);
    }
  });

  test("keeps the small fills on the blocks' backgrounds, but the red a step stronger", () => {
    for (const theme of [light, dark]) {
      expect(smallPillColors(theme, "yellow").fill).toBe(
        hueColors(theme, "yellow").background
      );
      expect(smallPillColors(theme, "purple").fill).toBe(
        hueColors(theme, "purple").background
      );
      expect(smallPillColors(theme, "red").fill).not.toBe(
        hueColors(theme, "red").background
      );
    }
  });
});
