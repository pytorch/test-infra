FROM python:3.11-slim

# Build for linux/amd64 architecture (force rebuild)
WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy proxy code
COPY proxy.py .

# Run as non-root user
RUN useradd -m -u 1000 proxyuser && chown -R proxyuser:proxyuser /app
USER proxyuser

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"

# Expose port
EXPOSE 8080

# Run proxy
CMD ["python", "-u", "proxy.py"]
