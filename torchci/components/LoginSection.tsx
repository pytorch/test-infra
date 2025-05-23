import QuestionMarkIcon from "@mui/icons-material/QuestionMark";
import SyncIcon from "@mui/icons-material/Sync";
import { Button as _Button, MenuItem } from "@mui/material";
import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { HoverDropDownMenu } from "./common/HoverDropDownMenu";
import styles from "./LoginSection.module.css";

const Button = (props: any) => {
  // Make button as small as possible
  return <_Button {...props} style={{ minWidth: 0 }} />;
};

export default function LoginSection() {
  const { data: session, status } = useSession();

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
          <HoverDropDownMenu
            title={
              session.user?.image ? (
                <img
                  style={{
                    backgroundImage: `url('${session.user.image}')`,
                  }}
                  className={styles.avatar}
                />
              ) : (
                // Hopefully shouldn't get here
                <QuestionMarkIcon fontSize="inherit" />
              )
            }
          >
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
          </HoverDropDownMenu>
        </>
      )}
    </>
  );
}
