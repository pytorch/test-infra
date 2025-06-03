#!/usr/bin/env node

/**
 * Test Suite Runner for Grafana MCP Lambda
 * 
 * Runs all test suites in sequence and provides comprehensive reporting
 */

const { execSync, spawn } = require('child_process');
const path = require('path');

class TestSuiteRunner {
  constructor() {
    this.testSuites = [
      {
        name: 'Unit Tests',
        script: 'yarn test:unit',
        description: 'Core functionality and component tests'
      },
      {
        name: 'Session Management Tests',
        script: 'test/test_session_management.js',
        description: 'Session persistence and isolation tests'
      }
    ];
    this.results = [];
  }

  async runTestSuite(suite) {
    console.log(`\n🚀 Running ${suite.name}`);
    console.log(`📝 ${suite.description}`);
    console.log('─'.repeat(60));
    
    return new Promise((resolve) => {
      const testProcess = spawn('bash', ['-c', suite.script], {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..')
      });
      
      testProcess.on('close', (code) => {
        const success = code === 0;
        this.results.push({
          name: suite.name,
          success,
          code
        });
        
        console.log(`\n${success ? '✅' : '❌'} ${suite.name} ${success ? 'PASSED' : 'FAILED'}`);
        resolve(success);
      });
      
      testProcess.on('error', (error) => {
        console.error(`❌ Failed to run ${suite.name}:`, error.message);
        this.results.push({
          name: suite.name,
          success: false,
          error: error.message
        });
        resolve(false);
      });
    });
  }

  async runAll() {
    console.log('🧪 Grafana MCP Lambda - Test Suite Runner');
    console.log('=' .repeat(60));
    console.log(`📊 Running ${this.testSuites.length} test suites`);
    
    // Check dependencies first
    console.log('\n🔍 Checking dependencies...');
    try {
      require('adm-zip');
      console.log('✅ adm-zip: Available');
    } catch (error) {
      console.log('❌ adm-zip: Missing - run npm install');
      return false;
    }
    
    // Run each test suite
    for (const suite of this.testSuites) {
      await this.runTestSuite(suite);
    }
    
    // Generate final report
    this.generateReport();
    
    // Return overall success
    return this.results.every(result => result.success);
  }

  generateReport() {
    console.log('\n' + '=' .repeat(60));
    console.log('📋 TEST SUITE SUMMARY');
    console.log('=' .repeat(60));
    
    const passed = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;
    
    console.log(`📊 Overall Results: ${passed} passed, ${failed} failed`);
    console.log('');
    
    for (const result of this.results) {
      const status = result.success ? '✅ PASS' : '❌ FAIL';
      console.log(`${status} ${result.name}`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    }
    
    if (failed === 0) {
      console.log('\n🎉 All test suites passed!');
      console.log('🚀 Your Grafana MCP Lambda is ready for deployment');
      console.log('\nNext steps:');
      console.log('1. Build the Lambda package: make deployment.zip');
      console.log('2. Deployment is handled by CI/CD in pytorch-gha-infra');
    } else {
      console.log('\n💥 Some test suites failed');
      console.log('🔧 Please fix the failing tests before deployment');
    }
    
    console.log('=' .repeat(60));
  }
}

// Add some system information
function displaySystemInfo() {
  console.log('🖥️  System Information:');
  console.log(`   Node.js: ${process.version}`);
  console.log(`   Platform: ${process.platform}`);
  console.log(`   Architecture: ${process.arch}`);
  console.log(`   Working Directory: ${process.cwd()}`);
  
  try {
    const packageInfo = require('../package.json');
    console.log(`   Project: ${packageInfo.name} v${packageInfo.version}`);
  } catch (error) {
    console.log('   Project: Unknown');
  }
}

// Run individual test suite if specified
function runIndividualTest() {
  const testName = process.argv[2];
  if (!testName) return false;
  
  const testMap = {
    'unit': 'yarn test:unit',
    'session': 'test/test_session_management.js'
  };
  
  if (testMap[testName]) {
    console.log(`🎯 Running individual test: ${testName}`);
    try {
      execSync(`${testMap[testName]}`, { stdio: 'inherit' });
      return true;
    } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
      process.exit(1);
    }
  }
  
  return false;
}

// Main execution
async function main() {
  // Check if running individual test
  if (runIndividualTest()) {
    return;
  }
  
  displaySystemInfo();
  
  const runner = new TestSuiteRunner();
  const success = await runner.runAll();
  
  process.exit(success ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Test runner failed:', error);
    process.exit(1);
  });
}

module.exports = { TestSuiteRunner };