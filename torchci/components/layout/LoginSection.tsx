import QuestionMarkIcon from "@mui/icons-material/QuestionMark";
import SyncIcon from "@mui/icons-material/Sync";
import { Button as _Button, Link } from "@mui/material";
import { Box } from "@mui/system";
import { signIn, signOut, useSession } from "next-auth/react";
import styles from "./LoginSection.module.css";
import { NavBarGroupDropdown, NavItem } from "./NavBarGroupDropdown";

const Button = (props: any) => {
  // Make button as small as possible
  return <_Button {...props} style={{ minWidth: 0 }} />;
};

export default function LoginSection() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <Button disabled>
        <SyncIcon fontSize="inherit" />
      </Button>
    );
  }

  // If not signed in, just show a sign in button (no dropdown)
  if (!session?.user) {
    return (
      <Link
        href={`/api/auth/signin`}
        onClick={(e) => {
          e.preventDefault();
          signIn();
        }}
      >
        <Button variant="contained">Sign in</Button>
      </Link>
    );
  }

  // If signed in, show dropdown with user info
  const items: NavItem[] = [
    {
      label: (
        <Box
          component="span"
          sx={{ color: "text.secondary" }}
          onClick={(e) => e.preventDefault()}
        >
          Signed in as {session.user.name}
        </Box>
      ),
      type: "item",
      route: "#",
    },
    {
      type: "item",
      route: "/api/auth/signout",
      label: (
        <Box
          component="span"
          onClick={(e) => {
            e.preventDefault();
            signOut();
          }}
          style={{
            textDecoration: "none",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Sign out
        </Box>
      ),
    },
  ];

  const title = session?.user?.image ? (
    <img
      style={{
        backgroundImage: `url('${session.user.image}')`,
      }}
      className={styles.avatar}
    />
  ) : (
    // Hopefully shouldn't get here
    <QuestionMarkIcon fontSize="inherit" />
  );

  return <NavBarGroupDropdown items={items} title={title} showCarrot={false} />;
}
