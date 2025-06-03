#!/usr/bin/env node

/**
 * Test script to verify MCP server connectivity
 * Run this after terraform deployment to test the complete pipeline
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function testMCPConnectivity() {
  console.log('Testing MCP server connectivity...');
  
  // Create a temporary directory
  const tempDir = `/tmp/mcp_connectivity_test_${Date.now()}`;
  fs.mkdirSync(tempDir, { recursive: true });
  
  try {
    // Get the service URLs (these would come from terraform outputs in real scenario)
    const grafanaUrl = process.env.GRAFANA_MCP_URL || 'http://grafana-mcp-service.default.svc.cluster.local:8000';
    const clickhouseUrl = process.env.CLICKHOUSE_MCP_URL || 'http://clickhouse-mcp-service.default.svc.cluster.local:8001';
    
    console.log(`Testing Grafana MCP at: ${grafanaUrl}`);
    console.log(`Testing ClickHouse MCP at: ${clickhouseUrl}`);
    
    // Create mcp.json configuration
    const mcpConfig = {
      mcpServers: {
        grafana: {
          url: `${grafanaUrl}/sse`,
          type: "sse"
        },
        clickhouse: {
          url: `${clickhouseUrl}/sse`, 
          type: "sse"
        }
      }
    };
    
    fs.writeFileSync(path.join(tempDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2));
    console.log('Created mcp.json configuration');
    
    // Test simple Claude command with MCP
    const testQuery = 'List available tools from both MCP servers';
    
    console.log('Running Claude with MCP configuration...');
    
    const claudeProcess = spawn('claude', [
      '-p', testQuery,
      '--output-format', 'json',
      '--mcp-config', path.join(tempDir, 'mcp.json'),
      '--allowedTools', 'mcp__grafana-mcp__list_datasources,mcp__clickhouse-pip__get_clickhouse_tables'
    ], {
      cwd: tempDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let output = '';
    let error = '';
    
    claudeProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    claudeProcess.stderr.on('data', (data) => {
      error += data.toString();
    });
    
    claudeProcess.on('close', (code) => {
      console.log(`\nClaude process exited with code: ${code}`);
      
      if (output) {
        console.log('Output:', output);
      }
      
      if (error) {
        console.log('Error:', error);
      }
      
      if (code === 0) {
        console.log('✅ MCP connectivity test passed');
      } else {
        console.log('❌ MCP connectivity test failed');
      }
      
      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
    
  } catch (err) {
    console.error('Test failed:', err);
    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Run the test
if (require.main === module) {
  testMCPConnectivity();
}

module.exports = { testMCPConnectivity };