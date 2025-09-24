/**
 * Navigate inside a MUI DataGrid by matching rowId keywords,
 * and optionally focus on a specific column (field).
 *
 * @param sectionId  The section container DOM id (e.g. "section-metric-execution_time")
 * @param keywords   Array of keywords to match in the rowId (e.g. ["arch=h100", "dtype=bfloat16"])
 * @param field      Optional column field (suite name) to highlight a specific cell
 * @returns          The matched row or cell HTMLElement | null
 */
export function navigateToDataGrid(
  sectionId: string,
  keywords: string[],
  field?: string
): HTMLElement | null {
  const section = document.getElementById(sectionId);
  if (!section) return null;

  const grid = section.querySelector(".MuiDataGrid-root") as HTMLElement | null;
  if (!grid) return null;

  // Search for row whose data-id contains all keywords
  const rows = grid.querySelectorAll<HTMLElement>("[data-id]");
  const match = Array.from(rows).find((r) => {
    const id = r.getAttribute("data-id") || "";
    return keywords.every((k) => id.includes(k));
  });

  if (!match) return null;

  // Scroll to the row
  match.scrollIntoView({ behavior: "smooth", block: "center" });

  // If a specific column (field) is given, focus on that cell
  let target: HTMLElement | null = match;
  if (field) {
    const cell = match.querySelector<HTMLElement>(
      `[data-field="${CSS.escape(field)}"]`
    );
    if (cell) {
      target = cell;
      cell.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  return target;
}

export function navigateToEchartInGroup(
  sectionId: string,
  chartId: string // optional keywords to filter which chart
): HTMLElement | null {
  const section = document.getElementById(sectionId);
  if (!section) return null;

  // assume each chart container has className="echart"
  const chart = document.getElementById(chartId);
  let target: HTMLElement | null = chart;

  if (!target) {
    return null;
  }
  // scroll into view
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  return target;
}
