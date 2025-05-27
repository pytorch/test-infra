/**
 * Utility functions for CSV export functionality
 */

/**
 * Escapes a string for CSV format by adding quotes if necessary
 * and escaping internal quotes by doubling them
 */
export const escapeCSV = (str: string): string => {
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

/**
 * Converts an array of objects to CSV format
 * @param data Array of objects to convert
 * @param headers Optional array of header names. If not provided, uses object keys
 * @returns CSV string
 */
export const arrayToCSV = (data: any[], headers?: string[]): string => {
  if (!data || data.length === 0) {
    return "";
  }

  const csvHeaders = headers || Object.keys(data[0]);
  const headerRow = csvHeaders.map(escapeCSV).join(",");

  const rows = data.map((row) =>
    csvHeaders
      .map((header) => {
        const value = row[header];
        return escapeCSV(String(value ?? ""));
      })
      .join(",")
  );

  return [headerRow, ...rows].join("\n");
};

/**
 * Downloads a CSV string as a file
 * @param csvData The CSV string to download
 * @param filename The filename for the download
 */
export const downloadCSV = (csvData: string, filename: string): void => {
  const blob = new Blob([csvData], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

/**
 * Generates a standardized CSV filename with timestamp and descriptive components
 * @param prefix Prefix for the filename (e.g., "pytorchci", "benchmark")
 * @param type Type of export (e.g., "cost", "duration", "metrics")
 * @param components Additional filename components
 * @returns Formatted filename with .csv extension
 */
export const generateCSVFilename = (
  prefix: string,
  type: string,
  components: string[] = []
): string => {
  const timestamp = new Date().toISOString().split("T")[0]; // YYYY-MM-DD format
  const sanitizedComponents = components
    .filter(Boolean)
    .map((component) => component.replace(/[^a-z0-9]/gi, "_"));

  const parts = [prefix, type, timestamp, ...sanitizedComponents].filter(
    Boolean
  );
  return `${parts.join("_")}.csv`;
};
