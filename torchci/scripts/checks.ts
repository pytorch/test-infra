import dotenv from "dotenv";
import { RowData } from "lib/types";
import path from "path";
import fetchHud from "../lib/fetchHud";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

console.log("FETCH HUD IS", fetchHud);
fetchHud({
  repoName: "pytorch",
  repoOwner: "pytorch",
  page: 1,
  per_page: 50,
  branch: "master",
}).then((data: { shaGrid: RowData[]; jobNames: string[] }) => {

  
  console.log(data);
});

export {};
