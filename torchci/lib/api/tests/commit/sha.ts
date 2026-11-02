import { z } from "zod/v4";

// A commit as the commit endpoints and the commit page address it: the full
// SHA, lowercased. Zod only, so the pages can import it into the browser.
export const CommitShaSchema = z
  .string({
    error: "sha must be a full 40-character hexadecimal commit SHA",
  })
  .regex(/^[0-9a-fA-F]{40}$/, {
    error: "sha must be a full 40-character hexadecimal commit SHA",
  })
  .transform((value) => value.toLowerCase())
  .describe(
    "Full 40-character commit SHA. Hexadecimal letters are case-insensitive and normalized to lowercase; abbreviated SHAs are not accepted."
  );
