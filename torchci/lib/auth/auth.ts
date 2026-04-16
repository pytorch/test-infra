import { getServerSession } from "next-auth";
import { authOptions } from "pages/api/auth/[...nextauth]";

const API_TOKEN_HEADER = "x-hud-internal-bot";

export async function checkAuthWithApiToken(req: any, res: any) {
  // Check Custom Header
  const headerToken = req.headers[API_TOKEN_HEADER];
  if (headerToken && headerToken == process.env.INTERNAL_API_TOKEN) {
    return { ok: true, type: "header" };
  }

  // if no headertoken provided, falls back to NextAuth Session.
  // @ts-ignore
  const session = await getServerSession(req, res, authOptions);
  if (session?.user && session?.accessToken) {
    return { ok: true, type: "session" };
  }

  // 3. Not authenticated
  return { ok: false };
}

export async function checkAuthWithLogin(req: any, res: any) {
  // NextAuth Session
  // @ts-ignore
  const session = await getServerSession(req, res, authOptions);
  if (session?.user && session?.accessToken) {
    return { ok: true, type: "session" };
  }
  // 3. Not authenticated
  return { ok: false };
}
