import dayjs from "dayjs";
import type { NextApiRequest, NextApiResponse } from "next";

const S3_BASE_URL = "https://gha-artifacts.s3.us-east-1.amazonaws.com";
const DEFAULT_TARGET_PREFIX = "vllm-project/vllm/";
const DEFAULT_LOOKBACK_MONTHS = 6;
const MAX_PAGINATION_LOOPS = 100;

type ArtifactFile = {
  key: string;
  url: string;
  date: string;
  modelName: string;
  fileName: string;
  commitHash: string;
  workflowId: string;
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
    const prefixParam = Array.isArray(req.query.prefix)
      ? req.query.prefix[0]
      : req.query.prefix;
    const lookbackParam = Array.isArray(req.query.lookbackMonths)
      ? req.query.lookbackMonths[0]
      : req.query.lookbackMonths;

    const targetPrefix = parsePrefix(prefixParam);
    const lookbackMonths = parseLookbackMonths(lookbackParam);

    const files = await collectArtifacts(targetPrefix, lookbackMonths);

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json({ files });
  } catch (error) {
    console.error("Failed to fetch artifact listing", error);
    return res.status(500).json({ error: "Failed to fetch artifact listing" });
  }
}

async function collectArtifacts(targetPrefix: string, lookbackMonths: number) {
  const now = dayjs();
  const earliestDate = now.subtract(lookbackMonths, "month").startOf("day");

  const keys = new Set<string>();
  let cursor = earliestDate.startOf("month");

  while (cursor.isBefore(now, "month") || cursor.isSame(now, "month")) {
    const monthPrefix = cursor.format("YYYY-MM");
    const monthKeys = await listS3Keys(monthPrefix);

    for (const key of monthKeys) {
      if (key.endsWith("/")) {
        continue;
      }

      const [dateSegment, ...rest] = key.split("/");
      if (!dateSegment) {
        continue;
      }

      const pathAfterDate = rest.join("/");
      if (!pathAfterDate.startsWith(targetPrefix)) {
        continue;
      }

      const keyDate = dayjs(dateSegment);
      if (!keyDate.isValid()) {
        continue;
      }

      if (
        keyDate.isBefore(earliestDate, "day") ||
        keyDate.isAfter(now, "day")
      ) {
        continue;
      }

      keys.add(key);
    }

    cursor = cursor.add(1, "month");
  }

  return Array.from(keys)
    .sort((a, b) => b.localeCompare(a))
    .map((key) => ({
      key,
      url: buildDownloadUrl(key),
      ...extractFileMetadata(key, targetPrefix),
    }));
}

async function listS3Keys(prefix: string) {
  let continuationToken: string | undefined;
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

function parsePrefix(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_TARGET_PREFIX;
  }
  return value.endsWith("/") ? value : `${value}/`;
}

function parseLookbackMonths(raw: string | undefined) {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOOKBACK_MONTHS;
  }
  return Math.min(parsed, 24);
}

function buildDownloadUrl(key: string) {
  return `${S3_BASE_URL}/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function extractFileMetadata(key: string, targetPrefix: string) {
  const segments = key.split("/").filter(Boolean);
  const date = segments[0] ?? "";
  const fileName = segments[segments.length - 1] ?? "";
  const prefixSegments = targetPrefix.split("/").filter(Boolean);
  const afterDateSegments = segments.slice(1);
  const afterPrefixSegments = afterDateSegments.slice(prefixSegments.length);

  const commitHash =
    afterPrefixSegments.length >= 1 ? afterPrefixSegments[0] ?? "" : "";
  const workflowId =
    afterPrefixSegments.length >= 3 ? afterPrefixSegments[1] ?? "" : "";
  const trailingSegments = afterPrefixSegments.slice(2);
  const modelName =
    trailingSegments.length >= 2
      ? trailingSegments[trailingSegments.length - 2] ?? ""
      : "";

  return { date, modelName, fileName, commitHash, workflowId };
}
