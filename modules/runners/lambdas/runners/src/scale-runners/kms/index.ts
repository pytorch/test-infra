import AWS from 'aws-sdk';
import { Config } from '../config';
import { KMS } from 'aws-sdk';

let kms: KMS | undefined = undefined;

export async function decrypt(encrypted: string, key: string, environmentName: string): Promise<string | undefined> {
  /* istanbul ignore next */
  if (!kms) {
    AWS.config.update({
      region: Config.Instance.awsRegion,
    });

    kms = new KMS();
  }

  const decripted = await kms
    .decrypt({
      CiphertextBlob: Buffer.from(encrypted, 'base64'),
      KeyId: key,
      EncryptionContext: {
        ['Environment']: environmentName,
      },
    })
    .promise();

  /* istanbul ignore next */
  return decripted.Plaintext?.toString() ?? undefined;
}
