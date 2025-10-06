import { openToggleSectionById } from "./ToggleSection";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Navigate inside a MUI DataGrid by matching rowId keywords,
 * and optionally focus on a specific column (field).
 *
 * @param sectionId  The section container DOM id (e.g. "section-metric-execution_time")
 * @param keywords   Array of keywords to match in the rowId (e.g. ["arch=h100", "dtype=bfloat16"])
 * @param field      Optional column field (suite name) to highlight a specific cell
 * @returns          The matched row or cell HTMLElement | null
 */
export async function navigateToDataGrid(
  sectionId: string,
  keywords: string[],
  field?: string,
  toggleId?: string
): Promise<HTMLElement | null> {
  if (toggleId) {
    openToggleSectionById(toggleId);
    await delay(350); // wait for toggle animation
  }
  const target = scrollToDataGridView(sectionId, keywords, field);
  await delay(800); // wait for scroll animation
  return target;
}

function scrollToDataGridView(
  sectionId: string,
  keywords: string[],
  field?: string
) {
  const section = document.getElementById(sectionId);
  if (!section) return null;

  let target: HTMLElement | null = section;

  const grid = section.querySelector(".MuiDataGrid-root") as HTMLElement | null;
  if (!grid) return null;

  // Search for row whose data-id contains all keywords
  const rows = grid.querySelectorAll<HTMLElement>("[data-id]");
  const match = Array.from(rows).find((r) => {
    const id = r.getAttribute("data-id") || "";
    return keywords.every((k) => id.includes(k));
  });

  if (!match) return null;
  target = match;

  // Scroll to the row
  match.scrollIntoView({ behavior: "smooth", block: "center" });
  // If a specific column (field) is given, focus on that cell
  if (field) {
    const cell = match.querySelector<HTMLElement>(
      `[data-field="${CSS.escape(field)}"]`
    );
    if (cell) {
      target = cell;
      scrollingToElement(cell);
    }
  }
  return target;
}

export async function navigateToEchartInGroup(
  sectionId: string,
  chartId: string,
  toggleId?: string // optional toggleId to open
): Promise<HTMLElement | null> {
  const section = getElementById(sectionId);
  if (!section) return null;

  let target: HTMLElement | null = section.querySelector<HTMLElement>(
    `#${CSS.escape(chartId)}`
  );

  if (toggleId) {
    openToggleSectionById(toggleId);
    await delay(350);
  }

  if (!target) {
    return null;
  }
  // scroll into view
  scrollingToElement(target);
  return target;
}

// Accss element from DOM by id
export function getElementById(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export async function scrollingToElement(
  target: HTMLElement | null,
  delay_ts: number = 200
) {
  if (!target) return null;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  await delay(delay_ts);
}
