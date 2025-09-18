import dayjs from "dayjs";
import type { NextApiRequest, NextApiResponse } from "next";

const S3_BASE_URL = process.env.GITHUB_ARTIFACTS_S3_URL ?? "";
const DEFAULT_TARGET_PREFIX = "vllm-project/vllm/";
const DEFAULT_LOOKBACK_MONTHS = 6;

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

  const files: ArtifactFile[] = [];
  let cursor = earliestDate.startOf("month");

  while (cursor.isBefore(now, "month") || cursor.isSame(now, "month")) {
    const monthPrefix = cursor.format("YYYY-MM");
    const monthKeys = await listS3Keys(monthPrefix);

    for (const key of monthKeys) {
      if (key.endsWith("/")) {
        continue;
      }

      if (!key.includes(`/${targetPrefix}`)) {
        continue;
      }

      const metadata = extractFileMetadata(key);
      if (!metadata) {
        continue;
      }

      const fileDate = dayjs(metadata.date);
      if (!fileDate.isValid()) {
        continue;
      }

      if (
        fileDate.isBefore(earliestDate, "day") ||
        fileDate.isAfter(now, "day")
      ) {
        continue;
      }

      files.push({
        key,
        url: buildDownloadUrl(key),
        ...metadata,
      });
    }

    cursor = cursor.add(1, "month");
  }

  return files.sort((a, b) => b.key.localeCompare(a.key));
}

async function listS3Keys(prefix: string) {
  const url = new URL(S3_BASE_URL);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", prefix);
  url.searchParams.set("encoding-type", "url");

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`S3 listing request failed with status ${response.status}`);
  }

  const xml = await response.text();
  const keys: string[] = [];

  for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    const [, encodedKey] = match;
    keys.push(decodeURIComponent(encodedKey));
  }

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

function extractFileMetadata(key: string) {
  const segments = key.split("/").filter(Boolean);
  if (segments.length < 7) {
    return null;
  }

  const fileName = segments.pop() ?? "";
  const modelName = segments.pop() ?? "";
  segments.pop();
  const workflowId = segments.pop() ?? "";
  const commitHash = segments.pop() ?? "";
  const date = segments.shift() ?? "";

  if (!date) {
    return null;
  }

  return { date, modelName, fileName, commitHash, workflowId };
}
