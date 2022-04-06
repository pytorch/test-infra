import React from "react";
import useCopyClipboard from "react-use-clipboard";

export default function CopyLink({ textToCopy }: { textToCopy: string }) {
  const [isCopied, setCopied] = useCopyClipboard(textToCopy);
  return (
    <button
      style={{ background: "none", border: "none" }}
      title={isCopied ? "Copied" : "Copy Link"}
      onClick={setCopied}
    >
      {isCopied ? "✔️" : "🔗"}
    </button>
  );
}
