import React, { useState } from "react";
import useCopyClipboard from "react-use-clipboard";

export default function CopyLink({ textToCopy }: { textToCopy: string }) {
  const [isCopied, setCopied] = useCopyClipboard(textToCopy);
  const [showCopied, setShowCopied] = useState(false);
  const onClick = () => {
    setCopied();
    setShowCopied(true);

    setTimeout(() => {
      setShowCopied(false);
    }, 3000);
  };
  return (
    <button
      style={{ fontSize: "smaller", background: "none", border: "none" }}
      title={isCopied ? "Copied" : "Copy Link"}
      onClick={onClick}
    >
      {showCopied ? "✔️" : "📋"}
    </button>
  );
}
