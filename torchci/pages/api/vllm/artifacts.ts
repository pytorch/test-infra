import dayjs from "dayjs";
import type { NextApiRequest, NextApiResponse } from "next";

const S3_BASE_URL = "https://gha-artifacts.s3.us-east-1.amazonaws.com";
const TARGET_PREFIX = "vllm-project/vllm/";
const LOOKBACK_MONTHS = 6;
const MAX_PAGINATION_LOOPS = 100;

type ArtifactFile = {
  key: string;
  url: string;
  date: string;
  modelName: string;
  fileName: string;
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
    const monthKeyResults = await Promise.all(
      monthPrefixes.map((monthPrefix) => listKeysForPrefix(monthPrefix))
    );

    const keys = new Set<string>();

    for (const monthKeys of monthKeyResults) {
      for (const key of monthKeys) {
        if (!isKeyInTargetPrefix(key)) {
          continue;
        }

        const [dateSegment] = key.split("/");
        if (!isDateWithinRange(dateSegment, lookbackStart, now)) {
          continue;
        }

        keys.add(key);
      }
    }

    const sortedKeys = Array.from(keys).sort((a, b) => b.localeCompare(a));
    const files = sortedKeys.map((key) => ({
      key,
      url: buildDownloadUrl(key),
      ...extractFileMetadata(key),
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
      throw new Error(
        `S3 listing request failed with status ${response.status}`
      );
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

    const tokenMatch = xml.match(
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
    );
    continuationToken = tokenMatch ? tokenMatch[1] : undefined;
  } while (continuationToken);

  return keys;
}

function buildDownloadUrl(key: string) {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${S3_BASE_URL}/${encodedKey}`;
}

function isKeyInTargetPrefix(key: string) {
  if (key.endsWith("/")) {
    return false;
  }
  const [dateSegment, ...rest] = key.split("/");
  if (!dateSegment) {
    return false;
  }
  return rest.join("/").startsWith(TARGET_PREFIX);
}

function isDateWithinRange(
  dateSegment: string,
  earliest: dayjs.Dayjs,
  latest: dayjs.Dayjs
) {
  const parsedDate = dayjs(dateSegment);
  if (!parsedDate.isValid()) {
    return false;
  }

  if (parsedDate.isBefore(earliest, "day")) {
    return false;
  }

  if (parsedDate.isAfter(latest, "day")) {
    return false;
  }

  return true;
}

function extractFileMetadata(key: string) {
  const segments = key.split("/").filter(Boolean);
  const date = segments[0] ?? "";
  const fileName = segments[segments.length - 1] ?? "";
  const modelName = segments.length >= 2 ? segments[segments.length - 2] : "";

  return { date, modelName, fileName };
}
