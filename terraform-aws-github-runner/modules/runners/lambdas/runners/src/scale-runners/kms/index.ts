import { Config } from '../config';
import { expBackOff } from '../utils';
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';
import { Metrics } from '../metrics';

let kms: KMSClient | undefined = undefined;

export async function decrypt(
  encrypted: string,
  key: string,
  environmentName: string,
  metrics: Metrics,
): Promise<string | undefined> {
  /* istanbul ignore next */
  if (!kms) {
    kms = new KMSClient({
      region: Config.Instance.awsRegion,
    });
  }

  // this is so the linter understands that KMS is not undefined at this point :(
  const kmsD = kms;

  const decripted = await expBackOff(() => {
    return metrics.trackRequest(metrics.kmsDecryptAWSCallSuccess, metrics.kmsDecryptAWSCallFailure, () => {
      return kmsD.send(
        new DecryptCommand({
          CiphertextBlob: Buffer.from(encrypted, 'base64'),
          KeyId: key,
          EncryptionContext: {
            ['Environment']: environmentName,
          },
        }),
      );
    });
  });

  /* istanbul ignore next */
  return decripted.Plaintext?.toString() ?? undefined;
}
