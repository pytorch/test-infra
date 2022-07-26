import AWS from 'aws-sdk';
import { Config } from '../config';
import { decrypt } from './index';
import nock from 'nock';

const decryptedStr = 'The Decrypted String';
const awsRegion = 'the-aws-region';
const mockKmsPromise = {
  Plaintext: {
    toString: jest.fn().mockReturnValue(decryptedStr),
  },
};
const mockKmsDecrypt = {
  promise: jest.fn().mockImplementation(async () => mockKmsPromise),
};
const mockKms = {
  decrypt: jest.fn().mockImplementation(() => mockKmsDecrypt),
};

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: {
      update: jest.fn(),
    },
  },
  KMS: jest.fn().mockImplementation(() => mockKms),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
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

      expect(await decrypt(encrypted.toString('base64'), key, environmentName)).toBe(decryptedStr);
      expect(AWS.config.update).toBeCalledWith({
        region: awsRegion,
      });
      expect(mockKms.decrypt).toBeCalledWith({
        CiphertextBlob: encrypted,
        KeyId: key,
        EncryptionContext: {
          ['Environment']: environmentName,
        },
      });
      expect(mockKmsDecrypt.promise).toBeCalled();
      expect(mockKmsPromise.Plaintext.toString).toBeCalled();
    });
  });
});
