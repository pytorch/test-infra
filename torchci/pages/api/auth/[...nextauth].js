import NextAuth from "next-auth";
import GithubProvider from "next-auth/providers/github";

export default (req, res) =>
  NextAuth(req, res, {
    providers: [
      GithubProvider({
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        authorization: { params: { scope: "repo" } },
      }),
    ],
    debug: process.env.NODE_ENV === "development",
    secret: process.env.AUTH_SECRET,
    jwt: {
      secret: process.env.JWT_SECRET,
    },
    theme: {
      colorScheme: "light",
    },
    callbacks: {
      async session({ session, token, user }) {
        session.user.id = token.id;
        session.accessToken = token.accessToken;
        session.userData = user;
        return session;
      },
      async jwt({ token, user, account, profile, isNewUser }) {
        if (user) {
          token.id = user.id;
        }
        if (account) {
          token.accessToken = account.access_token;
        }
        return token;
      },
    },
  });
