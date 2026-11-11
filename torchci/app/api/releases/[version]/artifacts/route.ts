import { publicRead } from "lib/api/public";
import { releaseArtifactsHandler } from "lib/api/releases/handler";

export const GET = publicRead(releaseArtifactsHandler);
export const dynamic = "force-dynamic";
