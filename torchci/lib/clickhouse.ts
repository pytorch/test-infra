export default async function queryClickHouse(queryVariables: {
  [k: string]: string;
}) {
  if (
    typeof process.env.CLICKHOUSE_ENDPOINT === "undefined" ||
    typeof process.env.CLICKHOUSE_API_KEY_ID === "undefined" ||
    typeof process.env.CLICKHOUSE_API_KEY_SECRET === "undefined"
  ) {
    throw "CLICKHOUSE_ENDPOINT or CLICKHOUSE_API_KEY_ID or CLICKHOUSE_API_KEY_SECRET is not defined, add it to your .env.local file";
  }

  const credential = `${process.env.CLICKHOUSE_API_KEY_ID}:${process.env.CLICKHOUSE_API_KEY_SECRET}`;
  const response = await fetch(process.env.CLICKHOUSE_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(credential).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      queryVariables: queryVariables,
      format: "JSONEachRow",
    }),
  });

  if (!response.ok) {
    return [];
  }

  const records = await response.json();
  if (!records || !records.data) {
    return [];
  }
  // Map the column to their values on each row
  const columns = records.data.columns;
  return records.data.rows.map((r: any) => {
    const record: { [k: string]: any } = {};
    r.forEach((v: any, i: number) => (record[columns[i].name] = v));
    return record;
  });
}
