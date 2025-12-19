#!/bin/bash

# Start ngrok to expose the frontend (port 3000)
# The frontend proxies /api requests to the backend (port 3001)

echo "🚀 Starting ngrok tunnel for eBay Sync App..."
echo "📡 Exposing frontend on port 3000"
echo ""
echo "⚠️  Make sure your frontend is running on port 3000"
echo "⚠️  Make sure your backend is running on port 3001"
echo ""
echo "Once ngrok starts, you'll see a Forwarding URL like:"
echo "   https://abc123.ngrok.io -> http://localhost:3000"
echo ""
echo "Use this URL for your eBay Developer Portal settings:"
echo "   - Privacy Policy URL: https://abc123.ngrok.io/privacy-policy"
echo "   - Auth Accepted URL: https://abc123.ngrok.io/auth/accepted"
echo "   - Auth Declined URL: https://abc123.ngrok.io/auth/declined"
echo "   - OAuth Redirect URI: https://abc123.ngrok.io/api/auth/ebay/callback"
echo ""
echo "Press Ctrl+C to stop ngrok"
echo ""

ngrok http 3000

