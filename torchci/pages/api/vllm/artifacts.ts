import type { NextApiRequest, NextApiResponse } from "next";
import dayjs from "dayjs";

const S3_BASE_URL = "https://gha-artifacts.s3.us-east-1.amazonaws.com";
const TARGET_PREFIX = "vllm-project/vllm/";
const LOOKBACK_MONTHS = 6;
const MAX_PAGINATION_LOOPS = 100;

type ArtifactFile = {
  key: string;
  fileName: string;
  url: string;
};

type ArtifactResponse = {
  files: ArtifactFile[];
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ArtifactResponse | { error: string }>
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const now = dayjs();
    const lookbackStart = now.subtract(LOOKBACK_MONTHS, "month").startOf("day");

    const monthPrefixes = buildMonthPrefixes(lookbackStart, now);
    const keys = new Set<string>();

    for (const monthPrefix of monthPrefixes) {
      const monthKeys = await listKeysForPrefix(monthPrefix);
      for (const key of monthKeys) {
        if (!key.includes(`/${TARGET_PREFIX}`)) {
          continue;
        }
        if (key.endsWith("/")) {
          continue;
        }
        const [dateSegment] = key.split("/");
        const parsedDate = dayjs(dateSegment);
        if (!parsedDate.isValid()) {
          continue;
        }
        if (parsedDate.isBefore(lookbackStart, "day")) {
          continue;
        }
        if (parsedDate.isAfter(now, "day")) {
          continue;
        }
        keys.add(key);
      }
    }

    const sortedKeys = Array.from(keys).sort((a, b) => (a > b ? -1 : 1));
    const files = sortedKeys.map((key) => ({
      key,
      fileName: getFileName(key),
      url: buildDownloadUrl(key),
    }));

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json({ files });
  } catch (error) {
    console.error("Failed to fetch vLLM artifact listing", error);
    return res
      .status(500)
      .json({ error: "Failed to fetch vLLM artifact listing" });
  }
}

function buildMonthPrefixes(startDate: dayjs.Dayjs, endDate: dayjs.Dayjs) {
  const prefixes: string[] = [];
  let cursor = startDate.startOf("month");
  const final = endDate.endOf("month");

  while (cursor.isBefore(final) || cursor.isSame(final, "month")) {
    prefixes.push(cursor.format("YYYY-MM"));
    cursor = cursor.add(1, "month");
  }

  return prefixes;
}

async function listKeysForPrefix(prefix: string): Promise<string[]> {
  let continuationToken: string | undefined = undefined;
  const keys: string[] = [];
  let loopCount = 0;

  do {
    if (loopCount++ > MAX_PAGINATION_LOOPS) {
      throw new Error("Reached pagination loop limit while listing S3 keys");
    }

    const url = new URL(S3_BASE_URL);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("encoding-type", "url");
    if (continuationToken) {
      url.searchParams.set("continuation-token", continuationToken);
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`S3 listing request failed with status ${response.status}`);
    }

    const xml = await response.text();
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const [, encodedKey] = match;
      keys.push(decodeURIComponent(encodedKey));
    }

    const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!isTruncated) {
      continuationToken = undefined;
      continue;
    }

    const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    continuationToken = tokenMatch ? tokenMatch[1] : undefined;
  } while (continuationToken);

  return keys;
}

function getFileName(key: string) {
  const parts = key.split("/");
  return parts[parts.length - 1];
}

function buildDownloadUrl(key: string) {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${S3_BASE_URL}/${encodedKey}`;
}
