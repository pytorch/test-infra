// Mapping of EC2 (Meta) runner labels to their ARC (OSDC) equivalents.
//
// Source of truth: pytorch/pytorch/.github/arc.yaml. Keep in sync manually.
// Used by `getNameWithoutOSDC` (in `JobClassifierUtil`) to condense HUD
// columns across the EC2 and OSDC variants of the same job, mirroring the
// rewrite that `map_ec2_to_arc.py` performs when producing the ARC test
// matrix.
//
// Entries where the value equals the key are passthrough runners
// (e.g. ROCm/XPU partner hardware) that are not OSDC-managed — they are
// omitted here because they require no rewrite.
export const EC2_TO_ARC_RUNNER_MAPPING: Readonly<Record<string, string>> = {
  // x86 CPU — Intel AVX-512 (c5, c7i families)
  "linux.large": "l-x86iavx512-2-4",
  "linux.2xlarge": "l-x86iavx512-8-64",
  "linux.c7i.2xlarge": "l-x86iavx512-8-64",
  "linux.4xlarge": "l-x86iavx512-16-128",
  "linux.c7i.4xlarge": "l-x86iavx512-16-128",
  "linux.12xlarge": "l-x86iavx512-48-384",
  "linux.c7i.12xlarge": "l-x86iavx512-48-384",
  "linux.24xl.spr-metal": "l-bx86iamx-92-167",

  // x86 CPU — Intel AMX (m7i-flex family)
  "linux.2xlarge.amx": "l-x86iamx-8-64",
  "linux.8xlarge.amx": "l-x86iamx-32-128",

  // x86 CPU — Intel AVX2 (m4 family)
  "linux.2xlarge.avx2": "l-x86iavx2-8-32",
  "linux.10xlarge.avx2": "l-x86iavx2-40-160",

  // x86 CPU — Memory-optimized (r5, r7i families)
  "linux.r7i.2xlarge": "l-x86iavx512-8-64",
  "linux.r7i.4xlarge": "l-x86iavx512-16-128",
  "linux.4xlarge.memory": "l-x86iavx512-16-128",
  "linux.8xlarge.memory": "l-x86iavx512-32-256",
  "linux.12xlarge.memory": "l-x86iavx512-48-384",
  "linux.24xlarge.memory": "l-x86iavx512-94-768",

  // x86 CPU — AMD (m6a, m7a families)
  "linux.24xlarge.amd": "l-x86aavx512-125-463",

  // x86 GPU — T4 (g4dn family)
  "linux.g4dn.4xlarge.nvidia.gpu": "l-x86iavx512-29-115-t4",
  "linux.g4dn.12xlarge.nvidia.gpu": "l-x86iavx512-45-172-t4-4",
  "linux.g4dn.metal.nvidia.gpu": "l-bx86iavx512-94-344-t4-8",

  // x86 GPU — A10G (g5 family)
  "linux.g5.4xlarge.nvidia.gpu": "l-x86aavx2-29-113-a10g",
  "linux.g5.12xlarge.nvidia.gpu": "l-x86aavx2-45-167-a10g-4",
  "linux.g5.48xlarge.nvidia.gpu": "l-x86aavx2-189-704-a10g-8",

  // x86 GPU — L4 (g6 family)
  "linux.g6.4xlarge.experimental.nvidia.gpu": "l-x86aavx2-29-113-l4",
  "linux.g6.12xlarge.nvidia.gpu": "l-x86aavx2-45-172-l4-4",

  // ARM64 — Graviton
  "linux.arm64.2xlarge": "l-arm64g2-6-32",
  "linux.arm64.2xlarge.ephemeral": "l-arm64g2-6-32",
  "linux.arm64.m7g.4xlarge": "l-arm64g3-16-62",
  "linux.arm64.m8g.4xlarge": "l-arm64g4-16-62",
  "linux.arm64.r7g.12xlarge.memory": "l-arm64g3-61-463",
  "linux.arm64.m7g.metal": "l-barm64g4-62-226",

  // x86 GPU — B200 (p6 family)
  "linux.dgx.b200": "l-x86iamx-22-225-b200",
};
