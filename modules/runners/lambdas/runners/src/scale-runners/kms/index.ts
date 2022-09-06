import AWS from 'aws-sdk';
import { Config } from '../config';
import { KMS } from 'aws-sdk';
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
    AWS.config.update({
      region: Config.Instance.awsRegion,
    });

    kms = new KMS();
  }

  // this is so the linter understands that KMS is not undefined at this point :(
  const kmsD = kms;

  const decripted = await metrics.trackRequest(
    metrics.kmsDecryptAWSCallSuccess,
    metrics.kmsDecryptAWSCallFailure,
    () => {
      return kmsD
        .decrypt({
          CiphertextBlob: Buffer.from(encrypted, 'base64'),
          KeyId: key,
          EncryptionContext: {
            ['Environment']: environmentName,
          },
        })
        .promise();
    },
  );

  /* istanbul ignore next */
  return decripted.Plaintext?.toString() ?? undefined;
}
