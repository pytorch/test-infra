import { createHmac } from 'crypto';

import { handle } from './handler';
import check_run_event from '../../test/resources/github_check_run_event.json';

import { sendActionRequest } from '../sqs';

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
    originalError = console.error;
    console.error = jest.fn();
    jest.clearAllMocks();
  });

  afterEach(() => {
    console.error = originalError;
  });

  it('returns 500 if no signature available', async () => {
    const resp = await handle({}, '');
    expect(resp).toBe(500);
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

  it('does not handle check_run events with actions other than created', async () => {
    const payload = JSON.stringify({ ...check_run_event, action: 'completed' });
    const resp = await handle(signedHeaders(payload), payload);
    expect(resp).toBe(200);
    expect(sendActionRequest).not.toBeCalled();
  });

  it('does not handle check_run events with status other than queued', async () => {
    const payload = JSON.stringify({ ...check_run_event, check_run: { id: 1234, status: 'completed' } });
    const resp = await handle(signedHeaders(payload), payload);
    expect(resp).toBe(200);
    expect(sendActionRequest).not.toBeCalled();
  });
});
