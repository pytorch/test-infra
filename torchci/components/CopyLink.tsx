import React, { useState } from "react";
import useCopyClipboard from "react-use-clipboard";
import Emoji from "./SmallerEmoji";

export default function CopyLink({
  textToCopy,
  style,
  copyPrompt = "Permalink",
  compressed = true, // Whether a small or large button should be used
}: {
  textToCopy: string;
  style?: React.CSSProperties;
  copyPrompt?: string;
  compressed?: boolean;
}) {
  const [isCopied, setCopied] = useCopyClipboard(textToCopy);
  const [showCopied, setShowCopied] = useState(false);
  const onClick = () => {
    setCopied();
    setShowCopied(true);

    setTimeout(() => {
      setShowCopied(false);
    }, 3000);
  };

  const copyAck = "Copied";

  function getButtonText(elaboration: string) {
    if (!compressed) {
      return elaboration;
    }
  }

  let css_style: React.CSSProperties = compressed ? { background: "none" } : {};
  css_style = { ...css_style, ...style };

  return (
    <button
      style={css_style}
      title={isCopied ? copyAck : copyPrompt}
      onClick={onClick}
    >
      {showCopied ? (
        <>
          <Emoji emoji="✅" /> {getButtonText(copyAck)}
        </>
      ) : (
        <>
          <Emoji emoji="🔗" /> {getButtonText(copyPrompt)}
        </>
      )}
    </button>
  );
}
