// The table's row geometry in pixels, set directly rather than through the
// grid's density setting, which scales whatever it is given by a hidden
// factor. A row is at least ROW_HEIGHT, which holds the two tight lines of
// the environment and duration cells with a little air, and grows with a
// name that wraps onto more lines; its cells keep CELL_VERTICAL_PADDING
// above and below their content, and the grid's own CELL_HORIZONTAL_PADDING
// at the sides, where every cell's text starts.
export const ROW_HEIGHT = 44;
export const CELL_VERTICAL_PADDING = 3;
export const CELL_HORIZONTAL_PADDING = 10;
// The Health cell, which holds a block, pads its sides by
// CELL_VERTICAL_PADDING instead, so the block, which fills the cell, sits
// the same distance from every edge; the block pads its own text by the
// rest, so the text starts where the other cells' does.
export const CELL_BLOCK_PADDING =
  CELL_HORIZONTAL_PADDING - CELL_VERTICAL_PADDING;
