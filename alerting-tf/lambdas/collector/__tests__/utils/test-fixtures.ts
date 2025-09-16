import { SQSRecord } from 'aws-lambda';
import { AlertEvent, Envelope } from '../../src/types';

// Mock SQS record factory
export function createMockSQSRecord(
  body: any,
  messageAttributes: Record<string, any> = {}
): SQSRecord {
  return {
    messageId: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    receiptHandle: 'mock-receipt-handle',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: Date.now().toString(),
      SenderId: 'AIDAMOCK',
      ApproximateFirstReceiveTimestamp: Date.now().toString(),
    },
    messageAttributes,
    md5OfBody: 'mock-md5',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:test-alerts-queue',
    awsRegion: 'us-east-1',
  } as SQSRecord;
}

// Test alert event fixtures
export const testAlertEvents = {
  grafanaFiring: {
    schema_version: 1,
    provider_version: 'grafana:1.0',
    source: 'grafana',
    state: 'FIRING' as const,
    title: 'Test Alert',
    description: 'Test alert description',
    reason: 'Test reason',
    priority: 'P1' as const,
    occurred_at: '2025-09-16T12:00:00.000Z',
    team: 'dev-infra',
    resource: {
      type: 'runner' as const,
      id: 'test-runner',
      region: 'us-east-1',
    },
    identity: {
      org_id: '1',
      rule_id: 'test-rule-123',
    },
    links: {
      runbook_url: 'https://runbooks.example.com/test',
      dashboard_url: 'https://grafana.example.com/dashboard',
      source_url: 'https://grafana.example.com/alert',
    },
    raw_provider: {},
  } satisfies AlertEvent,

  grafanaResolved: {
    schema_version: 1,
    provider_version: 'grafana:1.0',
    source: 'grafana',
    state: 'RESOLVED' as const,
    title: 'Test Alert',
    description: 'Test alert description',
    reason: 'Test reason',
    priority: 'P1' as const,
    occurred_at: '2025-09-16T12:05:00.000Z',
    team: 'dev-infra',
    resource: {
      type: 'runner' as const,
      id: 'test-runner',
      region: 'us-east-1',
    },
    identity: {
      org_id: '1',
      rule_id: 'test-rule-123',
    },
    links: {
      runbook_url: 'https://runbooks.example.com/test',
      dashboard_url: 'https://grafana.example.com/dashboard',
      source_url: 'https://grafana.example.com/alert',
    },
    raw_provider: {},
  } satisfies AlertEvent,

  cloudwatchAlarm: {
    schema_version: 1,
    provider_version: 'cloudwatch:1.0',
    source: 'cloudwatch',
    state: 'FIRING' as const,
    title: 'High CPU Usage',
    description: 'CPU usage is above threshold',
    reason: 'Threshold crossed',
    priority: 'P2' as const,
    occurred_at: '2025-09-16T12:00:00.000Z',
    team: 'platform',
    resource: {
      type: 'instance' as const,
      id: 'i-1234567890abcdef0',
      region: 'us-east-1',
    },
    identity: {
      org_id: '123456789012',
      rule_id: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPU',
    },
    links: {
      source_url: 'https://console.aws.amazon.com/cloudwatch/home#alarmsV2:alarm/HighCPU',
    },
    raw_provider: {},
  } satisfies AlertEvent,
};

// Test Grafana payloads
export const testGrafanaPayloads = {
  firing: {
    receiver: 'sns',
    status: 'firing',
    orgId: 1,
    alerts: [
      {
        status: 'firing',
        labels: {
          alertname: 'Test Alert',
          resource_type: 'runner',
          resource_id: 'test-runner',
        },
        annotations: {
          Priority: 'P1',
          Team: 'dev-infra',
          description: 'Test alert description',
          runbook_url: 'https://runbooks.example.com/test',
          summary: 'Test alert summary',
        },
        startsAt: '2025-09-16T12:00:00.000Z',
        endsAt: '0001-01-01T00:00:00Z',
        generatorURL: 'https://grafana.example.com/alert',
        fingerprint: 'abc123',
      },
    ],
    groupLabels: { alertname: 'Test Alert' },
    commonLabels: {},
    commonAnnotations: {},
    externalURL: 'https://grafana.example.com',
    version: '1',
    groupKey: '{}:{alertname="Test Alert"}',
    truncatedAlerts: 0,
    title: '[FIRING:1] Test Alert',
    state: 'alerting',
    message: 'Test message',
  },

  resolved: {
    receiver: 'sns',
    status: 'resolved',
    orgId: 1,
    alerts: [
      {
        status: 'resolved',
        labels: {
          alertname: 'Test Alert',
          resource_type: 'runner',
          resource_id: 'test-runner',
        },
        annotations: {
          Priority: 'P1',
          Team: 'dev-infra',
          description: 'Test alert description',
          runbook_url: 'https://runbooks.example.com/test',
          summary: 'Test alert summary',
        },
        startsAt: '2025-09-16T12:00:00.000Z',
        endsAt: '2025-09-16T12:05:00.000Z',
        generatorURL: 'https://grafana.example.com/alert',
        fingerprint: 'abc123',
      },
    ],
    groupLabels: { alertname: 'Test Alert' },
    commonLabels: {},
    commonAnnotations: {},
    externalURL: 'https://grafana.example.com',
    version: '1',
    groupKey: '{}:{alertname="Test Alert"}',
    truncatedAlerts: 0,
    title: '[RESOLVED:1] Test Alert',
    state: 'ok',
    message: 'Test message',
  },

  missingTeam: {
    receiver: 'sns',
    status: 'firing',
    orgId: 1,
    alerts: [
      {
        status: 'firing',
        labels: {
          alertname: 'Test Alert Without Team',
        },
        annotations: {
          Priority: 'P0',
          description: 'Test alert without team',
        },
        startsAt: '2025-09-16T12:00:00.000Z',
        endsAt: '0001-01-01T00:00:00Z',
        generatorURL: 'https://grafana.example.com/alert',
        fingerprint: 'def456',
      },
    ],
    groupLabels: { alertname: 'Test Alert Without Team' },
    commonLabels: {},
    commonAnnotations: {},
    externalURL: 'https://grafana.example.com',
    version: '1',
    groupKey: '{}:{alertname="Test Alert Without Team"}',
    truncatedAlerts: 0,
    title: '[FIRING:1] Test Alert Without Team',
    state: 'alerting',
    message: 'Test message',
  },
};

// Test CloudWatch payloads
export const testCloudWatchPayloads = {
  alarm: {
    Type: 'Notification',
    MessageId: '12345678-1234-1234-1234-123456789012',
    TopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts',
    Subject: 'ALARM: High CPU Usage in US East - N. Virginia',
    Message: JSON.stringify({
      AlarmName: 'High CPU Usage',
      AlarmDescription: 'TEAM=platform | PRIORITY=P2 | RUNBOOK=https://runbooks.example.com/cpu',
      AWSAccountId: '123456789012',
      NewStateValue: 'ALARM',
      NewStateReason: 'Threshold Crossed: CPU usage is above 80%',
      StateChangeTime: '2025-09-16T12:00:00.000Z',
      Region: 'US East - N. Virginia',
      AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPU',
      OldStateValue: 'OK',
      Trigger: {
        MetricName: 'CPUUtilization',
        Namespace: 'AWS/EC2',
        StatisticType: 'Statistic',
        Statistic: 'AVERAGE',
        Unit: 'Percent',
        Dimensions: [{ name: 'InstanceId', value: 'i-1234567890abcdef0' }],
        Period: 300,
        EvaluationPeriods: 2,
        ComparisonOperator: 'GreaterThanThreshold',
        Threshold: 80.0,
      },
    }),
    Timestamp: '2025-09-16T12:00:00.123Z',
    SignatureVersion: '1',
  },

  ok: {
    Type: 'Notification',
    MessageId: '12345678-1234-1234-1234-123456789012',
    TopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts',
    Subject: 'OK: High CPU Usage in US East - N. Virginia',
    Message: JSON.stringify({
      AlarmName: 'High CPU Usage',
      AlarmDescription: 'TEAM=platform | PRIORITY=P2 | RUNBOOK=https://runbooks.example.com/cpu',
      AWSAccountId: '123456789012',
      NewStateValue: 'OK',
      NewStateReason: 'Threshold no longer crossed',
      StateChangeTime: '2025-09-16T12:05:00.000Z',
      Region: 'US East - N. Virginia',
      AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPU',
      OldStateValue: 'ALARM',
      Trigger: {
        MetricName: 'CPUUtilization',
        Namespace: 'AWS/EC2',
        StatisticType: 'Statistic',
        Statistic: 'AVERAGE',
        Unit: 'Percent',
        Dimensions: [{ name: 'InstanceId', value: 'i-1234567890abcdef0' }],
        Period: 300,
        EvaluationPeriods: 2,
        ComparisonOperator: 'GreaterThanThreshold',
        Threshold: 80.0,
      },
    }),
    Timestamp: '2025-09-16T12:05:00.123Z',
    SignatureVersion: '1',
  },
};