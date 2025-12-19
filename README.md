# eBay to ShareTribe Product Sync Integration

A comprehensive solution for synchronizing products from eBay to ShareTribe marketplace. This application provides a React-based frontend for managing field mappings, API configurations, and product sync operations, with a Node.js/Express backend that handles the synchronization logic and scheduled tasks.

## Features

- **API Configuration**: Configure eBay and ShareTribe API credentials through an intuitive interface
- **Field Mapping**: Map eBay product fields to ShareTribe listing fields with a visual drag-and-drop style interface
- **Product Management**: View, filter, and select products to sync from eBay to ShareTribe
- **Manual Sync**: Trigger product synchronization on-demand for selected or all products
- **Auto-Sync**: Automatic inventory synchronization every 6 hours
- **Sync Logs**: View detailed history of all sync operations with status tracking
- **Multi-Tenant Support**: Built with scalability in mind to support multiple businesses

## Project Structure

```
ebay-sync/
├── backend/                 # Node.js/Express backend
│   ├── config/             # Database configuration
│   ├── routes/             # API routes
│   ├── services/           # Business logic services
│   │   ├── ebayService.js      # eBay API integration
│   │   ├── sharetribeService.js # ShareTribe API integration
│   │   ├── syncService.js      # Sync orchestration
│   │   └── syncScheduler.js    # Auto-sync scheduler
│   ├── server.js           # Express server
│   └── package.json
├── frontend/               # React frontend
│   ├── src/
│   │   ├── components/     # React components
│   │   │   ├── ProductsTab.jsx
│   │   │   ├── SyncLogsTab.jsx
│   │   │   ├── ApiConfigTab.jsx
│   │   │   └── FieldMappingTab.jsx
│   │   ├── services/       # API service layer
│   │   ├── App.jsx
│   │   └── main.jsx
│   └── package.json
└── README.md
```

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- eBay API credentials (App ID, Cert ID, Dev ID, Access Token, Refresh Token)
- ShareTribe API credentials (API Key, API Secret, Marketplace ID)

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd ebay-sync
```

### 2. Backend Setup

```bash
cd backend
npm install
cp env.example .env
# Edit .env with your configuration
npm start
# For development with auto-reload:
npm run dev
```

### 3. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

The frontend will be available at `http://localhost:3000` and the backend at `http://localhost:3001`.

## Configuration

### Backend Environment Variables

Create a `.env` file in the `backend` directory:

```env
PORT=3001
NODE_ENV=development
DB_PATH=./data/sync.db
CORS_ORIGIN=http://localhost:3000
```

### API Configuration

1. Navigate to the **API Configuration** tab in the frontend
2. Enter your eBay API credentials:
   - App ID (Client ID)
   - Cert ID (Client Secret)
   - Dev ID
   - Access Token
   - Refresh Token
3. Enter your ShareTribe API credentials:
   - API Key
   - API Secret
   - Marketplace ID
4. Click **Test Connections** to verify your credentials
5. Click **Save Configuration** to store your settings

### Field Mapping

1. Navigate to the **Field Mapping** tab
2. Map eBay fields to ShareTribe fields using the dropdown menus
3. Common mappings include:
   - `title` → `title`
   - `description` → `description`
   - `price` → `price`
   - `images` → `images`
   - etc.
4. Click **Save Mappings** to store your configuration

## Usage

### Viewing Products

1. Navigate to the **Products & Sync** tab
2. Click **Refresh from eBay** to fetch the latest products from your eBay account
3. Use the search box and filters to find specific products
4. Products are categorized as:
   - **Synced**: Successfully synced to ShareTribe
   - **Not Synced**: Available but not yet synced
   - **Out of Stock**: Products with zero quantity

### Manual Sync

1. Select individual products using the checkboxes, or
2. Click **Sync All** to sync all products, or
3. Click **Sync Selected** to sync only selected products
4. Monitor the sync progress and results

### Auto-Sync

The application automatically syncs inventory every 6 hours. Sync logs can be viewed in the **Sync Logs** tab.

### Viewing Sync Logs

1. Navigate to the **Sync Logs** tab
2. View all sync operations with:
   - Status (success, failed, partial)
   - Sync type (manual or auto)
   - Number of products synced/failed
   - Timestamps
   - Error messages (if any)

## Database

The application uses SQLite by default for simplicity. The database is automatically created on first run. The schema includes:

- **tenants**: Multi-tenant support
- **api_config**: API credentials per tenant
- **field_mappings**: Field mapping configuration
- **products**: Cached eBay products with sync status
- **sync_logs**: History of sync operations

To migrate to PostgreSQL or another database, update the database configuration in `backend/config/database.js`.

## API Endpoints

### Configuration
- `GET /api/config` - Get API configuration
- `POST /api/config` - Save API configuration
- `POST /api/config/test` - Test API connections

### Field Mappings
- `GET /api/field-mappings` - Get field mappings
- `POST /api/field-mappings` - Save field mappings

### Products
- `GET /api/products` - Get products (supports `?synced=true/false&search=term`)
- `POST /api/products/refresh` - Refresh products from eBay

### Sync
- `POST /api/sync` - Manual sync (supports `{ item_ids: [...] }` body)

### Logs
- `GET /api/sync-logs` - Get sync logs (supports `?limit=50`)

## Multi-Tenant Support

The application is designed to support multiple tenants (businesses). Currently, it defaults to tenant ID 1. To support multiple tenants:

1. Add tenant authentication/authorization
2. Pass tenant ID via header: `X-Tenant-ID`
3. Each tenant will have isolated configuration, mappings, and products

## Development

### Backend Development

```bash
cd backend
npm run dev  # Uses nodemon for auto-reload
```

### Frontend Development

```bash
cd frontend
npm run dev  # Vite dev server with hot reload
```

## Production Deployment

### Backend

1. Set `NODE_ENV=production`
2. Configure production database
3. Set up proper CORS origins
4. Use a process manager like PM2:
   ```bash
   pm2 start backend/server.js --name ebay-sync-backend
   ```

### Frontend

1. Build the production bundle:
   ```bash
   cd frontend
   npm run build
   ```
2. Serve the `dist` folder using a web server (nginx, Apache, etc.)
3. Configure the backend API URL in production

## Troubleshooting

### API Connection Issues

- Verify your API credentials are correct
- Check that your access tokens are valid and not expired
- Ensure your IP is whitelisted (if required by eBay/ShareTribe)
- Check the browser console and server logs for detailed error messages

### Sync Failures

- Review sync logs in the **Sync Logs** tab
- Check that field mappings are correctly configured
- Verify that products have valid data for required fields
- Ensure ShareTribe marketplace is accessible

### Database Issues

- Check that the `data` directory exists and is writable
- Verify database file permissions
- If issues persist, delete the database file to reset (you'll need to reconfigure)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

[Specify your license here]

## Support

For issues and questions, please open an issue in the repository.
