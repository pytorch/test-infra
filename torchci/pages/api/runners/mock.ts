import type { NextApiRequest, NextApiResponse } from "next";

export interface RunnerData {
  id: number;
  name: string;
  os: string;
  status: "online" | "offline";
  busy: boolean;
  labels: Array<{
    id?: number;
    name: string;
    type: "read-only" | "custom";
  }>;
}

export interface RunnersApiResponse {
  total_count: number;
  runners: RunnerData[];
}

// Mock data for demonstration purposes
const mockRunners: RunnersApiResponse = {
  total_count: 15,
  runners: [
    {
      id: 1,
      name: "pytorch-linux-cpu-1",
      os: "linux",
      status: "online",
      busy: false,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 2, name: "linux", type: "read-only" },
        { id: 3, name: "x64", type: "read-only" },
        { id: 4, name: "cpu", type: "custom" },
        { id: 5, name: "pytorch", type: "custom" },
      ],
    },
    {
      id: 2,
      name: "pytorch-linux-gpu-1",
      os: "linux", 
      status: "online",
      busy: true,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 2, name: "linux", type: "read-only" },
        { id: 3, name: "x64", type: "read-only" },
        { id: 6, name: "gpu", type: "custom" },
        { id: 7, name: "cuda", type: "custom" },
        { id: 5, name: "pytorch", type: "custom" },
      ],
    },
    {
      id: 3,
      name: "pytorch-linux-gpu-2",
      os: "linux",
      status: "online",
      busy: false,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 2, name: "linux", type: "read-only" },
        { id: 3, name: "x64", type: "read-only" },
        { id: 6, name: "gpu", type: "custom" },
        { id: 7, name: "cuda", type: "custom" },
        { id: 5, name: "pytorch", type: "custom" },
      ],
    },
    {
      id: 4,
      name: "pytorch-windows-cpu-1",
      os: "windows",
      status: "online",
      busy: false,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 8, name: "windows", type: "read-only" },
        { id: 3, name: "x64", type: "read-only" },
        { id: 4, name: "cpu", type: "custom" },
        { id: 5, name: "pytorch", type: "custom" },
      ],
    },
    {
      id: 5,
      name: "pytorch-macos-m1-1",
      os: "macos",
      status: "online",
      busy: true,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 9, name: "macos", type: "read-only" },
        { id: 10, name: "arm64", type: "read-only" },
        { id: 4, name: "cpu", type: "custom" },
        { id: 5, name: "pytorch", type: "custom" },
        { id: 11, name: "m1", type: "custom" },
      ],
    },
    {
      id: 6,
      name: "pytorch-linux-cpu-2",
      os: "linux",
      status: "offline",
      busy: false,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 2, name: "linux", type: "read-only" },
        { id: 3, name: "x64", type: "read-only" },
        { id: 4, name: "cpu", type: "custom" },
        { id: 5, name: "pytorch", type: "custom" },
      ],
    },
    {
      id: 7,
      name: "pytorch-rocm-1",
      os: "linux",
      status: "online",
      busy: false,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 2, name: "linux", type: "read-only" },
        { id: 3, name: "x64", type: "read-only" },
        { id: 12, name: "rocm", type: "custom" },
        { id: 5, name: "pytorch", type: "custom" },
      ],
    },
    {
      id: 8,
      name: "executorch-android-1",
      os: "linux",
      status: "online",
      busy: true,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 2, name: "linux", type: "read-only" },
        { id: 3, name: "x64", type: "read-only" },
        { id: 13, name: "android", type: "custom" },
        { id: 14, name: "executorch", type: "custom" },
      ],
    },
  ],
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RunnersApiResponse | { error: string }>
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Simulate a slight delay like a real API call
  await new Promise(resolve => setTimeout(resolve, 500));

  return res.status(200).json(mockRunners);
}