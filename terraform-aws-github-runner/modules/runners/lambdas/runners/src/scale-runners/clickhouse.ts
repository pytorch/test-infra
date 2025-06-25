import { createClient, ClickHouseClient, ClickHouseClientConfigOptions } from '@clickhouse/client';
import { Config } from './config';

export class CHFactory {
  static #instance: CHFactory;
  private client: ClickHouseClient | null = null;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  public static get instance(): CHFactory {
    if (!CHFactory.#instance) {
      CHFactory.#instance = new CHFactory();
    }

    return CHFactory.#instance;
  }

  public getClient(): ClickHouseClient {
    if (!this.client) {
      const config = Config.Instance;

      const host = config.clickhouseHost;
      const port = config.clickhousePort;
      const database = config.clickhouseDatabase;
      const username = config.clickhouseUsername;
      const password = config.clickhousePassword;

      const options: ClickHouseClientConfigOptions = {
        host: `https://${host}:${port}`,
        database,
        username,
        password,
        compression: {
          request: true,
          response: true,
        },
        clickhouse_settings: {
          wait_end_of_query: 1,
        },
        max_open_connections: 10,
      };

      this.client = createClient(options);
    }

    return this.client;
  }

  public async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  public static reset(): void {
    if (CHFactory.#instance && CHFactory.#instance.client) {
      CHFactory.#instance.client.close().catch(console.error);
    }
    CHFactory.#instance = undefined as unknown as CHFactory;
  }
}
