import AWS from 'aws-sdk';
import { KMS } from '@aws-sdk/client-kms';
import { Config } from '../config';
import { expBackOff } from '../utils';
import { Metrics } from '../metrics';

let kms: KMS | undefined = undefined;

export async function decrypt(
  encrypted: string,
  key: string,
  environmentName: string,
  metrics: Metrics,
): Promise<string | undefined> {
  /* istanbul ignore next */
  if (!kms) {
    kms = new KMS({
      region: Config.Instance.awsRegion,
    });
  }

  // this is so the linter understands that KMS is not undefined at this point :(
  const kmsD = kms;

  const decripted = await expBackOff(() => {
    return metrics.trackRequest(metrics.kmsDecryptAWSCallSuccess, metrics.kmsDecryptAWSCallFailure, () => {
      return (
        kmsD
          .decrypt({
            CiphertextBlob: Buffer.from(encrypted, 'base64'),
            KeyId: key,
            EncryptionContext: {
              ['Environment']: environmentName,
            },
          })
      );
    });
  });

  /* istanbul ignore next */
  return decripted.Plaintext?.toString() ?? undefined;
}
