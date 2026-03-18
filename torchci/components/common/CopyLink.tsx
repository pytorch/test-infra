import React, { useState } from "react";
import { FaCheck, FaLink, FaRegCopy } from "react-icons/fa";
import useCopyClipboard from "react-use-clipboard";

export default function CopyLink({
  textToCopy,
  style,
  copyPrompt = "Permalink",
  link = true, // Whether this is a link or not, controls the icon shown
  compressed = true, // Whether a small or large button should be used
}: {
  textToCopy: string;
  style?: React.CSSProperties;
  copyPrompt?: string;
  link?: boolean;
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
          <SmallIcon>
            <FaCheck />
          </SmallIcon>{" "}
          {getButtonText(copyAck)}
        </>
      ) : (
        <>
          <SmallIcon>{link ? <FaLink /> : <FaRegCopy />}</SmallIcon>{" "}
          {getButtonText(copyPrompt)}
        </>
      )}
    </button>
  );
}

function SmallIcon({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: "80%" }}>{children}</span>;
}
