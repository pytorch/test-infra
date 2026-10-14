import { KMS } from '@aws-sdk/client-kms';

const kms = new KMS({ region: process.env.AWS_REGION });

export async function decrypt(encrypted: string, key: string, environmentName: string): Promise<string | undefined> {
  let result: string | undefined = encrypted;
  if (key != undefined) {
    const decrypted = await kms.decrypt({
      CiphertextBlob: Buffer.from(encrypted, 'base64') as Uint8Array,
      KeyId: key,
      EncryptionContext: {
        ['Environment']: environmentName,
      },
    });
    // Plaintext is a Uint8Array, whose toString() yields comma-separated byte values, not the secret.
    result = decrypted.Plaintext === undefined ? undefined : Buffer.from(decrypted.Plaintext).toString('utf8');
  }
  return result;
}
