const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '../.env.local') });

// Test MCP server connectivity independently
class MCPTester {
  constructor() {
    this.tempDir = null;
  }

  async setup() {
    // Create temporary directory
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    
    // Create MCP config
    const mcpConfig = {
      mcpServers: {
        grafana: {
          command: "python",
          args: ["-m", "grafana_mcp"],
          env: {}
        },
        clickhouse: {
          command: "python", 
          args: ["-m", "clickhouse_mcp"],
          env: {}
        }
      },
      allowedTools: [
        "mcp__grafana-mcp__*",
        "mcp__clickhouse-pip__*"
      ]
    };

    const mcpConfigPath = path.join(this.tempDir, 'mcp.json');
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Create .env file
    const envPath = path.join(this.tempDir, '.env');
    const envVars = Object.keys(process.env)
      .filter(key => 
        key.startsWith('GRAFANA_') || 
        key.startsWith('CLICKHOUSE_') || 
        key.startsWith('AWS_')
      )
      .map(key => `${key}=${process.env[key]}`)
      .join('\n');
    fs.writeFileSync(envPath, envVars);

    return mcpConfigPath;
  }

  async cleanup() {
    if (this.tempDir && fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }

  async testMCPServer(serverName, testQueries) {
    console.log(`\n=== Testing ${serverName} MCP Server ===`);
    
    const mcpConfigPath = await this.setup();
    
    const results = [];
    
    for (const query of testQueries) {
      console.log(`Testing query: ${query}`);
      
      try {
        const result = await this.runClaudeQuery(mcpConfigPath, query);
        results.push({
          query,
          status: 'success',
          output: result.output,
          error: result.error
        });
        console.log(`✅ Query successful`);
      } catch (error) {
        results.push({
          query,
          status: 'error',
          error: error.message
        });
        console.log(`❌ Query failed: ${error.message}`);
      }
    }
    
    await this.cleanup();
    return results;
  }

  async runClaudeQuery(mcpConfigPath, query) {
    return new Promise((resolve, reject) => {
      const claudeArgs = [
        '-p', mcpConfigPath,
        '--model', 'claude-3-5-sonnet-20241022',
        '--no-stream'  // Easier for testing
      ];

      const claudeProcess = spawn('claude', claudeArgs, {
        cwd: this.tempDir,
        env: {
          ...process.env,
          PYTHONPATH: process.env.PYTHONPATH || ''
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      claudeProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      claudeProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      claudeProcess.on('close', (code) => {
        if (code === 0) {
          resolve({ output: stdout, error: stderr });
        } else {
          reject(new Error(`Claude process exited with code ${code}: ${stderr}`));
        }
      });

      claudeProcess.on('error', (error) => {
        reject(error);
      });

      // Send query and close stdin
      claudeProcess.stdin.write(query);
      claudeProcess.stdin.end();

      // Timeout after 2 minutes
      setTimeout(() => {
        claudeProcess.kill('SIGTERM');
        reject(new Error('Query timeout'));
      }, 120000);
    });
  }
}

// Test queries for different MCP servers
const clickhouseQueries = [
  'List all available ClickHouse tables',
  'Show me the schema for the default database',
  'What tools are available for ClickHouse?'
];

const grafanaQueries = [
  'List all available Grafana datasources', 
  'What Grafana tools are available?',
  'Show me how to create a simple dashboard'
];

const integrationQueries = [
  'Get ClickHouse tables and create a simple Grafana dashboard',
  'Query ClickHouse data and visualize it in Grafana'
];

// Main test runner
async function runMCPTests() {
  console.log('Starting MCP Integration Tests\n');
  
  const tester = new MCPTester();
  
  try {
    // Test ClickHouse MCP
    const clickhouseResults = await tester.testMCPServer('ClickHouse', clickhouseQueries);
    
    // Test Grafana MCP  
    const grafanaResults = await tester.testMCPServer('Grafana', grafanaQueries);
    
    // Test integration
    const integrationResults = await tester.testMCPServer('Integration', integrationQueries);
    
    // Summary
    console.log('\n=== MCP Test Summary ===');
    
    const allResults = [...clickhouseResults, ...grafanaResults, ...integrationResults];
    const successful = allResults.filter(r => r.status === 'success').length;
    const failed = allResults.filter(r => r.status === 'error').length;
    
    console.log(`Total MCP tests: ${allResults.length}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${failed}`);
    
    // Detailed results
    console.log('\n=== Detailed Results ===');
    allResults.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.query}`);
      console.log(`   Status: ${result.status}`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
      if (result.output && result.output.length > 0) {
        console.log(`   Output: ${result.output.substring(0, 200)}...`);
      }
    });
    
    return allResults;
    
  } catch (error) {
    console.error('MCP test runner failed:', error);
    throw error;
  }
}

module.exports = {
  MCPTester,
  runMCPTests
};

// Run tests if this file is executed directly
if (require.main === module) {
  runMCPTests().then(results => {
    const hasFailures = results.some(r => r.status !== 'success');
    process.exit(hasFailures ? 1 : 0);
  }).catch(error => {
    console.error('MCP tests failed:', error);
    process.exit(1);
  });
}