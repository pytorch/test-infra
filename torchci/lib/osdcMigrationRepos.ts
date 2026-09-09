export const PYTORCH_MIGRATION_REPOS: readonly string[] = [
  "pytorch/executorch",
  "pytorch/helion",
  "pytorch/FBGEMM",
  "pytorch/vision",
  "pytorch/torchtitan",
  "pytorch/ao",
];

export const META_PYTORCH_MIGRATION_REPOS: readonly string[] = [
  "meta-pytorch/monarch",
  "meta-pytorch/torchcodec",
  "meta-pytorch/torchcomms",
];

// Reference only: reaches OSDC through runtime label translation (.github/arc.yaml
// + map_ec2_to_arc.py) rather than runs-on edits, and is not finished --
// docker-release.yml still puts legacy jobs on nightly/release tags.
export const OSDC_REFERENCE_REPOS: readonly string[] = ["pytorch/pytorch"];

export const OSDC_TRACKED_REPOS: readonly string[] = [
  ...PYTORCH_MIGRATION_REPOS,
  ...META_PYTORCH_MIGRATION_REPOS,
  ...OSDC_REFERENCE_REPOS,
];
