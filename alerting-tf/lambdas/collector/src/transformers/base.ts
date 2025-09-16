import { AlertEvent, Envelope } from "../types";

// Abstract base class for alert transformers
export abstract class BaseTransformer {
  // Transform raw provider payload to canonical AlertEvent
  abstract transform(rawPayload: any, envelope: Envelope): AlertEvent;

  // Extract priority from string - fail fast for invalid values
  protected extractPriority(input: string): "P0" | "P1" | "P2" | "P3" {
    if (!input) {
      throw new Error("Missing required priority field");
    }

    const normalized = input.toUpperCase().trim();

    // Strict matching - only allow exact priority values
    if (normalized === "P0") return "P0";
    if (normalized === "P1") return "P1";
    if (normalized === "P2") return "P2";
    if (normalized === "P3") return "P3";

    // Support common priority number formats
    if (normalized === "0") return "P0";
    if (normalized === "1") return "P1";
    if (normalized === "2") return "P2";
    if (normalized === "3") return "P3";

    throw new Error(`Invalid priority value: '${input}'. Expected P0, P1, P2, P3, or 0-3`);
  }

  // Normalize title by trimming whitespace
  protected normalizeTitle(title: string): string {
    if (!title) throw new Error("Missing alert title");
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

  // Extract team from string - fail fast for missing values
  protected extractTeam(input: string): string {
    if (!input || !input.trim()) {
      throw new Error("Missing required team field");
    }
    return input.trim().toLowerCase();
  }

  // Safe string extraction with fallback
  protected safeString(value: any, fallback: string = ""): string {
    if (typeof value === "string") return value;
    if (value !== null && value !== undefined) return String(value);
    return fallback;
  }
}