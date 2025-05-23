import { Button, Menu } from "@mui/material";
import React from "react";

const SmallButton = (props: any) => {
  // Make button as small as possible
  return <Button {...props} style={{ minWidth: 0, textTransform: "none" }} />;
};
/**
 *
 * @param children Must be a list of MenuItem components
 * @returns
 */
export const HoverDropDownMenu = ({
  title,
  children,
}: {
  title: React.ReactNode;
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
        {title}
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
