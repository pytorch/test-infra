import NextAuth from "next-auth";
import GithubProvider from "next-auth/providers/github";
import CredentialsProvider from "next-auth/providers/credentials";

const isPreview = process.env.VERCEL_ENV === "preview";

export const authOptions = {
  providers: [
    // 🔹 Preview credential login only
    ...(isPreview
      ? [
          CredentialsProvider({
            name: "Preview Login",
            credentials: {
              username: { label: "Username", type: "text" },
              password: { label: "Password", type: "password" },
            },
            async authorize(credentials) {
              if (!credentials) return null;

              if (
                credentials.username === process.env.PREVIEW_USER &&
                credentials.password === process.env.PREVIEW_PASS
              ) {
                return {
                  id: "preview-user",
                  name: "Preview User",
                  email: "preview@demo.com",

                  // 👇 create a fake accessToken for CredentialsProvider
                  previewAccessToken: crypto.randomUUID(),
                };
              }

              return null;
            },
          }),
        ]
      : []),

    // 🔹 GitHub OAuth (always enabled)
    GithubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      authorization: { params: { scope: "public_repo workflow" } },
    }),
  ],

  debug: process.env.NODE_ENV === "development",

  secret: process.env.AUTH_SECRET,
  jwt: {
    secret: process.env.JWT_SECRET,
  },

  theme: {
    colorScheme: "light",
    logo: "/favicon.ico",
  },

  callbacks: {
    // @ts-ignore
    async jwt({ token, user, account }) {
      // If GitHub OAuth returns a token
      if (account && account.access_token) {
        token.accessToken = account.access_token;
      }

      // CredentialsProvider login
      if (user && user.previewAccessToken) {
        token.accessToken = user.previewAccessToken;
      }

      if (user && user.id) {
        token.id = user.id;
      }

      return token;
    },
    // @ts-ignore
    async session({ session, token, user }) {
      session.user.id = token.id;
      session.accessToken = token.accessToken;
      session.userData = user;
      return session;
    },
  },
};
// @ts-ignore
export default function handler(req, res) {
  // @ts-ignore
  return NextAuth(req, res, authOptions);
}
