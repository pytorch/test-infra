import rockset, { MainApi } from "@rockset/client";

export default function getRocksetClient(): MainApi {
  if (typeof process.env.ROCKSET_API_KEY === "undefined") {
    throw "ROCKSET_API_KEY is not defined, add it to your .env.local file";
  }
  return rockset(process.env.ROCKSET_API_KEY);
}
