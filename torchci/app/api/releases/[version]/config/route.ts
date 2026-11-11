import { publicRead } from "lib/api/public";
import { releaseConfigHandler } from "lib/api/releases/handler";

export const GET = publicRead(releaseConfigHandler);
export const dynamic = "force-dynamic";
