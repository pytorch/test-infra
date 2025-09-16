import { describe, it, expect } from 'vitest';
import { generateFingerprint } from '../src/fingerprint';
import { testAlertEvents } from './utils/test-fixtures';

describe('generateFingerprint', () => {
  it('should generate consistent fingerprints for identical alerts', () => {
    const alert1 = testAlertEvents.grafanaFiring;
    const alert2 = { ...testAlertEvents.grafanaFiring };

    const fingerprint1 = generateFingerprint(alert1);
    const fingerprint2 = generateFingerprint(alert2);

    expect(fingerprint1).toBe(fingerprint2);
    expect(fingerprint1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex format
  });

  it('should generate different fingerprints for different alerts', () => {
    const alert1 = testAlertEvents.grafanaFiring;
    const alert2 = testAlertEvents.cloudwatchAlarm;

    const fingerprint1 = generateFingerprint(alert1);
    const fingerprint2 = generateFingerprint(alert2);

    expect(fingerprint1).not.toBe(fingerprint2);
  });

  it('should ignore timestamp and raw_provider changes', () => {
    const alert1 = testAlertEvents.grafanaFiring;
    const alert2 = {
      ...testAlertEvents.grafanaFiring,
      occurred_at: '2025-09-16T14:00:00.000Z', // Different timestamp
      raw_provider: { different: 'data' }, // Different raw data
    };

    const fingerprint1 = generateFingerprint(alert1);
    const fingerprint2 = generateFingerprint(alert2);

    expect(fingerprint1).toBe(fingerprint2);
  });

  it('should change fingerprint when title changes', () => {
    const baseAlert = testAlertEvents.grafanaFiring;
    const modifiedAlert = { ...baseAlert, title: 'Different Title' };

    const baseFingerprint = generateFingerprint(baseAlert);
    const modifiedFingerprint = generateFingerprint(modifiedAlert);

    expect(modifiedFingerprint).not.toBe(baseFingerprint);
  });

  it('should change fingerprint when resource changes', () => {
    const baseAlert = testAlertEvents.grafanaFiring;
    const modifiedAlert = {
      ...baseAlert,
      resource: { ...baseAlert.resource, id: 'different-id' }
    };

    const baseFingerprint = generateFingerprint(baseAlert);
    const modifiedFingerprint = generateFingerprint(modifiedAlert);

    expect(modifiedFingerprint).not.toBe(baseFingerprint);
  });

  it('should be consistent across state changes', () => {
    const firingAlert = testAlertEvents.grafanaFiring;
    const resolvedAlert = {
      ...testAlertEvents.grafanaFiring,
      state: 'RESOLVED' as const,
    };

    const firingFingerprint = generateFingerprint(firingAlert);
    const resolvedFingerprint = generateFingerprint(resolvedAlert);

    expect(firingFingerprint).toBe(resolvedFingerprint);
  });
});