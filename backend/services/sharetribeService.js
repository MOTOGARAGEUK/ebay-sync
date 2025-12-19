const axios = require('axios');
const responseStore = require('../utils/responseStore');

class ShareTribeService {
  constructor(config) {
    if (!config) {
      throw new Error('ShareTribeService: config is required');
    }
    
    this.apiKey = config.apiKey || ''; // Integration API Client ID
    this.apiSecret = config.apiSecret || ''; // Integration API Client Secret
    this.marketplaceApiClientId = config.marketplaceApiClientId || ''; // Marketplace API Client ID (for Asset Delivery API)
    this.marketplaceId = config.marketplaceId || '';
    this.userId = config.userId || '';
    
    if (!this.marketplaceId) {
      throw new Error('ShareTribeService: marketplaceId is required');
    }
    
    // Determine API type based on whether client_secret is provided
    // Integration API: requires client_secret, uses flex-integ-api.sharetribe.com
    // Marketplace API: client_id only, uses flex-api.sharetribe.com
    this.isIntegrationAPI = !!this.apiSecret;
    
    if (this.isIntegrationAPI) {
      // Integration API endpoints
      this.baseUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/marketplaces/${this.marketplaceId}`;
    } else {
      // Marketplace API endpoints
      this.baseUrl = `https://flex-api.sharetribe.com/v1/marketplaces/${this.marketplaceId}`;
    }
    
    this.authUrl = 'https://flex-api.sharetribe.com/v1/auth/token';
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  // Get OAuth2 access token using Client Credentials grant
  async getAccessToken() {
    // Return cached token if still valid (with 5 minute buffer)
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry - 5 * 60 * 1000) {
      return this.accessToken;
    }

    try {
      if (!this.apiKey) {
        throw new Error('Client ID (apiKey) is required for ShareTribe authentication');
      }
      
      console.log('Getting ShareTribe OAuth2 access token...');
      console.log('Auth URL:', this.authUrl);
      console.log('Client ID:', this.apiKey ? `${this.apiKey.substring(0, 15)}...` : 'MISSING');
      console.log('Has Client Secret:', !!this.apiSecret);
      
      // Build request parameters based on API type
      // If client_secret is provided, use Integration API (scope=integ)
      // Otherwise, use Marketplace API (scope=public-read, client_id only)
      const params = {
        grant_type: 'client_credentials',
        client_id: this.apiKey
      };

      if (this.apiSecret) {
        // Integration API: requires client_secret and uses scope=integ
        params.client_secret = this.apiSecret;
        params.scope = 'integ';
        console.log('Using Integration API authentication (client_id + client_secret, scope=integ)');
      } else {
        // Marketplace API: only client_id, uses scope=public-read
        params.scope = 'public-read';
        console.log('Using Marketplace API authentication (client_id only, scope=public-read)');
      }

      const response = await axios.post(
        this.authUrl,
        new URLSearchParams(params),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
            'Accept': 'application/json'
          }
        }
      );

      console.log('OAuth2 response status:', response.status);
      console.log('OAuth2 response keys:', response.data ? Object.keys(response.data) : 'no data');
      
      if (response.data && response.data.access_token) {
        this.accessToken = response.data.access_token;
        // Token expires in expires_in seconds (default to 3600 if not provided)
        const expiresIn = response.data.expires_in || 3600;
        this.tokenExpiry = Date.now() + (expiresIn * 1000);
        console.log('ShareTribe OAuth2 token obtained successfully');
        console.log('Token expires in:', expiresIn, 'seconds');
        console.log('Token scope:', response.data.scope);
        return this.accessToken;
      } else {
        console.error('OAuth2 response data:', JSON.stringify(response.data, null, 2));
        throw new Error('ShareTribe OAuth2 response missing access_token. Response: ' + JSON.stringify(response.data));
      }
    } catch (error) {
      console.error('Error getting ShareTribe OAuth2 token:', error.response?.data || error.message);
      if (error.response?.data) {
        console.error('Full error response:', JSON.stringify(error.response.data, null, 2));
      }
      throw new Error(`Failed to authenticate with ShareTribe API: ${error.response?.data?.error_description || error.response?.data?.error || error.message}`);
    }
  }

  // Get authorization headers with OAuth2 token
  async getAuthHeaders() {
    const token = await this.getAccessToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  // Create or update a listing in ShareTribe
  async createOrUpdateListing(productData, existingListingId = null) {
    const correlationId = productData.ebay_item_id || 'unknown';
    
    // CRITICAL: Upload eBay image URLs to ShareTribe to get UUIDs
    // eBay returns image URLs, but ShareTribe requires UUIDs
    // ShareTribe doesn't allow reusing the same image UUID across multiple listings
    const fs = require('fs');
    const path = require('path');
    const axios = require('axios');
    
    // Helper function to check if a string is a URL (not a UUID)
    const isImageURL = (str) => {
      if (!str || typeof str !== 'string') return false;
      return str.startsWith('http://') || str.startsWith('https://');
    };
    
    // Helper function to validate UUID format
    const isValidUUID = (str) => {
      if (!str || typeof str !== 'string') return false;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRegex.test(str.trim());
    };
    
    // Process product images: if they're URLs, upload them to ShareTribe to get UUIDs
    if (productData.images) {
      try {
        let imageUrls = [];
        
        // Parse images (could be comma-separated string or array)
        if (Array.isArray(productData.images)) {
          imageUrls = productData.images;
        } else if (typeof productData.images === 'string' && productData.images.trim() !== '') {
          imageUrls = productData.images.split(',').map(url => url.trim()).filter(url => url);
        }
        
        // Filter out URLs (eBay images) from UUIDs (already uploaded)
        const urlsToUpload = imageUrls.filter(img => isImageURL(img));
        const existingUUIDs = imageUrls.filter(img => isValidUUID(img));
        
        console.log(`🖼️ [${correlationId}] Processing images: ${urlsToUpload.length} URL(s) to upload, ${existingUUIDs.length} UUID(s) already`);
        
        // Upload each eBay image URL to ShareTribe
        const uploadedUUIDs = [];
        for (const imageUrl of urlsToUpload) {
          try {
            console.log(`📤 [${correlationId}] Downloading image from eBay: ${imageUrl.substring(0, 50)}...`);
            
            // Download image from eBay URL
            const imageResponse = await axios.get(imageUrl, {
              responseType: 'arraybuffer',
              timeout: 30000, // 30 second timeout
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; eBay-Sync/1.0)'
              }
            });
            
            const imageBuffer = Buffer.from(imageResponse.data);
            const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
            
            // Determine filename from URL or use default
            const urlPath = new URL(imageUrl).pathname;
            const imageFileName = path.basename(urlPath) || `ebay-image-${Date.now()}.jpg`;
            
            console.log(`📤 [${correlationId}] Uploading image to ShareTribe: ${imageFileName} (${(imageBuffer.length / 1024).toFixed(2)} KB)`);
            
            // Upload to ShareTribe to get UUID
            const imageUUID = await this.uploadImage(imageBuffer, imageFileName, contentType);
            
            console.log(`✅ [${correlationId}] Image uploaded successfully, got UUID: ${imageUUID}`);
            uploadedUUIDs.push(imageUUID);
          } catch (uploadError) {
            console.error(`❌ [${correlationId}] Failed to upload image ${imageUrl}:`, uploadError.message);
            // Continue with other images
          }
        }
        
        // Combine existing UUIDs with newly uploaded ones
        const allImageUUIDs = [...existingUUIDs, ...uploadedUUIDs];
        
        if (allImageUUIDs.length > 0) {
          // Set as comma-separated string (buildSharetribePayload will handle it)
          productData.images = allImageUUIDs.join(',');
          console.log(`✅ [${correlationId}] Total images ready: ${allImageUUIDs.length} UUID(s)`);
        } else {
          // No images after processing - clear it
          productData.images = '';
        }
      } catch (error) {
        console.error(`❌ [${correlationId}] Error processing images:`, error.message);
        // Continue without images
        productData.images = '';
      }
    }
    
    // If no images after processing and we have a default image file, upload it fresh to get a NEW UUID
    if ((!productData.images || productData.images === '' || (Array.isArray(productData.images) && productData.images.length === 0)) 
        && productData.defaultImagePath && fs.existsSync(productData.defaultImagePath)) {
      try {
        console.log(`🔄 [${correlationId}] No images provided, uploading default image file to get NEW UUID...`);
        console.log(`   Default image file: ${productData.defaultImagePath}`);
        
        // Read image file
        const imageBuffer = fs.readFileSync(productData.defaultImagePath);
        const imageFileName = path.basename(productData.defaultImagePath);
        
        // Determine content type from file extension
        const ext = path.extname(imageFileName).toLowerCase();
        const contentTypeMap = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.webp': 'image/webp'
        };
        const contentType = contentTypeMap[ext] || 'image/jpeg';
        
        // Upload image to ShareTribe to get a NEW UUID for this listing
        const newImageId = await this.uploadImage(imageBuffer, imageFileName, contentType);
        
        console.log(`✅ [${correlationId}] Uploaded default image, got NEW UUID: ${newImageId}`);
        console.log(`   This UUID will be used ONLY for this listing (not reused)`);
        
        // Set the new image ID in productData so buildSharetribePayload can use it
        productData.images = newImageId;
      } catch (uploadError) {
        console.error(`❌ [${correlationId}] Failed to upload default image:`, uploadError.message);
        console.error(`   Error details:`, uploadError.response?.data || uploadError);
        // Continue without image - buildSharetribePayload will handle it
      }
    }
    
    // If updating and no images provided, fetch existing images to preserve them
    // This prevents ShareTribe from removing images when the images field is omitted
    if (existingListingId && (!productData.images || productData.images === '' || (Array.isArray(productData.images) && productData.images.length === 0))) {
      try {
        console.log(`🔄 Updating existing listing ${existingListingId} - fetching current images to preserve them...`);
        const existingListing = await this.getListing(existingListingId);
        
        // Extract images from existing listing
        // ShareTribe API returns images in different structures:
        // - Integration API: response.data.data.attributes.images (array of UUIDs or objects)
        // - Or in relationships: response.data.data.relationships.images.data (array of {id, type})
        let existingImages = [];
        
        if (existingListing && existingListing.data) {
          // Try attributes.images first
          if (existingListing.data.attributes && existingListing.data.attributes.images) {
            existingImages = existingListing.data.attributes.images;
          }
          // Try relationships if attributes doesn't have images
          else if (existingListing.data.relationships && existingListing.data.relationships.images) {
            const imageRelationships = existingListing.data.relationships.images.data || [];
            existingImages = imageRelationships.map(rel => rel.id);
          }
          
          if (existingImages.length > 0) {
            console.log(`✅ Found ${existingImages.length} existing image(s) on listing - preserving them`);
            // Convert to array of UUIDs if needed
            const imageUUIDs = existingImages.map(img => typeof img === 'string' ? img : img.id || img.uuid).filter(Boolean);
            if (imageUUIDs.length > 0) {
              productData.images = imageUUIDs.join(',');
              console.log(`   Preserved images: ${JSON.stringify(imageUUIDs)}`);
            }
          } else {
            console.log(`⚠️ No existing images found on listing - will use default image if available`);
          }
        }
      } catch (error) {
        console.warn(`⚠️ Could not fetch existing listing images (${error.message}) - will proceed without preserving them`);
        console.warn(`   Error details:`, error.response?.data || error.message);
      }
    }
    
    // Build payload ONCE - this is the single source of truth
    const listingData = await this.buildSharetribePayload(productData);
    
    // Validate that payload has required fields
    if (this.isIntegrationAPI) {
      // Integration API: title is at top level
      if (!listingData.title) {
        throw new Error('Product title is required');
      }
    } else {
      // Marketplace API: title is in publicData
      if (!listingData.publicData || !listingData.publicData.title) {
        throw new Error('Product title is required');
      }
    }
    
    // CHECKPOINT 3: Log HTTP request body (the actual JSON string that will be sent)
    const requestBodyJson = JSON.stringify(listingData);
    console.log(`=== CHECKPOINT 3 [${correlationId}]: HTTP Request Body (JSON String) ===`);
    console.log(requestBodyJson);
    console.log(`Request body length:`, requestBodyJson.length);
    console.log(`Request body has price:`, requestBodyJson.includes('"price"'));
    console.log(`Request body has publicData:`, requestBodyJson.includes('"publicData"'));
    console.log(`Request body has privateData:`, requestBodyJson.includes('"privateData"'));
    
    // Verify payload integrity - if preview showed data but payload is empty, FATAL ERROR
    const hasPrice = listingData.price && listingData.price.amount !== undefined;
    const hasPublicData = listingData.publicData && Object.keys(listingData.publicData).length > 0;
    const hasPrivateData = listingData.privateData && Object.keys(listingData.privateData).length > 0;
    const hasDescription = listingData.description && listingData.description.trim() !== '';
    
    if (!hasPrice && productData.price !== undefined && productData.price !== null) {
      console.error(`❌ FATAL ERROR [${correlationId}]: Price was in source but missing from payload!`);
      console.error(`Source price:`, productData.price);
      console.error(`Payload price:`, listingData.price);
    }
    if (!hasPublicData && (productData.categoryLevel1 || productData.gearbrand || productData.helmetsize)) {
      console.error(`❌ FATAL ERROR [${correlationId}]: PublicData fields were in source but missing from payload!`);
      console.error(`Source has categoryLevel1:`, productData.categoryLevel1);
      console.error(`Source has gearbrand:`, productData.gearbrand);
      console.error(`Payload publicData:`, JSON.stringify(listingData.publicData));
    }
    if (!hasPrivateData && productData.ebay_item_id) {
      console.error(`❌ FATAL ERROR [${correlationId}]: ebay_item_id was in source but missing from privateData!`);
    }
    if (!hasDescription && productData.description) {
      console.error(`❌ FATAL ERROR [${correlationId}]: Description was in source but missing/empty in payload!`);
      console.error(`Source description:`, productData.description);
      console.error(`Payload description:`, listingData.description);
    }
    
    try {
      console.log(`Creating listing for user: ${this.userId}, marketplace: ${this.marketplaceId}`);

      // Get OAuth2 token and headers
      const headers = await this.getAuthHeaders();

      // Store payload BEFORE sending for comparison (deep copy)
      const payloadBeforeSend = JSON.parse(JSON.stringify(listingData));

      // Determine endpoint based on API type
      let apiUrl;
      if (this.isIntegrationAPI) {
        // Integration API endpoints
        if (existingListingId) {
          apiUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/listings/${existingListingId}`;
        } else {
          // Try /create endpoint first, fallback to base listings endpoint
          apiUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/listings/create`;
        }
      } else {
        // Marketplace API endpoints
        if (existingListingId) {
          apiUrl = `${this.baseUrl}/own_listings/${existingListingId}.json`;
        } else {
          apiUrl = `${this.baseUrl}/own_listings.json`;
        }
      }

      if (existingListingId) {
        // Update existing listing
        console.log('=== Updating ShareTribe Listing ===');
        console.log('API URL:', apiUrl);
        console.log('API Type:', this.isIntegrationAPI ? 'Integration API' : 'Marketplace API');
        console.log('Listing ID:', existingListingId);
        console.log('Listing Data (SENDING THIS EXACT OBJECT):', JSON.stringify(listingData, null, 2));
        console.log('Images in update payload:', listingData.images ? JSON.stringify(listingData.images) : '(field omitted - no images)');
        console.log('Has images field:', 'images' in listingData);
        console.log('Images field value:', listingData.images);
        
        const response = await axios.put(
          apiUrl,
          listingData, // Send the exact object
          {
            headers: headers,
            params: {
              include: 'images' // Request expanded images in response to verify attachment (ShareTribe expects comma-separated string)
            },
            validateStatus: function (status) {
              return status < 500; // Don't throw on 4xx errors, we'll handle them
            }
          }
        );
        
        console.log('=== ShareTribe API Update Response ===');
        console.log('Status:', response.status);
        console.log('Status Text:', response.statusText);
        
        // Check if images were attached (if include: ["images"] was requested)
        if (response.data && response.data.data && response.data.data.relationships) {
          const imagesRelationship = response.data.data.relationships.images;
          if (imagesRelationship && imagesRelationship.data) {
            console.log(`✅ Images attached to listing: ${JSON.stringify(imagesRelationship.data)}`);
          } else {
            console.log(`⚠️ No images relationship in update response (may not have been requested or images not attached)`);
          }
        }
        
        // Check included images data (from include: ["images"] parameter)
        if (response.data && response.data.included) {
          const imageData = response.data.included.filter(item => item.type === 'image');
          if (imageData.length > 0) {
            console.log(`✅ Expanded image data in update response: ${imageData.length} image(s)`);
            imageData.forEach((img, idx) => {
              console.log(`   Image ${idx + 1}: ID=${img.id}, Type=${img.type}`);
            });
          }
        }
        
        // Store response for admin interface
        responseStore.addResponse({
          listingId: existingListingId,
          ebayItemId: listingData.privateData?.ebay_item_id || productData.ebay_item_id || 'unknown',
          timestamp: new Date().toISOString(),
          createResponse: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            data: response.data,
            timestamp: new Date().toISOString()
          },
          sentPayload: payloadBeforeSend,
          sourceProduct: productData
        });
        
        // After successful update, verify images were attached via /listings/show with include=images
        if (response.status >= 200 && response.status < 300 && existingListingId) {
          console.log('=== Verifying images attachment after update via /listings/show ===');
          console.log(`Calling GET /v1/integration_api/listings/show?id=${existingListingId}&include=images...`);
          
          try {
            // Wait a moment for ShareTribe to process the update
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Call the specific endpoint with include=images to verify images were attached
            const verifyUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/listings/show?id=${existingListingId}&include=images`;
            const verifyHeaders = await this.getAuthHeaders();
            
            const verifyResponse = await axios.get(verifyUrl, {
              headers: verifyHeaders,
              validateStatus: function (status) {
                return status < 500;
              }
            });
            
            console.log('=== Image Verification Response (After Update) ===');
            console.log('Status:', verifyResponse.status);
            
            if (verifyResponse.status >= 200 && verifyResponse.status < 300) {
              const verifyListingData = verifyResponse.data?.data;
              const includedImages = verifyResponse.data?.included?.filter(item => item.type === 'image') || [];
              
              // Check relationships
              const imagesRelationship = verifyListingData?.relationships?.images;
              
              if (imagesRelationship && imagesRelationship.data && imagesRelationship.data.length > 0) {
                console.log(`✅ VERIFIED: Listing has ${imagesRelationship.data.length} image(s) attached after update`);
                console.log(`   Image IDs in relationships:`, JSON.stringify(imagesRelationship.data));
                
                if (includedImages.length > 0) {
                  console.log(`✅ VERIFIED: ${includedImages.length} image(s) in included data:`);
                  includedImages.forEach((img, idx) => {
                    console.log(`   Image ${idx + 1}: ID=${img.id}, Type=${img.type}`);
                  });
                } else {
                  console.log(`⚠️ Images in relationships but not in included data (may need to wait for processing)`);
                }
              } else {
                console.error(`❌ VERIFICATION FAILED: No images found in listing relationships after update`);
                console.error(`   Listing ID: ${existingListingId}`);
                console.error(`   Images sent in update payload: ${JSON.stringify(listingData.images || [])}`);
                console.error(`   Relationships in verification response:`, JSON.stringify(verifyListingData?.relationships || {}));
                console.error(`   This means ShareTribe did not attach the images during update. Possible reasons:`);
                console.error(`   1. Image UUID is invalid or doesn't exist in ShareTribe`);
                console.error(`   2. Image was deleted from ShareTribe`);
                console.error(`   3. Image UUID format is incorrect`);
                console.error(`   4. ShareTribe requires images field to be explicitly included in updates`);
                console.error(`   5. If images field was omitted (empty array), ShareTribe may have removed existing images`);
                console.error(`   Please verify:`);
                console.error(`   - The image UUID exists in ShareTribe Console → Images`);
                console.error(`   - The UUID was returned from POST /v1/integration_api/images/upload (response.data.data.id)`);
                console.error(`   - The UUID matches exactly (case-sensitive)`);
                console.error(`   - The images field is included in the update payload (not omitted)`);
              }
              
              console.log('Full verification response:', JSON.stringify(verifyResponse.data, null, 2));
            } else {
              console.error(`⚠️ Verification request failed with status ${verifyResponse.status}`);
              console.error(`Response:`, JSON.stringify(verifyResponse.data, null, 2));
            }
          } catch (verifyError) {
            console.error(`Error verifying images after update:`, verifyError.message);
          }
        }
        
        return { success: true, listingId: existingListingId, data: response.data };
      } else {
        // Create new listing
        console.log('=== Creating ShareTribe Listing ===');
        console.log('API URL:', apiUrl);
        console.log('API Type:', this.isIntegrationAPI ? 'Integration API' : 'Marketplace API');
        console.log('Marketplace ID:', this.marketplaceId);
        console.log('User ID:', this.userId);
        console.log('Listing Data (SENDING THIS EXACT OBJECT):', JSON.stringify(listingData, null, 2));
        console.log('Images in payload:', listingData.images ? JSON.stringify(listingData.images) : '(field omitted - no images)');
        console.log('Has images field:', 'images' in listingData);
        console.log('Images field value:', listingData.images);
        
        // Send the EXACT payload object - no modifications
        // Include images in response to verify they were attached
        const response = await axios.post(
          apiUrl,
          listingData, // Send the exact object, not a copy
          {
            headers: headers,
            params: {
              include: 'images' // Request expanded images in response to verify attachment (ShareTribe expects comma-separated string)
            },
            validateStatus: function (status) {
              return status < 500; // Don't throw on 4xx errors, we'll handle them
            }
          }
        );
        
        console.log('=== ShareTribe API Create Response ===');
        console.log('Status:', response.status);
        console.log('Status Text:', response.statusText);
        console.log('Content-Type:', response.headers['content-type']);
        console.log('Response keys:', response.data && typeof response.data === 'object' ? Object.keys(response.data) : 'not an object');
        
        // Check if images were attached (if include: ["images"] was requested)
        if (response.data && response.data.data && response.data.data.relationships) {
          const imagesRelationship = response.data.data.relationships.images;
          if (imagesRelationship && imagesRelationship.data) {
            console.log(`✅ Images attached to listing: ${JSON.stringify(imagesRelationship.data)}`);
          } else {
            console.log(`⚠️ No images relationship in response (may not have been requested or images not attached)`);
          }
        }
        
        // Check included images data (from include: ["images"] parameter)
        if (response.data && response.data.included) {
          const imageData = response.data.included.filter(item => item.type === 'image');
          if (imageData.length > 0) {
            console.log(`✅ Expanded image data in response: ${imageData.length} image(s)`);
            imageData.forEach((img, idx) => {
              console.log(`   Image ${idx + 1}: ID=${img.id}, Type=${img.type}`);
            });
          }
        }
        
        console.log('=== FULL CREATE RESPONSE (stored for debugging) ===');
        const fullCreateResponse = JSON.stringify(response.data, null, 2);
        console.log(fullCreateResponse);
        
        // Store full response for debugging
        const createResponseData = {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          data: response.data,
          timestamp: new Date().toISOString()
        };
        
        // Check for image errors BEFORE checking status code (409 is a valid error status we can handle)
        // Log ALL errors fully for debugging
        if (response.data && response.data.errors && Array.isArray(response.data.errors)) {
          console.error('=== ShareTribe API Errors (Full Details) ===');
          console.error('Status Code:', response.status);
          console.error('Number of errors:', response.data.errors.length);
          console.error('Full errors array:', JSON.stringify(response.data.errors, null, 2));
          
          // Check for 409 status (Conflict) - often indicates image reuse issue
          if (response.status === 409) {
            console.error(`❌ ShareTribe API returned 409 Conflict status`);
            console.error(`   This often indicates an image UUID is already in use or invalid`);
            console.error(`   Image IDs sent: ${JSON.stringify(listingData.images || [])}`);
          }
          
          // Check if error is related to invalid images
          const imageError = response.data.errors.find(err => 
            err.code === 'image-invalid' || 
            err.status === 409 ||
            (err.title && err.title.toLowerCase().includes('image')) ||
            (err.title && err.title.toLowerCase().includes('invalid image')) ||
            (err.detail && err.detail.toLowerCase().includes('image'))
          );
          
          // If image error and we have images, provide detailed error info
          if (imageError && listingData.images && listingData.images.length > 0) {
            console.error(`❌ ShareTribe Image Validation Error Detected:`);
            console.error(`   Error Code: ${imageError.code || 'unknown'}`);
            console.error(`   Error Status: ${imageError.status || response.status}`);
            console.error(`   Error Title: ${imageError.title || 'Invalid image'}`);
            console.error(`   Error Detail: ${imageError.detail || 'No detail provided'}`);
            console.error(`   Error Source: ${JSON.stringify(imageError.source || {})}`);
            console.error(`   Image IDs attempted: ${JSON.stringify(listingData.images)}`);
            console.error(`   Image format used: images: [uuid] (correct ShareTribe format)`);
            console.error(`   Possible causes:`);
            console.error(`   1. Image UUID is invalid or doesn't exist in ShareTribe`);
            console.error(`   2. Image was deleted from ShareTribe`);
            console.error(`   3. Image UUID is already used in another listing (ShareTribe doesn't allow reuse)`);
            console.error(`   4. Image UUID format is incorrect`);
            console.error(`   Solution: Upload a fresh image for each listing (we now do this automatically)`);
            console.error(`   Action: Check ShareTribe Console → Images to verify the UUID exists`);
            
            // Retry without images as fallback
            console.warn(`⚠️ Retrying listing creation without images...`);
            
            // Create a new payload without images
            const retryPayload = JSON.parse(JSON.stringify(listingData));
            retryPayload.images = [];
            
            // Retry the request without images
            const retryResponse = await axios.post(
              apiUrl,
              retryPayload,
              {
                headers: headers,
                validateStatus: function (status) {
                  return status < 500;
                }
              }
            );
            
            console.log('Retry response status:', retryResponse.status);
            
            // If retry succeeds, use that response and continue
            if (retryResponse.status >= 200 && retryResponse.status < 300) {
              console.warn(`⚠️ Listing created successfully but WITHOUT images due to image validation error.`);
              console.warn(`   Please check your default image configuration and upload a new image if needed.`);
              // Replace response with retry response
              response.status = retryResponse.status;
              response.statusText = retryResponse.statusText;
              response.data = retryResponse.data;
              response.headers = retryResponse.headers;
              // Update createResponseData for storage
              createResponseData.status = retryResponse.status;
              createResponseData.statusText = retryResponse.statusText;
              createResponseData.data = retryResponse.data;
              createResponseData.headers = retryResponse.headers;
            } else {
              // If retry also fails, throw error with both error messages
              const retryErrors = retryResponse.data?.errors || [];
              const errorMsg = `ShareTribe API returned errors. Original image error: ${imageError.title || imageError.code}. Retry errors: ${JSON.stringify(retryErrors)}`;
              console.error(errorMsg);
              throw new Error(errorMsg);
            }
          }
        }
        
        // Extract listing ID from response
        const listingId = this.extractListingId(response.data);
        console.log('Extracted listingId from create response:', listingId);
        
        // Check if publicData was accepted in create response
        if (response.data && response.data.data && response.data.data.attributes) {
          const returnedPublicData = response.data.data.attributes.publicData || {};
          const returnedPrivateData = response.data.data.attributes.privateData || {};
          const returnedDescription = response.data.data.attributes.description || '';
          const returnedTitle = response.data.data.attributes.title || '';
          
          console.log('=== ShareTribe Create Response Analysis ===');
          console.log('Sent title:', listingData.title);
          console.log('Returned title:', returnedTitle);
          console.log('Sent description:', listingData.description);
          console.log('Returned description:', returnedDescription);
          console.log('Sent publicData keys:', Object.keys(listingData.publicData || {}));
          console.log('Returned publicData keys:', Object.keys(returnedPublicData));
          console.log('Sent privateData keys:', Object.keys(listingData.privateData || {}));
          console.log('Returned privateData keys:', Object.keys(returnedPrivateData));
          
          // Compare sent vs returned
          const sentPublicDataKeys = Object.keys(listingData.publicData || {});
          const returnedPublicDataKeys = Object.keys(returnedPublicData);
          const missingKeys = sentPublicDataKeys.filter(key => !returnedPublicDataKeys.includes(key));
          
          if (missingKeys.length > 0) {
            console.error('❌ REJECTED FIELDS: ShareTribe did not accept these publicData fields:', missingKeys);
            console.error('Sent values for rejected fields:');
            missingKeys.forEach(key => {
              console.error(`  - ${key}: "${listingData.publicData[key]}" (type: ${typeof listingData.publicData[key]})`);
            });
            console.error('');
            console.error('⚠️  POSSIBLE REASONS:');
            console.error('1. Field keys don\'t match exactly (case-sensitive) - check ShareTribe Console > Listings > Listing Fields');
            console.error('2. Enum values don\'t match allowed options (case-sensitive) - check allowed values in ShareTribe Console');
            console.error('3. Fields not attached to listing type - ensure fields are attached to your listing type');
            console.error('4. Fields not attached to category - ensure fields are attached to the selected category');
            console.error('');
            console.error('💡 TIP: Compare your values with the successful listing:');
            console.error('   - gearbrand: "alpinestars" (lowercase, no spaces)');
            console.error('   - helmetsize: "m" (lowercase)');
            console.error('   - newused: "used" (lowercase)');
            console.error('');
            console.error('Your current values:');
            missingKeys.forEach(key => {
              console.error(`   - ${key}: "${listingData.publicData[key]}"`);
            });
          }
          
          // Also check for value mismatches (field exists but value changed)
          sentPublicDataKeys.forEach(key => {
            if (returnedPublicDataKeys.includes(key)) {
              const sentValue = listingData.publicData[key];
              const returnedValue = returnedPublicData[key];
              if (JSON.stringify(sentValue) !== JSON.stringify(returnedValue)) {
                console.warn(`⚠️  Value mismatch for ${key}: sent "${sentValue}" but ShareTribe returned "${returnedValue}"`);
              }
            }
          });
          
          console.log('Returned publicData full content:', JSON.stringify(returnedPublicData, null, 2));
          console.log('Returned privateData full content:', JSON.stringify(returnedPrivateData, null, 2));
        }
        
        // Check HTTP status code first
        if (response.status === 404) {
          // If 404, try alternative endpoint for Integration API
          if (this.isIntegrationAPI && !existingListingId) {
            console.log('404 error, trying alternative endpoint without /create');
            const altUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/listings`;
            console.log('Trying alternative URL:', altUrl);
            
            try {
              const altResponse = await axios.post(
                altUrl,
                listingData,
                {
                  headers: headers,
                  validateStatus: function (status) {
                    return status < 500;
                  }
                }
              );
              
              if (altResponse.status >= 200 && altResponse.status < 300) {
                console.log('Alternative endpoint worked! Status:', altResponse.status);
                const listingId = this.extractListingId(altResponse.data);
                return { success: true, listingId: listingId, data: altResponse.data };
              } else {
                const errorMsg = `ShareTribe API returned error status ${altResponse.status}: ${altResponse.statusText}. Tried both /create and base endpoint. Response: ${JSON.stringify(altResponse.data).substring(0, 300)}`;
                console.error(errorMsg);
                throw new Error(errorMsg);
              }
            } catch (altError) {
              const errorMsg = `ShareTribe API endpoint not found (404). Tried: ${apiUrl} and ${altUrl}. Response: ${JSON.stringify(response.data).substring(0, 300)}`;
              console.error(errorMsg);
              throw new Error(errorMsg);
            }
          } else {
            const errorMsg = `ShareTribe API returned error status ${response.status}: ${response.statusText}. Endpoint: ${apiUrl}. Response: ${JSON.stringify(response.data).substring(0, 300)}`;
            console.error(errorMsg);
            throw new Error(errorMsg);
          }
        }
        
        if (response.status < 200 || response.status >= 300) {
          const errorMsg = `ShareTribe API returned error status ${response.status}: ${response.statusText}. Response: ${JSON.stringify(response.data).substring(0, 300)}`;
          console.error(errorMsg);
          throw new Error(errorMsg);
        }
        
        // Check if response is HTML (indicates authentication failure or wrong endpoint)
        const contentType = response.headers['content-type'] || '';
        const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        
        if (contentType.includes('text/html') || responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
          console.error('ShareTribe API returned HTML instead of JSON. This usually means:');
          console.error('1. Authentication failed (check Client ID and Client Secret)');
          console.error('2. Wrong API endpoint or Marketplace ID');
          console.error('3. API credentials don\'t have access to this marketplace');
          console.error('4. Marketplace ID might be incorrect');
          console.error('Response status:', response.status);
          console.error('Response URL:', apiUrl);
          console.error('Full response headers:', JSON.stringify(response.headers, null, 2));
          throw new Error(`ShareTribe API authentication failed or wrong endpoint. Received HTML response (status ${response.status}). Please verify your Client ID, Client Secret, and Marketplace ID in API Configuration. The Marketplace ID should be just the marketplace name (e.g., "motogarage-test"), not a full URL.`);
        }
        
        console.log('ShareTribe API response:', {
          status: response.status,
          statusText: response.statusText,
          contentType: contentType,
          dataKeys: response.data && typeof response.data === 'object' ? Object.keys(response.data) : 'not an object',
          dataStructure: typeof response.data === 'object' ? JSON.stringify(response.data, null, 2).substring(0, 500) : 'not JSON'
        });
        
        // After successful creation, verify images were attached via /listings/show with include=images
        if (response.status >= 200 && response.status < 300 && listingId) {
          console.log('=== Verifying images attachment via /listings/show ===');
          console.log(`Calling GET /v1/integration_api/listings/show?id=${listingId}&include=images...`);
          
          try {
            // Wait a moment for ShareTribe to process the listing
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Call the specific endpoint with include=images to verify images were attached
            const verifyUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/listings/show?id=${listingId}&include=images`;
            const verifyHeaders = await this.getAuthHeaders();
            
            const verifyResponse = await axios.get(verifyUrl, {
              headers: verifyHeaders,
              validateStatus: function (status) {
                return status < 500;
              }
            });
            
            console.log('=== Image Verification Response ===');
            console.log('Status:', verifyResponse.status);
            
            if (verifyResponse.status >= 200 && verifyResponse.status < 300) {
              const verifyListingData = verifyResponse.data?.data;
              const includedImages = verifyResponse.data?.included?.filter(item => item.type === 'image') || [];
              
              // Check relationships
              const imagesRelationship = verifyListingData?.relationships?.images;
              
              if (imagesRelationship && imagesRelationship.data && imagesRelationship.data.length > 0) {
                console.log(`✅ VERIFIED: Listing has ${imagesRelationship.data.length} image(s) attached`);
                console.log(`   Image IDs in relationships:`, JSON.stringify(imagesRelationship.data));
                
                if (includedImages.length > 0) {
                  console.log(`✅ VERIFIED: ${includedImages.length} image(s) in included data:`);
                  includedImages.forEach((img, idx) => {
                    console.log(`   Image ${idx + 1}: ID=${img.id}, Type=${img.type}`);
                  });
                } else {
                  console.log(`⚠️ Images in relationships but not in included data (may need to wait for processing)`);
                }
              } else {
                console.error(`❌ VERIFICATION FAILED: No images found in listing relationships`);
                console.error(`   Listing ID: ${listingId}`);
                console.error(`   Images sent in create payload: ${JSON.stringify(listingData.images || [])}`);
                console.error(`   Relationships in verification response:`, JSON.stringify(verifyListingData?.relationships || {}));
                console.error(`   This means ShareTribe did not attach the images. Possible reasons:`);
                console.error(`   1. Image UUID is invalid or doesn't exist in ShareTribe`);
                console.error(`   2. Image was deleted from ShareTribe`);
                console.error(`   3. Image UUID format is incorrect`);
                console.error(`   4. Image UUID was not from ShareTribe's upload endpoint (must be from POST /v1/integration_api/images/upload)`);
                console.error(`   Please verify:`);
                console.error(`   - The image UUID exists in ShareTribe Console → Images`);
                console.error(`   - The UUID was returned from POST /v1/integration_api/images/upload (response.data.data.id)`);
                console.error(`   - The UUID matches exactly (case-sensitive)`);
              }
              
              console.log('Full verification response:', JSON.stringify(verifyResponse.data, null, 2));
            } else {
              console.error(`⚠️ Verification request failed with status ${verifyResponse.status}`);
              console.error(`Response:`, JSON.stringify(verifyResponse.data, null, 2));
            }
            
            // Also call getListing for backward compatibility
            const showResponse = await this.getListing(listingId);
            console.log('=== /listings/show Response (backward compatibility) ===');
            console.log('Full show response:', JSON.stringify(showResponse, null, 2));
            
            // Extract data from show response
            const showData = showResponse?.data?.attributes || showResponse?.attributes || showResponse;
            const showPublicData = showData?.publicData || {};
            const showPrivateData = showData?.privateData || {};
            const showTitle = showData?.title || '';
            const showDescription = showData?.description || '';
            
            console.log('=== Comparison: Sent vs /listings/show ===');
            console.log('Title - Sent:', listingData.title, '| Show:', showTitle);
            console.log('Description - Sent:', listingData.description?.substring(0, 100), '| Show:', showDescription?.substring(0, 100));
            console.log('publicData keys - Sent:', Object.keys(listingData.publicData || {}), '| Show:', Object.keys(showPublicData));
            console.log('privateData keys - Sent:', Object.keys(listingData.privateData || {}), '| Show:', Object.keys(showPrivateData));
            
            // Detailed comparison of publicData
            const sentPublicDataKeysDetailed = Object.keys(listingData.publicData || {});
            const showPublicDataKeysDetailed = Object.keys(showPublicData);
            const missingInShow = sentPublicDataKeysDetailed.filter(key => !showPublicDataKeysDetailed.includes(key));
            const extraInShow = showPublicDataKeysDetailed.filter(key => !sentPublicDataKeysDetailed.includes(key));
            
            if (missingInShow.length > 0) {
              console.error('❌ Fields sent but NOT present in /listings/show:', missingInShow);
              console.error('This indicates ShareTribe rejected these fields. Check:');
              console.error('1. Field keys match exactly (case-sensitive)');
              console.error('2. Field values match allowed enum options');
              console.error('3. Fields are registered in ShareTribe Console > Listings > Listing Fields');
              console.error('4. Fields are attached to the listing type');
            }
            
            if (extraInShow.length > 0) {
              console.log('ℹ️  Fields present in /listings/show but not sent:', extraInShow);
            }
            
            // Compare values for each field
            console.log('=== Field-by-Field Comparison ===');
            sentPublicDataKeysDetailed.forEach(key => {
              const sentValue = listingData.publicData[key];
              const showValue = showPublicData[key];
              if (JSON.stringify(sentValue) !== JSON.stringify(showValue)) {
                console.warn(`⚠️  Field "${key}" mismatch:`);
                console.warn(`   Sent: ${JSON.stringify(sentValue)}`);
                console.warn(`   Show: ${JSON.stringify(showValue)}`);
              } else {
                console.log(`✅ Field "${key}" matches: ${JSON.stringify(sentValue)}`);
              }
            });
            
            // Store show response for debugging
            createResponseData.showResponse = showResponse;
            createResponseData.comparison = {
              missingInShow,
              extraInShow,
              titleMatch: listingData.title === showTitle,
              descriptionMatch: listingData.description === showDescription,
              publicDataKeysMatch: JSON.stringify(sentPublicDataKeysDetailed.sort()) === JSON.stringify(showPublicDataKeysDetailed.sort())
            };
            
          } catch (showError) {
            console.error('❌ Error calling /listings/show:', showError.message);
            console.error('This may indicate the listing was not created successfully, or there was an error fetching it.');
            createResponseData.showError = showError.message;
          }
          
          // Set stock for finite-stock listings (required for "Buy now" button)
          try {
            const listingTypeId = listingData.publicData?.listingType || productData.listingType || productData.listing_type;
            
            if (listingTypeId) {
              console.log(`🔍 Checking if listing type ${listingTypeId} requires stock...`);
              const requiresStock = await this.checkListingTypeRequiresStock(listingTypeId);
              
              if (requiresStock) {
                console.log(`📦 Setting stock to 1 for listing ${listingId} (listing type: ${listingTypeId})`);
                await this.setStock(listingId, 1);
                console.log(`✅ Stock set successfully - listing should now show "Buy now" button`);
              } else {
                console.log(`ℹ️ Listing type ${listingTypeId} does not require finite stock - skipping stock setting`);
              }
            } else {
              // If no listing type specified, default to setting stock (most listings are finite)
              console.log(`⚠️ No listing type specified - defaulting to setting stock to 1`);
              await this.setStock(listingId, 1);
              console.log(`✅ Stock set successfully (default behavior)`);
            }
          } catch (stockError) {
            console.error(`⚠️ Failed to set stock for listing ${listingId}:`, stockError.message);
            console.error(`   This may cause the listing to show as "Out of stock"`);
            console.error(`   Error details:`, stockError.response?.data || stockError);
            // Don't throw - stock setting failure shouldn't fail the entire sync
          }
        } else if (response.status >= 200 && response.status < 300 && listingId) {
          // If image verification wasn't run, still set stock
          try {
            const listingTypeId = listingData.publicData?.listingType || productData.listingType || productData.listing_type;
            if (listingTypeId) {
              const requiresStock = await this.checkListingTypeRequiresStock(listingTypeId);
              if (requiresStock) {
                await this.setStock(listingId, 1);
                console.log(`✅ Stock set successfully`);
              }
            } else {
              await this.setStock(listingId, 1);
              console.log(`✅ Stock set successfully (default behavior)`);
            }
          } catch (stockError) {
            console.error(`⚠️ Failed to set stock:`, stockError.message);
          }
        }
        
        // Store response for admin interface
        // Use the payload that was actually sent (payloadBeforeSend)
        responseStore.addResponse({
          listingId: listingId,
          ebayItemId: listingData.privateData?.ebay_item_id || productData.ebay_item_id || 'unknown',
          timestamp: new Date().toISOString(),
          createResponse: createResponseData,
          sentPayload: payloadBeforeSend, // The exact payload that was sent
          sourceProduct: productData // Also store source for comparison
        });
        
        // Return response with full debugging data
        return { 
          success: true, 
          listingId: listingId, 
          data: response.data,
          createResponse: createResponseData // Include full response and show comparison
        };
      }
    } catch (error) {
      const errorDetails = error.response?.data || error.message;
      const contentType = error.response?.headers?.['content-type'] || '';
      const responseText = typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails);
      
      // Check if error response is HTML (authentication failure)
      const isHtmlResponse = contentType.includes('text/html') || 
                            responseText.trim().startsWith('<!DOCTYPE') || 
                            responseText.trim().startsWith('<html');
      
      const errorInfo = {
        status: error.response?.status,
        statusText: error.response?.statusText,
        contentType: contentType,
        isHtmlResponse: isHtmlResponse,
        data: isHtmlResponse ? 'HTML response (authentication likely failed)' : errorDetails,
        message: error.message,
        listingData: listingData || 'Not generated',
        apiUrl: `${this.baseUrl}/own_listings.json`,
        marketplaceId: this.marketplaceId
      };
      
      console.error('Error creating/updating ShareTribe listing:', errorInfo);
      
      // Provide more detailed error message
      let errorMessage = `Failed to create/update ShareTribe listing: ${error.message}`;
      
      if (isHtmlResponse) {
        errorMessage = `ShareTribe API authentication failed. Received HTML response instead of JSON (status ${error.response?.status || 'unknown'}). `;
        errorMessage += `Please verify your Client ID, Client Secret, and Marketplace ID in the API Configuration tab. `;
        errorMessage += `The API endpoint being used is: ${this.baseUrl}/own_listings.json`;
      } else if (error.response?.data) {
        if (typeof error.response.data === 'string') {
          errorMessage += ` - ${error.response.data.substring(0, 200)}`;
        } else if (error.response.data.errors) {
          errorMessage += ` - ${JSON.stringify(error.response.data.errors)}`;
        } else if (error.response.data.error) {
          errorMessage += ` - ${error.response.data.error}`;
        } else if (typeof error.response.data === 'object') {
          errorMessage += ` - Response: ${JSON.stringify(error.response.data).substring(0, 200)}`;
        }
      }
      
      // Include more context in error
      const enhancedError = new Error(errorMessage);
      enhancedError.details = errorInfo;
      throw enhancedError;
    }
  }

  // Extract listing ID from API response
  extractListingId(responseData) {
    if (!responseData || typeof responseData !== 'object') {
      throw new Error('ShareTribe API returned non-JSON response. Response type: ' + typeof responseData);
    }
    
    // Try different response structures
    if (responseData.data && responseData.data.id) {
      return responseData.data.id.uuid || responseData.data.id;
    } else if (responseData.id) {
      return responseData.id.uuid || responseData.id;
    } else if (responseData.uuid) {
      return responseData.uuid;
    } else if (responseData.data && responseData.data.uuid) {
      return responseData.data.uuid;
    } else {
      console.error('Unexpected ShareTribe API response structure:', JSON.stringify(responseData, null, 2));
      throw new Error('ShareTribe API returned unexpected response structure. Response: ' + JSON.stringify(responseData).substring(0, 500));
    }
  }

  // Build ShareTribe payload - SINGLE SOURCE OF TRUTH
  // This function is used for both preview and actual API calls
  // DO NOT modify the returned payload - use it as-is
  async buildSharetribePayload(productData) {
    const correlationId = productData.ebay_item_id || 'unknown';
    
    // CHECKPOINT 1: Log source product (raw)
    console.log(`=== CHECKPOINT 1 [${correlationId}]: Source Product (Raw) ===`);
    console.log(JSON.stringify(productData, null, 2));
    console.log(`Source product keys:`, Object.keys(productData));
    console.log(`Source product.title:`, productData.title);
    console.log(`Source product.description:`, productData.description);
    console.log(`Source product.price:`, productData.price);
    console.log(`Source product.currency:`, productData.currency);
    
    // ============================================
    // publicData: User-visible marketplace schema
    // ============================================
    const publicData = {};
    
    // Listing type (resolved from productData, not hardcoded)
    // CRITICAL: ShareTribe expects listingType in publicData
    if (productData.listingType || productData.listing_type) {
      publicData.listingType = productData.listingType || productData.listing_type;
    }
    
    // Category structure: ShareTribe expects categoryLevel1, categoryLevel2 directly
    // NOT category/subcategory - use the exact field names ShareTribe expects
    if (productData.categoryLevel1) {
      publicData.categoryLevel1 = productData.categoryLevel1;
    }
    if (productData.categoryLevel2) {
      publicData.categoryLevel2 = productData.categoryLevel2;
    }
    if (productData.categoryLevel3) {
      publicData.categoryLevel3 = productData.categoryLevel3;
    }
    if (productData.categoryLevel4) {
      publicData.categoryLevel4 = productData.categoryLevel4;
    }
    if (productData.categoryLevel5) {
      publicData.categoryLevel5 = productData.categoryLevel5;
    }
    
    // Fallback: If categoryLevel1 doesn't exist but category does, use it
    // But prefer categoryLevel1 if both exist
    if (!productData.categoryLevel1 && productData.category) {
      publicData.categoryLevel1 = productData.category;
    }
    
    // Listing fields: All custom fields go flat in publicData
    // Field keys must match ShareTribe listing field keys exactly
    // Values must match allowed option values (for enums)
    const excludedKeys = [
      // Core system fields (go at top level, not in publicData)
      'title', 'description', 'price', 'currency', 'images', 'geolocation',
      // Image-related fields (images are top-level only, NOT in publicData)
      'defaultImageId', 'default_image_id', 'defaultimageid',
      'defaultImagePath', 'default_image_path', 'defaultimagepath', // Internal file path, not for ShareTribe
      // User-configured listing defaults (go in publicData, not at top level)
      'pickupEnabled', 'shippingEnabled', 'shippingMeasurement', 'transactionProcessAlias', 'unitType',
      'location', // Location goes in publicData, but handled separately above
      'parcel', // Parcel goes in publicData, but handled separately above
      // Category fields (already handled above - EXCLUDE from listing fields processing)
      'category', // Exclude old 'category' field if categoryLevel1 exists
      'subcategory', // Exclude old 'subcategory' field if categoryLevel2 exists
      'categoryLevel1', 'categoryLevel2', 'categoryLevel3', 'categoryLevel4', 'categoryLevel5',
      'categorylevel1', 'categorylevel2', 'categorylevel3', 'categorylevel4', 'categorylevel5', // Exclude lowercase variants
      // Listing type (already handled above)
      'listingType', 'listing_type',
      // Database metadata
      'ebay_item_id', 'id', 'tenant_id', 'synced', 'sharetribe_listing_id', 'last_synced_at', 
      'created_at', 'updated_at', 'user_id', 'custom_fields',
      // Quantity (not a ShareTribe field)
      'quantity'
    ];
    
    // Category field keys that should NOT be normalized (keep as-is)
    const categoryFieldKeys = ['categoryLevel1', 'categoryLevel2', 'categoryLevel3', 'categoryLevel4', 'categoryLevel5'];
    
    // Helper function to normalize ShareTribe field VALUES (not keys)
    // ShareTribe requires enum/string values: lowercase, no spaces, no dashes
    // Example: "Fox Racing" -> "foxracing", "L" -> "l"
    const normalizeFieldValue = (value) => {
      if (value === null || value === undefined) return value;
      
      // If it's a string, normalize it
      if (typeof value === 'string') {
        return value
          .toLowerCase()                    // Convert to lowercase
          .replace(/\s+/g, '')              // Remove all spaces
          .replace(/-/g, '')                 // Remove all dashes
          .replace(/_/g, '');                // Remove all underscores
      }
      
      // If it's an array, normalize each element
      if (Array.isArray(value)) {
        return value.map(item => normalizeFieldValue(item));
      }
      
      // For other types (numbers, booleans, objects), return as-is
      return value;
    };
    
    // Helper function to normalize ShareTribe field keys
    // ShareTribe requires: lowercase, spaces replaced with dashes
    const normalizeFieldKey = (key) => {
      if (!key || typeof key !== 'string') return key;
      return key
        .toLowerCase()                    // Convert to lowercase
        .replace(/\s+/g, '-')             // Replace spaces with dashes
        .replace(/_/g, '-')               // Replace underscores with dashes
        .replace(/--+/g, '-')             // Replace multiple dashes with single dash
        .replace(/^-+|-+$/g, '');         // Remove leading/trailing dashes
    };
    
    // Add all listing fields (gearbrand, helmetsize, newused, condition, brand, sku, etc.)
    // Field VALUES MUST be normalized: lowercase, no spaces/dashes (e.g., "Fox Racing" -> "foxracing", "L" -> "l")
    // Field KEYS must use the EXACT ShareTribe field IDs (e.g., "glove_size", NOT "glove-size")
    // IMPORTANT: Category fields (categoryLevel1, etc.) are EXCLUDED - they're already set above and should NOT be normalized
    // DO NOT filter out empty strings, null, or undefined - only exclude undefined/null at the key level
    Object.keys(productData).forEach(key => {
      // Skip excluded keys (including category fields)
      if (excludedKeys.includes(key)) {
        return;
      }
      
      // Skip category fields (check both original and normalized key)
      const normalizedKey = normalizeFieldKey(key);
      const isCategoryField = categoryFieldKeys.some(catKey => 
        key.toLowerCase() === catKey.toLowerCase() || 
        normalizedKey === catKey.toLowerCase()
      );
      
      if (isCategoryField) {
        return; // Skip category fields - they're already set above with correct format
      }
      
      // Skip if already set in publicData (like categoryLevel fields)
      // Use the exact key (not normalized) since ShareTribe field IDs are already correct
      if (publicData.hasOwnProperty(key)) {
        return;
      }
      
      // Include the field if it's not undefined/null
      // Include empty strings, empty objects, empty arrays - let ShareTribe decide
      if (productData[key] !== undefined && productData[key] !== null) {
        // Use the EXACT field key from ShareTribe (no normalization)
        // The field IDs from ShareTribe are already in the correct format (e.g., "glove_size")
        // Normalize the field VALUE (string values must be lowercase, no spaces/dashes)
        // ONLY normalize values for listing fields, NOT category fields
        const normalizedValue = normalizeFieldValue(productData[key]);
        
        // Use the exact key as-is (ShareTribe field IDs are already correct)
        publicData[key] = normalizedValue;
        
        // Log value normalization for debugging (but not key normalization since we're using exact IDs)
        if (productData[key] !== normalizedValue) {
          console.log(`Normalized listing field value "${key}": "${productData[key]}" -> "${normalizedValue}"`);
        }
      }
    });
    
    // ============================================
    // Build Integration API listing structure
    // ============================================
    const listingData = {};
    
    // Core system fields at top level
    // DO NOT convert undefined to empty string - only set if value exists
    if (productData.title !== undefined && productData.title !== null) {
      listingData.title = productData.title;
    } else {
      listingData.title = ''; // Title is required, so use empty string as fallback
    }
    
    // Description: Keep as-is or omit, but don't convert undefined to ""
    if (productData.description !== undefined && productData.description !== null && productData.description !== '') {
      listingData.description = productData.description;
    }
    // If description is missing, don't set it at all (or set to empty string if required)
    // ShareTribe may require description, so we'll set empty string if missing
    if (!listingData.description) {
      listingData.description = '';
    }
    
    // authorId and state (required for Integration API)
    if (this.userId) {
      listingData.authorId = this.userId;
    } else {
      throw new Error('authorId is required for Integration API. Please select a ShareTribe user.');
    }
    listingData.state = 'published'; // Create listings as published by default
    
    // Price object (amount in minor units, currency as ISO 4217)
    // ALWAYS set price if productData.price exists, even if 0
    if (productData.price !== undefined && productData.price !== null) {
      const priceAmount = typeof productData.price === 'number' ? productData.price : parseFloat(productData.price);
      if (!isNaN(priceAmount)) {
        // Convert to minor units (e.g., dollars to cents, pounds to pence)
        const amountInMinorUnits = Math.round(priceAmount * 100);
        
        // Determine currency: ALWAYS use marketplace default currency (GBP for UK marketplace)
        // Override any currency in productData to ensure consistency
        let currency = 'GBP'; // Default fallback
        try {
          const marketplaceConfig = await this.getMarketplaceConfig();
          currency = marketplaceConfig?.currency || 'GBP';
          console.log(`Using marketplace default currency: ${currency} (overriding productData.currency: ${productData.currency || 'none'})`);
        } catch (error) {
          console.warn(`Could not fetch marketplace config for currency, using GBP:`, error.message);
          currency = 'GBP'; // Default to GBP for UK marketplace
        }
        
        listingData.price = {
          amount: amountInMinorUnits,
          currency: currency
        };
      }
    }
    
    // Location (user address details) - goes in publicData
    // This is automatically included from user settings, not from CSV
    if (productData.location) {
      publicData.location = productData.location;
      console.log(`Added location to publicData for product ${correlationId}`);
    }
    
    // Parcel data (shipping dimensions/weight) - automatically included from user settings
    if (productData.parcel) {
      publicData.parcel = productData.parcel;
      console.log(`Added parcel to publicData for product ${correlationId}`);
    }
    
    // User-configured listing defaults (from user setup)
    // These fields go in publicData, not at top level
    if (productData.pickupEnabled !== undefined) {
      publicData.pickupEnabled = Boolean(productData.pickupEnabled);
    }
    if (productData.shippingEnabled !== undefined) {
      publicData.shippingEnabled = Boolean(productData.shippingEnabled);
    }
    if (productData.shippingMeasurement) {
      publicData.shippingMeasurement = productData.shippingMeasurement;
    }
    if (productData.transactionProcessAlias) {
      publicData.transactionProcessAlias = productData.transactionProcessAlias;
    }
    if (productData.unitType) {
      publicData.unitType = productData.unitType;
    }
    
    // Geolocation (if provided) - goes at top level for Integration API
    if (productData.geolocation) {
      listingData.geolocation = productData.geolocation;
    } else if (productData.lat && productData.lng) {
      listingData.geolocation = {
        lat: parseFloat(productData.lat),
        lng: parseFloat(productData.lng)
      };
    }
    
    // Images array (array of UUIDs) - ShareTribe format: images: [uuid]
    // CRITICAL: Images are top-level only, NOT in publicData
    // According to ShareTribe API: images field should be an array of UUID strings at top level
    // If no images, omit the field entirely (do NOT send empty array)
    
    // Helper function to validate UUID format
    const isValidUUID = (str) => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRegex.test(str);
    };
    
    const imageUUIDs = [];
    
    // Log image processing start
    console.log(`🔍 [${correlationId}] Image processing - productData.images:`, productData.images, `(type: ${typeof productData.images}, isArray: ${Array.isArray(productData.images)})`);
    console.log(`🔍 [${correlationId}] Image processing - productData.defaultImageId:`, productData.defaultImageId, `(type: ${typeof productData.defaultImageId})`);
    
    // Process product images first
    if (productData.images !== undefined && productData.images !== null) {
      if (Array.isArray(productData.images)) {
        console.log(`🔍 [${correlationId}] Processing images as array, length: ${productData.images.length}`);
        // Filter and validate UUIDs
        const validImages = productData.images
          .filter(img => img && typeof img === 'string')
          .map(img => img.trim())
          .filter(img => img && isValidUUID(img));
        imageUUIDs.push(...validImages);
        console.log(`🔍 [${correlationId}] Valid images from array: ${validImages.length}`, validImages);
      } else if (typeof productData.images === 'string' && productData.images.trim() !== '') {
        console.log(`🔍 [${correlationId}] Processing images as string: "${productData.images}"`);
        // Split comma-separated string and validate UUIDs
        const validImages = productData.images
          .split(',')
          .map(img => img.trim())
          .filter(img => img && isValidUUID(img));
        imageUUIDs.push(...validImages);
        console.log(`🔍 [${correlationId}] Valid images from string: ${validImages.length}`, validImages);
      } else {
        console.log(`🔍 [${correlationId}] productData.images is ${typeof productData.images} but empty/null - will check default image`);
      }
    } else {
      console.log(`🔍 [${correlationId}] productData.images is undefined/null - will check default image`);
    }
    
    console.log(`🔍 [${correlationId}] After processing product images: ${imageUUIDs.length} UUID(s)`, imageUUIDs);
    
    // If no images after processing, use default image if available
    if (imageUUIDs.length === 0) {
      console.log(`🔍 [${correlationId}] No product images found, checking default image...`);
      if (productData.defaultImageId) {
        const defaultImageId = typeof productData.defaultImageId === 'string' 
          ? productData.defaultImageId.trim() 
          : String(productData.defaultImageId).trim();
        
        console.log(`🔍 [${correlationId}] Default image ID found: "${defaultImageId}" (type: ${typeof defaultImageId})`);
        
        // Validate default image ID is a valid UUID
        if (isValidUUID(defaultImageId)) {
          imageUUIDs.push(defaultImageId);
          console.log(`✅ Using default image UUID ${defaultImageId} for product ${correlationId}`);
        } else {
          console.warn(`⚠️ Default image ID "${defaultImageId}" is not a valid UUID format. Skipping image.`);
        }
      } else {
        console.warn(`⚠️ [${correlationId}] No default image ID available in productData.defaultImageId`);
        console.warn(`   productData keys:`, Object.keys(productData));
        console.warn(`   productData.defaultImageId:`, productData.defaultImageId);
        console.warn(`   productData.default_image_id:`, productData.default_image_id);
        console.warn(`   productData.defaultimageid:`, productData.defaultimageid);
      }
    } else {
      console.log(`✅ [${correlationId}] Using ${imageUUIDs.length} product image(s), skipping default image`);
    }
    
    // Only set images field if we have valid UUIDs (omit entirely if empty)
    if (imageUUIDs.length > 0) {
      listingData.images = imageUUIDs;
      console.log(`📸 Setting images field with ${imageUUIDs.length} UUID(s) for product ${correlationId}: ${JSON.stringify(imageUUIDs)}`);
    } else {
      // Omit images field entirely if no images (per ShareTribe API requirements)
      console.log(`⚠️ No images available for product ${correlationId} - omitting images field entirely`);
    }
    
    // Log image configuration for debugging
    if (productData.defaultImageId) {
      console.log(`🔍 Default image ID in productData: ${productData.defaultImageId} (type: ${typeof productData.defaultImageId})`);
    }
    
    // publicData: Marketplace schema - ALWAYS set, even if empty
    listingData.publicData = publicData;
    
    // privateData: Integration data - ALWAYS set with eBay identifiers
    // Store eBay IDs for mapping back to eBay listings
    // This follows the recommended workflow: "Store eBay IDs in privateData"
    listingData.privateData = {};
    if (productData.ebay_item_id !== undefined && productData.ebay_item_id !== null) {
      listingData.privateData.ebay_item_id = productData.ebay_item_id; // Primary: SKU
    }
    // Store additional eBay identifiers if available
    if (productData.ebay_offer_id) {
      listingData.privateData.ebay_offer_id = productData.ebay_offer_id;
    }
    if (productData.ebay_listing_id) {
      listingData.privateData.ebay_listing_id = productData.ebay_listing_id;
    }
    
    // Availability plan - omit for normal "sell item" listings
    // Only include if explicitly required by the listing type
    // (Removed per ShareTribe best practices for standard item listings)
    
    // CHECKPOINT 2: Log built payload (immediately after build)
    console.log(`=== CHECKPOINT 2 [${correlationId}]: Built Payload (After Build) ===`);
    console.log(`Payload.title:`, listingData.title);
    console.log(`Payload.description:`, listingData.description);
    console.log(`Payload.price:`, listingData.price);
    console.log(`Payload.images:`, listingData.images ? JSON.stringify(listingData.images) : '(omitted - no images)');
    console.log(`Payload.publicData keys:`, Object.keys(listingData.publicData));
    console.log(`Payload.publicData:`, JSON.stringify(listingData.publicData, null, 2));
    console.log(`Payload.privateData keys:`, Object.keys(listingData.privateData));
    console.log(`Payload.privateData:`, JSON.stringify(listingData.privateData, null, 2));
    console.log(`Full payload:`, JSON.stringify(listingData, null, 2));
    
    return listingData;
  }

  // Transform product data to ShareTribe format
  // DEPRECATED: Use buildSharetribePayload() instead
  // Kept for backward compatibility - delegates to buildSharetribePayload
  async transformProductToShareTribe(productData) {
    return await this.buildSharetribePayload(productData);
  }

  // Get listing by ID
  async getListing(listingId) {
    try {
      const headers = await this.getAuthHeaders();
      let apiUrl;
      if (this.isIntegrationAPI) {
        // Include images in response to get full image data
        apiUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/listings/show?id=${listingId}&include=images`;
      } else {
        apiUrl = `${this.baseUrl}/own_listings/${listingId}.json`;
      }
      
      const response = await axios.get(
        apiUrl,
        {
          headers: headers
        }
      );
      return response.data;
    } catch (error) {
      console.error(`Error fetching ShareTribe listing ${listingId}:`, error.response?.data || error.message);
      throw new Error(`Failed to fetch ShareTribe listing: ${error.message}`);
    }
  }

  // Delete a listing
  async deleteListing(listingId) {
    try {
      const headers = await this.getAuthHeaders();
      let apiUrl;
      if (this.isIntegrationAPI) {
        apiUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/listings/${listingId}`;
      } else {
        apiUrl = `${this.baseUrl}/own_listings/${listingId}.json`;
      }
      
      await axios.delete(
        apiUrl,
        {
          headers: headers
        }
      );
      return { success: true };
    } catch (error) {
      console.error(`Error deleting ShareTribe listing ${listingId}:`, error.response?.data || error.message);
      throw new Error(`Failed to delete ShareTribe listing: ${error.message}`);
    }
  }

  // Get all listings
  async getAllListings() {
    try {
      // Use correct endpoint based on API type
      let apiUrl;
      if (this.isIntegrationAPI) {
        apiUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/listings/query`;
      } else {
        apiUrl = `${this.baseUrl}/own_listings.json`;
      }
      
      console.log('=== Fetching ShareTribe Listings ===');
      console.log('API Type:', this.isIntegrationAPI ? 'Integration API' : 'Marketplace API');
      console.log('API URL:', apiUrl);
      console.log('Marketplace ID:', this.marketplaceId);
      
      const headers = await this.getAuthHeaders();
      console.log('Authorization header:', headers.Authorization ? `${headers.Authorization.substring(0, 30)}...` : 'MISSING');
      
      const response = await axios.get(
        apiUrl,
        {
          headers: headers,
          params: {
            per_page: 100
          },
          validateStatus: function (status) {
            return status < 500; // Don't throw on 4xx errors
          }
        }
      );
      
      console.log('Response status:', response.status);
      console.log('Response Content-Type:', response.headers['content-type']);
      console.log('Response data type:', typeof response.data);
      
      // Check if response is HTML
      const contentType = response.headers['content-type'] || '';
      const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      
      if (contentType.includes('text/html') || responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
        console.error('ShareTribe API returned HTML instead of JSON');
        console.error('Response preview (first 500 chars):', responseText.substring(0, 500));
        throw new Error(`ShareTribe API authentication failed. Received HTML response (status ${response.status}). Please verify your Client ID, Client Secret, and Marketplace ID.`);
      }
      
      if (response.status < 200 || response.status >= 300) {
        console.error('ShareTribe API error response:', JSON.stringify(response.data, null, 2));
        throw new Error(`ShareTribe API returned error status ${response.status}: ${response.statusText}`);
      }
      
      console.log('ShareTribe API connection successful!');
      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching ShareTribe listings:', error.response?.data || error.message);
      if (error.response) {
        console.error('Error response status:', error.response.status);
        console.error('Error response headers:', error.response.headers);
        console.error('Error response data:', typeof error.response.data === 'string' 
          ? error.response.data.substring(0, 500) 
          : JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  // Query marketplace to get all available categories
  // This might use a different endpoint or query method
  async getAllCategories() {
    try {
      const headers = await this.getAuthHeaders();
      
      // Try querying listings with include=categories to get category relationships
      // Or try a categories query endpoint
      const endpoints = [];
      if (this.isIntegrationAPI) {
        // Try querying with include parameter
        endpoints.push(`https://flex-integ-api.sharetribe.com/v1/integration_api/listings/query?include=category&per_page=1`);
        endpoints.push(`https://flex-integ-api.sharetribe.com/v1/integration_api/categories/query`);
        endpoints.push(`https://flex-integ-api.sharetribe.com/v1/integration_api/marketplaces/${this.marketplaceId}/categories`);
      }
      
      for (const endpoint of endpoints) {
        try {
          console.log(`Trying to get all categories from: ${endpoint}`);
          const response = await axios.get(endpoint, {
            headers: headers,
            validateStatus: function (status) {
              return status < 500;
            }
          });
          
          if (response.status >= 200 && response.status < 300) {
            // Check included array for categories
            if (response.data.included) {
              const categories = response.data.included.filter(item => 
                item.type === 'category' || item.type === 'categories'
              );
              if (categories.length > 0) {
                console.log(`Found ${categories.length} categories from included array`);
                return categories.map(cat => {
                  const attrs = cat.attributes || cat;
                  return {
                    id: attrs.id || cat.id,
                    name: attrs.name || attrs.label || cat.id,
                    label: attrs.label || attrs.name || cat.id
                  };
                });
              }
            }
            
            // Check data array
            if (Array.isArray(response.data.data) && response.data.data.length > 0) {
              const categories = response.data.data.filter(item => 
                item.type === 'category'
              );
              if (categories.length > 0) {
                return categories.map(cat => {
                  const attrs = cat.attributes || cat;
                  return {
                    id: attrs.id || cat.id,
                    name: attrs.name || attrs.label || cat.id,
                    label: attrs.label || attrs.name || cat.id
                  };
                });
              }
            }
          }
        } catch (err) {
          console.log(`Endpoint ${endpoint} failed: ${err.message}`);
          continue;
        }
      }
      
      return [];
    } catch (error) {
      console.error('Error fetching all categories:', error.message);
      return [];
    }
  }

  // Query a single listing with includes to get listing type relationship
  async getListingWithIncludes(listingId) {
    try {
      const headers = await this.getAuthHeaders();
      const apiUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/listings/${listingId}?include=listingType,category`;
      
      console.log(`Querying listing ${listingId} with includes:`, apiUrl);
      const response = await axios.get(apiUrl, {
        headers: headers,
        validateStatus: function (status) {
          return status < 500;
        }
      });
      
      if (response.status >= 200 && response.status < 300) {
        console.log('Listing with includes response:', JSON.stringify(response.data, null, 2).substring(0, 2000));
        return response.data;
      }
      return null;
    } catch (error) {
      console.error('Error fetching listing with includes:', error.message);
      return null;
    }
  }

  // Get listing types from ShareTribe using Asset Delivery API
  // Asset Delivery API provides: /listings/listing-types.json
  // Base URL: https://cdn.st-api.com/v1/assets/pub/[CLIENT_ID]/
  async getListingTypes() {
    try {
      // Asset Delivery API requires Marketplace API Client ID
      if (!this.marketplaceApiClientId) {
        console.log('Marketplace API Client ID not configured, skipping Asset Delivery API');
        return [];
      }
      
      // Asset Delivery API endpoint format: https://cdn.st-api.com/v1/assets/pub/[CLIENT_ID]/listings/listing-types.json
      // Try both with and without marketplace ID, and try different aliases
      const assetDeliveryEndpoints = [
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/listings/listing-types.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/latest/listings/listing-types.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/${this.marketplaceId}/listings/listing-types.json`
      ];
      
      for (const endpoint of assetDeliveryEndpoints) {
        try {
          console.log(`Trying Asset Delivery API for listing types: ${endpoint}`);
          // Asset Delivery API uses Marketplace API client ID (no secret needed for read-only)
          const response = await axios.get(endpoint, {
            headers: {
              'Accept': 'application/json'
            },
            validateStatus: function (status) {
              return status < 500;
            }
          });
          
          console.log(`Asset Delivery API response status: ${response.status} for ${endpoint}`);
          
          if (response.status >= 200 && response.status < 300) {
            const data = response.data;
            console.log('=== Asset Delivery API Listing Types Response ===');
            console.log('Full response:', JSON.stringify(data, null, 2));
            console.log('Response type:', typeof data);
            console.log('Is array:', Array.isArray(data));
            if (data && typeof data === 'object') {
              console.log('Response keys:', Object.keys(data));
            }
            
            // Asset data might be in data array or directly as array
            let listingTypes = [];
            if (Array.isArray(data)) {
              listingTypes = data;
              console.log('Found listing types as direct array');
            } else if (data && data.data && Array.isArray(data.data)) {
              listingTypes = data.data;
              console.log('Found listing types in data.data array');
            } else if (data && data.listingTypes) {
              listingTypes = Array.isArray(data.listingTypes) ? data.listingTypes : [data.listingTypes];
              console.log('Found listing types in data.listingTypes');
            } else if (data && typeof data === 'object') {
              console.log('Response is object but no listing types found. Structure:', JSON.stringify(data, null, 2).substring(0, 500));
            }
            
            if (listingTypes.length > 0) {
              console.log(`Successfully fetched ${listingTypes.length} listing types from Asset Delivery API`);
              console.log('Sample listing type:', JSON.stringify(listingTypes[0], null, 2));
              return listingTypes.map(lt => {
                // Preserve full structure including attributes for stock type checking
                const attrs = lt.attributes || lt;
                return {
                  id: lt.id || lt.key || lt.listingTypeId || lt.listing_type_id || attrs.id || attrs.key,
                  name: lt.name || lt.label || lt.title || lt.id || attrs.name || attrs.label,
                  label: lt.label || lt.name || lt.title || lt.id || attrs.label || attrs.name,
                  attributes: attrs, // Preserve full attributes for stock type checking
                  stockType: attrs.stockType || attrs.stock_type || attrs.stockTypeId,
                  unitType: attrs.unitType || attrs.unit_type || attrs.unitTypeId
                };
              });
            } else {
              console.log('No listing types found in Asset Delivery API response');
            }
          } else {
            console.log(`Asset Delivery API returned non-200 status: ${response.status}`);
            console.log('Response:', JSON.stringify(response.data, null, 2).substring(0, 500));
          }
        } catch (err) {
          console.log(`Asset Delivery API endpoint ${endpoint} failed: ${err.message}`);
          if (err.response) {
            console.log(`Response status: ${err.response.status}`);
            console.log(`Response data:`, JSON.stringify(err.response.data, null, 2).substring(0, 500));
          }
          continue;
        }
      }
      
      console.warn('No listing types found from Asset Delivery API');
      return [];
    } catch (error) {
      console.error('Error fetching listing types:', error.response?.data || error.message);
      return [];
    }
  }

  // Get categories from ShareTribe using Asset Delivery API
  // Asset Delivery API provides: /listings/listing-categories.json
  // Base URL: https://cdn.st-api.com/v1/assets/pub/[CLIENT_ID]/
  async getCategories() {
    try {
      // Asset Delivery API requires Marketplace API Client ID
      if (!this.marketplaceApiClientId) {
        console.log('Marketplace API Client ID not configured, skipping Asset Delivery API');
        return [];
      }
      
      // Asset Delivery API endpoint format: https://cdn.st-api.com/v1/assets/pub/[CLIENT_ID]/a/latest/listings/listing-categories.json
      // The correct path includes /a/latest/ based on actual API response
      const assetDeliveryEndpoints = [
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/a/latest/listings/listing-categories.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/listings/listing-categories.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/latest/listings/listing-categories.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/${this.marketplaceId}/listings/listing-categories.json`
      ];
      
      for (const endpoint of assetDeliveryEndpoints) {
        try {
          console.log(`Trying Asset Delivery API for categories: ${endpoint}`);
          const response = await axios.get(endpoint, {
            headers: {
              'Accept': 'application/json'
            },
            validateStatus: function (status) {
              return status < 500;
            }
          });
          
          console.log(`Asset Delivery API response status: ${response.status} for ${endpoint}`);
          
          if (response.status >= 200 && response.status < 300) {
            const data = response.data;
            console.log('=== Asset Delivery API Categories Response ===');
            console.log('Full response:', JSON.stringify(data, null, 2));
            console.log('Response type:', typeof data);
            console.log('Is array:', Array.isArray(data));
            if (data && typeof data === 'object') {
              console.log('Response keys:', Object.keys(data));
            }
            
            // Asset data structure: { data: { categories: [...] } }
            // Categories are nested with subcategories that need to be flattened
            let categories = [];
            if (Array.isArray(data)) {
              categories = data;
              console.log('Found categories as direct array');
            } else if (data && data.data && data.data.categories && Array.isArray(data.data.categories)) {
              // Correct structure: data.data.categories
              categories = data.data.categories;
              console.log('Found categories in data.data.categories');
            } else if (data && data.data && Array.isArray(data.data)) {
              categories = data.data;
              console.log('Found categories in data.data array');
            } else if (data && data.categories) {
              categories = Array.isArray(data.categories) ? data.categories : [data.categories];
              console.log('Found categories in data.categories');
            } else if (data && typeof data === 'object') {
              console.log('Response is object but no categories found. Structure:', JSON.stringify(data, null, 2).substring(0, 500));
            }
            
            if (categories.length > 0) {
              // Transform categories preserving parent-child relationships
              const transformCategories = (catList, parentId = null, level = 0) => {
                return catList.map(cat => {
                  // Extract category info (handle both with and without attributes)
                  const attrs = cat.attributes || cat;
                  const categoryId = attrs.id || attrs.key || cat.id;
                  const categoryName = attrs.name || attrs.label || attrs.title || cat.id;
                  
                  // Build category object with parent reference
                  const categoryObj = {
                    id: categoryId,
                    name: categoryName,
                    label: attrs.label || attrs.name || attrs.title || categoryId,
                    parentId: parentId || null,
                    level: level
                  };
                  
                  // Recursively transform subcategories if they exist
                  if (cat.subcategories && Array.isArray(cat.subcategories) && cat.subcategories.length > 0) {
                    categoryObj.subcategories = transformCategories(cat.subcategories, categoryId, level + 1);
                  } else {
                    categoryObj.subcategories = [];
                  }
                  
                  return categoryObj;
                });
              };
              
              const transformedCategories = transformCategories(categories);
              
              // Count total categories (including nested)
              const countCategories = (catList) => {
                let count = catList.length;
                catList.forEach(cat => {
                  if (cat.subcategories && cat.subcategories.length > 0) {
                    count += countCategories(cat.subcategories);
                  }
                });
                return count;
              };
              
              const totalCount = countCategories(transformedCategories);
              console.log(`Successfully fetched ${totalCount} categories (including nested subcategories) from Asset Delivery API`);
              console.log(`Top-level categories: ${transformedCategories.length}, Total with children: ${totalCount}`);
              console.log('Sample category structure:', JSON.stringify(transformedCategories[0], null, 2));
              
              return transformedCategories;
            } else {
              console.log('No categories found in Asset Delivery API response');
            }
          } else {
            console.log(`Asset Delivery API returned non-200 status: ${response.status}`);
            console.log('Response:', JSON.stringify(response.data, null, 2).substring(0, 500));
          }
        } catch (err) {
          console.log(`Asset Delivery API endpoint ${endpoint} failed: ${err.message}`);
          if (err.response) {
            console.log(`Response status: ${err.response.status}`);
            console.log(`Response data:`, JSON.stringify(err.response.data, null, 2).substring(0, 500));
          }
          continue;
        }
      }
      
      console.warn('No categories found from Asset Delivery API');
      return [];
    } catch (error) {
      console.error('Error fetching categories:', error.response?.data || error.message);
      return [];
    }
  }

  // Get listing fields from ShareTribe using Asset Delivery API
  // Asset Delivery API provides: /listings/listing-fields.json
  // Base URL: https://cdn.st-api.com/v1/assets/pub/[CLIENT_ID]/
  async getListingFields() {
    try {
      // Asset Delivery API requires Marketplace API Client ID
      if (!this.marketplaceApiClientId) {
        console.log('Marketplace API Client ID not configured, skipping Asset Delivery API');
        return [];
      }
      
      // Asset Delivery API endpoint format: https://cdn.st-api.com/v1/assets/pub/[CLIENT_ID]/a/latest/listings/listing-fields.json
      // The correct path includes /a/latest/ based on actual API response
      const assetDeliveryEndpoints = [
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/a/latest/listings/listing-fields.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/listings/listing-fields.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/latest/listings/listing-fields.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/${this.marketplaceId}/listings/listing-fields.json`
      ];
      
      for (const endpoint of assetDeliveryEndpoints) {
        try {
          console.log(`Trying Asset Delivery API for listing fields: ${endpoint}`);
          const response = await axios.get(endpoint, {
            headers: {
              'Accept': 'application/json'
            },
            validateStatus: function (status) {
              return status < 500;
            }
          });
          
          console.log(`Asset Delivery API response status: ${response.status} for ${endpoint}`);
          
          if (response.status >= 200 && response.status < 300) {
            const data = response.data;
            console.log('=== Asset Delivery API Listing Fields Response ===');
            console.log('Full response:', JSON.stringify(data, null, 2));
            console.log('Response type:', typeof data);
            console.log('Is array:', Array.isArray(data));
            if (data && typeof data === 'object') {
              console.log('Response keys:', Object.keys(data));
            }
            
            // Asset data structure: { data: { listingFields: [...] } }
            let fields = [];
            if (Array.isArray(data)) {
              fields = data;
              console.log('Found fields as direct array');
            } else if (data && data.data && data.data.listingFields && Array.isArray(data.data.listingFields)) {
              // Correct structure: data.data.listingFields
              fields = data.data.listingFields;
              console.log('Found fields in data.data.listingFields');
            } else if (data && data.data && Array.isArray(data.data)) {
              fields = data.data;
              console.log('Found fields in data.data array');
            } else if (data && data.fields) {
              fields = Array.isArray(data.fields) ? data.fields : [data.fields];
              console.log('Found fields in data.fields');
            } else if (data && data.listingFields) {
              fields = Array.isArray(data.listingFields) ? data.listingFields : [data.listingFields];
              console.log('Found fields in data.listingFields');
            } else if (data && typeof data === 'object') {
              console.log('Response is object but no fields found. Structure:', JSON.stringify(data, null, 2).substring(0, 500));
            }
            
            if (fields.length > 0) {
              console.log(`Successfully fetched ${fields.length} listing fields from Asset Delivery API`);
              console.log('Sample field:', JSON.stringify(fields[0], null, 2));
              
              // Transform fields preserving all metadata and structure
              const transformedFields = fields.map(field => {
                // Extract field properties (fields don't have attributes wrapper, they're direct)
                const fieldKey = field.key || field.id || field.name;
                const fieldLabel = field.label || field.name || field.title || fieldKey;
                const schemaType = field.schemaType || field.type || field.fieldType || 'text';
                
                // Extract required status from saveConfig
                const isRequired = field.saveConfig?.required || field.required || field.mandatory || false;
                
                // Extract enum options - check multiple possible locations
                // ShareTribe may store enum options in different places depending on API version
                let enumOptions = field.enumOptions || field.options || null;
                
                // Also check filterConfig for enum options (used in some ShareTribe versions)
                if (!enumOptions && field.filterConfig) {
                  if (field.filterConfig.enumOptions) {
                    enumOptions = field.filterConfig.enumOptions;
                  } else if (field.filterConfig.options) {
                    enumOptions = field.filterConfig.options;
                  }
                }
                
                // Check showConfig as well
                if (!enumOptions && field.showConfig) {
                  if (field.showConfig.enumOptions) {
                    enumOptions = field.showConfig.enumOptions;
                  } else if (field.showConfig.options) {
                    enumOptions = field.showConfig.options;
                  }
                }
                
                // If enumOptions is an object with a 'values' property, extract that
                if (enumOptions && typeof enumOptions === 'object' && !Array.isArray(enumOptions)) {
                  if (enumOptions.values && Array.isArray(enumOptions.values)) {
                    enumOptions = enumOptions.values;
                  } else if (enumOptions.options && Array.isArray(enumOptions.options)) {
                    enumOptions = enumOptions.options;
                  }
                }
                
                // Normalize enum options: if they're objects, extract the actual value
                // ShareTribe may return options as objects like { key: 'value', label: 'Label' } or { value: 'value' }
                if (enumOptions && Array.isArray(enumOptions) && enumOptions.length > 0) {
                  enumOptions = enumOptions.map(option => {
                    // If it's already a string, return as-is
                    if (typeof option === 'string') {
                      return option;
                    }
                    // If it's an object, try to extract the value
                    if (typeof option === 'object' && option !== null) {
                      // Try common property names
                      return option.key || option.value || option.id || option.label || option.name || String(option);
                    }
                    // Fallback to string conversion
                    return String(option);
                  }).filter(opt => opt !== null && opt !== undefined); // Remove null/undefined values
                  
                  console.log(`Field ${fieldKey} has ${enumOptions.length} enum options (normalized):`, enumOptions.slice(0, 5));
                } else if (enumOptions && Array.isArray(enumOptions) && enumOptions.length > 0) {
                  console.log(`Field ${fieldKey} has ${enumOptions.length} enum options:`, enumOptions.slice(0, 5));
                }
                
                // Extract category IDs from categoryConfig
                const categoryIds = field.categoryConfig?.categoryIds || 
                                  field.categoryIds || 
                                  field.categories || 
                                  [];
                
                // Extract listing type IDs from listingTypeConfig
                const listingTypeIds = field.listingTypeConfig?.listingTypeIds || 
                                     field.listingTypeIds || 
                                     field.listing_types || 
                                     [];
                
                // Extract scope (public/private)
                const scope = field.scope || 'public';
                
                // Extract filter config
                const filterConfig = field.filterConfig || null;
                
                return {
                  id: fieldKey,
                  key: fieldKey,
                  label: fieldLabel,
                  name: fieldLabel,
                  type: schemaType,
                  schemaType: schemaType,
                  required: isRequired,
                  options: enumOptions,
                  listingTypeIds: Array.isArray(listingTypeIds) ? listingTypeIds : [],
                  categoryIds: Array.isArray(categoryIds) ? categoryIds : [],
                  scope: scope,
                  filterConfig: filterConfig,
                  categoryConfig: field.categoryConfig || null,
                  listingTypeConfig: field.listingTypeConfig || null,
                  saveConfig: field.saveConfig || null,
                  showConfig: field.showConfig || null,
                  // Preserve original field for reference
                  originalField: field
                };
              });
              
              console.log(`Transformed ${transformedFields.length} listing fields`);
              console.log('Sample transformed field:', JSON.stringify(transformedFields[0], null, 2));
              
              return transformedFields;
            } else {
              console.log('No listing fields found in Asset Delivery API response');
            }
          } else {
            console.log(`Asset Delivery API returned non-200 status: ${response.status}`);
            console.log('Response:', JSON.stringify(response.data, null, 2).substring(0, 500));
          }
        } catch (err) {
          console.log(`Asset Delivery API endpoint ${endpoint} failed: ${err.message}`);
          if (err.response) {
            console.log(`Response status: ${err.response.status}`);
            console.log(`Response data:`, JSON.stringify(err.response.data, null, 2).substring(0, 500));
          }
          continue;
        }
      }
      
      console.warn('No listing fields found from Asset Delivery API');
      return [];
    } catch (error) {
      console.error('Error fetching listing fields:', error.response?.data || error.message);
      return [];
    }
  }

  // Get marketplace configuration including default currency
  async getMarketplaceConfig() {
    try {
      if (!this.marketplaceApiClientId) {
        console.log('Marketplace API Client ID not configured, cannot fetch marketplace config');
        return null;
      }

      // Try Asset Delivery API for marketplace configuration
      const assetDeliveryEndpoints = [
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/a/latest/marketplace.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/marketplace.json`,
        `https://cdn.st-api.com/v1/assets/pub/${this.marketplaceApiClientId}/latest/marketplace.json`
      ];

      for (const endpoint of assetDeliveryEndpoints) {
        try {
          console.log(`Trying Asset Delivery API for marketplace config: ${endpoint}`);
          const response = await axios.get(endpoint, {
            headers: {
              'Accept': 'application/json'
            },
            validateStatus: function (status) {
              return status < 500;
            }
          });

          if (response.status >= 200 && response.status < 300) {
            const data = response.data;
            // Extract currency from marketplace config
            // Structure might be: data.data.attributes.currency or data.currency
            const currency = data?.data?.attributes?.currency || 
                           data?.attributes?.currency || 
                           data?.currency ||
                           data?.data?.currency;
            
            if (currency) {
              console.log(`Found marketplace default currency: ${currency}`);
              return { currency };
            }
          }
        } catch (err) {
          console.log(`Asset Delivery API endpoint ${endpoint} failed: ${err.message}`);
          continue;
        }
      }

      // Fallback: Try Integration API marketplace endpoint
      if (this.isIntegrationAPI && this.apiKey && this.apiSecret) {
        try {
          const token = await this.getAccessToken();
          const response = await axios.get(
            `${this.baseUrl}/marketplace`,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
              }
            }
          );

          if (response.data && response.data.data && response.data.data.attributes) {
            const currency = response.data.data.attributes.currency;
            if (currency) {
              console.log(`Found marketplace default currency from Integration API: ${currency}`);
              return { currency };
            }
          }
        } catch (err) {
          console.log(`Integration API marketplace endpoint failed: ${err.message}`);
        }
      }

      console.warn('Could not fetch marketplace default currency');
      return null;
    } catch (error) {
      console.error('Error fetching marketplace config:', error.message);
      return null;
    }
  }

  // Get all ShareTribe metadata (listing types, categories, default fields, listing fields)
  async getMetadata() {
    try {
      // Default/core fields that are always available in ShareTribe API
      // Based on ShareTribe Integration API documentation:
      // https://www.sharetribe.com/api-reference/marketplace.html#create-listing
      const defaultFields = [
        { id: 'title', label: 'Title', type: 'string', required: true, description: 'Listing title (1-1000 characters)', listingTypeIds: [], categoryIds: [] },
        { id: 'authorId', label: 'Author ID', type: 'uuid', required: true, description: 'Marketplace user ID (set automatically)', listingTypeIds: [], categoryIds: [] },
        { id: 'state', label: 'State', type: 'string', required: true, description: 'Listing state: published or pendingApproval (set automatically)', listingTypeIds: [], categoryIds: [] },
        { id: 'description', label: 'Description', type: 'string', required: false, description: 'Listing description (1-5000 characters)', listingTypeIds: [], categoryIds: [] },
        { id: 'geolocation', label: 'Geolocation', type: 'object', required: false, description: 'Latitude (lat) and longitude (lng)', listingTypeIds: [], categoryIds: [] },
        { id: 'price', label: 'Price', type: 'object', required: false, description: 'Price object with currency and amount', listingTypeIds: [], categoryIds: [] },
        { id: 'price.currency', label: 'Price Currency', type: 'string', required: false, description: 'Currency code (e.g., USD)', listingTypeIds: [], categoryIds: [] },
        { id: 'price.amount', label: 'Price Amount', type: 'integer', required: false, description: 'Amount in minor unit (e.g., cents for USD)', listingTypeIds: [], categoryIds: [] },
        { id: 'availabilityPlan', label: 'Availability Plan', type: 'object', required: false, description: 'Listing availability plan', listingTypeIds: [], categoryIds: [] },
        { id: 'publicData', label: 'Public Data', type: 'object', required: false, description: 'Public data object (max 50KB)', listingTypeIds: [], categoryIds: [] },
        { id: 'privateData', label: 'Private Data', type: 'object', required: false, description: 'Private data object (max 50KB)', listingTypeIds: [], categoryIds: [] },
        { id: 'metadata', label: 'Metadata', type: 'object', required: false, description: 'Public metadata object (max 50KB)', listingTypeIds: [], categoryIds: [] },
        { id: 'images', label: 'Images', type: 'array', required: false, description: 'Array of image IDs', listingTypeIds: [], categoryIds: [] }
      ];
      
      // First try Asset Delivery API endpoints
      const [listingTypes, categories, listingFields] = await Promise.all([
        this.getListingTypes().catch(err => {
          console.error('Error fetching listing types from Asset Delivery API:', err.message);
          return [];
        }),
        this.getCategories().catch(err => {
          console.error('Error fetching categories from Asset Delivery API:', err.message);
          return [];
        }),
        this.getListingFields().catch(err => {
          console.error('Error fetching listing fields from Asset Delivery API:', err.message);
          return [];
        })
      ]);

      // If Asset Delivery API didn't return data (common in test environments before deployment),
      // try to infer from existing listings as a fallback
      if ((listingTypes.length === 0 || categories.length === 0 || listingFields.length === 0) && this.marketplaceId) {
        console.log('Asset Delivery API returned empty results, attempting to infer metadata from existing listings...');
        try {
          const existingListings = await this.getAllListings().catch(err => {
            console.log('Could not fetch existing listings for inference:', err.message);
            return [];
          });
          
          if (existingListings && existingListings.length > 0) {
            console.log(`Found ${existingListings.length} existing listings to analyze`);
            
            const uniqueListingTypes = new Set();
            const uniqueCategories = new Set();
            const allFields = new Map();
            
            existingListings.forEach(listing => {
              // Get publicData - could be nested in attributes or at top level
              const publicData = listing.attributes?.publicData || listing.publicData || {};
              
              // Extract listing type from publicData.listingType
              const listingTypeId = publicData.listingType;
              if (listingTypeId) {
                uniqueListingTypes.add(listingTypeId);
              }
              
              // Extract categories from categoryLevel1, categoryLevel2, etc.
              Object.keys(publicData).forEach(key => {
                if (key.startsWith('categoryLevel') || key === 'category') {
                  const categoryId = publicData[key];
                  if (categoryId) {
                    uniqueCategories.add(categoryId);
                  }
                }
              });
              
              // Extract all custom fields from publicData
              const standardFields = ['listingType', 'category', 'categoryLevel1', 'categoryLevel2', 'categoryLevel3', 'location', 'parcel'];
              Object.keys(publicData).forEach(key => {
                if (!standardFields.includes(key) && !key.startsWith('categoryLevel')) {
                  if (!allFields.has(key)) {
                    const value = publicData[key];
                    allFields.set(key, {
                      id: key,
                      label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim(),
                      type: Array.isArray(value) ? 'array' : (value === null || value === undefined ? 'text' : typeof value),
                      required: false,
                      listingTypeIds: [],
                      categoryIds: []
                    });
                  }
                }
              });
            });
            
            // Use inferred data only if Asset Delivery API didn't return anything
            if (listingTypes.length === 0 && uniqueListingTypes.size > 0) {
              listingTypes.push(...Array.from(uniqueListingTypes).map((typeId) => ({
                id: typeId,
                name: typeId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                label: typeId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
              })));
              console.log(`Inferred ${listingTypes.length} listing types from existing listings`);
            }
            
            if (categories.length === 0 && uniqueCategories.size > 0) {
              categories.push(...Array.from(uniqueCategories).map((catId) => ({
                id: catId,
                name: typeof catId === 'string' ? catId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : catId,
                label: typeof catId === 'string' ? catId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : catId
              })));
              console.log(`Inferred ${categories.length} categories from existing listings`);
            }
            
            if (listingFields.length === 0 && allFields.size > 0) {
              listingFields.push(...Array.from(allFields.values()));
              console.log(`Inferred ${listingFields.length} listing fields from existing listings`);
            }
          } else {
            console.log('No existing listings found to infer metadata from');
          }
        } catch (err) {
          console.error('Error inferring metadata from listings:', err.message);
        }
      }

      // Fetch marketplace configuration to get default currency
      const marketplaceConfig = await this.getMarketplaceConfig();
      const defaultCurrency = marketplaceConfig?.currency || null;

      return {
        listingTypes: listingTypes,
        categories: categories,
        defaultFields: defaultFields,
        listingFields: listingFields,
        defaultCurrency: defaultCurrency // Include default currency from marketplace config
      };
    } catch (error) {
      console.error('Error fetching ShareTribe metadata:', error);
      throw error;
    }
  }

  // Test API connection
  async testConnection() {
    try {
      // First, verify we can get an access token
      const token = await this.getAccessToken();
      if (!token) {
        return { success: false, message: 'Failed to obtain OAuth2 access token' };
      }
      
      console.log(`Using ${this.isIntegrationAPI ? 'Integration' : 'Marketplace'} API`);
      console.log('Base URL:', this.baseUrl);
      
      const headers = await this.getAuthHeaders();
      
      // Try different endpoint variations based on API type
      const endpointsToTry = [];
      
      if (this.isIntegrationAPI) {
        // Integration API endpoints
        endpointsToTry.push(
          `${this.baseUrl}/listings/query`,
          `https://flex-integ-api.sharetribe.com/v1/integration_api/listings/query`,
          `https://flex-integ-api.sharetribe.com/v1/integration_api/marketplaces/${this.marketplaceId}/listings/query`
        );
      } else {
        // Marketplace API endpoints
        endpointsToTry.push(
          `${this.baseUrl}/own_listings.json`,
          `${this.baseUrl}/current_user/own_listings.json`,
          `https://flex-api.sharetribe.com/v1/marketplaces/${this.marketplaceId}/current_user/own_listings.json`
        );
      }
      
      for (const endpoint of endpointsToTry) {
        console.log(`Trying endpoint: ${endpoint}`);
        try {
          const response = await axios.get(
            endpoint,
            {
              headers: headers,
              params: { per_page: 1 },
              validateStatus: function (status) {
                return status < 500; // Don't throw on 4xx errors
              }
            }
          );
          
          console.log(`Endpoint ${endpoint} returned status: ${response.status}`);
          
          if (response.status >= 200 && response.status < 300) {
            console.log('Success! Using endpoint:', endpoint);
            // Update baseUrl to the working endpoint's base
            const urlParts = endpoint.split('/');
            const baseIndex = urlParts.findIndex(part => part === 'v1');
            if (baseIndex > 0) {
              this.baseUrl = urlParts.slice(0, baseIndex + (this.isIntegrationAPI ? 3 : 2)).join('/');
              console.log('Updated baseUrl to:', this.baseUrl);
            }
            return { success: true, message: `ShareTribe API connection successful using ${this.isIntegrationAPI ? 'Integration' : 'Marketplace'} API` };
          }
          
          if (response.status === 404) {
            console.log(`Endpoint ${endpoint} returned 404, trying next...`);
            continue;
          }
          
          // If we get a non-404 error, return it
          return { 
            success: false, 
            message: `ShareTribe API returned status ${response.status}: ${response.statusText}. Response: ${JSON.stringify(response.data).substring(0, 200)}` 
          };
    } catch (error) {
          if (error.response && error.response.status === 404) {
            console.log(`Endpoint ${endpoint} returned 404, trying next...`);
            continue;
          }
          throw error;
        }
      }
      
      // If all endpoints returned 404
      return { 
        success: false, 
        message: `ShareTribe API endpoints not found (404). Tried ${endpointsToTry.length} different endpoints. Please verify:\n1. Your Marketplace ID (${this.marketplaceId}) is correct\n2. You're using ${this.isIntegrationAPI ? 'Integration' : 'Marketplace'} API credentials\n3. Check ShareTribe Console → Integrations → API credentials to confirm the API type` 
      };
    } catch (error) {
      console.error('Test connection error:', error.message);
      if (error.response) {
        console.error('Error response status:', error.response.status);
        console.error('Error response:', JSON.stringify(error.response.data, null, 2));
      }
      return { success: false, message: error.message };
    }
  }

  // Upload an image to ShareTribe
  // Returns the image ID (UUID) that can be used in listings
  async uploadImage(imageBuffer, imageName, contentType = 'image/jpeg') {
    try {
      if (!this.isIntegrationAPI) {
        throw new Error('Image upload is only available with Integration API');
      }

      const headers = await this.getAuthHeaders();
      // Remove Content-Type from headers - FormData will set it with boundary
      delete headers['Content-Type'];

      // Create FormData for multipart/form-data upload
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('image', imageBuffer, {
        filename: imageName || 'image.jpg',
        contentType: contentType
      });

      const apiUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/images/upload`;
      
      console.log(`Uploading image to ShareTribe: ${imageName || 'unnamed'}`);
      
      const response = await axios.post(apiUrl, formData, {
        headers: {
          ...headers,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      console.log(`Image upload response status: ${response.status}`);
      console.log(`Image upload response structure:`, JSON.stringify(response.data, null, 2));

      // ShareTribe returns image UUID in response.data.data.id
      // This UUID must be used exactly as returned - it's the ShareTribe image asset ID
      if (response.data && response.data.data && response.data.data.id) {
        const imageId = response.data.data.id;
        console.log(`✅ Image uploaded successfully to ShareTribe`);
        console.log(`   Image UUID (from response.data.data.id): ${imageId}`);
        console.log(`   This UUID will be used in listings as: images: ["${imageId}"]`);
        
        // Validate it's a proper UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(imageId)) {
          console.warn(`⚠️ Warning: Image ID "${imageId}" doesn't match UUID format. This may cause issues.`);
        } else {
          console.log(`   ✅ UUID format validated successfully`);
        }
        
        // Verify this UUID can be used by checking it exists in ShareTribe
        console.log(`   To verify this image exists, check ShareTribe Console → Images or call:`);
        console.log(`   GET /v1/integration_api/listings/show?id=<listingId>&include=images`);
        
        return imageId; // Return the exact UUID from ShareTribe
      } else {
        console.error('❌ ShareTribe image upload response structure:', JSON.stringify(response.data, null, 2));
        console.error('Expected structure: response.data.data.id');
        throw new Error('Unexpected response format from ShareTribe image upload. Expected response.data.data.id');
      }
    } catch (error) {
      console.error('Error uploading image to ShareTribe:', error.response?.data || error.message);
      if (error.response?.data) {
        console.error('Full error response:', JSON.stringify(error.response.data, null, 2));
      }
      throw new Error(`Failed to upload image to ShareTribe: ${error.response?.data?.errors?.[0]?.title || error.message}`);
    }
  }

  // Get all users from ShareTribe Integration API
  async getAllUsers() {
    try {
      if (!this.isIntegrationAPI) {
        throw new Error('User query is only available with Integration API');
      }

      const headers = await this.getAuthHeaders();
      const apiUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/users/query`;
      
      console.log('Fetching users from ShareTribe...');
      
      const response = await axios.post(
        apiUrl,
        {}, // Empty query to get all users
        {
          headers: headers,
          validateStatus: function (status) {
            return status < 500;
          }
        }
      );

      if (response.status >= 200 && response.status < 300) {
        const users = [];
        
        // Parse ShareTribe API response structure
        if (response.data && response.data.data) {
          response.data.data.forEach(userData => {
            const attributes = userData.attributes || {};
            const relationships = userData.relationships || {};
            
            // Extract user information
            const user = {
              id: userData.id,
              profile: {
                displayName: attributes.profile?.displayName || attributes.displayName || 'N/A',
                bio: attributes.profile?.bio || attributes.bio || 'N/A',
                firstName: attributes.profile?.firstName || attributes.firstName || '',
                lastName: attributes.profile?.lastName || attributes.lastName || '',
              },
              email: attributes.email || 'N/A',
              stripeAccountId: attributes.stripeAccountId || attributes.stripe_account_id || null,
              publicData: attributes.publicData || {},
              createdAt: attributes.createdAt || attributes.created_at || null,
              updatedAt: attributes.updatedAt || attributes.updated_at || null,
            };
            
            users.push(user);
          });
        }
        
        console.log(`✅ Fetched ${users.length} users from ShareTribe`);
        return users;
      } else {
        console.error('ShareTribe API returned error:', response.status, response.data);
        throw new Error(`ShareTribe API returned status ${response.status}: ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      console.error('Error fetching users from ShareTribe:', error.response?.data || error.message);
      throw new Error(`Failed to fetch users from ShareTribe: ${error.response?.data?.errors?.[0]?.title || error.message}`);
    }
  }

  // Set stock for a listing using stock_adjustments/create endpoint
  // This is required for finite-stock listings to make them purchasable
  // Reference: https://www.sharetribe.com/api-reference/integration.html#create-stock-adjustment
  async setStock(listingId, quantity = 1) {
    try {
      if (!this.isIntegrationAPI) {
        throw new Error('Stock management is only available with Integration API');
      }

      const headers = await this.getAuthHeaders();
      const apiUrl = `https://flex-integ-api.sharetribe.com/v1/integration_api/stock_adjustments/create`;
      
      console.log(`📦 Creating stock adjustment for listing ${listingId} with quantity ${quantity}...`);
      
      // ShareTribe expects listingId as UUID and quantity as number
      const payload = {
        listingId: listingId, // UUID string
        quantity: quantity    // Positive number increases stock
      };
      
      console.log(`Stock adjustment payload:`, JSON.stringify(payload, null, 2));
      
      const response = await axios.post(apiUrl, payload, {
        headers: headers,
        validateStatus: function (status) {
          return status < 500;
        }
      });

      if (response.status >= 200 && response.status < 300) {
        console.log(`✅ Successfully created stock adjustment - stock set to ${quantity} for listing ${listingId}`);
        console.log(`Stock adjustment response:`, JSON.stringify(response.data, null, 2));
        return { success: true, quantity: quantity, data: response.data };
      } else {
        console.error(`❌ Failed to create stock adjustment. Status: ${response.status}`);
        console.error(`Response:`, JSON.stringify(response.data, null, 2));
        throw new Error(`Failed to set stock: ${response.status} - ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      console.error(`Error creating stock adjustment for listing ${listingId}:`, error.response?.data || error.message);
      if (error.response?.data) {
        console.error(`Full error response:`, JSON.stringify(error.response.data, null, 2));
      }
      throw new Error(`Failed to set stock: ${error.response?.data?.errors?.[0]?.title || error.message}`);
    }
  }

  // Check if a listing type requires finite stock
  // This checks the listing type metadata to determine if stock should be set
  async checkListingTypeRequiresStock(listingTypeId) {
    try {
      // Fetch listing types to check stock configuration
      const listingTypes = await this.getListingTypes();
      
      if (!listingTypes || listingTypes.length === 0) {
        console.warn('⚠️ Could not fetch listing types to check stock requirements. Will set stock by default.');
        return true; // Default to setting stock if we can't determine
      }
      
      // Find the listing type
      const listingType = listingTypes.find(lt => 
        lt.id === listingTypeId || 
        lt.key === listingTypeId ||
        (lt.attributes && (lt.attributes.id === listingTypeId || lt.attributes.key === listingTypeId))
      );
      
      if (!listingType) {
        console.warn(`⚠️ Listing type ${listingTypeId} not found in metadata. Will set stock by default.`);
        return true; // Default to setting stock if listing type not found
      }
      
      // Extract stock type information
      // Listing types may have: stockType, unitType, or other indicators
      const attrs = listingType.attributes || listingType;
      const stockType = attrs.stockType || attrs.stock_type || attrs.stockTypeId;
      const unitType = attrs.unitType || attrs.unit_type || attrs.unitTypeId;
      
      console.log(`Listing type ${listingTypeId} stock info:`, {
        stockType: stockType,
        unitType: unitType,
        fullAttributes: attrs
      });
      
      // If stockType is 'finite' or unitType indicates single item, set stock
      // Default to true (set stock) if we can't determine
      if (stockType === 'finite' || stockType === 'item' || unitType === 'item') {
        console.log(`✅ Listing type ${listingTypeId} requires finite stock - will set stock to 1`);
        return true;
      }
      
      // If explicitly infinite stock, don't set stock
      if (stockType === 'infinite' || stockType === 'unlimited') {
        console.log(`ℹ️ Listing type ${listingTypeId} has infinite stock - skipping stock setting`);
        return false;
      }
      
      // Default: set stock for safety (most listings are finite)
      console.log(`⚠️ Could not determine stock type for ${listingTypeId}. Defaulting to setting stock.`);
      return true;
    } catch (error) {
      console.warn(`⚠️ Error checking listing type stock requirements: ${error.message}. Will set stock by default.`);
      return true; // Default to setting stock on error
    }
  }
}

module.exports = ShareTribeService;

