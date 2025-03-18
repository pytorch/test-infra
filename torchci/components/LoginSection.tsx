import { Button, Menu, MenuItem } from "@mui/material";
import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";
import React from "react";
import styles from "./LoginSection.module.css";

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
      {status == "loading" && <Button disabled></Button>}
      {status != "loading" && !session && (
        <Link
          href={`/api/auth/signin`}
          onClick={(e) => {
            e.preventDefault();
            signIn();
          }}
        >
          <Button>Sign in</Button>
        </Link>
      )}
      {session && (
        <>
          <Button style={{ minWidth: "0px" }} onClick={onClick}>
            <img
              style={{
                backgroundImage: `url('${session?.user?.image}')`,
              }}
              className={styles.avatar}
            />
          </Button>
          <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={onClose}>
            <MenuItem>Signed in as {session?.user?.name}</MenuItem>
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
