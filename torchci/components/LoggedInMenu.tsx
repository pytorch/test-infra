import { signOut, useSession } from "next-auth/react";
import styles from "./LoginSection.module.css";

export default function LoggedInMenu() {
  const { data: session, status } = useSession();

  return (
    <div className={styles.dropdown}>
      <div className={styles.dropdownContent}>
        <a href="#">Signed in as {session?.user?.email}</a>
        <a
          href={`/api/auth/signout`}
          className={styles.button}
          onClick={(e) => {
            e.preventDefault();
            signOut();
          }}
        >
          Sign out
        </a>{" "}
      </div>
    </div>
  );
}
