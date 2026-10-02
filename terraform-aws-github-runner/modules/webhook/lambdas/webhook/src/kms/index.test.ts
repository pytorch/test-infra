import { decrypt } from '.';

const mockDecrypt = jest.fn();
jest.mock('@aws-sdk/client-kms', () => ({
  // The client is built at import time, before mockDecrypt is initialised, so defer the lookup.
  KMS: jest.fn().mockImplementation(() => ({ decrypt: (...args: unknown[]) => mockDecrypt(...args) })),
}));

describe('decrypt', () => {
  beforeEach(() => mockDecrypt.mockReset());

  it('returns the value unchanged when no key is configured', async () => {
    expect(await decrypt('plain', undefined as unknown as string, 'env')).toBe('plain');
    expect(mockDecrypt).not.toBeCalled();
  });

  it('decodes the Uint8Array plaintext KMS returns as UTF-8', async () => {
    mockDecrypt.mockResolvedValue({ Plaintext: new TextEncoder().encode('s3cret') });
    expect(await decrypt('Y2lwaGVy', 'key', 'env')).toBe('s3cret');
    expect(mockDecrypt).toBeCalledWith(
      expect.objectContaining({ KeyId: 'key', EncryptionContext: { Environment: 'env' } }),
    );
  });

  it('returns undefined when KMS returns no plaintext', async () => {
    mockDecrypt.mockResolvedValue({});
    expect(await decrypt('Y2lwaGVy', 'key', 'env')).toBeUndefined();
  });
});
