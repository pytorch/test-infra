import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CloudWatchTransformer } from '../../src/transformers/cloudwatch';
import { Envelope } from '../../src/types';
import { testCloudWatchPayloads } from '../utils/test-fixtures';

describe('CloudWatchTransformer', () => {
  let transformer: CloudWatchTransformer;
  let mockEnvelope: Envelope;

  beforeEach(() => {
    transformer = new CloudWatchTransformer();
    mockEnvelope = {
      event_id: 'test-event-123',
      source: 'cloudwatch',
      timestamp: '2025-09-16T12:00:00.000Z',
    };
  });

  describe('transform', () => {
    it('should transform valid CloudWatch alarm', () => {
      const result = transformer.transform(testCloudWatchPayloads.alarm, mockEnvelope);

      expect(result).toMatchObject({
        schema_version: 1,
        provider_version: 'cloudwatch:2025-06',
        source: 'cloudwatch',
        state: 'FIRING',
        title: 'High CPU Usage',
        priority: 'P2',
        team: 'platform',
        resource: {
          type: 'instance',
          id: 'i-1234567890abcdef0',
          region: 'us-east-1',
        },
        identity: {
          aws_account: '123456789012',
          region: 'us-east-1',
          alarm_arn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:HighCPU',
        },
        links: {
          runbook_url: 'https://runbooks.example.com/cpu',
          source_url: 'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/High%20CPU%20Usage',
        },
      });

      expect(result.occurred_at).toBe('2025-09-16T12:00:00.000Z');
      expect(result.raw_provider).toBe(testCloudWatchPayloads.alarm);
    });

    it('should transform valid CloudWatch OK state', () => {
      const result = transformer.transform(testCloudWatchPayloads.ok, mockEnvelope);

      expect(result.state).toBe('RESOLVED');
      expect(result.title).toBe('High CPU Usage');
      expect(result.occurred_at).toBe('2025-09-16T12:05:00.000Z');
    });

    it('should handle string payload (direct alarm JSON)', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      const stringPayload = JSON.stringify(alarmData);

      const result = transformer.transform(stringPayload, mockEnvelope);

      expect(result.state).toBe('FIRING');
      expect(result.title).toBe('High CPU Usage');
    });

    it('should handle direct alarm data (not wrapped in SNS)', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);

      const result = transformer.transform(alarmData, mockEnvelope);

      expect(result.state).toBe('FIRING');
      expect(result.title).toBe('High CPU Usage');
    });

    it('should parse AlarmDescription metadata correctly', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      const customAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify({
          ...alarmData,
          AlarmDescription: 'CPU usage is high\nTEAM=devops\nPRIORITY=P1\nRUNBOOK=https://runbooks.example.com/cpu',
        }),
      };

      const result = transformer.transform(customAlarm, mockEnvelope);

      expect(result.team).toBe('devops');
      expect(result.priority).toBe('P1');
      expect(result.links?.runbook_url).toBe('https://runbooks.example.com/cpu');
      expect(result.description).toBe('CPU usage is high');
    });

    it('should handle pipe-separated AlarmDescription format', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      const customAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify({
          ...alarmData,
          AlarmDescription: 'TEAM=devops | PRIORITY=P1 | RUNBOOK=https://runbooks.example.com/cpu | Custom description',
        }),
      };

      const result = transformer.transform(customAlarm, mockEnvelope);

      expect(result.team).toBe('devops');
      expect(result.priority).toBe('P1');
      expect(result.links?.runbook_url).toBe('https://runbooks.example.com/cpu');
      expect(result.description).toBe('Custom description');
    });

    it('should extract resource type from namespace', () => {
      const testCases = [
        { namespace: 'AWS/AutoScaling', expected: 'instance' },
        { namespace: 'AWS/EC2', expected: 'instance' },
        { namespace: 'AWS/ECS', expected: 'service' },
        { namespace: 'AWS/Lambda', expected: 'service' },
      ];

      testCases.forEach(({ namespace, expected }) => {
        const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
        const customAlarm = {
          ...testCloudWatchPayloads.alarm,
          Message: JSON.stringify({
            ...alarmData,
            AlarmDescription: 'TEAM=platform | PRIORITY=P2',
            Trigger: {
              ...alarmData.Trigger,
              Namespace: namespace,
            },
          }),
        };

        const result = transformer.transform(customAlarm, mockEnvelope);
        expect(result.resource.type).toBe(expected);
      });
    });

    it('should extract resource ID from dimensions', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      const customAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify({
          ...alarmData,
          Trigger: {
            ...alarmData.Trigger,
            Dimensions: [
              { name: 'AutoScalingGroupName', value: 'my-asg' },
              { name: 'InstanceId', value: 'i-1234567890abcdef0' },
            ],
          },
        }),
      };

      const result = transformer.transform(customAlarm, mockEnvelope);
      expect(result.resource.id).toBe('my-asg'); // Should prefer AutoScalingGroupName
    });

    it('should build resource extra information', () => {
      const result = transformer.transform(testCloudWatchPayloads.alarm, mockEnvelope);

      expect(result.resource.extra).toMatchObject({
        metric_name: 'CPUUtilization',
        namespace: 'AWS/EC2',
        statistic: 'AVERAGE',
        threshold: 80.0,
        comparison_operator: 'GreaterThanThreshold',
      });
    });

    it('should extract region from ARN correctly', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      const customAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify({
          ...alarmData,
          AlarmArn: 'arn:aws:cloudwatch:eu-west-1:123456789012:alarm:TestAlarm',
        }),
      };

      const result = transformer.transform(customAlarm, mockEnvelope);

      expect(result.resource.region).toBe('eu-west-1');
      expect(result.identity.region).toBe('eu-west-1');
    });

    it('should normalize region names to codes', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      const customAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify({
          ...alarmData,
          Region: 'US West - Oregon',
          AlarmArn: undefined, // No ARN, should use region name
        }),
      };

      const result = transformer.transform(customAlarm, mockEnvelope);

      expect(result.resource.region).toBe('us-west-2');
    });

    it('should build console URL correctly', () => {
      const result = transformer.transform(testCloudWatchPayloads.alarm, mockEnvelope);

      expect(result.links?.source_url).toBe(
        'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/High%20CPU%20Usage'
      );
    });
  });

  describe('error handling', () => {
    it('should throw error for invalid JSON string payload', () => {
      expect(() => transformer.transform('invalid json', mockEnvelope))
        .toThrow('Invalid CloudWatch payload: failed to parse JSON');
    });

    it('should throw error for invalid SNS Message', () => {
      const invalidSNS = {
        ...testCloudWatchPayloads.alarm,
        Message: 'invalid json',
      };

      expect(() => transformer.transform(invalidSNS, mockEnvelope))
        .toThrow('Invalid CloudWatch SNS Message: failed to parse');
    });

    it('should throw error for non-object alarm data', () => {
      expect(() => transformer.transform('not-json-string', mockEnvelope))
        .toThrow('Invalid CloudWatch payload: failed to parse JSON');
    });

    it('should throw error for missing AlarmName', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      delete alarmData.AlarmName;

      const invalidAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify(alarmData),
      };

      expect(() => transformer.transform(invalidAlarm, mockEnvelope))
        .toThrow('Missing required field "AlarmName"');
    });

    it('should throw error for missing NewStateValue', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      delete alarmData.NewStateValue;

      const invalidAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify(alarmData),
      };

      expect(() => transformer.transform(invalidAlarm, mockEnvelope))
        .toThrow('Missing required field "NewStateValue"');
    });

    it('should throw error for invalid NewStateValue', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      alarmData.NewStateValue = 'UNKNOWN';

      const invalidAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify(alarmData),
      };

      expect(() => transformer.transform(invalidAlarm, mockEnvelope))
        .toThrow('Invalid NewStateValue: \'UNKNOWN\'');
    });

    it('should throw error for missing PRIORITY in AlarmDescription', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      alarmData.AlarmDescription = 'TEAM=platform | Missing priority';

      const invalidAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify(alarmData),
      };

      expect(() => transformer.transform(invalidAlarm, mockEnvelope))
        .toThrow('Missing required field "PRIORITY"');
    });

    it('should throw error for missing TEAM in AlarmDescription', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      alarmData.AlarmDescription = 'PRIORITY=P1 | Missing team';

      const invalidAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify(alarmData),
      };

      expect(() => transformer.transform(invalidAlarm, mockEnvelope))
        .toThrow('Missing required field "TEAM"');
    });

    // Note: Detailed error message tests removed due to debugContext dependency
    // These would be better as integration tests
  });

  describe('security features', () => {
    it('should sanitize AlarmDescription metadata', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      const maliciousDescription = `
        TEAM=<script>alert('xss')</script>platform
        PRIORITY=P1
        RUNBOOK=javascript:alert(1)
        Description with "quotes" and 'apostrophes'
      `;

      const customAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify({
          ...alarmData,
          AlarmDescription: maliciousDescription,
        }),
      };

      const result = transformer.transform(customAlarm, mockEnvelope);

      expect(result.team).not.toContain('<script>');
      expect(result.team).toBe('scriptalert(xss)/scriptplatform');
      expect(result.links?.runbook_url).toBeUndefined(); // Invalid URL should be filtered
      expect(result.description).toContain('Description with quotes and apostrophes');
    });

    it('should ignore non-whitelisted metadata keys', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      const customAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify({
          ...alarmData,
          AlarmDescription: `
            TEAM=platform
            PRIORITY=P1
            MALICIOUS_KEY=dangerous_value
            RUNBOOK=https://runbooks.example.com/test
          `,
        }),
      };

      const result = transformer.transform(customAlarm, mockEnvelope);

      expect(result.team).toBe('platform');
      expect(result.priority).toBe('P1');
      expect(result.links?.runbook_url).toBe('https://runbooks.example.com/test');
      expect(result.description).toContain('MALICIOUS_KEY=dangerous_value'); // Treated as description
      expect(consoleSpy).toHaveBeenCalledWith(
        'Non-whitelisted key in AlarmDescription treated as description: MALICIOUS_KEY'
      );

      consoleSpy.mockRestore();
    });

    it('should limit number of description lines', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      const manyLines = Array.from({ length: 25 }, (_, i) => `Line${i}`).join('\n');

      const customAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify({
          ...alarmData,
          AlarmDescription: `TEAM=platform\nPRIORITY=P1\n${manyLines}`,
        }),
      };

      const result = transformer.transform(customAlarm, mockEnvelope);

      // The description should be truncated (exact behavior depends on implementation)
      // Just check that it doesn't contain all 25 lines worth of content
      const description = result.description || '';
      expect(description.includes('Line24')).toBe(false);
    });
  });

  describe('debug context', () => {
    it('should include debug context in error messages', () => {
      const alarmData = JSON.parse(testCloudWatchPayloads.alarm.Message);
      delete alarmData.AlarmName;

      const invalidAlarm = {
        ...testCloudWatchPayloads.alarm,
        Message: JSON.stringify(alarmData),
      };

      try {
        transformer.transform(invalidAlarm, mockEnvelope);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).toContain('source=cloudwatch');
        expect(error.message).toContain('messageId=test-event-123');
        expect(error.message).toContain('AWSAccountId=123456789012');
      }
    });
  });
});