import { createHmac } from 'crypto';

import { handle } from './handler';
import check_run_event from '../../test/resources/github_check_run_event.json';

import { sendActionRequest } from '../sqs';
import { decrypt } from '../kms';

jest.mock('../sqs');
jest.mock('../kms', () => ({
  decrypt: jest.fn().mockImplementation((value) => {
    return Promise.resolve(value);
  }),
}));

const TEST_SECRET = 'TEST_SECRET';

const sign = (payload: string, algorithm: 'sha256' | 'sha1' = 'sha256'): string =>
  `${algorithm}=${createHmac(algorithm, TEST_SECRET).update(payload).digest('hex')}`;

const signedHeaders = (payload: string, event = 'push') => ({
  'X-Hub-Signature-256': sign(payload),
  'X-GitHub-Event': event,
});

// A workflow_job/queued event IS actionable, so `sendActionRequest` assertions below are
// only meaningful when the payload is this one — see the positive control test.
const queuedWorkflowJob = JSON.stringify({
  action: 'queued',
  installation: { id: 42 },
  repository: { name: 'pytorch', owner: { login: 'pytorch' } },
  workflow_job: {
    id: 1234,
    labels: ['linux.2xlarge'],
    html_url: 'https://github.com/pytorch/pytorch/actions/runs/1',
  },
});

describe('handler', () => {
  let originalError: Console['error'];

  beforeEach(() => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = TEST_SECRET;
    delete process.env.WEBHOOK_SIGNATURE_MODE;
    originalError = console.error;
    console.error = jest.fn();
    jest.clearAllMocks();
  });

  afterEach(() => {
    console.error = originalError;
  });

  it('returns 401 if no signature available', async () => {
    const resp = await handle({}, '');
    expect(resp).toBe(401);
  });

  // Positive control: proves the actionable path really does fire when the signature is valid,
  // which is what makes every `not.toBeCalled()` assertion below non-vacuous.
  it('enqueues a correctly signed queued workflow_job', async () => {
    const resp = await handle(signedHeaders(queuedWorkflowJob, 'workflow_job'), queuedWorkflowJob);
    expect(resp).toBe(200);
    expect(sendActionRequest).toBeCalledTimes(1);
  });

  it('returns 401 and does not enqueue when the signature does not match the payload', async () => {
    const resp = await handle(
      { 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`, 'X-GitHub-Event': 'workflow_job' },
      queuedWorkflowJob,
    );
    expect(resp).toBe(401);
    expect(sendActionRequest).not.toBeCalled();
  });

  it('returns 401 and does not enqueue when the payload was tampered with after signing', async () => {
    const headers = signedHeaders(queuedWorkflowJob, 'workflow_job');
    const tampered = JSON.stringify({ ...JSON.parse(queuedWorkflowJob), workflow_job: { id: 9999, labels: ['huge'] } });
    const resp = await handle(headers, tampered);
    expect(resp).toBe(401);
    expect(sendActionRequest).not.toBeCalled();
  });

  it('returns 401 and does not enqueue when the signature was made with a different secret', async () => {
    const foreign = `sha256=${createHmac('sha256', 'NOT_THE_SECRET').update(queuedWorkflowJob).digest('hex')}`;
    const resp = await handle({ 'X-Hub-Signature-256': foreign, 'X-GitHub-Event': 'workflow_job' }, queuedWorkflowJob);
    expect(resp).toBe(401);
    expect(sendActionRequest).not.toBeCalled();
  });

  it('returns 401 when the signature header is not a recognisable digest', async () => {
    const resp = await handle(
      { 'X-Hub-Signature-256': 'not-a-signature', 'X-GitHub-Event': 'workflow_job' },
      queuedWorkflowJob,
    );
    expect(resp).toBe(401);
    expect(sendActionRequest).not.toBeCalled();
  });

  // The verifier throws (rather than returning false) on an empty payload; the handler must
  // turn that into a 401 instead of an unhandled rejection.
  it('returns 401 rather than throwing when the verifier rejects', async () => {
    const resp = await handle({ 'X-Hub-Signature-256': sign(''), 'X-GitHub-Event': 'workflow_job' }, '');
    expect(resp).toBe(401);
    expect(sendActionRequest).not.toBeCalled();
    // The colon distinguishes the catch branch from the plain invalid-signature message.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unable to verify signature:'));
  });

  // sha256 is preferred, so a bad sha256 must NOT be rescued by a valid legacy sha1 header.
  it('rejects an invalid sha256 signature even when a valid sha1 header is present', async () => {
    const resp = await handle(
      {
        'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
        'X-Hub-Signature': sign(queuedWorkflowJob, 'sha1'),
        'X-GitHub-Event': 'workflow_job',
      },
      queuedWorkflowJob,
    );
    expect(resp).toBe(401);
    expect(sendActionRequest).not.toBeCalled();
  });

  it('accepts the legacy sha1 signature header when no sha256 header is sent', async () => {
    const payload = JSON.stringify(check_run_event);
    const resp = await handle({ 'X-Hub-Signature': sign(payload, 'sha1'), 'X-GitHub-Event': 'push' }, payload);
    expect(resp).toBe(200);
  });

  it('does not handle other events', async () => {
    const payload = JSON.stringify(check_run_event);
    const resp = await handle(signedHeaders(payload), payload);
    expect(resp).toBe(200);
    expect(sendActionRequest).not.toBeCalled();
  });

  it('ignores a push event carrying a completed check_run payload', async () => {
    const payload = JSON.stringify({ ...check_run_event, action: 'completed' });
    const resp = await handle(signedHeaders(payload), payload);
    expect(resp).toBe(200);
    expect(sendActionRequest).not.toBeCalled();
  });

  it('ignores a push event carrying a check_run payload with a completed status', async () => {
    const payload = JSON.stringify({ ...check_run_event, check_run: { id: 1234, status: 'completed' } });
    const resp = await handle(signedHeaders(payload), payload);
    expect(resp).toBe(200);
    expect(sendActionRequest).not.toBeCalled();
  });

  it('returns 500, not 401, when the configured secret is blank', async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = '';
    const resp = await handle(signedHeaders(queuedWorkflowJob, 'workflow_job'), queuedWorkflowJob);
    expect(resp).toBe(500);
    expect(sendActionRequest).not.toBeCalled();
  });

  it.each(['enforce', 'warn'])('returns 500 for a whitespace-only secret in %s mode', async (mode) => {
    process.env.WEBHOOK_SIGNATURE_MODE = mode;
    process.env.GITHUB_APP_WEBHOOK_SECRET = '   ';
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const resp = await handle(signedHeaders(queuedWorkflowJob, 'workflow_job'), queuedWorkflowJob);
    expect(resp).toBe(500);
    expect(sendActionRequest).not.toBeCalled();
    const records = info.mock.calls.filter(([line]) => String(line).startsWith('{"signature_check"'));
    expect(records).toEqual([
      [expect.stringContaining('"signature_check":"no_secret","mode":"' + mode + '","action":"rejected"')],
    ]);
    info.mockRestore();
  });

  it('returns 500 when the secret cannot be decrypted', async () => {
    (decrypt as jest.Mock).mockRejectedValueOnce(new Error('KMS unavailable'));
    const resp = await handle(signedHeaders(queuedWorkflowJob, 'workflow_job'), queuedWorkflowJob);
    expect(resp).toBe(500);
    expect(sendActionRequest).not.toBeCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('KMS unavailable'));
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  describe('signature check logging', () => {
    let info: jest.SpyInstance;

    beforeEach(() => {
      info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    });

    afterEach(() => {
      info.mockRestore();
    });

    const checks = () =>
      info.mock.calls
        .map(([line]) => line)
        .filter((line) => typeof line === 'string' && line.startsWith('{"signature_check"'))
        .map((line) => JSON.parse(line));

    it('logs an accepted check for a valid signature', async () => {
      const headers = { ...signedHeaders(queuedWorkflowJob, 'workflow_job'), 'X-GitHub-Delivery': 'abc-123' };
      await handle(headers, queuedWorkflowJob);
      expect(checks()).toEqual([
        {
          signature_check: 'valid',
          mode: 'enforce',
          action: 'accepted',
          github_event: 'workflow_job',
          delivery: 'abc-123',
        },
      ]);
    });

    it('logs a rejected check when enforcing', async () => {
      await handle({ 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`, 'X-GitHub-Event': 'push' }, queuedWorkflowJob);
      expect(checks()).toEqual([expect.objectContaining({ signature_check: 'invalid', action: 'rejected' })]);
    });

    it('logs a rejected check when the secret is blank', async () => {
      process.env.GITHUB_APP_WEBHOOK_SECRET = '';
      await handle(signedHeaders(queuedWorkflowJob, 'push'), queuedWorkflowJob);
      expect(checks()).toEqual([expect.objectContaining({ signature_check: 'no_secret', action: 'rejected' })]);
    });

    it.each(['enforce', 'warn'])('rejects a decryption failure in %s mode and logs one decrypt_error', async (mode) => {
      process.env.WEBHOOK_SIGNATURE_MODE = mode;
      (decrypt as jest.Mock).mockRejectedValueOnce(new Error('ThrottlingException'));
      const resp = await handle(signedHeaders(queuedWorkflowJob, 'workflow_job'), queuedWorkflowJob);
      expect(resp).toBe(500);
      expect(sendActionRequest).not.toBeCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(checks()).toEqual([
        expect.objectContaining({ signature_check: 'decrypt_error', mode, action: 'rejected' }),
      ]);
    });

    it('logs a rejected check for a missing signature', async () => {
      await handle({ 'X-GitHub-Event': 'push' }, queuedWorkflowJob);
      expect(checks()).toEqual([expect.objectContaining({ signature_check: 'missing', action: 'rejected' })]);
    });
  });

  describe('WEBHOOK_SIGNATURE_MODE', () => {
    const badHeaders = { 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`, 'X-GitHub-Event': 'workflow_job' };

    it('processes an invalid signature in warn mode, and logs that it was allowed', async () => {
      process.env.WEBHOOK_SIGNATURE_MODE = 'warn';
      const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
      const resp = await handle(badHeaders, queuedWorkflowJob);
      expect(resp).toBe(200);
      expect(sendActionRequest).toBeCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('"signature_check":"invalid","mode":"warn","action":"allowed"'),
      );
      info.mockRestore();
    });

    // An empty payload makes the verifier throw rather than return false.
    it('processes a verifier error in warn mode, and logs it as an error', async () => {
      process.env.WEBHOOK_SIGNATURE_MODE = 'warn';
      const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
      const resp = await handle({ 'X-Hub-Signature-256': sign(''), 'X-GitHub-Event': 'push' }, '');
      expect(resp).toBe(200);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unable to verify signature:'));
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('"signature_check":"error","mode":"warn","action":"allowed"'),
      );
      info.mockRestore();
    });

    it('still rejects a missing signature with 401 in warn mode', async () => {
      process.env.WEBHOOK_SIGNATURE_MODE = 'warn';
      const resp = await handle({ 'X-GitHub-Event': 'workflow_job' }, queuedWorkflowJob);
      expect(resp).toBe(401);
      expect(sendActionRequest).not.toBeCalled();
    });

    it.each(['enforce', 'ENFORCE', ' Warn-ish ', 'off', 'false'])('enforces when set to %p', async (value) => {
      process.env.WEBHOOK_SIGNATURE_MODE = value;
      const resp = await handle(badHeaders, queuedWorkflowJob);
      expect(resp).toBe(401);
      expect(sendActionRequest).not.toBeCalled();
    });

    it('accepts warn case-insensitively', async () => {
      process.env.WEBHOOK_SIGNATURE_MODE = ' WARN ';
      const resp = await handle(badHeaders, queuedWorkflowJob);
      expect(resp).toBe(200);
    });

    it('logs an error for an unrecognised value', async () => {
      process.env.WEBHOOK_SIGNATURE_MODE = 'off';
      await handle(badHeaders, queuedWorkflowJob);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown WEBHOOK_SIGNATURE_MODE "off"'));
    });
  });
});
