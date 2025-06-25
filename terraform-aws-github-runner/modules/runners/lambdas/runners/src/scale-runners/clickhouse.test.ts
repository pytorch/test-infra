import { CHFactory } from './clickhouse';
import { Config } from './config';
import { createClient } from '@clickhouse/client';

// Mock the @clickhouse/client module
jest.mock('@clickhouse/client', () => {
  return {
    createClient: jest.fn(),
  };
});

const mockClickHouseClient = {
  close: jest.fn().mockResolvedValue(undefined),
  command: jest.fn(),
  exec: jest.fn(),
  insert: jest.fn(),
  query: jest.fn(),
  ping: jest.fn(),
};

// Mock Config
const mockConfig = {
  clickhouseHost: 'test-host',
  clickhousePort: '8443',
  clickhouseDatabase: 'test-db',
  clickhouseUsername: 'test-user',
  clickhousePassword: 'test-password',
};

describe('./clickhouse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    CHFactory.reset();

    // Mock createClient to return our mock client
    (createClient as jest.Mock).mockReturnValue(mockClickHouseClient);

    // Mock Config.Instance
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => mockConfig as unknown as Config);

    mockClickHouseClient.close.mockClear();
  });

  describe('CHFactory', () => {
    it('should create a singleton instance', () => {
      const instance1 = CHFactory.instance;
      const instance2 = CHFactory.instance;
      expect(instance1).toBe(instance2);
    });

    it('should create a client with correct config when getClient is called', () => {
      const instance = CHFactory.instance;
      instance.getClient();

      // Check that createClient was called with the right parameters
      expect(createClient).toHaveBeenCalledWith({
        host: `https://${mockConfig.clickhouseHost}:${mockConfig.clickhousePort}`,
        database: mockConfig.clickhouseDatabase,
        username: mockConfig.clickhouseUsername,
        password: mockConfig.clickhousePassword,
        compression: {
          request: true,
          response: true,
        },
        clickhouse_settings: {
          wait_end_of_query: 1,
        },
        max_open_connections: 10,
      });
    });

    it('should not create a new client when getClient is called multiple times', () => {
      const instance = CHFactory.instance;
      const client1 = instance.getClient();
      const client2 = instance.getClient();

      expect(createClient).toHaveBeenCalledTimes(1);
      expect(client1).toBe(client2);
    });

    it('should close the client when close is called', async () => {
      const instance = CHFactory.instance;
      instance.getClient(); // Make sure a client exists

      await instance.close();

      expect(mockClickHouseClient.close).toHaveBeenCalledTimes(1);
    });

    it('should not call close when no client exists', async () => {
      const instance = CHFactory.instance;

      // Directly manipulate the client property to be null
      Object.defineProperty(instance, 'client', {
        get: jest.fn(() => null),
        set: jest.fn(),
        configurable: true,
      });

      await instance.close();

      expect(mockClickHouseClient.close).not.toHaveBeenCalled();
    });

    it('should reset the instance when reset is called', async () => {
      // Store reference to original instance
      const originalInstance = CHFactory.instance;
      originalInstance.getClient();

      CHFactory.reset();

      // Get new instance
      const newInstance = CHFactory.instance;

      // Verify instance was reset
      expect(mockClickHouseClient.close).toHaveBeenCalled();
      expect(originalInstance).not.toBe(newInstance);
    });

    it('should handle error during close in reset', async () => {
      // Get instance and initialize client
      const instance = CHFactory.instance;
      instance.getClient();

      // Make close throw an error
      mockClickHouseClient.close.mockRejectedValueOnce(new Error('Close error'));

      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // Reset should not throw
      expect(() => CHFactory.reset()).not.toThrow();

      // Restore console.error
      errorSpy.mockRestore();
    });
  });
});
