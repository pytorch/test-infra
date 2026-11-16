import { publicRead } from "lib/api/public";
import { releaseMilestoneItemsHandler } from "lib/api/releases/handler";

export const GET = publicRead(releaseMilestoneItemsHandler);
export const dynamic = "force-dynamic";
