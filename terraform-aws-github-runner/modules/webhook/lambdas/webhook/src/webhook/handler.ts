import { IncomingHttpHeaders } from 'http';
import { Webhooks } from '@octokit/webhooks';
import { sendActionRequest } from '../sqs';
import { WorkflowJobEvent } from '@octokit/webhooks-types';
import { decrypt } from '../kms';

const DEFAULT_PATTERNS = [/windows-.*/, /ubuntu-.*/, /macos-.*/];

type SignatureResult = 'valid' | 'invalid' | 'error' | 'missing' | 'no_secret' | 'decrypt_error';

// WEBHOOK_SIGNATURE_MODE=warn logs a failed verification but still processes the event, so enforcement
// can be rolled out and rolled back without a code change. Unset or any other value enforces.
// A delivery with no signature header is rejected with a 401 in both modes.
export function signatureMode(): 'enforce' | 'warn' {
  const raw = (process.env.WEBHOOK_SIGNATURE_MODE ?? '').trim().toLowerCase();
  if (raw === 'warn') {
    return 'warn';
  }
  if (raw !== '' && raw !== 'enforce') {
    console.error(`Unknown WEBHOOK_SIGNATURE_MODE "${process.env.WEBHOOK_SIGNATURE_MODE}", enforcing.`);
  }
  return 'enforce';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handle = async (headers: IncomingHttpHeaders, payload: any): Promise<number> => {
  // ensure header keys lower case since github headers can contain capitals.
  for (const key in headers) {
    headers[key.toLowerCase()] = headers[key];
  }

  const githubEvent = headers['x-github-event'] as string;
  const mode = signatureMode();
  const logCheck = (result: SignatureResult, action: 'accepted' | 'rejected' | 'allowed') =>
    // One JSON line per delivery so enforcement can be monitored from the logs. lambda.ts also logs the raw
    // request, so anchor queries on the start of this line, e.g. in Logs Insights:
    //   filter @message like /^\S+\s+\S+\s+INFO\s+\{"signature_check"/
    //   | parse @message '{"signature_check":"*","mode":"*","action":"*"' as result, mode, action
    //   | stats count() by result, action
    console.info(
      JSON.stringify({
        signature_check: result,
        mode,
        action,
        github_event: githubEvent,
        delivery: headers['x-github-delivery'],
      }),
    );

  // Prefer the SHA-256 signature; GitHub still sends the legacy SHA-1 header alongside it.
  const signature = (headers['x-hub-signature-256'] ?? headers['x-hub-signature']) as string;
  if (!signature) {
    console.error("Github event doesn't have signature. This webhook requires a secret to be configured.");
    logCheck('missing', 'rejected');
    // 4xx rather than 5xx, so a sender that retries server errors does not replay it.
    return 401;
  }

  let secret: string | undefined;
  try {
    secret = await decrypt(
      process.env.GITHUB_APP_WEBHOOK_SECRET as string,
      process.env.KMS_KEY_ID as string,
      process.env.ENVIRONMENT as string,
    );
  } catch (e) {
    console.error(`Cannot decrypt secret: ${e}`);
    logCheck('decrypt_error', 'rejected');
    return 500;
  }
  // A missing or blank secret is a deployment problem, not a bad signature, so it must not surface as a 401.
  if (secret === undefined || secret.trim() === '') {
    console.error('Webhook secret is not configured.');
    logCheck('no_secret', 'rejected');
    return 500;
  }

  const webhooks = new Webhooks({
    secret: secret,
  });
  // `verify` is async — without the await this is an always-truthy Promise and the check never rejects.
  let result: SignatureResult;
  try {
    result = (await webhooks.verify(payload, signature)) ? 'valid' : 'invalid';
    if (result === 'invalid') {
      console.error('Unable to verify signature!');
    }
  } catch (e) {
    console.error(`Unable to verify signature: ${e}`);
    result = 'error';
  }
  if (result !== 'valid') {
    if (mode === 'enforce') {
      logCheck(result, 'rejected');
      return 401;
    }
    logCheck(result, 'allowed');
  } else {
    logCheck(result, 'accepted');
  }

  console.info(`Received Github event: "${githubEvent}"`);

  if (githubEvent === 'workflow_job') {
    const body = JSON.parse(payload) as WorkflowJobEvent;
    let installationId = body.installation?.id;
    if (installationId == null) {
      installationId = 0;
    }
    if (body.action === 'queued') {
      // If repository ends with -canary and environment is not canary environment then ignore
      if (
        body.repository.name.endsWith('-canary') &&
        !((process.env.ENVIRONMENT as string).endsWith('-canary') || (process.env.ENVIRONMENT as string).endsWith('-c'))
      ) {
        console.info(
          `Ignore canary event on non-canary environment (${process.env.ENVIRONMENT as string})` + githubEvent,
        );
        return 200;
      }
      if (isDefault(body.workflow_job.labels)) {
        console.info('Ignoring default label');
        return 200;
      }
      await sendActionRequest({
        id: body.workflow_job.id,
        repositoryName: body.repository.name,
        repositoryOwner: body.repository.owner.login,
        eventType: githubEvent,
        installationId: installationId,
        runnerLabels: body.workflow_job.labels,
        callbackUrl: body.workflow_job.html_url,
      });
    }
  } else {
    console.info('Ignore event ' + githubEvent);
  }

  return 200;
};

function isDefault(labels: string[]): boolean {
  for (const label of labels) {
    for (const pattern of DEFAULT_PATTERNS) {
      if (label.match(pattern)) {
        console.info(`Matched default label ${label}`);
        return true;
      }
    }
  }
  return false;
}
