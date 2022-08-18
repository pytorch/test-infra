import React, { useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import styles from "./LoginSection.module.css";
import LoggedInMenu from "./LoggedInMenu";

export default function LoginSection() {
  const { data: session, status } = useSession();
  const loading = status === "loading";
  const [showLoginSection, setShowLoginSection] = useState(false);

  return (
    <>
      <span
        className={`nojs-show ${
          !session && loading ? styles.loading : styles.loaded
        }`}
      >
        <span className={`nojs-show`}>
          {!session && (
            <>
              <a
                href={`/api/auth/signin`}
                className={styles.buttonPrimary}
                onClick={(e) => {
                  e.preventDefault();
                  signIn();
                }}
              >
                Sign in
              </a>
            </>
          )}
          {session?.user && (
            <span>
              {session.user.image && (
                <img
                  onClick={() => {
                    console.log("HELLO");
                    setShowLoginSection(!showLoginSection);
                  }}
                  style={{
                    backgroundImage: `url('${session.user.image}')`,
                    display: "inline",
                    cursor: "pointer",
                  }}
                  className={styles.avatar}
                />
              )}
              {showLoginSection && <LoggedInMenu />}
            </span>
          )}
        </span>
      </span>
    </>
  );
}
