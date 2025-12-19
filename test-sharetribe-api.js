const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

// Connect to database
const dbPath = path.join(__dirname, 'data', 'sync.db');
const db = new sqlite3.Database(dbPath);

console.log('Fetching ShareTribe configuration from database...\n');

db.get(
  'SELECT sharetribe_api_key, sharetribe_api_secret, sharetribe_marketplace_id FROM api_config WHERE tenant_id = 1 LIMIT 1',
  [],
  async (err, row) => {
    if (err) {
      console.error('Database error:', err);
      db.close();
      return;
    }

    if (!row || !row.sharetribe_api_key || !row.sharetribe_api_secret || !row.sharetribe_marketplace_id) {
      console.error('ShareTribe API not configured in database');
      db.close();
      return;
    }

    const clientId = row.sharetribe_api_key;
    const clientSecret = row.sharetribe_api_secret;
    const marketplaceId = row.sharetribe_marketplace_id;

    console.log('Configuration found:');
    console.log('  Marketplace ID:', marketplaceId);
    console.log('  Client ID:', clientId.substring(0, 15) + '...');
    console.log('  Client Secret:', clientSecret.substring(0, 15) + '...');
    console.log('\n');

    const apiUrl = `https://api.sharetribe.com/v1/marketplaces/${marketplaceId}/own_listings.json`;

    console.log('Testing ShareTribe API...');
    console.log('URL:', apiUrl);
    console.log('Method: GET');
    console.log('Auth: Basic Auth (Client ID as username, Client Secret as password)');
    console.log('\n');

    try {
      const response = await axios.get(apiUrl, {
        auth: {
          username: clientId,
          password: clientSecret
        },
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        params: {
          per_page: 1
        },
        validateStatus: function (status) {
          return status < 500; // Don't throw on 4xx errors
        }
      });

      console.log('=== RESPONSE ===');
      console.log('Status:', response.status);
      console.log('Status Text:', response.statusText);
      console.log('Content-Type:', response.headers['content-type']);
      console.log('\n');

      const contentType = response.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html') || 
                     (typeof response.data === 'string' && 
                      (response.data.trim().startsWith('<!DOCTYPE') || 
                       response.data.trim().startsWith('<html')));

      if (isHtml) {
        console.log('❌ PROBLEM: ShareTribe returned HTML instead of JSON!');
        console.log('\nThis usually means:');
        console.log('1. Authentication failed (wrong Client ID or Client Secret)');
        console.log('2. Wrong Marketplace ID');
        console.log('3. API credentials don\'t have access to this marketplace');
        console.log('4. ShareTribe Marketplace API v1 might require OAuth tokens instead of Basic Auth');
        console.log('\nResponse preview (first 500 chars):');
        console.log('─'.repeat(60));
        const preview = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        console.log(preview.substring(0, 500));
        console.log('─'.repeat(60));
      } else if (response.status >= 200 && response.status < 300) {
        console.log('✅ SUCCESS: ShareTribe API responded with JSON!');
        console.log('\nResponse data:');
        console.log(JSON.stringify(response.data, null, 2).substring(0, 1000));
      } else {
        console.log('❌ ERROR: ShareTribe API returned error status');
        console.log('\nResponse data:');
        console.log(JSON.stringify(response.data, null, 2).substring(0, 1000));
      }

    } catch (error) {
      console.log('❌ EXCEPTION:', error.message);
      if (error.response) {
        console.log('Status:', error.response.status);
        console.log('Content-Type:', error.response.headers['content-type']);
        console.log('Response:', typeof error.response.data === 'string' 
          ? error.response.data.substring(0, 500)
          : JSON.stringify(error.response.data).substring(0, 500));
      }
    }

    db.close();
  }
);

