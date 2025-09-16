#!/usr/bin/env node

/**
 * Test script for alert normalization logic
 *
 * Usage:
 *   node test-normalization.js
 *
 * This script:
 * 1. Loads test payloads from test-data directory
 * 2. Simulates SQS record structure
 * 3. Tests the normalization pipeline
 * 4. Validates fingerprint generation
 * 5. Checks expected field values
 */

const fs = require('fs');
const path = require('path');

// Import the compiled TypeScript modules
const { AlertProcessor } = require('./lambdas/collector/dist/processor');
const { generateFingerprint } = require('./lambdas/collector/dist/fingerprint');
const { getTransformerForRecord } = require('./lambdas/collector/dist/transformers');

const TEST_DATA_DIR = path.join(__dirname, 'lambdas/collector/test-data');

function loadTestPayload(filename) {
  const filePath = path.join(TEST_DATA_DIR, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createMockSQSRecord(payload, source = null) {
  const messageAttributes = source ? {
    source: {
      stringValue: source,
      dataType: 'String'
    }
  } : {};

  return {
    messageId: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    body: JSON.stringify(payload),
    messageAttributes,
    attributes: {
      ApproximateReceiveCount: '1'
    },
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:test-alerts-queue'
  };
}

async function testTransformer(testName, filename, expectedSource, expectedValues = {}) {
  console.log(`\n🧪 Testing: ${testName}`);
  console.log(`📁 File: ${filename}`);

  try {
    // Load test payload
    const payload = loadTestPayload(filename);

    // Create mock SQS record
    const sqsRecord = createMockSQSRecord(payload, expectedSource);

    // Test transformer selection
    const transformer = getTransformerForRecord(sqsRecord);
    console.log(`🔄 Transformer: ${transformer.constructor.name}`);

    // Create processor and normalize
    const processor = new AlertProcessor();
    const result = await processor.processRecord(sqsRecord);

    if (!result.success) {
      console.error(`❌ Processing failed: ${result.error}`);
      return false;
    }

    const { fingerprint, metadata } = result;
    const alertEvent = metadata.alertEvent;

    console.log(`🔑 Fingerprint: ${fingerprint}`);
    console.log(`📊 Normalized Alert:`);
    console.log(`   Source: ${alertEvent.source}`);
    console.log(`   Title: ${alertEvent.title}`);
    console.log(`   Team: ${alertEvent.team}`);
    console.log(`   Priority: ${alertEvent.priority}`);
    console.log(`   State: ${alertEvent.state}`);
    console.log(`   Occurred At: ${alertEvent.occurred_at}`);

    // Validate expected values
    let validationsPassed = 0;
    let totalValidations = 0;

    for (const [field, expectedValue] of Object.entries(expectedValues)) {
      totalValidations++;
      const actualValue = alertEvent[field];
      if (actualValue === expectedValue) {
        console.log(`✅ ${field}: ${actualValue}`);
        validationsPassed++;
      } else {
        console.log(`❌ ${field}: expected '${expectedValue}', got '${actualValue}'`);
      }
    }

    // Test fingerprint consistency
    const fingerprint2 = generateFingerprint(alertEvent);
    if (fingerprint === fingerprint2) {
      console.log(`✅ Fingerprint consistency: ${fingerprint}`);
      validationsPassed++;
    } else {
      console.log(`❌ Fingerprint inconsistency: ${fingerprint} !== ${fingerprint2}`);
    }
    totalValidations++;

    const success = validationsPassed === totalValidations;
    console.log(`📈 Validation Score: ${validationsPassed}/${totalValidations} ${success ? '✅' : '❌'}`);

    return success;

  } catch (error) {
    console.error(`💥 Test failed with error: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

async function runAllTests() {
  console.log('🚀 Starting Alert Normalization Tests');
  console.log('=====================================');

  const tests = [
    {
      name: 'Grafana Firing Alert',
      filename: 'grafana-firing.json',
      expectedSource: 'grafana',
      expectedValues: {
        source: 'grafana',
        team: 'dev-infra',
        priority: 'P1',
        state: 'FIRING',
        title: 'Runners Scale Up Failure'
      }
    },
    {
      name: 'Grafana Resolved Alert',
      filename: 'grafana-resolved.json',
      expectedSource: 'grafana',
      expectedValues: {
        source: 'grafana',
        team: 'dev-infra',
        priority: 'P1',
        state: 'RESOLVED',
        title: 'Runners Scale Up Failure'
      }
    },
    {
      name: 'CloudWatch Alarm',
      filename: 'cloudwatch-alarm.json',
      expectedSource: 'cloudwatch',
      expectedValues: {
        source: 'cloudwatch',
        team: 'dev-infra',
        priority: 'P1',
        state: 'FIRING',
        title: 'Runners-ASG-InsufficientInstances'
      }
    },
    {
      name: 'CloudWatch OK',
      filename: 'cloudwatch-ok.json',
      expectedSource: 'cloudwatch',
      expectedValues: {
        source: 'cloudwatch',
        team: 'dev-infra',
        priority: 'P1',
        state: 'RESOLVED',
        title: 'Runners-ASG-InsufficientInstances'
      }
    },
    {
      name: 'Grafana Missing Team (Fallback)',
      filename: 'grafana-missing-team.json',
      expectedSource: 'grafana',
      expectedValues: {
        source: 'grafana',
        team: 'unknown',
        priority: 'P0',
        state: 'FIRING',
        title: 'Database Connection Failure'
      }
    },
    {
      name: 'CloudWatch Missing Priority (Fallback)',
      filename: 'cloudwatch-missing-priority.json',
      expectedSource: 'cloudwatch',
      expectedValues: {
        source: 'cloudwatch',
        team: 'platform-team',
        priority: 'P3',
        state: 'FIRING',
        title: 'CPU-Utilization-High'
      }
    }
  ];

  let passedTests = 0;

  for (const test of tests) {
    const success = await testTransformer(
      test.name,
      test.filename,
      test.expectedSource,
      test.expectedValues
    );

    if (success) {
      passedTests++;
    }
  }

  console.log('\n📊 Test Summary');
  console.log('================');
  console.log(`Total Tests: ${tests.length}`);
  console.log(`Passed: ${passedTests}`);
  console.log(`Failed: ${tests.length - passedTests}`);

  if (passedTests === tests.length) {
    console.log('🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('💥 Some tests failed!');
    process.exit(1);
  }
}

// Check if compiled files exist
if (!fs.existsSync('./lambdas/collector/dist')) {
  console.error('❌ Compiled files not found. Please run "npm run build" first.');
  console.error('   cd alerting-tf/lambdas/collector && npm run build');
  process.exit(1);
}

// Run the tests
runAllTests().catch(error => {
  console.error('💥 Test suite failed:', error);
  process.exit(1);
});