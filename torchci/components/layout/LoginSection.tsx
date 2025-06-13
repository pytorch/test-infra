import QuestionMarkIcon from "@mui/icons-material/QuestionMark";
import SyncIcon from "@mui/icons-material/Sync";
import { Button as _Button, Menu, MenuItem } from "@mui/material";
import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";
import React from "react";
import styles from "./LoginSection.module.css";

const Button = (props: any) => {
  // Make button as small as possible
  return <_Button {...props} style={{ minWidth: 0 }} />;
};

export default function LoginSection() {
  const { data: session, status } = useSession();
  const [anchorEl, setAnchorEl] = React.useState(null);
  const onClick = (event: any) => {
    setAnchorEl(event.currentTarget);
  };
  const onClose = () => {
    setAnchorEl(null);
  };

  return (
    <>
      {status == "loading" && (
        // Shows up very briefly while api responds
        <Button disabled>
          <SyncIcon fontSize="inherit" />
        </Button>
      )}
      {status != "loading" && !session?.user && (
        <Link
          href={`/api/auth/signin`}
          onClick={(e) => {
            e.preventDefault();
            signIn();
          }}
        >
          <Button variant="contained">Sign in</Button>
        </Link>
      )}
      {session && (
        <>
          <Button onClick={onClick}>
            {session.user?.image ? (
              <img
                style={{
                  backgroundImage: `url('${session.user.image}')`,
                }}
                className={styles.avatar}
              />
            ) : (
              // Hopefully shouldn't get here
              <QuestionMarkIcon fontSize="inherit" />
            )}
          </Button>
          <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={onClose}>
            {session.user?.name && (
              <MenuItem>Signed in as {session.user.name}</MenuItem>
            )}
            <Link
              href={`/api/auth/signout`}
              onClick={(e) => {
                e.preventDefault();
                signOut();
              }}
            >
              <MenuItem>Sign out</MenuItem>
            </Link>
          </Menu>
        </>
      )}
    </>
  );
}
