import { publicRead } from "lib/api/public";
import { releaseIndexHandler } from "lib/api/releases/handler";

export const GET = publicRead(releaseIndexHandler);
export const dynamic = "force-dynamic";
