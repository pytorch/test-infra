import { publicRead } from "lib/api/public";
import { releaseBoardHandler } from "lib/api/releases/handler";

export const GET = publicRead(releaseBoardHandler);
export const dynamic = "force-dynamic";
