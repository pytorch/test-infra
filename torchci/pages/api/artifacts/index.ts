import { LAST_N_DAYS } from "components/benchmark/common";
import dayjs from "dayjs";
import type { NextApiRequest, NextApiResponse } from "next";

const S3_BASE_URL = "https://gha-artifacts.s3.us-east-1.amazonaws.com";
const DEFAULT_TARGET_REPO = "vllm-project/vllm/";

type ArtifactFile = {
  key: string;
  url: string;
  date: string;
  modelName: string;
  deviceType: string;
  deviceName: string;
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
    const repositoryParam = req.query.repository as string | undefined;
    const lookbackParam = req.query.lookbackDays as string | undefined;
    const modelNameParam = req.query.modelName as string | undefined;
    const deviceTypeParam = req.query.deviceType as string | undefined;
    const deviceNameParam = req.query.deviceName as string | undefined;

    // Build the full S3 prefix path based on provided parameters
    let targetPrefix = parsePrefix(repositoryParam);

    // Append model name if provided
    if (modelNameParam && modelNameParam.trim()) {
      targetPrefix = `${targetPrefix}${modelNameParam}/`;
    }

    // Append device type if provided
    if (deviceTypeParam && deviceTypeParam.trim()) {
      targetPrefix = `${targetPrefix}${deviceTypeParam}/`;
    }

    // Append device name if provided
    if (deviceNameParam && deviceNameParam.trim()) {
      targetPrefix = `${targetPrefix}${deviceNameParam}/`;
    }

    const lookbackDays = parseLookbackDays(lookbackParam);
    const files = await collectArtifacts(targetPrefix, lookbackDays);

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json({ files });
  } catch (error) {
    console.error("Failed to fetch artifact listing", error);
    return res.status(500).json({ error: "Failed to fetch artifact listing" });
  }
}

async function collectArtifacts(targetPrefix: string, lookbackDays: number) {
  const now = dayjs();
  const startDate = now.subtract(lookbackDays, "day").startOf("day");

  const files: ArtifactFile[] = [];

  let currentDate = startDate;
  while (currentDate.isBefore(now, "day") || currentDate.isSame(now, "day")) {
    const dayPrefix = currentDate.format("YYYY-MM-DD");
    const fullPrefix = `${dayPrefix}/${targetPrefix}`;

    const dayKeys = await listS3Keys(fullPrefix);

    for (const key of dayKeys) {
      if (key.endsWith("/")) {
        continue;
      }

      const metadata = extractFileMetadata(key);
      if (!metadata) {
        continue;
      }

      files.push({
        key,
        url: buildDownloadUrl(key),
        ...metadata,
      });
    }

    currentDate = currentDate.add(1, "day");
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
    return DEFAULT_TARGET_REPO;
  }
  return value.endsWith("/") ? value : `${value}/`;
}

function parseLookbackDays(raw: string | undefined) {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return LAST_N_DAYS;
  }
  return Math.min(parsed, 180); // Max 6 months
}

function buildDownloadUrl(key: string) {
  return `${S3_BASE_URL}/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function extractFileMetadata(key: string) {
  // Path structure: <date>/<repo_name>/<model_name>/<device_type>/<device_name>/<test_name>/<commit_sha>/<github_workflow_id>/<github_job_id>/<file_name>
  const segments = key.split("/").filter(Boolean);

  // We need at least 10 segments for a valid vLLM artifact path
  if (segments.length < 10) {
    return null;
  }

  // Extract from the end (file_name is last)
  const fileName = segments[segments.length - 1];
  // Skip github_job_id (segments.length - 2)
  const workflowId = segments[segments.length - 3];
  const commitHash = segments[segments.length - 4];
  // Skip test_name (segments.length - 5)
  const deviceName = segments[segments.length - 6];
  const deviceType = segments[segments.length - 7];
  const modelName = segments[segments.length - 8];
  // Skip repo name (segments[1] and segments[2])
  const date = segments[0];

  if (!date) {
    return null;
  }

  return {
    date,
    modelName,
    deviceType,
    deviceName,
    fileName,
    commitHash,
    workflowId,
  };
}
