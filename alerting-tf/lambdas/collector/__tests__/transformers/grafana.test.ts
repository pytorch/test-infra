import { describe, it, expect, beforeEach } from 'vitest';
import { GrafanaTransformer } from '../../src/transformers/grafana';
import { Envelope } from '../../src/types';
import { testGrafanaPayloads } from '../utils/test-fixtures';

describe('GrafanaTransformer', () => {
  let transformer: GrafanaTransformer;
  let mockEnvelope: Envelope;

  beforeEach(() => {
    transformer = new GrafanaTransformer();
    mockEnvelope = {
      event_id: 'test-event-123',
      source: 'grafana',
      timestamp: '2025-09-16T12:00:00.000Z',
    };
  });

  describe('transform', () => {
    it('should transform valid Grafana firing alert', () => {
      const result = transformer.transform(testGrafanaPayloads.firing, mockEnvelope);

      expect(result).toMatchObject({
        schema_version: 1,
        provider_version: 'grafana:1.0',
        source: 'grafana',
        state: 'FIRING',
        title: 'Test Alert',
        description: 'Test alert description',
        priority: 'P1',
        team: 'dev-infra',
        resource: {
          type: 'runner',
          id: 'test-runner',
        },
        identity: {
          org_id: '1',
          rule_id: 'abc123',
        },
        links: {
          runbook_url: 'https://runbooks.example.com/test',
          source_url: 'https://grafana.example.com/alert',
        },
      });

      expect(result.occurred_at).toBeTruthy();
      expect(result.raw_provider).toBe(testGrafanaPayloads.firing);
    });

    it('should transform valid Grafana resolved alert', () => {
      const result = transformer.transform(testGrafanaPayloads.resolved, mockEnvelope);

      expect(result).toMatchObject({
        state: 'RESOLVED',
        title: 'Test Alert',
        priority: 'P1',
        team: 'dev-infra',
      });
    });

    it('should handle alerts with team and priority in labels (fallback)', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          labels: {
            ...testGrafanaPayloads.firing.alerts[0].labels,
            team: 'platform-team',
            priority: 'P2',
          },
          annotations: {
            description: 'Test description without team/priority',
          },
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);

      expect(result.team).toBe('platform-team');
      expect(result.priority).toBe('P2');
    });

    it('should extract title from various sources', () => {
      // Test alertname in alert labels
      const payload1 = {
        ...testGrafanaPayloads.firing,
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          labels: { alertname: 'Alert From Labels' },
        }],
      };

      const result1 = transformer.transform(payload1, mockEnvelope);
      expect(result1.title).toBe('Alert From Labels');

      // Test fallback to top-level title
      const payload2 = {
        ...testGrafanaPayloads.firing,
        title: 'Top Level Title',
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          labels: {},
        }],
        groupLabels: {}, // Clear this too
      };

      const result2 = transformer.transform(payload2, mockEnvelope);
      expect(result2.title).toBe('Top Level Title');
    });

    it('should extract state correctly', () => {
      const firingPayload = {
        ...testGrafanaPayloads.firing,
        alerts: [{ ...testGrafanaPayloads.firing.alerts[0], status: 'firing' }],
      };

      const resolvedPayload = {
        ...testGrafanaPayloads.resolved,
        alerts: [{ ...testGrafanaPayloads.resolved.alerts[0], status: 'resolved' }],
      };

      expect(transformer.transform(firingPayload, mockEnvelope).state).toBe('FIRING');
      expect(transformer.transform(resolvedPayload, mockEnvelope).state).toBe('RESOLVED');
    });

    it('should extract occurred_at from various timestamp fields', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          startsAt: '2025-09-16T10:30:00.000Z',
          endsAt: '0001-01-01T00:00:00Z', // Should be ignored as it's the null timestamp
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);
      expect(result.occurred_at).toBe('2025-09-16T10:30:00.000Z');
    });

    it('should build resource information correctly', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          labels: {
            alertname: 'Test Alert',
            resource_type: 'service',
            resource_id: 'web-service-1',
            region: 'us-west-2',
            environment: 'production',
            version: '1.2.3',
          },
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);

      expect(result.resource).toMatchObject({
        type: 'service',
        id: 'web-service-1',
        region: 'us-west-2',
        extra: {
          environment: 'production',
          version: '1.2.3',
        },
      });
    });

    it('should build identity information', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        orgId: 42,
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          fingerprint: 'unique-fingerprint-123',
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);

      expect(result.identity).toMatchObject({
        org_id: '42',
        rule_id: 'unique-fingerprint-123',
      });
    });

    it('should build links with URL validation', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          annotations: {
            ...testGrafanaPayloads.firing.alerts[0].annotations,
            runbook_url: 'https://runbooks.example.com/test',
          },
          dashboardURL: 'https://grafana.example.com/dashboard/123',
          generatorURL: 'https://grafana.example.com/alert/456',
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);

      expect(result.links).toMatchObject({
        runbook_url: 'https://runbooks.example.com/test',
        dashboard_url: 'https://grafana.example.com/dashboard/123',
        source_url: 'https://grafana.example.com/alert/456',
      });
    });

    it('should filter out invalid URLs', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          annotations: {
            ...testGrafanaPayloads.firing.alerts[0].annotations,
            runbook_url: 'javascript:alert(1)', // Invalid protocol
          },
          dashboardURL: 'not-a-url', // Invalid format
          generatorURL: '', // Empty URL
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);

      expect(result.links.runbook_url).toBeUndefined();
      expect(result.links.dashboard_url).toBeUndefined();
      expect(result.links.source_url).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should throw error for invalid payload', () => {
      expect(() => transformer.transform(null, mockEnvelope))
        .toThrow('Invalid Grafana payload: not an object');

      expect(() => transformer.transform('invalid', mockEnvelope))
        .toThrow('Invalid Grafana payload: not an object');
    });

    it('should throw error for missing priority', () => {
      const payload = {
        ...testGrafanaPayloads.missingTeam,
        alerts: [{
          ...testGrafanaPayloads.missingTeam.alerts[0],
          annotations: {}, // No priority
        }],
      };

      expect(() => transformer.transform(payload, mockEnvelope))
        .toThrow(/Missing required.*[Pp]riority/);
    });

    it('should throw error for missing team', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          annotations: {
            Priority: 'P1', // Has priority but no team
          },
          labels: {}, // No team in labels either
        }],
      };

      expect(() => transformer.transform(payload, mockEnvelope))
        .toThrow(/Missing required.*[Tt]eam/);
    });

    // Note: Detailed error message tests removed due to debugContext dependency
    // These would be better as integration tests
  });

  describe('resource type extraction', () => {
    it('should map known resource types', () => {
      const testCases = [
        { resource_type: 'runner', expected: 'runner' },
        { resource_type: 'instance', expected: 'instance' },
        { resource_type: 'job', expected: 'job' },
        { resource_type: 'service', expected: 'service' },
        { resource_type: 'RUNNER', expected: 'runner' }, // Case insensitive
        { resource_type: 'unknown-type', expected: 'generic' }, // Fallback
      ];

      testCases.forEach(({ resource_type, expected }) => {
        const payload = {
          ...testGrafanaPayloads.firing,
          alerts: [{
            ...testGrafanaPayloads.firing.alerts[0],
            labels: { alertname: 'Test', resource_type },
          }],
        };

        const result = transformer.transform(payload, mockEnvelope);
        expect(result.resource.type).toBe(expected);
      });
    });
  });

  describe('data sanitization', () => {
    it('should sanitize description and reason fields', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        message: '<script>alert("xss")</script>Some reason',
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          annotations: {
            ...testGrafanaPayloads.firing.alerts[0].annotations,
            description: '<script>alert("xss")</script>Some description',
          },
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);

      expect(result.description).not.toContain('<script>');
      expect(result.reason).not.toContain('<script>');
      expect(result.description).toContain('Some description');
      expect(result.reason).toContain('Some reason');
    });

    it('should respect field length limits', () => {
      const longDescription = 'a'.repeat(2000);
      const longReason = 'b'.repeat(3000);

      const payload = {
        ...testGrafanaPayloads.firing,
        message: longReason,
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          annotations: {
            ...testGrafanaPayloads.firing.alerts[0].annotations,
            description: longDescription,
          },
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);

      expect(result.description).toHaveLength(1500); // Limit from transformer
      expect(result.reason).toHaveLength(2000); // Limit from transformer
    });
  });

  describe('priority and team extraction', () => {
    it('should extract priority from annotations first', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        priority: 'P3', // Lower priority
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          annotations: {
            ...testGrafanaPayloads.firing.alerts[0].annotations,
            Priority: 'P1', // Higher priority in annotations
          },
          labels: {
            priority: 'P2', // Middle priority in labels
          },
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);
      expect(result.priority).toBe('P1'); // Should use annotations first
    });

    it('should fallback through priority sources', () => {
      const payload = {
        ...testGrafanaPayloads.firing,
        priority: 'P3', // Fallback source
        alerts: [{
          ...testGrafanaPayloads.firing.alerts[0],
          annotations: {
            Team: 'dev-infra', // Has team but no priority
          },
          labels: {
            priority: 'P2', // Should use this
          },
        }],
      };

      const result = transformer.transform(payload, mockEnvelope);
      expect(result.priority).toBe('P2');
    });

    it('should extract team from different annotation keys', () => {
      const testCases = [
        { Team: 'dev-infra', expected: 'dev-infra' },
        { TEAM: 'platform', expected: 'platform' },
        { team: 'security', expected: 'security' },
      ];

      testCases.forEach(({ expected, ...annotations }) => {
        const payload = {
          ...testGrafanaPayloads.firing,
          alerts: [{
            ...testGrafanaPayloads.firing.alerts[0],
            annotations: {
              Priority: 'P1',
              ...annotations,
            },
          }],
        };

        const result = transformer.transform(payload, mockEnvelope);
        expect(result.team).toBe(expected);
      });
    });
  });
});