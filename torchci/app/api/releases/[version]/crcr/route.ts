import { publicRead } from "lib/api/public";
import { releaseCrcrHandler } from "lib/api/releases/handler";

export const GET = publicRead(releaseCrcrHandler);
export const dynamic = "force-dynamic";
