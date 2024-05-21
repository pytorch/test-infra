import { css } from "@emotion/react";
import React, { useState } from "react";
import useCopyClipboard from "react-use-clipboard";

export default function CopyLink({
  textToCopy,
  style,
  compressed = true, // Whether a small or large button should be used
}: {
  textToCopy: string;
  style?: React.CSSProperties;
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

  const copy_prompt = "Permalink";
  const copy_ack = "Copied";

  function getButtonText(baseIcon: string, elaboration: string) {
    if (compressed) {
      return baseIcon;
    } else {
      return `${baseIcon} ${elaboration}`;
    }
  }

  let css_style: React.CSSProperties = compressed ? { background: "none" } : {};
  css_style = { ...css_style, ...style };

  return (
    <button
      style={css_style}
      title={isCopied ? copy_ack : copy_prompt}
      onClick={onClick}
    >
      {showCopied
        ? getButtonText("✅", copy_ack)
        : getButtonText("🔗", copy_prompt)}
    </button>
  );
}
