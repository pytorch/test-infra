#!/usr/bin/env node

/**
 * Debug script to understand current behavior vs expected behavior
 */

const { GrafanaTransformer } = require('./lambdas/collector/dist/transformers/grafana');

const testPayload = {
  "received": "sns",
  "status": "firing",
  "orgId": 1,
  "alerts": [{
    "status": "firing",
    "labels": {
      "alertname": "TEST Alert that keeps toggling ~every 1 min",
      "grafana_folder": "TEST - alerts just for testing"
    },
    "annotations": {
      "CustomAnnotationPriority": "CustomAnnotationLow",  // Wrong field name!
      "TEAM": "pytorch-dev-infra",
      "description": "TEST_DESCRIPTION: This alert keeps toggling every minute."
    },
    "startsAt": "2025-09-16T17:19:40Z",
    "endsAt": "0001-01-01T00:00:00Z",
    "generatorURL": "https://pytorchci.grafana.net/alerting/grafana/fex6jh8jaew3kc/view?orgId=1",
    "fingerprint": "3201e9e1f14b433c"
  }],
  "groupLabels": {
    "alertname": "TEST Alert that keeps toggling ~every 1 min"
  },
  "externalURL": "https://pytorchci.grafana.net/",
  "version": "1",
  "title": "[FIRING:1] TEST Alert",
  "state": "alerting"
};

const envelope = {
  received_at: new Date().toISOString(),
  ingest_topic: 'test-topic',
  ingest_region: 'us-east-1',
  delivery_attempt: 1,
  event_id: 'test-123'
};

console.log('🧪 Testing direct transformer call...');
console.log('Expected: Should throw error about missing Priority field');
console.log('');

try {
  const transformer = new GrafanaTransformer();
  const result = transformer.transform(testPayload, envelope);
  console.log('❌ UNEXPECTED: Transform succeeded when it should have failed');
  console.log('Result:', {
    priority: result.priority,
    team: result.team,
    title: result.title
  });
} catch (error) {
  console.log('✅ EXPECTED: Transform failed as expected');
  console.log('Error:', error.message);
}