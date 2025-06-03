const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env.local') });

// Environment validation tests
class EnvironmentTester {
  constructor() {
    this.results = [];
  }

  async runTest(name, testFn) {
    console.log(`Testing: ${name}`);
    try {
      const result = await testFn();
      this.results.push({ name, status: 'pass', result });
      console.log(`✅ ${name}: PASS`);
      return result;
    } catch (error) {
      this.results.push({ name, status: 'fail', error: error.message });
      console.log(`❌ ${name}: FAIL - ${error.message}`);
      return null;
    }
  }

  async testNodeVersion() {
    return new Promise((resolve, reject) => {
      const process = spawn('node', ['--version'], { stdio: 'pipe' });
      let output = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          const version = output.trim();
          const majorVersion = parseInt(version.slice(1).split('.')[0]);
          if (majorVersion >= 18) {
            resolve(`Node.js ${version} (>= 18 required)`);
          } else {
            reject(new Error(`Node.js ${version} is too old. >= 18 required`));
          }
        } else {
          reject(new Error('Node.js not found'));
        }
      });
    });
  }

  async testPythonVersion() {
    return new Promise((resolve, reject) => {
      const process = spawn('python3', ['--version'], { stdio: 'pipe' });
      let output = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          const version = output.trim();
          resolve(version);
        } else {
          reject(new Error('Python3 not found'));
        }
      });
    });
  }

  async testClaudeCLI() {
    return new Promise((resolve, reject) => {
      const process = spawn('claude', ['--version'], { stdio: 'pipe' });
      let output = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve(`Claude CLI ${output.trim()}`);
        } else {
          reject(new Error('Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code'));
        }
      });
    });
  }

  async testPythonMCP() {
    return new Promise((resolve, reject) => {
      const process = spawn('python3', ['-c', 'import mcp; print(f"MCP {mcp.__version__}")'], { stdio: 'pipe' });
      let output = '';
      let error = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.stderr.on('data', (data) => {
        error += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error('Python MCP not found. Install with: pip install mcp'));
        }
      });
    });
  }

  async testClickHouseMCP() {
    return new Promise((resolve, reject) => {
      const process = spawn('python3', ['-c', 'import clickhouse_mcp; print("ClickHouse MCP available")'], { stdio: 'pipe' });
      let output = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error('ClickHouse MCP not found. Install from GitHub repo'));
        }
      });
    });
  }

  async testGrafanaMCP() {
    return new Promise((resolve, reject) => {
      const process = spawn('python3', ['-c', 'import grafana_mcp; print("Grafana MCP available")'], { stdio: 'pipe' });
      let output = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error('Grafana MCP not found. Install from GitHub repo'));
        }
      });
    });
  }

  async testEnvironmentVariables() {
    const required = [
      'GRAFANA_URL',
      'GRAFANA_API_KEY',
      'CLICKHOUSE_HOST',
      'CLICKHOUSE_USER',
      'AWS_REGION'
    ];

    const missing = required.filter(name => !process.env[name]);
    
    if (missing.length > 0) {
      throw new Error(`Missing environment variables: ${missing.join(', ')}`);
    }

    const optional = [
      'CLICKHOUSE_PASSWORD',
      'CLICKHOUSE_PORT',
      'CLICKHOUSE_DATABASE',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY'
    ];

    const presentOptional = optional.filter(name => process.env[name]);
    
    return `Required: ${required.length}, Optional present: ${presentOptional.length}`;
  }

  async testGrafanaConnection() {
    const grafanaUrl = process.env.GRAFANA_URL;
    const apiKey = process.env.GRAFANA_API_KEY;
    
    if (!grafanaUrl || !apiKey) {
      throw new Error('Grafana URL or API key not configured');
    }

    // Test connection using curl (simple approach)
    return new Promise((resolve, reject) => {
      const process = spawn('curl', [
        '-H', `Authorization: Bearer ${apiKey}`,
        '-H', 'Content-Type: application/json',
        '--connect-timeout', '10',
        '--max-time', '30',
        `${grafanaUrl}/api/health`
      ], { stdio: 'pipe' });
      
      let output = '';
      let error = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.stderr.on('data', (data) => {
        error += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          try {
            const response = JSON.parse(output);
            resolve(`Grafana health: ${response.database || 'OK'}`);
          } catch {
            resolve('Grafana connection successful');
          }
        } else {
          reject(new Error(`Grafana connection failed: ${error}`));
        }
      });
    });
  }

  async testClickHouseConnection() {
    const host = process.env.CLICKHOUSE_HOST;
    const user = process.env.CLICKHOUSE_USER;
    
    if (!host || !user) {
      throw new Error('ClickHouse host or user not configured');
    }

    // Simple connection test using python
    const testScript = `
import sys
try:
    import clickhouse_connect
    client = clickhouse_connect.get_client(
        host='${host}',
        port=${process.env.CLICKHOUSE_PORT || 8443},
        username='${user}',
        password='${process.env.CLICKHOUSE_PASSWORD || ''}',
        secure=True
    )
    result = client.query('SELECT 1 as test')
    print(f"ClickHouse connection successful: {result.result_rows[0][0]}")
except Exception as e:
    print(f"ClickHouse connection failed: {e}", file=sys.stderr)
    sys.exit(1)
`;

    return new Promise((resolve, reject) => {
      const process = spawn('python3', ['-c', testScript], { stdio: 'pipe' });
      let output = '';
      let error = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.stderr.on('data', (data) => {
        error += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error(error.trim() || 'ClickHouse connection failed'));
        }
      });
    });
  }

  async runAllTests() {
    console.log('=== Environment Tests ===\n');

    // Core dependencies
    await this.runTest('Node.js Version', () => this.testNodeVersion());
    await this.runTest('Python Version', () => this.testPythonVersion());
    await this.runTest('Claude CLI', () => this.testClaudeCLI());
    await this.runTest('Python MCP Framework', () => this.testPythonMCP());
    
    // MCP packages
    await this.runTest('ClickHouse MCP Package', () => this.testClickHouseMCP());
    await this.runTest('Grafana MCP Package', () => this.testGrafanaMCP());
    
    // Configuration
    await this.runTest('Environment Variables', () => this.testEnvironmentVariables());
    
    // External connections
    await this.runTest('Grafana Connection', () => this.testGrafanaConnection());
    await this.runTest('ClickHouse Connection', () => this.testClickHouseConnection());

    // Summary
    console.log('\n=== Environment Test Summary ===');
    const passed = this.results.filter(r => r.status === 'pass').length;
    const failed = this.results.filter(r => r.status === 'fail').length;
    
    console.log(`Total tests: ${this.results.length}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    if (failed > 0) {
      console.log('\n=== Failed Tests ===');
      this.results.filter(r => r.status === 'fail').forEach(result => {
        console.log(`❌ ${result.name}: ${result.error}`);
      });
    }

    return this.results;
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  const tester = new EnvironmentTester();
  tester.runAllTests().then(results => {
    const hasFailures = results.some(r => r.status !== 'pass');
    process.exit(hasFailures ? 1 : 0);
  }).catch(error => {
    console.error('Environment tests failed:', error);
    process.exit(1);
  });
}

module.exports = { EnvironmentTester };