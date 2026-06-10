#!/bin/bash

# Test streaming support

echo "Testing non-streaming request to local backend..."
curl -s http://localhost:3000/v1/models -H "Content-Type: application/json"
echo ""
echo ""

echo "Testing streaming request (if OpenAI backend is configured)..."
curl -s -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4-turbo-preview",
    "messages": [{"role": "user", "content": "Hello, just say hi"}],
    "stream": true,
    "max_tokens": 50
  }' | head -20

echo ""
echo "Testing health check endpoint..."
curl -s http://localhost:3000/_health | jq .
