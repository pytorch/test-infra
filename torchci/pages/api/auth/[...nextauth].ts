import { createHash, timingSafeEqual } from "crypto";
import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GithubProvider from "next-auth/providers/github";

const isPreview = process.env.VERCEL_ENV === "preview";

// Whether what was submitted is the configured value, compared in constant
// time through digests so the comparison's timing says nothing about how
// much of it matched. An unset or empty configured value matches nothing:
// a preview without a password has no preview login.
export function sameSecret(
  submitted: unknown,
  configured: string | undefined
): boolean {
  if (typeof submitted !== "string" || !configured) return false;
  const digestOf = (value: string) =>
    new Uint8Array(createHash("sha256").update(value).digest());
  return timingSafeEqual(digestOf(submitted), digestOf(configured));
}

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
                sameSecret(credentials.username, process.env.PREVIEW_USER) &&
                sameSecret(credentials.password, process.env.PREVIEW_PASS)
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
      // GitHub now returns an `iss` param on the OAuth callback (RFC 9207), and
      // openid-client rejects it unless the issuer is configured here.
      issuer: "https://github.com/login/oauth",
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

      // CredentialsProvider login. The mark tells the API gate (lib/api/auth.ts)
      // that this session has no GitHub token to check: on a preview
      // deployment it passes as it is.
      if (user && user.previewAccessToken) {
        token.accessToken = user.previewAccessToken;
        token.previewLogin = true;
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
      session.previewLogin = token.previewLogin === true;
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
