# Quick Start Guide

## Prerequisites Check

Ensure you have:
- Node.js v16+ installed
- eBay API credentials ready
- ShareTribe API credentials ready

## Installation (One-time setup)

### Option 1: Install everything at once (root level)
```bash
npm run install:all
```

### Option 2: Install separately
```bash
# Backend
cd backend
npm install
cd ..

# Frontend
cd frontend
npm install
```

## Configuration

### 1. Backend Environment Setup

```bash
cd backend
cp env.example .env
# Edit .env if needed (defaults should work for local development)
```

### 2. Initialize Database

```bash
cd backend
npm run migrate
# OR
node scripts/migrate.js
```

## Running the Application

### Start Backend (Terminal 1)

```bash
cd backend
npm run dev
# Backend will run on http://localhost:3001
```

### Start Frontend (Terminal 2)

```bash
cd frontend
npm run dev
# Frontend will run on http://localhost:3000
```

## First Steps

1. **Open the application**: Navigate to `http://localhost:3000`

2. **Configure APIs**:
   - Go to "API Configuration" tab
   - Enter your eBay API credentials
   - Enter your ShareTribe API credentials
   - Click "Test Connections" to verify
   - Click "Save Configuration"

3. **Set up Field Mappings**:
   - Go to "Field Mapping" tab
   - Map eBay fields to ShareTribe fields (defaults are pre-populated)
   - Click "Save Mappings"

4. **Refresh Products**:
   - Go to "Products & Sync" tab
   - Click "Refresh from eBay" to fetch your products

5. **Sync Products**:
   - Select products to sync, or
   - Click "Sync All" to sync all products
   - Monitor progress and check "Sync Logs" tab for details

## Troubleshooting

### Backend won't start
- Check if port 3001 is available
- Verify database directory is writable
- Check .env file exists

### Frontend won't connect to backend
- Ensure backend is running on port 3001
- Check CORS_ORIGIN in backend/.env matches frontend URL

### API connection errors
- Verify credentials are correct
- Check that tokens are not expired
- Review browser console and server logs for detailed errors

### Database errors
- Delete `backend/data/sync.db` to reset database
- Run migration again: `npm run migrate`


