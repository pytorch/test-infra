import { describe, it, expect, beforeEach } from 'vitest';
import { GrafanaTransformer } from '../src/transformers/grafana';
import { CloudWatchTransformer } from '../src/transformers/cloudwatch';
import { generateFingerprint } from '../src/fingerprint';
import { testGrafanaPayloads, testCloudWatchPayloads, testAlertEvents } from './utils/test-fixtures';

describe('Basic Functionality Tests', () => {
  const mockEnvelope = {
    event_id: 'test-event-123',
    source: 'test',
    timestamp: '2025-09-16T12:00:00.000Z',
  };

  describe('GrafanaTransformer', () => {
    let transformer: GrafanaTransformer;

    beforeEach(() => {
      transformer = new GrafanaTransformer();
    });

    it('should transform basic Grafana firing alert', () => {
      const result = transformer.transform(testGrafanaPayloads.firing, mockEnvelope);

      expect(result.source).toBe('grafana');
      expect(result.state).toBe('FIRING');
      expect(result.title).toBe('Test Alert');
      expect(result.team).toBe('dev-infra');
      expect(result.priority).toBe('P1');
    });

    it('should transform basic Grafana resolved alert', () => {
      const result = transformer.transform(testGrafanaPayloads.resolved, mockEnvelope);

      expect(result.source).toBe('grafana');
      expect(result.state).toBe('RESOLVED');
      expect(result.title).toBe('Test Alert');
    });
  });

  describe('CloudWatchTransformer', () => {
    let transformer: CloudWatchTransformer;

    beforeEach(() => {
      transformer = new CloudWatchTransformer();
    });

    it('should transform basic CloudWatch alarm', () => {
      const result = transformer.transform(testCloudWatchPayloads.alarm, mockEnvelope);

      expect(result.source).toBe('cloudwatch');
      expect(result.state).toBe('FIRING');
      expect(result.title).toBe('High CPU Usage');
      expect(result.team).toBe('platform');
      expect(result.priority).toBe('P2');
    });

    it('should transform basic CloudWatch OK state', () => {
      const result = transformer.transform(testCloudWatchPayloads.ok, mockEnvelope);

      expect(result.source).toBe('cloudwatch');
      expect(result.state).toBe('RESOLVED');
      expect(result.title).toBe('High CPU Usage');
    });
  });

  describe('Fingerprint Generation', () => {
    it('should generate consistent fingerprints', () => {
      const alert1 = testAlertEvents.grafanaFiring;
      const alert2 = { ...testAlertEvents.grafanaFiring };

      const fingerprint1 = generateFingerprint(alert1);
      const fingerprint2 = generateFingerprint(alert2);

      expect(fingerprint1).toBe(fingerprint2);
      expect(fingerprint1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate different fingerprints for different titles', () => {
      const alert1 = testAlertEvents.grafanaFiring;
      const alert2 = { ...testAlertEvents.grafanaFiring, title: 'Different Alert Title' };

      const fingerprint1 = generateFingerprint(alert1);
      const fingerprint2 = generateFingerprint(alert2);

      expect(fingerprint1).not.toBe(fingerprint2);
    });

    it('should ignore timestamp differences', () => {
      const alert1 = testAlertEvents.grafanaFiring;
      const alert2 = { ...testAlertEvents.grafanaFiring, occurred_at: '2025-09-16T14:00:00.000Z' };

      const fingerprint1 = generateFingerprint(alert1);
      const fingerprint2 = generateFingerprint(alert2);

      expect(fingerprint1).toBe(fingerprint2);
    });
  });
});