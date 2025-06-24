import { createClient, ClickHouseClient, ClickHouseClientConfigOptions } from '@clickhouse/client';
import { Config } from './config';

export class CHFactory {
    static #instance: CHFactory;
    private client: ClickHouseClient | null = null;

    private constructor() {}

    public static get instance(): CHFactory {
        if (!CHFactory.#instance) {
            CHFactory.#instance = new CHFactory();
        }

        return CHFactory.#instance;
    }

    /**
     * Get the ClickHouse client instance. Creates a new client if one doesn't exist yet.
     * @returns ClickHouseClient instance
     */
    public getClient(): ClickHouseClient {
        if (!this.client) {
            const config = Config.Instance;

            // Get configuration from Config class
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
                    request: true, // Enable compression for request
                    response: true, // Enable compression for response
                },
                clickhouse_settings: {
                    wait_end_of_query: 1,
                },
                max_open_connections: 10, // Adjust based on your needs
            };

            this.client = createClient(options);
        }

        return this.client;
    }

    /**
     * Closes the client connection if one exists
     */
    public async close(): Promise<void> {
        if (this.client) {
            await this.client.close();
            this.client = null;
        }
    }

    /**
     * Reset the factory instance - useful for testing
     */
    public static reset(): void {
        if (CHFactory.#instance && CHFactory.#instance.client) {
            CHFactory.#instance.client.close().catch(console.error);
        }
        CHFactory.#instance = undefined as unknown as CHFactory;
    }
}
