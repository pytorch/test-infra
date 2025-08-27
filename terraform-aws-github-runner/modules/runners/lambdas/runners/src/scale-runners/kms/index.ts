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
    // JS SDK v3 does not support global configuration.
    // Codemod has attempted to pass values to each service client in this file.
    // You may need to update clients outside of this file, if they use global config.
    AWS.config.update({
      region: Config.Instance.awsRegion,
    });

    kms = new KMS({
      region: Config.Instance.awsRegion,
    });
  }

  // this is so the linter understands that KMS is not undefined at this point :(
  const kmsD = kms;

  const decripted = await expBackOff(() => {
    return metrics.trackRequest(metrics.kmsDecryptAWSCallSuccess, metrics.kmsDecryptAWSCallFailure, () => {
      return (
        // The `.promise()` call might be on an JS SDK v2 client API.
        // If yes, please remove .promise(). If not, remove this comment.
        kmsD
          .decrypt({
            CiphertextBlob: Buffer.from(encrypted, 'base64'),
            KeyId: key,
            EncryptionContext: {
              ['Environment']: environmentName,
            },
          })
          .promise()
      );
    });
  });

  /* istanbul ignore next */
  return decripted.Plaintext?.toString() ?? undefined;
}
