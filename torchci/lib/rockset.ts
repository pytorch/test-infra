import rockset, { MainApi } from "@rockset/client";

// Type for Rockset query lambda parameters.
export interface RocksetParam {
  name: string;
  // This is not complete, but we only really have string/int params atm.
  type: "string" | "int";
  value: any;
}

export default function getRocksetClient(): MainApi {
  if (typeof process.env.ROCKSET_API_KEY === "undefined") {
    throw "ROCKSET_API_KEY is not defined, add it to your .env.local file";
  }
  return rockset(process.env.ROCKSET_API_KEY);
}
