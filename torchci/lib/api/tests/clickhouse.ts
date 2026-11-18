import type { ClickHouseSettings } from "@clickhouse/client";
import * as clickhouse from "lib/clickhouse";

// The test hub's client, one for the process, so that its queries reuse
// connections: a client per query opens one each time, a TCP and TLS
// handshake before the query can be sent. It allows as many queries at once
// as a page asks for, where the client's own limit of ten would queue the
// rest, and keeps an idle connection for 8 seconds, under the 10 the server
// keeps it for.
let hubClient: ReturnType<typeof clickhouse.getClickhouseClient> | undefined;

// The server can have closed a kept connection without this side hearing of
// it, as while a serverless instance is paused: the query then fails at once.
function closedConnection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ECONNRESET" || code === "EPIPE";
}

// queryClickhouse of lib/clickhouse on the hub's client. A read whose kept
// connection turns out closed is sent once more, on a client of its own.
export async function queryClickhouse(
  query: string,
  params: Record<string, unknown>,
  query_id?: string,
  useQueryCache?: boolean,
  settings?: ClickHouseSettings
): Promise<any[]> {
  hubClient ??= clickhouse.getClickhouseClient({
    max_open_connections: 100,
    keep_alive: { idle_socket_ttl: 8_000 },
  });
  try {
    return await clickhouse.queryClickhouse(
      query,
      params,
      query_id,
      useQueryCache,
      settings,
      hubClient
    );
  } catch (error) {
    if (!closedConnection(error)) throw error;
    return clickhouse.queryClickhouse(
      query,
      params,
      query_id,
      useQueryCache,
      settings
    );
  }
}
