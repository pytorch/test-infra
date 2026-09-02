// Rendering raw query numbers as display strings.

export function intFormatter(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return Number(value).toLocaleString();
}
