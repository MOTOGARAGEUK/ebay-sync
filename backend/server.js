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
      <a href="/live-sync" onclick="loadPage('live-sync'); return false;">Live Sync</a>
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
      } else if (page === 'live-sync') {
        content.innerHTML = \`
          <h2>🔍 Live Sync Inspector</h2>
          <div style="margin-bottom: 20px;">
            <label style="margin-right: 15px;">
              <strong>Select Job:</strong>
              <select id="job-select" onchange="selectJob()" style="padding: 5px 10px; margin-left: 10px; border-radius: 4px; border: 1px solid #d1d5db;">
                <option value="">-- Select a sync job --</option>
              </select>
            </label>
            <button class="refresh-btn" onclick="refreshJobList()" style="margin-left: 10px;">🔄 Refresh Jobs</button>
          </div>
          
          <div id="job-summary" style="display: none; background: #f9fafb; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #2563eb;">
            <div class="stats" style="grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));">
              <div class="stat-card" style="border-left-color: #10b981;">
                <div class="stat-label">Status</div>
                <div class="stat-value" id="job-status" style="font-size: 18px;">-</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Products</div>
                <div class="stat-value" id="job-products">-</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Requests (60s)</div>
                <div class="stat-value" id="job-requests-60s">-</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Total Requests</div>
                <div class="stat-value" id="job-total-requests">-</div>
              </div>
              <div class="stat-card" style="border-left-color: #ef4444;">
                <div class="stat-label">429 Errors</div>
                <div class="stat-value" id="job-429-count">-</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Avg Latency</div>
                <div class="stat-value" id="job-avg-latency">-</div>
              </div>
            </div>
            <div style="margin-top: 15px; font-size: 12px; color: #6b7280;">
              <div>Throttle: <span id="job-throttle">-</span></div>
              <div>Last Event: <span id="job-last-event">-</span></div>
            </div>
          </div>
          
          <div style="margin-bottom: 15px;">
            <label style="margin-right: 15px;">
              <strong>Filters:</strong>
              <select id="status-filter" onchange="applyFilters()" style="padding: 5px 10px; margin-left: 10px; border-radius: 4px; border: 1px solid #d1d5db;">
                <option value="all">All Status</option>
                <option value="2xx">2xx Success</option>
                <option value="4xx">4xx Errors</option>
                <option value="429">429 Rate Limit</option>
              </select>
            </label>
            <label style="margin-right: 15px;">
              <input type="text" id="product-filter" placeholder="Product ID/SKU" onkeyup="applyFilters()" style="padding: 5px 10px; margin-left: 10px; border-radius: 4px; border: 1px solid #d1d5db; width: 200px;">
            </label>
            <label>
              <input type="checkbox" id="errors-only" onchange="applyFilters()" style="margin-left: 10px;">
              Errors Only
            </label>
          </div>
          
          <div id="live-sync-container">
            <div class="loading">Select a sync job to view live events...</div>
          </div>
        \`;
        refreshJobList();
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
    
    let currentJobId = null;
    let eventStream = null;
    let allEvents = [];
    let filteredEvents = [];
    
    async function refreshJobList() {
      try {
        const res = await fetch('/api/admin/sync/jobs');
        const data = await res.json();
        const select = document.getElementById('job-select');
        
        select.innerHTML = '<option value="">-- Select a sync job --</option>';
        data.jobs.forEach(job => {
          const option = document.createElement('option');
          option.value = job.jobId;
          option.textContent = \`Job \${job.jobId} (\${job.state}) - \${job.processed}/\${job.total}\`;
          select.appendChild(option);
        });
      } catch (e) {
        console.error('Error loading jobs:', e);
      }
    }
    
    async function selectJob() {
      const select = document.getElementById('job-select');
      const jobId = select.value;
      
      if (!jobId) {
        currentJobId = null;
        if (eventStream) {
          eventStream.close();
          eventStream = null;
        }
        document.getElementById('job-summary').style.display = 'none';
        document.getElementById('live-sync-container').innerHTML = '<div class="loading">Select a sync job to view live events...</div>';
        return;
      }
      
      currentJobId = jobId;
      allEvents = [];
      filteredEvents = [];
      
      // Load initial events
      await loadJobStatus();
      await loadJobEvents();
      
      // Start SSE stream
      startEventStream();
    }
    
    // Throttle status updates to once every 4 seconds
    let lastStatusUpdate = 0;
    const STATUS_UPDATE_THROTTLE = 4000; // 4 seconds
    
    function updateJobStatusUI(data) {
      if (!data) return;
      
      document.getElementById('job-summary').style.display = 'block';
      document.getElementById('job-status').textContent = data.state || '-';
      document.getElementById('job-status').style.color = data.state === 'RUNNING' ? '#10b981' : data.state === 'PAUSED' ? '#f59e0b' : data.state === 'COMPLETED' ? '#2563eb' : '#ef4444';
      document.getElementById('job-products').textContent = \`\${data.processed || 0}/\${data.total || 0}\`;
      document.getElementById('job-requests-60s').textContent = data.requestCounters?.last60s || 0;
      document.getElementById('job-total-requests').textContent = data.requestCounters?.total || 0;
      document.getElementById('job-429-count').textContent = data.requestCounters?.error429Count || 0;
      document.getElementById('job-avg-latency').textContent = \`\${data.requestCounters?.avgLatencyMs || 0}ms\`;
      document.getElementById('job-throttle').textContent = \`delay=\${data.throttleSettings?.minDelayMs || 0}ms, concurrency=\${data.throttleSettings?.concurrency || 100}\`;
      document.getElementById('job-last-event').textContent = data.lastEventAt ? new Date(data.lastEventAt).toLocaleString() : '-';
    }
    
    async function loadJobStatus() {
      if (!currentJobId) return;
      
      const now = Date.now();
      if (now - lastStatusUpdate < STATUS_UPDATE_THROTTLE) {
        return; // Throttled - skip this request
      }
      lastStatusUpdate = now;
      
      try {
        const res = await fetch(\`/api/admin/sync/jobs/\${currentJobId}/status\`);
        const data = await res.json();
        updateJobStatusUI(data);
      } catch (e) {
        console.error('Error loading job status:', e);
      }
    }
    
    async function loadJobEvents() {
      if (!currentJobId) return;
      
      try {
        const res = await fetch(\`/api/admin/sync/jobs/\${currentJobId}/events?limit=500\`);
        const data = await res.json();
        
        allEvents = data.events || [];
        applyFilters();
        
        // Refresh status
        await loadJobStatus();
      } catch (e) {
        console.error('Error loading events:', e);
        document.getElementById('live-sync-container').innerHTML = '<div class="log-error">Error loading events: ' + e.message + '</div>';
      }
    }
    
    function startEventStream() {
      if (!currentJobId) return;
      
      // Close existing stream
      if (eventStream) {
        eventStream.close();
      }
      
      const eventSource = new EventSource(\`/api/admin/sync/jobs/\${currentJobId}/events/stream\`);
      
      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'connected') {
          // Initial connection - update status from payload
          if (data.status) {
            updateJobStatusUI(data.status);
          }
        } else if (data.type === 'event') {
          // Add new event
          allEvents.unshift(data.event);
          // Keep only last 2000 events
          if (allEvents.length > 2000) {
            allEvents = allEvents.slice(0, 2000);
          }
          
          applyFilters();
          
          // Update status from SSE payload if included (every 3 seconds)
          if (data.status) {
            updateJobStatusUI(data.status);
          }
        } else if (data.type === 'ping') {
          // Heartbeat - update status from payload (every 15 seconds)
          if (data.status) {
            updateJobStatusUI(data.status);
          }
        }
      };
      
      eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        // Try to reconnect after 2 seconds
        setTimeout(() => {
          if (currentJobId) {
            startEventStream();
          }
        }, 2000);
      };
      
      eventStream = eventSource;
    }
    
    function applyFilters() {
      if (!currentJobId) return;
      
      const statusFilter = document.getElementById('status-filter')?.value || 'all';
      const productFilter = document.getElementById('product-filter')?.value?.toLowerCase() || '';
      const errorsOnly = document.getElementById('errors-only')?.checked || false;
      
      filteredEvents = allEvents.filter(event => {
        // Status filter
        if (statusFilter === '2xx' && (!event.statusCode || event.statusCode < 200 || event.statusCode >= 300)) return false;
        if (statusFilter === '4xx' && (!event.statusCode || event.statusCode < 400 || event.statusCode >= 500)) return false;
        if (statusFilter === '429' && event.statusCode !== 429) return false;
        
        // Product filter
        if (productFilter && !event.productId?.toLowerCase().includes(productFilter) && !event.listingId?.toLowerCase().includes(productFilter)) return false;
        
        // Errors only
        if (errorsOnly && (!event.statusCode || event.statusCode < 400)) return false;
        
        return true;
      });
      
      renderEvents();
    }
    
    function renderEvents() {
      const container = document.getElementById('live-sync-container');
      
      if (filteredEvents.length === 0) {
        container.innerHTML = '<div class="loading">No events match the current filters.</div>';
        return;
      }
      
      let html = '<table><thead><tr>';
      html += '<th>Time</th>';
      html += '<th>Product / Listing</th>';
      html += '<th>Operation</th>';
      html += '<th>Method + Path</th>';
      html += '<th>Status</th>';
      html += '<th>Duration</th>';
      html += '<th>Retry-After</th>';
      html += '<th>Message</th>';
      html += '</tr></thead><tbody>';
      
      filteredEvents.slice(0, 500).forEach(event => {
        const statusColor = event.statusCode === 429 ? '#ef4444' : 
                           event.statusCode >= 400 ? '#f59e0b' : 
                           event.statusCode >= 200 && event.statusCode < 300 ? '#10b981' : '#6b7280';
        
        html += '<tr style="cursor: pointer;" onclick="showEventDetails(' + JSON.stringify(event).replace(/"/g, '&quot;') + ')">';
        html += '<td>' + new Date(event.timestamp).toLocaleTimeString() + '</td>';
        html += '<td>' + (event.productId || '-') + '<br><small style="color: #6b7280;">' + (event.listingId || '-') + '</small></td>';
        html += '<td>' + escapeHtml(event.operation || '-') + '</td>';
        html += '<td><strong>' + escapeHtml(event.httpMethod || '-') + '</strong><br><small style="color: #6b7280;">' + escapeHtml(event.endpointPath || '-') + '</small></td>';
        html += '<td style="color: ' + statusColor + '; font-weight: bold;">' + (event.statusCode || 'ERROR') + '</td>';
        html += '<td>' + (event.durationMs || 0) + 'ms</td>';
        html += '<td>' + (event.retryAfterSeconds ? event.retryAfterSeconds + 's' : '-') + '</td>';
        html += '<td>' + escapeHtml((event.errorMessage || event.payloadSummary || '').substring(0, 50)) + '</td>';
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      
      container.innerHTML = html;
    }
    
    function showEventDetails(event) {
      const details = window.open('', 'Event Details', 'width=800,height=600');
      details.document.write('<html><head><title>Event Details</title><style>body{font-family:monospace;padding:20px;background:#f5f5f5;}pre{background:#fff;padding:15px;border-radius:5px;overflow:auto;}</style></head><body>');
      details.document.write('<h2>Event Details</h2>');
      details.document.write('<pre>' + JSON.stringify(event, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>');
      details.document.write('</body></html>');
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

