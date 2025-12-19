# ngrok Setup for eBay OAuth

This guide explains how to set up ngrok to expose your local development server for eBay OAuth integration.

## Prerequisites

1. **ngrok installed**: Already installed at `/opt/homebrew/bin/ngrok`
2. **Frontend running**: Port 3000 (Vite dev server)
3. **Backend running**: Port 3001 (Express API server)

## Quick Start

### 1. Start Your Servers

**Terminal 1 - Backend:**
```bash
cd backend
npm start
# Backend runs on http://localhost:3001
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm run dev
# Frontend runs on http://localhost:3000
```

### 2. Start ngrok

**Terminal 3 - ngrok:**
```bash
./start-ngrok.sh
```

Or manually:
```bash
ngrok http 3000
```

### 3. Get Your ngrok URL

Once ngrok starts, you'll see output like:
```
Forwarding   https://abc123-def456.ngrok-free.app -> http://localhost:3000
```

Copy the HTTPS URL (e.g., `https://abc123-def456.ngrok-free.app`)

### 4. Configure eBay URLs

#### In the App (API Configuration Tab):

1. Open the app at `http://localhost:3000` (or use the ngrok URL)
2. Go to **API Configuration** tab
3. Fill in the eBay URLs:
   - **Privacy Policy URL**: `https://abc123-def456.ngrok-free.app/privacy-policy`
   - **Auth Accepted URL**: `https://abc123-def456.ngrok-free.app/auth/accepted` (optional)
   - **Auth Declined URL**: `https://abc123-def456.ngrok-free.app/auth/declined` (optional)
   - **OAuth Redirect URI**: `https://abc123-def456.ngrok-free.app/api/auth/ebay/callback`
4. Click **Save Configuration**

#### In eBay Developer Portal:

1. Go to [eBay Developer Portal](https://developer.ebay.com/)
2. Navigate to **My Account** → **Application Keys**
3. Select your app (Sandbox or Production)
4. Go to **Settings** tab
5. Fill in the same URLs:
   - **Your privacy policy URL**: `https://abc123-def456.ngrok-free.app/privacy-policy`
   - **Your auth accepted URL**: `https://abc123-def456.ngrok-free.app/auth/accepted` (optional)
   - **Your auth declined URL**: `https://abc123-def456.ngrok-free.app/auth/declined` (optional)
   - **Redirect URI (RuName)**: Either use your RuName OR `https://abc123-def456.ngrok-free.app/api/auth/ebay/callback`
6. Click **Save**

## Important Notes

- **ngrok URL changes**: Free ngrok URLs change every time you restart ngrok (unless you have a paid plan with a static domain)
- **Keep ngrok running**: Don't close the ngrok terminal while testing OAuth
- **Update URLs**: If you restart ngrok and get a new URL, update both the app config and eBay Developer Portal
- **Privacy Policy**: You'll need to create a `/privacy-policy` route/page in your app (or use a placeholder)

## Creating Placeholder Pages (Optional)

If you want to create placeholder pages for the privacy policy and auth pages, you can add routes in your React app:

```jsx
// In App.jsx or your router
<Route path="/privacy-policy" element={<PrivacyPolicy />} />
<Route path="/auth/accepted" element={<AuthAccepted />} />
<Route path="/auth/declined" element={<AuthDeclined />} />
```

For now, eBay will just redirect to these URLs, but they don't need to exist for OAuth to work - the important URL is the callback URL (`/api/auth/ebay/callback`).

## Troubleshooting

- **"ngrok: command not found"**: Make sure ngrok is installed: `brew install ngrok`
- **"Address already in use"**: Make sure port 3000 isn't already in use
- **OAuth redirect fails**: Make sure the callback URL in eBay Developer Portal matches exactly (including `https://`)

