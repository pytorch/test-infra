import NextAuth from "next-auth";
import GithubProvider from "next-auth/providers/github";

const isPreview = process.env.VERCEL_ENV === "preview";
export const authOptions = {
  providers: [
    // 🔹 Preview-only username/password login
    ...(isPreview
      ? [
          CredentialsProvider({
            name: "Preview Login",
            credentials: {
              username: { label: "Username", type: "text" },
              password: { label: "Password", type: "password" }
            },
            async authorize(credentials) {
              // prevent mistakes
              if (!credentials) return null;

              if (
                credentials.username === process.env.PREVIEW_USER &&
                credentials.password === process.env.PREVIEW_PASS
              ) {
                return {
                  id: "preview-user",
                  name: "Preview User",
                  email: "preview@demo.com",
                };
              }
              return null;
            }
          })
        ]
      : []),

    // 🔹 Always allow GitHub OAuth
    GithubProvider({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      authorization: { params: { scope: "public_repo workflow" } },
    }),
  ],
  debug: process.env.NODE_ENV === "development",
  secret: process.env.AUTH_SECRET,
  jwt: { secret: process.env.JWT_SECRET },
  theme: {
    colorScheme: "light",
    logo: "/favicon.ico",
  },
  callbacks: {
    async session({ session, token, user }) {
      // extend session fields
      session.user.id = token.id;
      session.accessToken = token.accessToken;
      session.userData = user;
      return session;
    },
    async jwt({ token, user, account }) {
      if (user) token.id = user.id;
      if (account) token.accessToken = account.access_token;
      return token;
    },
  },
};

export default (req, res) => NextAuth(req, res, authOptions);
