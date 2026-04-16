import { Config } from '../config';
import { decrypt } from './index';
import { ScaleUpMetrics } from '../metrics';
import nock from 'nock';

const decryptedStr = 'The Decrypted String';
const awsRegion = 'the-aws-region';
const mockKmsPromise = {
  Plaintext: {
    toString: jest.fn().mockReturnValue(decryptedStr),
  },
};
const mockKms = {
  decrypt: jest.fn().mockResolvedValue(mockKmsPromise),
};

jest.mock('@aws-sdk/client-kms', () => ({
  KMS: jest.fn().mockImplementation(() => mockKms),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

describe('decrypt', () => {
  describe('check KMS calls', () => {
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
      expect(mockKms.decrypt).toBeCalledWith({
        CiphertextBlob: encrypted,
        KeyId: key,
        EncryptionContext: {
          ['Environment']: environmentName,
        },
      });
      expect(mockKmsPromise.Plaintext.toString).toBeCalled();
    });
  });
});
