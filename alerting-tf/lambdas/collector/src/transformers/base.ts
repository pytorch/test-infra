import { AlertEvent, Envelope } from "../types";

// Abstract base class for alert transformers
export abstract class BaseTransformer {
  // Transform raw provider payload to canonical AlertEvent
  abstract transform(rawPayload: any, envelope: Envelope): AlertEvent;

  // Extract priority from string - fail fast for invalid values
  protected extractPriority(input: string): "P0" | "P1" | "P2" | "P3" {
    if (!input) {
      throw new Error("Priority field is empty or missing");
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

    throw new Error(`Invalid priority value: '${input}'. Expected P0, P1, P2, P3, or 0-3.`);
  }

  // Normalize title by trimming whitespace
  protected normalizeTitle(title: string): string {
    if (!title) throw new Error("Alert title is empty or missing. This indicates corrupted data from the provider.");
    return title.trim();
  }

  // Parse timestamp to ISO8601 format with strict validation
  // TODO: Consider if it actually makes sense to default to current time if input was invalid
  protected parseTimestamp(input: string | Date, required: boolean = false): string {
    if (!input) {
      if (required) {
        throw new Error("Required timestamp field is missing. This indicates corrupted data from the provider.");
      }
      return new Date().toISOString();
    }

    if (typeof input === "string") {
      // Security: Validate timestamp format to prevent injection
      if (input.length > 50) {
        throw new Error(`Timestamp string too long (max 50 characters): '${input.substring(0, 50)}...'. This may indicate corrupted data.`);
      }

      const parsed = new Date(input);

      // Validate that the parsed date is reasonable.  Using wide bounds
      // since this is meant to be a data sanity check, not a strict business policy.
      if (isNaN(parsed.getTime())) {
        if (required) {
          throw new Error(`Invalid timestamp format: '${input}'. Expected ISO8601 format. This may indicate corrupted data from the provider.`);
        }
        console.warn(`Invalid timestamp format, using current time: ${input}`);
        return new Date().toISOString();
      }

      // Security: Ensure timestamp is within reasonable bounds (not too far in past/future)
      const now = new Date();
      const tenYearsAgo = new Date(now.getFullYear() - 10, now.getMonth(), now.getDate());
      const oneYearFromNow = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

      if (parsed < tenYearsAgo || parsed > oneYearFromNow) {
        let msg = `Timestamp outside reasonable bounds: ${input}`;
        if (required) {
          throw new Error(`${msg}. Timestamp is too far away from the present. This may indicate corrupted data from the provider.`);
        }
        msg += ", using current time";
        console.warn(msg);
        return new Date().toISOString();
      }

      return parsed.toISOString();
    }

    if (input instanceof Date) {
      if (isNaN(input.getTime())) {
        throw new Error("Invalid Date object provided (contains NaN). This indicates corrupted data from the provider.");
      }
      return input.toISOString();
    }

    throw new Error(`Invalid timestamp type: '${typeof input}'. Expected string or Date object. This indicates corrupted data from the provider.`);
  }

  // Extract team from string - fail fast for missing values
  protected extractTeam(input: string): string {
    if (!input || !input.trim()) {
      throw new Error("Team field is empty or missing");
    }
    return input.trim().toLowerCase();
  }

  // Safe string extraction with fallback
  protected safeString(value: any, fallback: string = ""): string {
    if (typeof value === "string") return value;
    if (value !== null && value !== undefined) return String(value);
    return fallback;
  }

  // Security: input sanitization
  protected sanitizeString(value: any, maxLength: number = 255): string {
    if (!value) {
      return "";
    }

    let sanitized = String(value);

    // Remove potentially dangerous characters and control characters
    sanitized = sanitized
      .replace(/[<>\"'&\x00-\x1F\x7F]/g, '') // Remove HTML entities and control chars
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/data:/gi, '') // Remove data: protocol
      .replace(/vbscript:/gi, '') // Remove vbscript: protocol
      .replace(/on\w+=/gi, '') // Remove event handlers like onclick=
      .substring(0, maxLength)
      .trim();

    return sanitized;
  }

  // Security: Validate and sanitize URLs
  protected validateUrl(url: string): string | undefined {
    if (!url || typeof url !== "string") {
      return undefined;
    }

    // Security: Check length first to prevent DoS attacks with very long strings
    if (url.length > 2048) {
      console.warn("URL too long, rejecting");
      return undefined;
    }

    let urlToValidate = url.trim();

    try {
      // First, try to parse as-is to see if it's already a valid URL
      let parsed: URL;
      try {
        parsed = new URL(urlToValidate);
      } catch (firstParseError) {
        // If parsing fails and URL doesn't contain any protocol, try prepending https
        // This allows simple hostnames like "www.example.com" to be accepted
        if (!urlToValidate.includes('://')) {
          urlToValidate = `https://${urlToValidate}`;
          parsed = new URL(urlToValidate);
        } else {
          // If it contains :// but still failed to parse, it's invalid
          throw firstParseError;
        }
      }

      // Only allow http and https protocols
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        console.warn(`Invalid URL protocol: ${parsed.protocol}`);
        return undefined;
      }

      // Validate hostname structure for basic domain format
      if (!parsed.hostname ||
          parsed.hostname.length === 0 ||
          !parsed.hostname.includes('.') ||
          parsed.hostname.includes(' ') ||
          parsed.hostname.includes('<') ||
          parsed.hostname.includes('>') ||
          parsed.hostname.includes('(') ||
          parsed.hostname.includes(')')) {
        console.warn(`Invalid hostname format: ${parsed.hostname}`);
        return undefined;
      }

      return urlToValidate;
    } catch (error) {
      console.warn(`Invalid URL format: ${url}`);
      return undefined;
    }
  }
}