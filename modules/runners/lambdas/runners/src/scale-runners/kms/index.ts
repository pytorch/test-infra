import { KMS } from 'aws-sdk';
import AWS from 'aws-sdk';

let kms: KMS | undefined = undefined;

export async function decrypt(encrypted: string, key: string, environmentName: string): Promise<string | undefined> {
  let result: string | undefined = encrypted;
  if (key != undefined) {
    if (kms == undefined) {
      AWS.config.update({
        region: process.env.AWS_REGION,
      });

      kms = new KMS();
    }

    const decrypted = await kms
      .decrypt({
        CiphertextBlob: Buffer.from(encrypted, 'base64'),
        KeyId: key,
        EncryptionContext: {
          ['Environment']: environmentName,
        },
      })
      .promise();
    result = decrypted.Plaintext?.toString();
  }
  return result;
}
