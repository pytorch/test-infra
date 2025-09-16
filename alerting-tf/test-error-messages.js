#!/usr/bin/env node

/**
 * Test script to demonstrate improved error messages
 */

const fs = require('fs');
const path = require('path');
const { AlertProcessor } = require('./lambdas/collector/dist/processor');

function loadTestPayload(filename) {
  const filePath = path.join(__dirname, 'lambdas/collector/test-data', filename);
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

async function testErrorMessage(testName, filename, expectedSource) {
  console.log(`\n🧪 Testing: ${testName}`);
  console.log(`📁 File: ${filename}`);

  try {
    // Load test payload
    const payload = loadTestPayload(filename);

    // Create mock SQS record
    const sqsRecord = createMockSQSRecord(payload, expectedSource);

    // Create processor and try to normalize (should fail)
    const processor = new AlertProcessor();
    const result = await processor.processRecord(sqsRecord);

    if (!result.success) {
      console.log(`✅ Expected error occurred: ${result.error}`);
      return true;
    } else {
      console.log(`❌ Expected error but processing succeeded unexpectedly`);
      return false;
    }

  } catch (error) {
    console.log(`✅ Expected error occurred: ${error.message}`);
    return true;
  }
}

async function runErrorTests() {
  console.log('🚀 Testing Improved Error Messages');
  console.log('===================================');

  const tests = [
    {
      name: 'Grafana Missing Priority Field (User Config Issue)',
      filename: 'grafana-absolutely-no-priority.json',
      expectedSource: 'grafana'
    },
    {
      name: 'CloudWatch Missing NewStateValue (AWS Corruption)',
      filename: 'cloudwatch-corrupted.json',
      expectedSource: 'cloudwatch'
    }
  ];

  let passedTests = 0;

  for (const test of tests) {
    const success = await testErrorMessage(
      test.name,
      test.filename,
      test.expectedSource
    );

    if (success) {
      passedTests++;
    }
  }

  console.log('\n📊 Error Test Summary');
  console.log('======================');
  console.log(`Total Tests: ${tests.length}`);
  console.log(`Passed: ${passedTests}`);
  console.log(`Failed: ${tests.length - passedTests}`);

  if (passedTests === tests.length) {
    console.log('🎉 All error message tests passed!');
    process.exit(0);
  } else {
    console.log('💥 Some error message tests failed!');
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
runErrorTests().catch(error => {
  console.error('💥 Error test suite failed:', error);
  process.exit(1);
});