import type { ButtonProps } from "@mui/material/Button";
import Button from "@mui/material/Button";
import { styled } from "@mui/material/styles";
import * as React from "react";

/** Anchor-style MUI Button with proper typing for href/target/rel. */
export interface BenchmarkLinkButtonProps
  extends Omit<ButtonProps<"a">, "component"> {
  href: string;
  /** Default: "_self". Use "_blank" for new tab. */
  target?: "_self" | "_blank" | "_parent" | "_top";
  /** Default: added automatically for _blank */
  rel?: string;
}

export const LinkButton = React.forwardRef<
  HTMLAnchorElement,
  BenchmarkLinkButtonProps
>(({ href, target = "_self", rel, ...props }, ref) => {
  // Security for new-tab links
  const finalRel = target === "_blank" ? rel ?? "noopener noreferrer" : rel;
  return (
    <Button
      ref={ref}
      component="a"
      href={href}
      target={target}
      rel={finalRel}
      {...props}
    />
  );
});
LinkButton.displayName = "LinkButton";

export const BenchmarkLinkButton = styled(LinkButton)(({ theme }) => ({
  px: 0.5,
  py: 0,
  mx: 1,
  minWidth: "auto",
  lineHeight: 2,
  fontSize: "0.75rem",
  textTransform: "none",
}));
