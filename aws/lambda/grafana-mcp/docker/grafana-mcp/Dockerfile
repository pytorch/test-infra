FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies including FastMCP
RUN pip install --no-cache-dir \
    git+https://github.com/wouterdevriendt/grafana-mcp.git \
    mcp>=1.3.0 \
    fastmcp \
    uvicorn

# Expose port for SSE
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run the MCP server via FastMCP with SSE support
CMD ["python", "-m", "fastmcp", "grafana_mcp", "--host", "0.0.0.0", "--port", "8000", "--sse"]