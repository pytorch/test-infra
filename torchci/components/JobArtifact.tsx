import { Artifact } from "lib/types";
import React from "react";

export default function JobArtifact({
  name,
  kind,
  expired,
  sizeInBytes,
  url,
}: Artifact) {
  if (expired) {
    return (
      <div>
        <span>
          [{kind}] {name}
        </span>{" "}
        <span>({formatBytes(sizeInBytes)}) (expired)</span>
      </div>
    );
  } else {
    return (
      <div>
        <a href={url}>
          [{kind}] {name}
        </a>{" "}
        <span>({formatBytes(sizeInBytes)})</span>
      </div>
    );
  }
}

// see https://github.com/qoomon/aws-s3-bucket-browser/blob/937147179a9284dc8d98e7a6d52f60e8fdcd7231/index.html#L430
function formatBytes(size: number) {
  if (!size) {
    return "-";
  }
  const KB = 1024;
  if (size < KB) {
    return size + "  B";
  }
  const MB = 1000000;
  if (size < MB) {
    return (size / KB).toFixed(0) + " KB";
  }
  const GB = 1000000000;
  if (size < GB) {
    return (size / MB).toFixed(2) + " MB";
  }
  return (size / GB).toFixed(2) + " GB";
}
