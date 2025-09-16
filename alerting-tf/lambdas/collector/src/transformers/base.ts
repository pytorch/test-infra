import { AlertEvent, Envelope } from "../types";

// Abstract base class for alert transformers
export abstract class BaseTransformer {
  // Transform raw provider payload to canonical AlertEvent
  abstract transform(rawPayload: any, envelope: Envelope): AlertEvent;

  // Extract priority from string, with fallback to P3
  protected extractPriority(input: string): "P0" | "P1" | "P2" | "P3" {
    if (!input) return "P3";

    const normalized = input.toUpperCase().trim();

    if (normalized.includes("P0")) return "P0";
    if (normalized.includes("P1")) return "P1";
    if (normalized.includes("P2")) return "P2";
    if (normalized.includes("P3")) return "P3";

    // Fallback for severity-based values
    if (normalized.includes("CRITICAL") || normalized.includes("HIGH")) return "P1";
    if (normalized.includes("MEDIUM") || normalized.includes("WARNING")) return "P2";
    if (normalized.includes("LOW") || normalized.includes("INFO")) return "P3";

    return "P3"; // Default fallback
  }

  // Normalize title by trimming whitespace
  protected normalizeTitle(title: string): string {
    if (!title) return "Unknown Alert";
    return title.trim();
  }

  // Parse timestamp to ISO8601 format
  protected parseTimestamp(input: string | Date): string {
    if (!input) return new Date().toISOString();

    if (typeof input === "string") {
      const parsed = new Date(input);
      if (isNaN(parsed.getTime())) {
        return new Date().toISOString();
      }
      return parsed.toISOString();
    }

    return input.toISOString();
  }

  // Extract team from string, with fallback
  protected extractTeam(input: string): string {
    if (!input) return "unknown";
    return input.trim().toLowerCase();
  }

  // Safe string extraction with fallback
  protected safeString(value: any, fallback: string = ""): string {
    if (typeof value === "string") return value;
    if (value !== null && value !== undefined) return String(value);
    return fallback;
  }
}