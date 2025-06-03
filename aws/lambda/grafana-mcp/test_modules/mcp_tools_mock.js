// Mock MCP Tools for testing
const MCP_TOOLS = {
  // Grafana MCP tools
  'mcp__grafana-mcp__get_dashboard': { 
    service: 'http://grafana-mcp-service:8000', 
    method: 'get_dashboard' 
  },
  'mcp__grafana-mcp__create_dashboard': { 
    service: 'http://grafana-mcp-service:8000', 
    method: 'create_dashboard' 
  },
  'mcp__grafana-mcp__update_dashboard': { 
    service: 'http://grafana-mcp-service:8000', 
    method: 'update_dashboard' 
  },
  'mcp__grafana-mcp__list_datasources': { 
    service: 'http://grafana-mcp-service:8000', 
    method: 'list_datasources' 
  },
  'mcp__grafana-mcp__create_datasource': { 
    service: 'http://grafana-mcp-service:8000', 
    method: 'create_datasource' 
  },
  
  // ClickHouse MCP tools
  'mcp__clickhouse-pip__readme_howto_use_clickhouse_tools': { 
    service: 'http://clickhouse-mcp-service:8001', 
    method: 'readme_howto_use_clickhouse_tools' 
  },
  'mcp__clickhouse-pip__run_clickhouse_query': { 
    service: 'http://clickhouse-mcp-service:8001', 
    method: 'run_clickhouse_query' 
  },
  'mcp__clickhouse-pip__get_clickhouse_schema': { 
    service: 'http://clickhouse-mcp-service:8001', 
    method: 'get_clickhouse_schema' 
  },
  'mcp__clickhouse-pip__get_query_execution_stats': { 
    service: 'http://clickhouse-mcp-service:8001', 
    method: 'get_query_execution_stats' 
  },
  'mcp__clickhouse-pip__explain_clickhouse_query': { 
    service: 'http://clickhouse-mcp-service:8001', 
    method: 'explain_clickhouse_query' 
  },
  'mcp__clickhouse-pip__get_clickhouse_tables': { 
    service: 'http://clickhouse-mcp-service:8001', 
    method: 'get_clickhouse_tables' 
  },
  'mcp__clickhouse-pip__get_query_details': { 
    service: 'http://clickhouse-mcp-service:8001', 
    method: 'get_query_details' 
  },
  'mcp__clickhouse-pip__semantic_search_docs': { 
    service: 'http://clickhouse-mcp-service:8001', 
    method: 'semantic_search_docs' 
  },
  'mcp__clickhouse-pip__lint_clickhouse_query': { 
    service: 'http://clickhouse-mcp-service:8001', 
    method: 'lint_clickhouse_query' 
  }
};

module.exports = { MCP_TOOLS };