# Quick Start: ngrok Setup for eBay OAuth

## 🚀 Complete Setup in 3 Steps

### Step 1: Start Your Servers

**Terminal 1 - Backend:**
```bash
cd backend
npm start
```
✅ Backend should be running on `http://localhost:3001`

**Terminal 2 - Frontend:**
```bash
cd frontend
npm run dev
```
✅ Frontend should be running on `http://localhost:3000`

### Step 2: Start ngrok

**Terminal 3 - ngrok:**
```bash
./start-ngrok.sh
```

You'll see output like:
```
Forwarding   https://abc123-def456.ngrok-free.app -> http://localhost:3000
```

**Copy the HTTPS URL** (e.g., `https://abc123-def456.ngrok-free.app`)

### Step 3: Configure URLs

#### In Your App (API Configuration Tab):

1. Open `http://localhost:3000` (or use the ngrok URL)
2. Go to **API Configuration** tab
3. Fill in eBay URLs (replace `abc123-def456.ngrok-free.app` with your actual ngrok URL):
   - **Privacy Policy URL**: `https://abc123-def456.ngrok-free.app/privacy-policy`
   - **Auth Accepted URL**: `https://abc123-def456.ngrok-free.app/auth/accepted`
   - **Auth Declined URL**: `https://abc123-def456.ngrok-free.app/auth/declined`
   - **OAuth Redirect URI**: `https://abc123-def456.ngrok-free.app/api/auth/ebay/callback`
4. Click **Save Configuration**

#### In eBay Developer Portal:

1. Go to [eBay Developer Portal](https://developer.ebay.com/)
2. Navigate to **My Account** → **Application Keys**
3. Select your app (Sandbox or Production)
4. Go to **Settings** tab
5. Fill in the **exact same URLs**:
   - **Your privacy policy URL**: `https://abc123-def456.ngrok-free.app/privacy-policy`
   - **Your auth accepted URL**: `https://abc123-def456.ngrok-free.app/auth/accepted`
   - **Your auth declined URL**: `https://abc123-def456.ngrok-free.app/auth/declined`
   - **Redirect URI (RuName)**: `https://abc123-def456.ngrok-free.app/api/auth/ebay/callback`
6. Click **Save**

## ✅ You're Done!

Now you can:
- Test eBay OAuth connection from the app
- Use HTTPS URLs for all eBay API requirements
- Access your app via the ngrok URL from anywhere

## 📝 Important Notes

- **Keep ngrok running**: Don't close the ngrok terminal while testing
- **URL changes**: Free ngrok URLs change when you restart ngrok (unless you have a paid plan)
- **Update both places**: If you restart ngrok, update URLs in both the app AND eBay Developer Portal

## 🐛 Troubleshooting

- **"ngrok: command not found"**: Run `brew install ngrok`
- **Port already in use**: Make sure ports 3000 and 3001 aren't already in use
- **OAuth fails**: Make sure URLs match exactly in both the app and eBay Developer Portal

