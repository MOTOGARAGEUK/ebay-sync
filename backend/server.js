require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const syncScheduler = require('./services/syncScheduler');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Request body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Serve uploaded files (for CSV processing) - create uploads directory if needed
const fs = require('fs');
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Routes
app.use('/api', apiRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Admin/Debug Interface
app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Backend Admin - eBay Sync</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #f5f5f5;
      padding: 20px;
      color: #333;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      background: #2563eb;
      color: white;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    h1 { font-size: 24px; margin-bottom: 10px; }
    nav {
      background: white;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    nav a {
      display: inline-block;
      padding: 10px 20px;
      margin-right: 10px;
      background: #2563eb;
      color: white;
      text-decoration: none;
      border-radius: 5px;
      transition: background 0.2s;
    }
    nav a:hover { background: #1d4ed8; }
    nav a.active { background: #1e40af; }
    .content {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .log-container {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 15px;
      border-radius: 5px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      max-height: 600px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .log-line {
      margin-bottom: 2px;
    }
    .log-error { color: #f48771; }
    .log-success { color: #89d185; }
    .log-info { color: #4ec9b0; }
    .refresh-btn {
      background: #10b981;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 5px;
      cursor: pointer;
      margin-bottom: 15px;
      font-size: 14px;
    }
    .refresh-btn:hover { background: #059669; }
    .auto-refresh {
      display: inline-block;
      margin-left: 10px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: #f9fafb;
      padding: 15px;
      border-radius: 5px;
      border-left: 4px solid #2563eb;
    }
    .stat-label { font-size: 12px; color: #6b7280; text-transform: uppercase; }
    .stat-value { font-size: 24px; font-weight: bold; color: #111827; margin-top: 5px; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }
    th {
      background: #f9fafb;
      font-weight: 600;
      color: #374151;
    }
    tr:hover { background: #f9fafb; }
    .json-view {
      background: #f9fafb;
      padding: 15px;
      border-radius: 5px;
      overflow-x: auto;
      font-family: 'Courier New', monospace;
      font-size: 12px;
    }
    .loading { color: #6b7280; font-style: italic; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔧 Backend Admin Panel</h1>
      <p>eBay to ShareTribe Sync - Debug & Monitoring</p>
    </header>
    
    <nav>
      <a href="/" class="active" onclick="loadPage('home'); return false;">Home</a>
      <a href="/logs" onclick="loadPage('logs'); return false;">Logs</a>
      <a href="/products" onclick="loadPage('products'); return false;">Products</a>
      <a href="/api-data" onclick="loadPage('api-data'); return false;">API Data</a>
      <a href="/asset-delivery" onclick="loadPage('asset-delivery'); return false;">Asset Delivery API</a>
    </nav>
    
    <div class="content" id="content">
      <div id="home-page">
        <h2>Welcome to Backend Admin</h2>
        <p style="margin: 15px 0;">Use the navigation above to view different sections:</p>
        <ul style="margin-left: 20px; line-height: 1.8;">
          <li><strong>Logs</strong> - View server logs in real-time</li>
          <li><strong>Products</strong> - View synced products from database</li>
          <li><strong>API Data</strong> - View recent API responses and sync data</li>
          <li><strong>Asset Delivery API</strong> - View raw Asset Delivery API responses for listing types</li>
        </ul>
        
        <div class="stats" id="stats">
          <div class="stat-card">
            <div class="stat-label">Server Status</div>
            <div class="stat-value" id="server-status">Loading...</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Products</div>
            <div class="stat-value" id="total-products">-</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Synced Products</div>
            <div class="stat-value" id="synced-products">-</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    let autoRefreshInterval = null;
    
    function loadPage(page) {
      // Update nav
      document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
      event.target.classList.add('active');
      
      const content = document.getElementById('content');
      
      if (page === 'home') {
        content.innerHTML = document.getElementById('home-page').innerHTML;
        loadStats();
      } else if (page === 'logs') {
        content.innerHTML = \`
          <h2>Server Logs</h2>
          <button class="refresh-btn" onclick="loadLogs()">🔄 Refresh Logs</button>
          <label class="auto-refresh">
            <input type="checkbox" id="auto-refresh" onchange="toggleAutoRefresh()"> Auto-refresh (5s)
          </label>
          <div class="log-container" id="log-container">
            <div class="loading">Loading logs...</div>
          </div>
        \`;
        loadLogs();
      } else if (page === 'products') {
        content.innerHTML = \`
          <h2>Products</h2>
          <button class="refresh-btn" onclick="loadProducts()">🔄 Refresh</button>
          <div id="products-container">
            <div class="loading">Loading products...</div>
          </div>
        \`;
        loadProducts();
      } else if (page === 'api-data') {
        content.innerHTML = \`
          <h2>Recent API Data</h2>
          <button class="refresh-btn" onclick="loadApiData()">🔄 Refresh</button>
          <div id="api-data-container">
            <div class="loading">Loading API data...</div>
          </div>
        \`;
        loadApiData();
      } else if (page === 'asset-delivery') {
        content.innerHTML = \`
          <h2>Asset Delivery API Response</h2>
          <button class="refresh-btn" onclick="loadAssetDeliveryApi()">🔄 Fetch Latest Response</button>
          <div id="asset-delivery-container">
            <div class="loading">Loading Asset Delivery API response...</div>
          </div>
        \`;
        loadAssetDeliveryApi();
      }
    }
    
    async function loadStats() {
      try {
        const res = await fetch('/api/products');
        const products = await res.json();
        const synced = products.filter(p => p.synced).length;
        
        document.getElementById('server-status').textContent = '✅ Running';
        document.getElementById('total-products').textContent = products.length;
        document.getElementById('synced-products').textContent = synced;
      } catch (e) {
        document.getElementById('server-status').textContent = '❌ Error';
        console.error(e);
      }
    }
    
    async function loadLogs() {
      try {
        const res = await fetch('/api/admin/logs');
        const data = await res.json();
        const container = document.getElementById('log-container');
        
        if (data.logs && data.logs.length > 0) {
          container.innerHTML = data.logs.map(line => {
            let className = 'log-line';
            if (line.includes('error') || line.includes('Error') || line.includes('ERROR')) className += ' log-error';
            else if (line.includes('success') || line.includes('Success') || line.includes('SUCCESS')) className += ' log-success';
            else if (line.includes('info') || line.includes('Info') || line.includes('INFO')) className += ' log-info';
            return \`<div class="\${className}">\${escapeHtml(line)}</div>\`;
          }).join('');
          container.scrollTop = container.scrollHeight;
        } else {
          container.innerHTML = '<div class="loading">No logs available</div>';
        }
      } catch (e) {
        document.getElementById('log-container').innerHTML = '<div class="log-error">Error loading logs: ' + e.message + '</div>';
      }
    }
    
    async function loadProducts() {
      try {
        const res = await fetch('/api/products');
        const products = await res.json();
        const container = document.getElementById('products-container');
        
        if (products.length === 0) {
          container.innerHTML = '<p>No products found.</p>';
          return;
        }
        
        container.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>eBay Item ID</th>
                <th>Title</th>
                <th>Price</th>
                <th>Synced</th>
                <th>ShareTribe ID</th>
                <th>Last Synced</th>
              </tr>
            </thead>
            <tbody>
              \${products.map(p => \`
                <tr>
                  <td>\${escapeHtml(p.ebay_item_id || '-')}</td>
                  <td>\${escapeHtml(p.title || '-')}</td>
                  <td>\${p.price ? p.currency + ' ' + p.price : '-'}</td>
                  <td>\${p.synced ? '✅' : '❌'}</td>
                  <td>\${escapeHtml(p.sharetribe_listing_id || '-')}</td>
                  <td>\${p.last_synced_at ? new Date(p.last_synced_at).toLocaleString() : '-'}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } catch (e) {
        document.getElementById('products-container').innerHTML = '<div class="log-error">Error loading products: ' + e.message + '</div>';
      }
    }
    
    async function loadApiData() {
      try {
        const res = await fetch('/api/admin/api-data');
        const data = await res.json();
        const container = document.getElementById('api-data-container');
        
        let html = '<h3>ShareTribe API Responses</h3>';
        
        if (data.sharetribeResponses && data.sharetribeResponses.length > 0) {
          html += '<p style="margin-bottom: 15px;">Showing ' + data.sharetribeResponses.length + ' most recent responses</p>';
          
          data.sharetribeResponses.forEach((response, index) => {
            const createResp = response.createResponse || {};
            const sentPayload = response.sentPayload || {};
            const showResp = createResp.showResponse || {};
            const comparison = createResp.comparison || {};
            const sentPayloadJson = JSON.stringify(sentPayload, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const createRespJson = JSON.stringify(createResp.data || createResp, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const showRespJson = JSON.stringify(showResp, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const timestamp = new Date(response.timestamp).toLocaleString();
            const listingId = response.listingId || 'N/A';
            const ebayItemId = response.ebayItemId || 'Unknown';
            
            html += '<div style="margin-bottom: 30px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; background: #f9fafb;">';
            html += '<h4 style="margin-bottom: 10px; color: #2563eb;">Response ' + (index + 1) + ': ' + escapeHtml(ebayItemId) + '<span style="font-size: 12px; color: #6b7280; font-weight: normal;"> (' + timestamp + ')</span></h4>';
            html += '<div style="margin-bottom: 10px;"><strong>ShareTribe Listing ID:</strong> <code>' + escapeHtml(listingId) + '</code></div>';
            
            html += '<details style="margin-bottom: 10px;"><summary style="cursor: pointer; font-weight: bold; color: #374151; margin-bottom: 5px;">📤 Sent Payload</summary>';
            html += '<div class="json-view" style="margin-top: 10px;">' + sentPayloadJson + '</div></details>';
            
            html += '<details style="margin-bottom: 10px;"><summary style="cursor: pointer; font-weight: bold; color: #374151; margin-bottom: 5px;">📥 Create Response</summary>';
            html += '<div class="json-view" style="margin-top: 10px;">' + createRespJson + '</div></details>';
            
            if (showResp.data || showResp.attributes) {
              html += '<details style="margin-bottom: 10px;"><summary style="cursor: pointer; font-weight: bold; color: #374151; margin-bottom: 5px;">✅ /listings/show Response</summary>';
              html += '<div class="json-view" style="margin-top: 10px;">' + showRespJson + '</div></details>';
            }
            
            if (comparison.missingInShow && comparison.missingInShow.length > 0) {
              html += '<div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 10px; margin-top: 10px; border-radius: 4px;">';
              html += '<strong style="color: #dc2626;">⚠️ Fields Rejected by ShareTribe:</strong>';
              html += '<ul style="margin-top: 5px; margin-left: 20px;">';
              comparison.missingInShow.forEach(field => {
                html += '<li><code>' + escapeHtml(field) + '</code></li>';
              });
              html += '</ul>';
              html += '<p style="margin-top: 5px; font-size: 12px; color: #991b1b;">These fields were sent but are not present in the /listings/show response. Check ShareTribe Console > Listings > Listing Fields to ensure they are configured.</p>';
              html += '</div>';
            }
            
            if (comparison.titleMatch && comparison.descriptionMatch && (!comparison.missingInShow || comparison.missingInShow.length === 0)) {
              html += '<div style="background: #f0fdf4; border-left: 4px solid #10b981; padding: 10px; margin-top: 10px; border-radius: 4px; color: #166534;">✅ All fields accepted successfully</div>';
            }
            
            html += '</div>';
          });
        } else {
          html += '<p style="color: #6b7280;">No ShareTribe API responses yet. Sync a product to see responses here.</p>';
        }
        
        html += '<hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">';
        html += '<h3>Recent Products</h3>';
        html += '<div class="json-view">' + JSON.stringify(data.recentProducts || [], null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
        
        container.innerHTML = html;
      } catch (e) {
        document.getElementById('api-data-container').innerHTML = '<div class="log-error">Error loading API data: ' + e.message + '</div>';
      }
    }
    
    function toggleAutoRefresh() {
      const checkbox = document.getElementById('auto-refresh');
      if (checkbox.checked) {
        autoRefreshInterval = setInterval(() => {
          if (document.getElementById('log-container')) {
            loadLogs();
          }
        }, 5000);
      } else {
        if (autoRefreshInterval) {
          clearInterval(autoRefreshInterval);
          autoRefreshInterval = null;
        }
      }
    }
    
    async function loadAssetDeliveryApi() {
      try {
        const res = await fetch('/api/admin/asset-delivery-api');
        const data = await res.json();
        const container = document.getElementById('asset-delivery-container');
        
        let html = '';
        
        if (data.error && !data.response) {
          html += '<div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; border-radius: 5px; margin-bottom: 15px;">';
          html += '<strong style="color: #dc2626;">Error:</strong> ' + escapeHtml(data.error);
          html += '</div>';
        }
        
        html += '<div style="margin-bottom: 20px;">';
        html += '<h3 style="margin-bottom: 10px;">Endpoint</h3>';
        html += '<div class="json-view" style="word-break: break-all;">' + escapeHtml(data.endpoint || 'N/A') + '</div>';
        html += '</div>';
        
        html += '<div style="margin-bottom: 20px;">';
        html += '<h3 style="margin-bottom: 10px;">Status</h3>';
        html += '<div style="font-size: 18px; font-weight: bold; color: ' + (data.status >= 200 && data.status < 300 ? '#10b981' : '#ef4444') + ';">';
        html += data.status || 'N/A';
        html += '</div>';
        html += '</div>';
        
        if (data.error) {
          html += '<div style="margin-bottom: 20px;">';
          html += '<h3 style="margin-bottom: 10px;">Error Details</h3>';
          html += '<div class="json-view">' + JSON.stringify(data.error, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
          html += '</div>';
        }
        
        html += '<div style="margin-bottom: 20px;">';
        html += '<h3 style="margin-bottom: 10px;">Full Response</h3>';
        html += '<details open><summary style="cursor: pointer; font-weight: bold; color: #374151; margin-bottom: 5px;">📥 Click to expand/collapse</summary>';
        html += '<div class="json-view" style="margin-top: 10px; max-height: 800px; overflow-y: auto;">';
        html += JSON.stringify(data.response, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html += '</div></details>';
        html += '</div>';
        
        html += '<div style="margin-bottom: 20px;">';
        html += '<h3 style="margin-bottom: 10px;">Response Analysis</h3>';
        if (data.response) {
          const response = data.response;
          let analysis = [];
          
          if (Array.isArray(response)) {
            analysis.push('✅ Response is an array');
            analysis.push('📊 Array length: ' + response.length);
            if (response.length > 0) {
              analysis.push('📋 First item keys: ' + Object.keys(response[0]).join(', '));
              analysis.push('📋 First item structure:');
              analysis.push(JSON.stringify(response[0], null, 2));
            }
          } else if (response && typeof response === 'object') {
            analysis.push('✅ Response is an object');
            analysis.push('📊 Object keys: ' + Object.keys(response).join(', '));
            if (response.data && Array.isArray(response.data)) {
              analysis.push('✅ Found data.data array with ' + response.data.length + ' items');
            }
            if (response.listingTypes && Array.isArray(response.listingTypes)) {
              analysis.push('✅ Found data.listingTypes array with ' + response.listingTypes.length + ' items');
            }
          }
          
          html += '<div class="json-view" style="white-space: pre-wrap;">' + analysis.join('\\n').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
        } else {
          html += '<div style="color: #6b7280;">No response data available</div>';
        }
        html += '</div>';
        
        html += '<div style="margin-bottom: 20px; font-size: 12px; color: #6b7280;">';
        html += 'Last fetched: ' + (data.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A');
        html += '</div>';
        
        container.innerHTML = html;
      } catch (e) {
        document.getElementById('asset-delivery-container').innerHTML = '<div class="log-error">Error loading Asset Delivery API response: ' + e.message + '</div>';
      }
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    // Load stats on page load
    loadStats();
  </script>
</body>
</html>
  `;
  res.send(html);
});

// Admin API endpoints
app.get('/api/admin/logs', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const logFile = path.join(__dirname, 'server.log');
  
  try {
    if (fs.existsSync(logFile)) {
      const logs = fs.readFileSync(logFile, 'utf8');
      const lines = logs.split('\\n').slice(-200); // Last 200 lines
      res.json({ logs: lines });
    } else {
      res.json({ logs: ['Log file not found'] });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/api-data', async (req, res) => {
  try {
    const db = require('./config/database');
    const dbInstance = db.getDb();
    const responseStore = require('./utils/responseStore');
    
    // Get recent products with sync info
    const products = await new Promise((resolve, reject) => {
      dbInstance.all(
        'SELECT ebay_item_id, title, synced, sharetribe_listing_id, last_synced_at, custom_fields FROM products ORDER BY last_synced_at DESC LIMIT 10',
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
    
    // Get ShareTribe API responses
    const sharetribeResponses = responseStore.getResponses(20);
    
    res.json({
      recentProducts: products,
      sharetribeResponses: sharetribeResponses,
      message: 'Recent sync data and ShareTribe API responses.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize database and start server
const db = require('./config/database');
db.init().then(() => {
  // Start sync scheduler
  syncScheduler.start();
  
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  syncScheduler.stop();
  db.close();
  process.exit(0);
});

