#!/usr/bin/env node

/**
 * Test script to demonstrate the distinction between:
 * 1. User-actionable errors (missing config in alerts) - "Please add this to make the alert work"
 * 2. System/corruption errors (AWS/Grafana data issues) - "This indicates corrupted data"
 */

const fs = require('fs');
const path = require('path');
const { AlertProcessor } = require('./lambdas/collector/dist/processor');

function createMockSQSRecord(payload, source = null) {
  return {
    messageId: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    body: JSON.stringify(payload),
    messageAttributes: source ? { source: { stringValue: source, dataType: 'String' } } : {},
    attributes: { ApproximateReceiveCount: '1' },
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:test-alerts-queue'
  };
}

async function testSpecificError(testName, payload, expectedSource) {
  console.log(`\n🧪 Testing: ${testName}`);

  try {
    const sqsRecord = createMockSQSRecord(payload, expectedSource);
    const processor = new AlertProcessor();
    const result = await processor.processRecord(sqsRecord);

    if (!result.success) {
      console.log(`✅ Expected error: ${result.error}`);
      return result.error;
    } else {
      console.log(`❌ Expected error but processing succeeded`);
      return null;
    }
  } catch (error) {
    console.log(`✅ Expected error: ${error.message}`);
    return error.message;
  }
}

async function runErrorTypeTests() {
  console.log('🚀 Testing Error Message Types');
  console.log('===============================');

  // Test 1: User-actionable error - Missing Priority in Grafana
  const grafanaMissingPriority = {
    receiver: "sns",
    status: "firing",
    orgId: 1,
    alerts: [{
      status: "firing",
      labels: { alertname: "Test Alert" },
      annotations: { Team: "dev-infra", description: "Test" },
      startsAt: "2025-09-16T17:19:40Z",
      generatorURL: "https://grafana.example.com/test123",
      fingerprint: "test123"
    }],
    externalURL: "https://grafana.example.com",
    title: "[FIRING:1] Test Alert",
    state: "alerting"
  };

  // Test 2: User-actionable error - Missing Team in Grafana
  const grafanaMissingTeam = {
    receiver: "sns",
    status: "firing",
    orgId: 1,
    alerts: [{
      status: "firing",
      labels: { alertname: "Test Alert" },
      annotations: { Priority: "P1", description: "Test" },
      startsAt: "2025-09-16T17:19:40Z",
      generatorURL: "https://grafana.example.com/test123",
      fingerprint: "test123"
    }],
    externalURL: "https://grafana.example.com",
    title: "[FIRING:1] Test Alert",
    state: "alerting"
  };

  // Test 3: User-actionable error - Missing PRIORITY in CloudWatch
  const cloudwatchMissingPriority = {
    "Type": "Notification",
    "Message": JSON.stringify({
      "AlarmName": "Test-Alarm",
      "AlarmDescription": "TEAM=dev-infra",  // Missing PRIORITY
      "AWSAccountId": "123456789012",
      "NewStateValue": "ALARM",
      "StateChangeTime": "2025-09-03T19:10:01.000Z",
      "Region": "US East - N. Virginia",
      "AlarmArn": "arn:aws:cloudwatch:us-east-1:123456789012:alarm:Test-Alarm"
    })
  };

  // Test 4: System/corruption error - Missing NewStateValue in CloudWatch
  const cloudwatchCorrupted = {
    "Type": "Notification",
    "Message": JSON.stringify({
      "AlarmName": "Test-Alarm",
      "AlarmDescription": "TEAM=dev-infra | PRIORITY=P1",
      "AWSAccountId": "123456789012",
      // Missing NewStateValue - this indicates AWS corruption
      "StateChangeTime": "2025-09-03T19:10:01.000Z",
      "Region": "US East - N. Virginia",
      "AlarmArn": "arn:aws:cloudwatch:us-east-1:123456789012:alarm:Test-Alarm"
    })
  };

  // Test 5: System/corruption error - Invalid status from Grafana
  const grafanaCorrupted = {
    receiver: "sns",
    status: "invalid_status_from_grafana",  // Corrupted status
    orgId: 1,
    alerts: [{
      status: "invalid_status_from_grafana",
      labels: { alertname: "Test Alert" },
      annotations: { Priority: "P1", Team: "dev-infra" },
      startsAt: "2025-09-16T17:19:40Z",
      generatorURL: "https://grafana.example.com/test123",
      fingerprint: "test123"
    }],
    title: "[FIRING:1] Test Alert",
    state: "invalid_status_from_grafana"
  };

  const tests = [
    { name: "Grafana Missing Priority (USER CONFIG)", payload: grafanaMissingPriority, source: "grafana", expectUserAction: true },
    { name: "Grafana Missing Team (USER CONFIG)", payload: grafanaMissingTeam, source: "grafana", expectUserAction: true },
    { name: "CloudWatch Missing PRIORITY (USER CONFIG)", payload: cloudwatchMissingPriority, source: "cloudwatch", expectUserAction: true },
    { name: "CloudWatch Missing NewStateValue (SYSTEM CORRUPTION)", payload: cloudwatchCorrupted, source: "cloudwatch", expectUserAction: false },
    { name: "Grafana Invalid Status (SYSTEM CORRUPTION)", payload: grafanaCorrupted, source: "grafana", expectUserAction: false }
  ];

  let correctlyClassified = 0;

  for (const test of tests) {
    const errorMessage = await testSpecificError(test.name, test.payload, test.source);

    if (errorMessage) {
      const hasUserAction = errorMessage.includes("Please add this to make the alert work");
      const hasCorruptionIndication = errorMessage.includes("This indicates corrupted data") ||
                                      errorMessage.includes("This may indicate corrupted data");

      if (test.expectUserAction && hasUserAction && !hasCorruptionIndication) {
        console.log(`   ✅ Correctly classified as USER-ACTIONABLE error`);
        correctlyClassified++;
      } else if (!test.expectUserAction && hasCorruptionIndication && !hasUserAction) {
        console.log(`   ✅ Correctly classified as SYSTEM/CORRUPTION error`);
        correctlyClassified++;
      } else {
        console.log(`   ❌ Incorrectly classified error type`);
        console.log(`      Expected user-actionable: ${test.expectUserAction}`);
        console.log(`      Has user action text: ${hasUserAction}`);
        console.log(`      Has corruption text: ${hasCorruptionIndication}`);
      }
    } else {
      console.log(`   ❌ No error occurred when one was expected`);
    }
  }

  console.log('\n📊 Error Classification Results');
  console.log('===============================');
  console.log(`Correctly Classified: ${correctlyClassified}/${tests.length}`);
  console.log(`User-Actionable Errors: Should include "Please add this to make the alert work"`);
  console.log(`System/Corruption Errors: Should include "This indicates corrupted data"`);

  if (correctlyClassified === tests.length) {
    console.log('🎉 All error types correctly classified!');
    process.exit(0);
  } else {
    console.log('💥 Some errors were incorrectly classified!');
    process.exit(1);
  }
}

// Check if compiled files exist
if (!fs.existsSync('./lambdas/collector/dist')) {
  console.error('❌ Compiled files not found. Please run "npm run build" first.');
  process.exit(1);
}

runErrorTypeTests().catch(error => {
  console.error('💥 Error classification test failed:', error);
  process.exit(1);
});