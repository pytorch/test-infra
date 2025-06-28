import { Button,  Menu } from "@mui/material";
import React from "react";
import Link from "next/link";
const SmallButton = (props: any) => {
  // Make button as small as possible
  return <Button {...props} style={{ minWidth: 0, textTransform: "none" ,font: "inherit"}} />;
};
/**
 *
 * @param children Must be a list of MenuItem components
 * @returns
 */
export const HoverDropDownMenu = ({
  title,
  href,
  children,
}: {
  title: React.ReactNode;
  href?: string; // Optional, if provided, will be used as the button's link
  children: React.ReactNode;
}): JSX.Element => {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);
  const onMouseEnter = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };
  const onMouseLeave = () => {
    setAnchorEl(null);
  };

  return (
    <>
      <SmallButton
        sx={{ zIndex: (theme: any) => theme.zIndex.modal + 1 }}
        onClick={onMouseEnter}
        onMouseOver={onMouseEnter}
        onMouseLeave={onMouseLeave}
        color="inherit"
      >
        {href ? (
          <Link href={href ?? "#"} prefetch={false}>
            {title}
          </Link>
        ) : (
          title
        )}
      </SmallButton>
      <Menu
        id="basic-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={onMouseLeave}
        autoFocus={false}
        MenuListProps={{
          onMouseLeave: onMouseLeave,
          onMouseEnter: () => setAnchorEl(anchorEl),
        }}
      >
        {children}
      </Menu>
    </>
  );
};
