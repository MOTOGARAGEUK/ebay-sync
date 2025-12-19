const axios = require('axios');
const eBayOAuthService = require('./ebayOAuthService');
const db = require('../config/database');

class eBayService {
  constructor(config, ebayUserId = null, tenantId = 1) {
    this.appId = config.appId;
    this.certId = config.certId;
    this.devId = config.devId;
    this.sandbox = config.sandbox !== false; // Default to sandbox
    this.baseUrl = this.sandbox 
      ? 'https://api.sandbox.ebay.com' 
      : 'https://api.ebay.com';
    
    // If ebayUserId is provided, load tokens from database
    this.ebayUserId = ebayUserId;
    this.tenantId = tenantId;
    this.accessToken = config.accessToken || null;
    this.refreshToken = config.refreshToken || null;
    
    // Initialize OAuth service for token refresh
    if (this.appId && this.certId) {
      this.oauthService = new eBayOAuthService({
        appId: this.appId,
        certId: this.certId,
        devId: this.devId,
        sandbox: this.sandbox
      });
    }
  }

  /**
   * Load tokens from database for a specific eBay user
   */
  async loadTokensFromDatabase() {
    if (!this.ebayUserId) {
      throw new Error('eBay user ID not provided');
    }

    const dbInstance = db.getDb();
    const user = await new Promise((resolve, reject) => {
      dbInstance.get(
        `SELECT access_token, refresh_token, token_expiry, sandbox
         FROM ebay_users 
         WHERE tenant_id = ? AND ebay_user_id = ? AND sandbox = ?`,
        [this.tenantId, this.ebayUserId, this.sandbox ? 1 : 0],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!user) {
      throw new Error(`eBay user ${this.ebayUserId} not found`);
    }

    this.accessToken = user.access_token;
    this.refreshToken = user.refresh_token;
    this.tokenExpiry = new Date(user.token_expiry);
  }

  /**
   * Ensure access token is valid, refresh if needed
   */
  async ensureValidToken() {
    // Load tokens from database if not already loaded
    if (this.ebayUserId && !this.accessToken) {
      await this.loadTokensFromDatabase();
    }

    // If no access token at all, throw error
    if (!this.accessToken) {
      throw new Error('No eBay access token available. Please reconnect your eBay account.');
    }

    // Check if token is expired or will expire in next 5 minutes
    const now = new Date();
    const expiryTime = this.tokenExpiry ? new Date(this.tokenExpiry) : null;
    const needsRefresh = !expiryTime || expiryTime < new Date(now.getTime() + 5 * 60 * 1000);

    if (needsRefresh) {
      if (!this.refreshToken) {
        throw new Error('Access token expired and no refresh token available. Please reconnect your eBay account.');
      }

      if (!this.oauthService) {
        throw new Error('OAuth service not initialized. Cannot refresh token.');
      }

      console.log('Refreshing eBay access token...');
      try {
        const tokenResponse = await this.oauthService.refreshAccessToken(this.refreshToken);
        
        this.accessToken = tokenResponse.access_token;
        this.refreshToken = tokenResponse.refresh_token || this.refreshToken;
        
        // Calculate new expiry
        const newExpiry = new Date();
        newExpiry.setSeconds(newExpiry.getSeconds() + tokenResponse.expires_in);
        this.tokenExpiry = newExpiry;

        // Update database
        if (this.ebayUserId) {
          const dbInstance = db.getDb();
          await new Promise((resolve, reject) => {
            dbInstance.run(
              `UPDATE ebay_users 
               SET access_token = ?, refresh_token = ?, token_expiry = ?, updated_at = CURRENT_TIMESTAMP
               WHERE tenant_id = ? AND ebay_user_id = ? AND sandbox = ?`,
              [
                this.accessToken,
                this.refreshToken,
                this.tokenExpiry.toISOString(),
                this.tenantId,
                this.ebayUserId,
                this.sandbox ? 1 : 0
              ],
              function(err) {
                if (err) reject(err);
                else resolve();
              }
            );
          });
        }

        console.log('eBay access token refreshed successfully');
      } catch (error) {
        console.error('Failed to refresh eBay access token:', error.message);
        throw new Error(`Failed to refresh eBay access token: ${error.message}. Please reconnect your eBay account.`);
      }
    }
  }

  /**
   * Make authenticated API request with automatic token refresh
   */
  async makeRequest(method, url, config = {}) {
    await this.ensureValidToken();
    
    if (!this.accessToken) {
      throw new Error('No access token available after refresh attempt');
    }
    
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...config.headers
    };

    // Build full URL
    const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
    
    // Build query string from params
    let queryString = '';
    if (config.params) {
      const params = new URLSearchParams();
      Object.keys(config.params).forEach(key => {
        params.append(key, config.params[key]);
      });
      queryString = params.toString();
    }
    
    const requestUrl = queryString ? `${fullUrl}?${queryString}` : fullUrl;
    
    // Log request details for validation
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📤 eBay API Request:');
    console.log(`   Method: ${method.toUpperCase()}`);
    console.log(`   URL: ${requestUrl}`);
    console.log(`   Base URL: ${this.baseUrl}`);
    console.log(`   Endpoint: ${url}`);
    if (config.params) {
      console.log(`   Query Parameters:`, config.params);
    }
    console.log(`   Headers:`);
    console.log(`      Authorization: Bearer ${this.accessToken.substring(0, 20)}...${this.accessToken.substring(this.accessToken.length - 10)}`);
    console.log(`      Content-Type: ${headers['Content-Type']}`);
    console.log(`   eBay User ID: ${this.ebayUserId || 'N/A'}`);
    console.log(`   Environment: ${this.sandbox ? 'SANDBOX' : 'PRODUCTION'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const response = await axios({
        method,
        url: fullUrl,
        headers,
        ...config
      });
      
      // Log response details
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📥 eBay API Response:');
      console.log(`   Status: ${response.status} ${response.statusText}`);
      console.log(`   Response Structure:`, Object.keys(response.data || {}));
      if (response.data?.inventoryItems) {
        console.log(`   Inventory Items Count: ${response.data.inventoryItems.length}`);
      }
      if (response.data?.offers) {
        console.log(`   Offers Count: ${response.data.offers.length}`);
      }
      if (response.data?.total !== undefined) {
        console.log(`   Total: ${response.data.total}`);
      }
      if (response.data?.size !== undefined) {
        console.log(`   Size: ${response.data.size}`);
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      return response;
    } catch (error) {
      // Log error details
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('❌ eBay API Error:');
      console.log(`   Status: ${error.response?.status || 'N/A'}`);
      console.log(`   Message: ${error.message}`);
      if (error.response?.data) {
        console.log(`   Error Data:`, JSON.stringify(error.response.data, null, 2));
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      // If 401, try refreshing token once more
      if (error.response?.status === 401 && this.refreshToken) {
        console.log('🔄 Received 401, attempting token refresh...');
        // Force token refresh by clearing expiry
        this.tokenExpiry = new Date(0);
        await this.ensureValidToken();
        
        // Retry request with new token
        console.log('🔄 Retrying request with refreshed token...');
        const retryResponse = await axios({
          method,
          url: fullUrl,
          headers: {
            ...headers,
            'Authorization': `Bearer ${this.accessToken}`
          },
          ...config
        });
        console.log('✅ Retry successful');
        return retryResponse;
      }
      throw error;
    }
  }

  /**
   * Get seller listings using Trading API GetSellerList
   * This retrieves ALL listings created by the authenticated user, regardless of creation method
   * Reference: https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetSellerList.html
   * 
   * @param {Object} options - Query options
   * @param {Date} options.startTimeFrom - Start of date range (required)
   * @param {Date} options.startTimeTo - End of date range (required)
   * @param {number} options.pageNumber - Page number (default: 1)
   * @param {number} options.entriesPerPage - Items per page (default: 200, max: 200)
   * @returns {Array} Array of listing items
   */
  async getSellerList(options = {}) {
    await this.ensureValidToken();
    
    // Trading API endpoint
    const tradingApiUrl = this.sandbox 
      ? 'https://api.sandbox.ebay.com/ws/api.dll'
      : 'https://api.ebay.com/ws/api.dll';
    
    // Calculate date range (default: last 120 days)
    const now = new Date();
    const startTimeFrom = options.startTimeFrom || new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000);
    const startTimeTo = options.startTimeTo || now;
    const pageNumber = options.pageNumber || 1;
    const entriesPerPage = Math.min(options.entriesPerPage || 200, 200);
    
    // Format dates for eBay XML (ISO 8601)
    const formatDate = (date) => {
      return date.toISOString().replace(/\.\d{3}Z$/, '.000Z');
    };
    
    // Build XML request (without RequesterCredentials - using header auth instead)
    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <StartTimeFrom>${formatDate(startTimeFrom)}</StartTimeFrom>
  <StartTimeTo>${formatDate(startTimeTo)}</StartTimeTo>
  <Pagination>
    <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
    <PageNumber>${pageNumber}</PageNumber>
  </Pagination>
  <DetailLevel>ReturnAll</DetailLevel>
  <Version>1423</Version>
</GetSellerListRequest>`;
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📤 eBay Trading API GetSellerList Request:');
    console.log(`   URL: ${tradingApiUrl}`);
    console.log(`   Call Name: GetSellerList`);
    console.log(`   Date Range: ${formatDate(startTimeFrom)} to ${formatDate(startTimeTo)}`);
    console.log(`   Page: ${pageNumber}, Entries Per Page: ${entriesPerPage}`);
    console.log(`   Environment: ${this.sandbox ? 'SANDBOX' : 'PRODUCTION'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    try {
      const response = await axios.post(tradingApiUrl, xmlRequest, {
          headers: {
          'Content-Type': 'text/xml',
          'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
          'X-EBAY-API-CALL-NAME': 'GetSellerList',
          'X-EBAY-API-SITEID': '0', // US site
          'X-EBAY-API-IAF-TOKEN': this.accessToken, // OAuth token in header (not XML body)
          'X-EBAY-API-DEV-NAME': this.devId || '',
          'X-EBAY-API-APP-NAME': this.appId || '',
          'X-EBAY-API-CERT-NAME': this.certId || ''
        }
      });
      
      // Parse XML response
      // Configure parser to read text values correctly (e.g., <CurrentPrice currencyID="GBP">24.99</CurrentPrice>)
      const xml2js = require('xml2js');
      const parser = new xml2js.Parser({ 
        explicitArray: false, 
        mergeAttrs: true,
        explicitText: true, // Ensure text content is preserved
        trim: true, // Trim whitespace from text values
        explicitRoot: false // Don't wrap root element
      });
      
      // Log HTTP status code
      console.log(`📥 HTTP Status Code: ${response.status}`);
      
      // Capture raw XML response
      const rawXml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      console.log(`📥 Raw XML Response Length: ${rawXml.length} characters`);
      console.log(`📥 Raw XML Response Preview (first 2000 chars):`);
      console.log(rawXml.substring(0, 2000));
      
      // Parse XML response
      let result;
      try {
        result = await parser.parseStringPromise(rawXml);
        console.log(`📦 Parsed Response Top-Level Keys:`, Object.keys(result));
        console.log(`📦 Parsed Response Structure Preview:`, JSON.stringify(result, null, 2).substring(0, 2000));
      } catch (parseError) {
        console.error('❌ XML Parse Error:', parseError.message);
        console.error('❌ Raw XML (first 5000 chars):', rawXml.substring(0, 5000));
        throw new Error(`Failed to parse XML response: ${parseError.message}`);
      }
      
      // Extract GetSellerListResponse (handle namespaces)
      // Try multiple possible paths for namespace-safe extraction
      let getSellerListResponse = null;
      let responsePath = null;
      
      // First, try direct access (most common case)
      if (result.GetSellerListResponse) {
        getSellerListResponse = result.GetSellerListResponse;
        responsePath = 'GetSellerListResponse (direct)';
        console.log(`✅ Found GetSellerListResponse directly`);
      } 
      // Try with namespace prefix
      else if (result['ebl:GetSellerListResponse']) {
        getSellerListResponse = result['ebl:GetSellerListResponse'];
        responsePath = 'ebl:GetSellerListResponse';
        console.log(`✅ Found GetSellerListResponse with namespace prefix`);
      }
      // Try SOAP envelope paths
      else if (result['soapenv:Envelope']?.['soapenv:Body']?.GetSellerListResponse) {
        getSellerListResponse = result['soapenv:Envelope']['soapenv:Body'].GetSellerListResponse;
        responsePath = 'soapenv:Envelope.soapenv:Body.GetSellerListResponse';
        console.log(`✅ Found GetSellerListResponse in SOAP envelope`);
      } else if (result.Envelope?.Body?.GetSellerListResponse) {
        getSellerListResponse = result.Envelope.Body.GetSellerListResponse;
        responsePath = 'Envelope.Body.GetSellerListResponse';
        console.log(`✅ Found GetSellerListResponse in Envelope.Body`);
      } 
      // Try to find any key containing "GetSellerList" or "SellerList"
      else {
        const allKeys = Object.keys(result);
        console.log(`🔍 Searching for GetSellerListResponse in keys:`, allKeys);
        const matchingKey = allKeys.find(k => 
          k.toLowerCase().includes('getsellerslist') || 
          k.toLowerCase().includes('sellerslistresponse') ||
          k.toLowerCase().includes('sellerlist')
        );
        if (matchingKey) {
          getSellerListResponse = result[matchingKey];
          responsePath = `${matchingKey} (found via search)`;
          console.log(`✅ Found response via key search: ${matchingKey}`);
        }
      }
      
      // With explicitRoot: false, xml2js puts children of root element directly in result
      // So if result has Ack, ItemArray, Timestamp - result IS the GetSellerListResponse
      if (!getSellerListResponse && result && (result.Ack || result.ItemArray || result.Timestamp)) {
        getSellerListResponse = result;
        console.log(`✅ Result IS GetSellerListResponse (has Ack/ItemArray/Timestamp)`);
      }
      
      if (!getSellerListResponse) {
        console.error('❌ Could not find GetSellerListResponse in parsed XML');
        console.error('   Available keys:', Object.keys(result || {}));
        console.error('   Result preview:', JSON.stringify(result, null, 2).substring(0, 2000));
        throw new Error('Unexpected response structure from Trading API. Check logs for parsed keys.');
      }
      
      // Check for errors FIRST (before checking for items)
      // Handle both Errors node and Ack=Failure
      const ack = getSellerListResponse.Ack || getSellerListResponse.ack;
      if (ack === 'Failure' || ack === 'failure' || getSellerListResponse.Errors) {
        const errors = getSellerListResponse.Errors;
        let errorMessage = 'Trading API failure';
        
        if (errors) {
          const errorArray = Array.isArray(errors.Error) ? errors.Error : [errors.Error];
          const errorDetails = errorArray.map(e => {
            const shortMsg = e.ShortMessage || e.shortMessage || '';
            const longMsg = e.LongMessage || e.longMessage || '';
            return `${shortMsg}${longMsg ? ' - ' + longMsg : ''}`;
          }).join('; ');
          errorMessage = `Trading API failure: ${errorDetails}`;
        } else if (ack === 'Failure') {
          errorMessage = 'Trading API failure: Ack=Failure (check logs for details)';
        }
        
        console.error('❌ Trading API Error Response:');
        console.error('   Ack:', ack);
        console.error('   Errors:', JSON.stringify(errors, null, 2));
        throw new Error(errorMessage);
      }
      
      // Extract items from ItemArray.Item[]
      const itemArray = getSellerListResponse.ItemArray;
      if (!itemArray) {
        console.warn('⚠️ No ItemArray found in response');
        return [];
      }
      
      const items = itemArray.Item || [];
      const itemsArray = Array.isArray(items) ? items : (items ? [items] : []);
      
      console.log(`✅ GetSellerList returned ${itemsArray.length} items`);
      console.log(`   HasMoreItems: ${getSellerListResponse.PaginationResult?.HasMoreItems === 'true'}`);
      console.log(`   Total Pages: ${getSellerListResponse.PaginationResult?.TotalNumberOfPages || 'N/A'}`);
      
      // Log one full Item for acceptance test
      if (itemsArray.length > 0) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 ACCEPTANCE TEST: Full Item Example:');
        console.log(JSON.stringify(itemsArray[0], null, 2));
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      }
      
      // Helper to extract text value from XML element (handles #text, _, _text)
      const extractTextValue = (node) => {
        if (!node) return null;
        if (typeof node === 'string') return node.trim();
        if (node['#text'] !== undefined) return String(node['#text']).trim();
        if (node._ !== undefined) return String(node._).trim();
        if (node._text !== undefined) return String(node._text).trim();
        return null;
      };
      
      // Helper to extract price value from CurrentPrice element
      // XML: <CurrentPrice currencyID="GBP">24.99</CurrentPrice>
      // Parser may store as: { currencyID: "GBP", "#text": "24.99" } or { currencyID: "GBP", "_": "24.99" }
      const extractPriceValue = (priceNode) => {
        if (!priceNode) return null;
        const textValue = extractTextValue(priceNode);
        if (textValue) {
          const value = parseFloat(textValue);
          if (!isNaN(value)) return value;
        }
        return null;
      };
      
      // Helper to extract currency from price node attributes
      const extractCurrency = (priceNode) => {
        if (!priceNode) return 'USD';
        if (typeof priceNode === 'object') {
          return priceNode.currencyID || priceNode.currency || priceNode._attr?.currencyID || 'USD';
        }
        return 'USD';
      };
      
      // Transform items to our format
      const basicProducts = itemsArray
        .filter(item => {
          const itemId = item.ItemID || item.itemID;
          if (!itemId) {
            console.warn('⚠️ Item missing ItemID');
            return false;
          }
          return true;
        })
        .map(item => {
          const itemId = item.ItemID || item.itemID;
          const listingType = item.ListingType || item.listingType || '';
          const listingStatus = item.ListingStatus || item.listingStatus || '';
          
          // Extract Title
          const title = extractTextValue(item.Title) || extractTextValue(item.title) || '';
          
          // Extract Description
          const description = extractTextValue(item.Description) || extractTextValue(item.description) || '';
          
          // Extract Images from PictureDetails.PictureURL[]
          let images = [];
          const pictureDetails = item.PictureDetails || item.pictureDetails;
          if (pictureDetails) {
            const pictureUrls = pictureDetails.PictureURL || pictureDetails.pictureURL || pictureDetails.PictureUrl;
            if (Array.isArray(pictureUrls)) {
              images = pictureUrls.map(url => extractTextValue(url) || url).filter(Boolean);
            } else if (pictureUrls) {
              const url = extractTextValue(pictureUrls) || pictureUrls;
              if (url) images = [url];
            }
          }
          
          // Extract Category
          const primaryCategory = item.PrimaryCategory || item.primaryCategory;
          const categoryId = primaryCategory?.CategoryID || primaryCategory?.categoryID || '';
          const categoryName = extractTextValue(primaryCategory?.CategoryName) || extractTextValue(primaryCategory?.categoryName) || '';
          
          // Extract Price from SellingStatus.CurrentPrice
          let price = null;
          let currency = 'USD';
          let priceSource = null;
          
          if (listingType === 'FixedPriceItem' || listingType === 'StoresFixedPrice') {
            const sellingStatus = item.SellingStatus || item.sellingStatus;
            const currentPrice = sellingStatus?.CurrentPrice || sellingStatus?.currentPrice;
            
            if (currentPrice) {
              price = extractPriceValue(currentPrice);
              currency = extractCurrency(currentPrice);
              priceSource = 'CurrentPrice';
              
              console.log(`💰 [${itemId}] Price: ${currency} ${price} (${listingType})`);
            }
          }
          
          // Build listing URL
          const listingUrl = this.sandbox 
            ? `https://www.sandbox.ebay.com/itm/${itemId}`
            : `https://www.ebay.com/itm/${itemId}`;

      return {
            ebay_item_id: itemId,
            ebay_listing_id: itemId,
            title: title,
            description: description,
            price: price,
            currency: currency,
            listing_type: listingType,
            listing_status: listingStatus,
            price_source: priceSource,
            quantity: parseInt(item.Quantity || item.quantity || 0),
            images: images.join(','),
            category: categoryId,
            category_name: categoryName,
            condition: extractTextValue(item.Condition?.DisplayName) || extractTextValue(item.Condition?.Type) || '',
            sku: extractTextValue(item.SKU) || extractTextValue(item.sku) || itemId,
            listing_url: listingUrl
          };
        });
      
      // Filter out auctions (only keep FixedPriceItem/StoresFixedPrice)
      const fixedPriceProducts = basicProducts.filter(product => {
        const listingType = product.listing_type;
        if (listingType === 'Auction' || listingType === 'Chinese') {
          console.log(`⚠️ Excluding ${listingType} listing ${product.ebay_item_id} - auctions not supported`);
          return false;
        }
        // Only include if we have a valid price (FixedPriceItem/StoresFixedPrice should have price)
        if (product.price === null || product.price === undefined || isNaN(product.price)) {
          console.warn(`⚠️ Excluding listing ${product.ebay_item_id} - no valid price (ListingType: ${listingType})`);
          return false;
        }
        return true;
      });
      
      console.log(`📊 Filtered ${basicProducts.length} items → ${fixedPriceProducts.length} fixed-price items`);
      
      // CRITICAL: GetSellerList does NOT include Item Specifics (Brand, Size, etc.)
      // We must call GetItem for each listing to get Item Specifics
      console.log(`📋 GetSellerList returned ${fixedPriceProducts.length} fixed-price items. Now fetching Item Specifics via GetItem...`);
      
      // Fetch Item Specifics for each item using GetItem API
      const productsWithItemSpecifics = await Promise.all(
        fixedPriceProducts.map(async (product) => {
          try {
            const itemSpecifics = await this.getItemSpecifics(product.ebay_item_id);
            
            // Merge Item Specifics into product
            if (itemSpecifics && Object.keys(itemSpecifics).length > 0) {
              Object.assign(product, itemSpecifics);
              console.log(`✅ Fetched Item Specifics for ${product.ebay_item_id}:`, Object.keys(itemSpecifics).join(', '));
            } else {
              console.log(`⚠️ No Item Specifics found for ${product.ebay_item_id}`);
            }
            
            return product;
          } catch (error) {
            console.warn(`⚠️ Failed to fetch Item Specifics for ${product.ebay_item_id}:`, error.message);
            // Return product without Item Specifics if GetItem fails
            return product;
          }
        })
      );
      
      console.log(`✅ Completed fetching Item Specifics for ${productsWithItemSpecifics.length} items`);
      
      return productsWithItemSpecifics;
    } catch (error) {
      console.error('❌ GetSellerList error:', error.response?.data || error.message);
      console.error('❌ Error stack:', error.stack);
      
      if (options.debug) {
        return {
          success: false,
          error: error.message,
          debug: {
            ...debugInfo,
            error: error.message,
            errorResponse: error.response?.data ? String(error.response.data).substring(0, 2000) : null
          }
        };
      }
      
      throw new Error(`Failed to fetch listings via Trading API: ${error.message}`);
    }
  }

  /**
   * Get all active listings for the authenticated user
   * Uses ONLY Trading API GetSellerList - BUYER-VISIBLE LISTINGS ONLY
   * This is the ONLY source of truth for what buyers can see
   * 
   * ❌ DO NOT use Inventory API endpoints:
   * - GET /sell/inventory/v1/inventory_item
   * - Anything that assumes "inventory items exist"
   * 
   * ✅ ONLY use Trading API GetSellerList:
   * - Endpoint: https://api.ebay.com/ws/api.dll (or sandbox)
   * - Call name: GetSellerList
   * - Filter to Active listings only
   * - Returns ItemID for each buyer-visible listing
   */
  async getActiveListings() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 Fetching ACTIVE BUYER-VISIBLE listings from eBay...');
    console.log('📡 Using Trading API GetSellerList ONLY (no Inventory API)');
    console.log('📡 Endpoint: api.ebay.com/ws/api.dll (or api.sandbox.ebay.com/ws/api.dll)');
    console.log('📡 Call Name: GetSellerList');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Use ONLY Trading API GetSellerList - no fallback to Inventory API
    const items = await this.getSellerList({
      startTimeFrom: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000), // Last 120 days
      startTimeTo: new Date(),
      entriesPerPage: 200
    });
    
    console.log(`✅ Successfully fetched ${items.length} buyer-visible listings via Trading API GetSellerList`);
    console.log(`   These are the listings buyers can actually see on eBay`);
    
    return items;
  }

  /**
   * Get detailed information for a specific item
   * ❌ DISABLED - Do NOT use Inventory API
   * Use Trading API GetItem instead via getItemSpecifics
   * 
   * @param {string} sku - SKU or inventory item key
   * @returns {Object|null} Item details
   */
  async getItemDetails(sku) {
    console.warn('⚠️ getItemDetails called - Inventory API disabled. Use Trading API GetItem instead.');
    return null;
  }

  // Get single item by item ID
  async getItemById(itemId) {
    console.warn('⚠️ getItemById called - Inventory API disabled. Use Trading API GetItem instead.');
    return null;
  }

  /**
   * Get Item Specifics (Brand, Size, Color, etc.) for a single listing using Trading API GetItem
   * eBay requires GetItem with IncludeItemSpecifics=true to get Item Specifics
   * GetSellerList does NOT support Item Specifics
   * 
   * @param {string} itemId - eBay Item ID
   * @returns {Object} Object with Item Specifics fields (brand, size, color, etc.)
   */
  async getItemSpecifics(itemId) {
    await this.ensureValidToken();
    
    if (!itemId) {
      throw new Error('Item ID is required');
    }
    
    // Trading API endpoint
    const tradingApiUrl = this.sandbox 
      ? 'https://api.sandbox.ebay.com/ws/api.dll'
      : 'https://api.ebay.com/ws/api.dll';
    
    // Build XML request for GetItem with IncludeItemSpecifics=true
    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${this.accessToken}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
  <DetailLevel>ReturnAll</DetailLevel>
  <Version>1423</Version>
</GetItemRequest>`;
    
    try {
      const response = await axios.post(tradingApiUrl, xmlRequest, {
        headers: {
          'Content-Type': 'text/xml',
          'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
          'X-EBAY-API-CALL-NAME': 'GetItem',
          'X-EBAY-API-SITEID': '0', // US site
          'X-EBAY-API-DEV-NAME': this.devId || '',
          'X-EBAY-API-APP-NAME': this.appId || '',
          'X-EBAY-API-CERT-NAME': this.certId || ''
        }
      });
      
      // Parse XML response
      // Configure parser to read text values correctly
      const xml2js = require('xml2js');
      const parser = new xml2js.Parser({ 
        explicitArray: false, 
        mergeAttrs: true,
        explicitText: true, // Ensure text content is preserved
        trim: true, // Trim whitespace from text values
        explicitRoot: false // Don't wrap root element
      });
      const result = await parser.parseStringPromise(response.data);
      
      const getItemResponse = result.GetItemResponse || result['soapenv:Envelope']?.['soapenv:Body']?.GetItemResponse;
      
      if (!getItemResponse) {
        console.error('❌ Unexpected GetItem response structure:', JSON.stringify(result, null, 2));
        return {};
      }
      
      // Check for errors
      if (getItemResponse.Errors) {
        const errors = Array.isArray(getItemResponse.Errors.Error) 
          ? getItemResponse.Errors.Error 
          : [getItemResponse.Errors.Error];
        const errorMessages = errors.map(e => e.LongMessage || e.ShortMessage || 'Unknown error').join('; ');
        console.warn(`⚠️ GetItem error for ${itemId}: ${errorMessages}`);
        return {};
      }
      
      // Extract Item Specifics
      const item = getItemResponse.Item;
      if (!item || !item.ItemSpecifics) {
        return {};
      }
      
      const itemSpecifics = {};
      const nameValueList = item.ItemSpecifics.NameValueList;
      
      if (!nameValueList) {
        return {};
      }
      
      // Handle both array and single object
      const nameValueArray = Array.isArray(nameValueList) ? nameValueList : [nameValueList];
      
      nameValueArray.forEach(nv => {
        if (nv.Name && nv.Value !== undefined && nv.Value !== null) {
          // Normalize field name: "Brand" -> "brand", "Size" -> "size", etc.
          const fieldName = nv.Name.toLowerCase().trim();
          const fieldValue = Array.isArray(nv.Value) ? nv.Value.join(', ') : nv.Value.toString().trim();
          
          // Only store with normalized key to avoid duplicates
          // Use lowercase version as the canonical key
          itemSpecifics[fieldName] = fieldValue;
        }
      });
      
      return itemSpecifics;
    } catch (error) {
      console.error(`❌ GetItem error for ${itemId}:`, error.response?.data || error.message);
      return {}; // Return empty object on error (don't fail the entire batch)
    }
  }

  // Test API connection
  async testConnection() {
    try {
      await this.getActiveListings();
      return { success: true, message: 'eBay API connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}

module.exports = eBayService;


