---
name: r2-outage-toggle
description: Disable or re-enable Cloudflare R2 (download-r2.pytorch.org) usage in manage_v2.py during R2 outages. Can toggle R2 off/on for nightly builds, prod/stable builds, or both. The affected packages are PT_FOUNDATION_PACKAGES (torch, torchvision, torchaudio, fbgemm_gpu, fbgemm_gpu_genai, triton, pytorch_triton, pytorch_triton_rocm, pytorch_triton_xpu).
---

# R2 Outage Toggle

Modifies `s3_management/manage_v2.py` to disable or re-enable Cloudflare R2 (`download-r2.pytorch.org`) URL generation for PyTorch foundation packages. Use during R2 outages to fall back to S3/CloudFront, or to restore R2 usage after an outage is resolved.

## When to use this skill

Use when the user asks to:
- Disable R2 / turn off R2 / stop using download-r2.pytorch.org
- Re-enable R2 / turn on R2 / restore R2 usage
- Handle an R2 outage or Cloudflare outage
- Switch nightly or prod packages away from R2
- Fall back to S3/CloudFront for foundation packages

## Target file

`s3_management/manage_v2.py` (relative to repo root)

## Key data structures

There are two sets that control which packages use R2 URLs:

| Set | Purpose | Location |
|-----|---------|----------|
| `PT_R2_PACKAGES` | Packages using R2 for **nightly** builds (`whl/nightly`) | ~line 437 |
| `PT_R2_PACKAGES_PROD` | Packages using R2 for **prod/stable** builds (not test, not nightly) | ~line 452 |

Both sets contain members of `PT_FOUNDATION_PACKAGES`. The URL routing logic is in the `to_simple_package_html` method (~line 799-824).

## Instructions

### Step 1: Determine the action and scope

Ask the user (if not already clear) two things:

1. **Action**: disable R2 or re-enable R2?
2. **Scope**: nightly only, prod only, or both?

### Step 2: Read the current state

Read `s3_management/manage_v2.py` and check the current contents of `PT_R2_PACKAGES` and `PT_R2_PACKAGES_PROD`. They may already be empty (disabled) or populated (enabled).

### Step 3a: To DISABLE R2

To disable R2, empty the relevant set(s) while preserving a comment showing the original contents. This ensures easy re-enablement.

**Disable R2 for nightly** — Replace the `PT_R2_PACKAGES` set with an empty set:

```python
# Packages that should use R2 (download-r2.pytorch.org) for nightly builds
# These packages will have their URLs point to R2 instead of S3/CloudFront
# when the path is whl/nightly
# R2 DISABLED - original packages commented out during R2 outage:
# "torch", "torchvision", "torchaudio", "fbgemm_gpu", "fbgemm_gpu_genai",
# "triton", "pytorch_triton", "pytorch_triton_rocm", "pytorch_triton_xpu"
PT_R2_PACKAGES: set[str] = set()
```

**Disable R2 for prod** — Replace the `PT_R2_PACKAGES_PROD` set with an empty set:

```python
# Packages that should use R2 (download-r2.pytorch.org) for prod/stable builds
# These packages will have their URLs point to R2 instead of S3/CloudFront
# when the path is NOT whl/test and NOT whl/nightly (i.e., prod)
# R2 DISABLED - original packages commented out during R2 outage:
# "torchaudio", "fbgemm_gpu", "fbgemm_gpu_genai"
PT_R2_PACKAGES_PROD: set[str] = set()
```

### Step 3b: To RE-ENABLE R2

Restore the original set contents and remove the outage comments.

**Re-enable R2 for nightly** — Restore `PT_R2_PACKAGES`:

```python
# Packages that should use R2 (download-r2.pytorch.org) for nightly builds
# These packages will have their URLs point to R2 instead of S3/CloudFront
# when the path is whl/nightly
PT_R2_PACKAGES = {
    "torch",
    "torchvision",
    "torchaudio",
    "fbgemm_gpu",
    "fbgemm_gpu_genai",
    "triton",
    "pytorch_triton",
    "pytorch_triton_rocm",
    "pytorch_triton_xpu",
}
```

**Re-enable R2 for prod** — Restore `PT_R2_PACKAGES_PROD`:

```python
# Packages that should use R2 (download-r2.pytorch.org) for prod/stable builds
# These packages will have their URLs point to R2 instead of S3/CloudFront
# when the path is NOT whl/test and NOT whl/nightly (i.e., prod)
PT_R2_PACKAGES_PROD = {
    "torchaudio",
    "fbgemm_gpu",
    "fbgemm_gpu_genai",
}
```

### Step 4: Verify the change

After editing, read back the modified sections to confirm correctness. Also verify that:
- The `to_simple_package_html` method logic (~line 799-824) was NOT modified — it naturally handles empty sets correctly (no packages will match, so R2 URLs won't be generated).
- No other references to `PT_R2_PACKAGES` or `PT_R2_PACKAGES_PROD` were affected.

### Step 5: Remind about deployment

After making the change, remind the user:

> **Important**: This change only modifies the source file. To take effect, you need to:
> 1. Commit and land this change
> 2. Re-run the index generation: `python s3_management/manage_v2.py all`
>    (or target specific prefixes like `whl/nightly` or `whl` depending on scope)
>
> The index HTML files will be regenerated with S3/CloudFront URLs (relative URLs for foundation packages) instead of `download-r2.pytorch.org` URLs.

## How it works

The URL routing in `to_simple_package_html` checks package membership in these sets:

```python
if package_name.lower() in PT_R2_PACKAGES and resolved_subdir.startswith("whl/nightly"):
    base_url = "https://download-r2.pytorch.org"
elif package_name.lower() in PT_R2_PACKAGES_PROD and not test and not nightly:
    base_url = "https://download-r2.pytorch.org"
elif use_cloudfront_for_non_foundation and package not in PT_FOUNDATION_PACKAGES:
    base_url = "https://d21usjoq99fcb9.cloudfront.net"
else:
    base_url = ""  # relative URL (served from S3)
```

When the sets are empty, no package matches the R2 conditions, so foundation packages fall through to `base_url = ""` (relative URLs served from S3). This is the safe fallback during an R2 outage.

## Example usage

**Disable R2 for everything during an outage:**
```
R2 is down, disable R2 for both nightly and prod
```

**Disable R2 for nightly only:**
```
Turn off R2 for nightly builds
```

**Re-enable after outage is resolved:**
```
R2 outage is over, re-enable R2 for nightly and prod
```
