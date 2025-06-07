import { Config } from '../config';
import { decrypt } from './index';
import { ScaleUpMetrics } from '../metrics';
import nock from 'nock';

const decryptedStr = 'The Decrypted String';
const awsRegion = 'the-aws-region';

// Mock AWS SDK v3 KMS client
const mockKMSSend = jest.fn().mockResolvedValue({
  Plaintext: Buffer.from(decryptedStr),
});

jest.mock('@aws-sdk/client-kms', () => ({
  KMSClient: jest.fn().mockImplementation(() => ({
    send: mockKMSSend,
  })),
  DecryptCommand: jest.fn().mockImplementation((params) => params),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

describe('decrypt', () => {
  describe('check AWS && KMS calls', () => {
    it('simple calls decrypt', async () => {
      const encrypted = Buffer.from('some random buffer');
      const key = 'decrypt key';
      const environmentName = 'environment Name';

      jest.spyOn(Config, 'Instance', 'get').mockImplementation(
        () =>
          ({
            awsRegion: awsRegion,
          } as Config),
      );

      expect(await decrypt(encrypted.toString('base64'), key, environmentName, new ScaleUpMetrics())).toBe(
        decryptedStr,
      );
      // AWS SDK v3 uses command pattern
      expect(mockKMSSend).toBeCalledWith({
        CiphertextBlob: encrypted,
        KeyId: key,
        EncryptionContext: {
          ['Environment']: environmentName,
        },
      });
    });
  });
});
