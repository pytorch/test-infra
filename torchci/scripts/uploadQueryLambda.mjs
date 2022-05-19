import rockset from "@rockset/client";
import { promises as fs } from "fs";
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const client = rockset.default(process.env.ROCKSET_API_KEY);

async function readJSON(path) {
    const rawData = await fs.readFile(path);
    return JSON.parse(rawData);
}
const prodVersions = await readJSON("rockset/prodVersions.json");
const prodVersionsNew = await readJSON("rockset/prodVersions.json");

async function upload(workspace, queryName) {
    const config = await readJSON(
        `./rockset/${workspace}/${queryName}.lambda.json`
    );
    const query = await fs.readFile(
        `./rockset/${workspace}/__sql/${queryName}.sql`,
        "utf8"
    );

    const res = await client.queryLambdas.updateQueryLambda(workspace, queryName, {
        description: config.description,
        sql: {
            query,
            default_parameters: config.default_parameters,
        },
    })

    const newVersion = res.data.version;
    prodVersionsNew[workspace][queryName] = newVersion;

    console.log(`Updated ${workspace}.${queryName} to version ${newVersion}`);
}

const tasks = [];
Object.keys(prodVersions).forEach((workspace) => {
    Object.entries(prodVersions[workspace]).forEach(([queryName, _]) =>
        tasks.push(upload(workspace, queryName))
    );
});
await Promise.all(tasks);

await fs.writeFile(
    "rockset/prodVersions.json",
    JSON.stringify(prodVersionsNew, null, 2),
    "utf8"
);
