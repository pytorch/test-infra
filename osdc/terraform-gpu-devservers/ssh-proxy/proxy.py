#!/usr/bin/env python3
"""
SSH Proxy Server using WebSocket tunneling
Receives WebSocket connections from clients and forwards to SSH servers (NodePorts)
"""

import asyncio
import socket
import logging
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
import boto3
from botocore.exceptions import ClientError
import websockets
from websockets.server import serve
import json

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

# Environment variables
DOMAIN_MAPPINGS_TABLE = os.environ.get("SSH_DOMAIN_MAPPINGS_TABLE", "")
AWS_REGION = os.environ.get("AWS_DEFAULT_REGION", "us-west-1")

# DynamoDB client
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)


def get_target_from_hostname(hostname: str) -> tuple:
    """
    Look up target IP and port from hostname in DynamoDB

    Args:
        hostname: Full hostname (e.g., ocean_rat.test.devservers.io)

    Returns:
        Tuple of (target_ip, target_port) or (None, None) if not found
    """
    if not DOMAIN_MAPPINGS_TABLE:
        logger.error("SSH_DOMAIN_MAPPINGS_TABLE environment variable not set")
        return None, None

    try:
        # Extract subdomain (first part before first dot)
        subdomain = hostname.split('.')[0]

        table = dynamodb.Table(DOMAIN_MAPPINGS_TABLE)
        response = table.get_item(Key={"domain_name": subdomain})

        if "Item" not in response:
            logger.warning(f"Domain not found in DynamoDB: {subdomain}")
            return None, None

        item = response["Item"]
        # Support both old (node_ip/node_port) and new (target_host/target_port) field names
        target_ip = item.get("target_host") or item.get("node_ip")
        target_port = int(item.get("target_port") or item.get("node_port", 22))

        logger.info(f"Resolved {hostname} -> {target_ip}:{target_port}")
        return target_ip, target_port

    except ClientError as e:
        logger.error(f"DynamoDB error looking up {hostname}: {e}")
        return None, None
    except Exception as e:
        logger.error(f"Error looking up {hostname}: {e}")
        return None, None


async def tunnel_ssh(websocket, target_ip: str, target_port: int, hostname: str):
    """
    Bidirectional tunnel between WebSocket and SSH server

    Args:
        websocket: WebSocket connection from client
        target_ip: Target SSH server IP
        target_port: Target SSH server port
        hostname: Hostname for logging
    """
    try:
        # Connect to SSH server
        reader, writer = await asyncio.open_connection(target_ip, target_port)
        logger.info(f"Connected to SSH server {target_ip}:{target_port} for {hostname}")

        async def ws_to_ssh():
            """Forward data from WebSocket to SSH server"""
            try:
                async for message in websocket:
                    if isinstance(message, bytes):
                        writer.write(message)
                        await writer.drain()
            except websockets.exceptions.ConnectionClosed:
                logger.info(f"WebSocket closed for {hostname}")
            except Exception as e:
                logger.error(f"Error in ws_to_ssh for {hostname}: {e}")
            finally:
                writer.close()
                await writer.wait_closed()

        async def ssh_to_ws():
            """Forward data from SSH server to WebSocket"""
            try:
                while True:
                    data = await reader.read(8192)
                    if not data:
                        break
                    await websocket.send(data)
            except websockets.exceptions.ConnectionClosed:
                logger.info(f"WebSocket closed for {hostname}")
            except Exception as e:
                logger.error(f"Error in ssh_to_ws for {hostname}: {e}")

        # Run both directions concurrently
        await asyncio.gather(ws_to_ssh(), ssh_to_ws())

    except Exception as e:
        logger.error(f"Error in tunnel for {hostname}: {e}")
    finally:
        logger.info(f"Tunnel closed for {hostname}")


async def handle_connection(websocket, path):
    """
    Handle incoming WebSocket connection

    Expects the path to be: /tunnel/<hostname>
    Where hostname is like ocean_rat.test.devservers.io
    """
    client_ip = websocket.remote_address[0]
    logger.info(f"New WebSocket connection from {client_ip} to {path}")

    try:
        # Parse path: /tunnel/hostname
        if not path.startswith("/tunnel/"):
            logger.warning(f"Invalid path from {client_ip}: {path}")
            await websocket.close(4000, "Invalid path - use /tunnel/<hostname>")
            return

        hostname = path[8:]  # Remove "/tunnel/" prefix

        if not hostname:
            logger.warning(f"Empty hostname from {client_ip}")
            await websocket.close(4000, "Hostname required")
            return

        # Look up target
        target_ip, target_port = get_target_from_hostname(hostname)

        if not target_ip or not target_port:
            logger.warning(f"Host not found for {hostname}")
            await websocket.close(4004, f"Host not found: {hostname}")
            return

        # Start tunneling
        await tunnel_ssh(websocket, target_ip, target_port, hostname)

    except Exception as e:
        logger.error(f"Error handling connection from {client_ip}: {e}", exc_info=True)
        try:
            await websocket.close(4500, "Internal server error")
        except:
            pass


class HealthCheckHandler(BaseHTTPRequestHandler):
    """Simple HTTP handler for health checks"""

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"OK")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        """Override to use our logger"""
        logger.info("%s - %s" % (self.client_address[0], format % args))


async def run_health_server():
    """Run HTTP health check server on port 8080"""
    server = HTTPServer(("0.0.0.0", 8080), HealthCheckHandler)
    logger.info("Health check server listening on port 8080")

    # Run in executor to not block async loop
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, server.serve_forever)


async def run_websocket_server():
    """Run WebSocket server on port 8081"""
    logger.info("Starting WebSocket SSH proxy server on port 8081")

    async with serve(handle_connection, "0.0.0.0", 8081):
        logger.info("WebSocket server ready")
        await asyncio.Future()  # Run forever


async def main():
    """Main entry point - run both servers"""
    if not DOMAIN_MAPPINGS_TABLE:
        logger.error("SSH_DOMAIN_MAPPINGS_TABLE environment variable not set")
        sys.exit(1)

    logger.info(f"Using DynamoDB table: {DOMAIN_MAPPINGS_TABLE}")
    logger.info(f"AWS Region: {AWS_REGION}")

    # Run both servers concurrently
    await asyncio.gather(
        run_health_server(),
        run_websocket_server()
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Shutting down...")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)
