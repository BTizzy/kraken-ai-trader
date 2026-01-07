#!/bin/bash
# start.sh - Start the Polymarket Trading Server

echo "🚀 Starting Polymarket Trading Server..."

cd "$(dirname "$0")"

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Kill any existing server on port 8000
pkill -f "node server.js" 2>/dev/null
pkill -f "python3 -m http.server 8000" 2>/dev/null

# Wait a moment
sleep 1

# Start the Node.js server
node server.js
