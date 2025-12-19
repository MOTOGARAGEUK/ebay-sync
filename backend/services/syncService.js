const db = require('../config/database');
const eBayService = require('./ebayService');
const ShareTribeService = require('./sharetribeService');

class SyncService {
  async syncProducts(tenantId = 1, itemIds = null, sharetribeUserId = null) {
    const dbInstance = db.getDb();
    
    // Get API configuration (shared credentials)
    const config = await this.getApiConfig(tenantId);
    if (!config.sharetribe) {
      throw new Error('API configuration incomplete. Please configure ShareTribe credentials.');
    }

    // Get ShareTribe user ID and configuration if provided
    let sharetribeUserIdValue = null;
    let userLocation = null;
    let userConfig = null;
    if (sharetribeUserId) {
      const userRow = await new Promise((resolve, reject) => {
        dbInstance.get(
          `SELECT sharetribe_user_id, location, parcel,
                  pickup_enabled, shipping_enabled, shipping_measurement,
                  transaction_process_alias, unit_type, default_image_id, default_image_path
           FROM sharetribe_users WHERE id = ?`,
          [sharetribeUserId],
          (err, row) => {
            if (err) {
              reject(err);
            } else {
              resolve(row);
            }
          }
        );
      });
      
      if (!userRow) {
        throw new Error('ShareTribe user not found');
      }
      
      sharetribeUserIdValue = userRow.sharetribe_user_id;
      // Parse location JSON if it exists
      if (userRow.location) {
        try {
          userLocation = JSON.parse(userRow.location);
        } catch (e) {
          console.warn('Failed to parse user location JSON:', e.message);
        }
      }
      
      // Parse parcel JSON if it exists
      let userParcel = null;
      if (userRow.parcel) {
        try {
          userParcel = JSON.parse(userRow.parcel);
        } catch (e) {
          console.warn('Failed to parse user parcel JSON:', e.message);
        }
      }
      
      // Store user configuration for listing defaults
      userConfig = {
        pickupEnabled: userRow.pickup_enabled !== undefined ? Boolean(userRow.pickup_enabled) : true,
        shippingEnabled: userRow.shipping_enabled !== undefined ? Boolean(userRow.shipping_enabled) : true,
        shippingMeasurement: userRow.shipping_measurement || 'custom',
        parcel: userParcel,
        transactionProcessAlias: userRow.transaction_process_alias || 'default-purchase/release-1',
        unitType: userRow.unit_type || 'item',
        defaultImageId: userRow.default_image_id || null,
        defaultImagePath: userRow.default_image_path || null
      };
    } else if (config.sharetribe.userId) {
      // Fallback to config user ID for backward compatibility
      sharetribeUserIdValue = config.sharetribe.userId;
    }

    // Use shared API credentials with selected user ID
    const sharetribeConfig = {
      apiKey: config.sharetribe.apiKey,
      apiSecret: config.sharetribe.apiSecret,
      marketplaceId: config.sharetribe.marketplaceId,
      userId: sharetribeUserIdValue
    };

    // Get field mappings
    const fieldMappings = await this.getFieldMappings(tenantId);

    // Initialize ShareTribe service
    const sharetribeService = new ShareTribeService(sharetribeConfig);

    // Get products from database (not from eBay API)
    let productsToSync = [];
    
    // Helper function to merge custom_fields back into product object
    // This MUST match the logic in /sync/preview endpoint
    const mergeCustomFields = (product) => {
      // Start with the original product object (spread to ensure all properties are enumerable)
      const completeProduct = { ...product };
      
      // Ensure all standard fields are explicitly set (even if null/undefined)
      completeProduct.title = product.title || null;
      completeProduct.description = product.description || null;
      completeProduct.price = product.price !== undefined && product.price !== null ? product.price : null;
      completeProduct.currency = product.currency || null;
      completeProduct.quantity = product.quantity !== undefined && product.quantity !== null ? product.quantity : null;
      completeProduct.images = product.images || null;
      completeProduct.category = product.category || null;
      completeProduct.condition = product.condition || null;
      completeProduct.brand = product.brand || null;
      completeProduct.sku = product.sku || null;
      
      console.log(`Sync: Product ${completeProduct.ebay_item_id} from database (before custom_fields merge):`, {
        title: completeProduct.title,
        description: completeProduct.description,
        price: completeProduct.price,
        currency: completeProduct.currency,
        hasCustomFields: !!product.custom_fields,
        allKeys: Object.keys(completeProduct)
      });
      
      if (product.custom_fields) {
        try {
          const customFields = JSON.parse(product.custom_fields);
          console.log(`Sync: Custom fields for product ${completeProduct.ebay_item_id}:`, customFields);
          
          // Merge ALL custom fields into the product
          for (const key in customFields) {
            completeProduct[key] = customFields[key];
          }
          
          console.log(`Sync: After merging custom_fields, product ${completeProduct.ebay_item_id} has:`, {
            categoryLevel1: completeProduct.categoryLevel1,
            categoryLevel2: completeProduct.categoryLevel2,
            allKeys: Object.keys(completeProduct),
            allValues: Object.entries(completeProduct).filter(([k, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${v}`).join(', ')
          });
        } catch (e) {
          console.error(`Error parsing custom_fields for product ${completeProduct.ebay_item_id}:`, e);
        }
      }
      
      // Remove custom_fields from the product object as it's now merged
      delete completeProduct.custom_fields;
      return completeProduct;
    };
    
    if (itemIds && itemIds.length > 0) {
      // Sync specific items from database
      const placeholders = itemIds.map(() => '?').join(',');
      productsToSync = await new Promise((resolve, reject) => {
        dbInstance.all(
          `SELECT * FROM products WHERE tenant_id = ? AND ebay_item_id IN (${placeholders})`,
          [tenantId, ...itemIds],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              // Merge custom_fields back into products
              const mergedRows = (rows || []).map(mergeCustomFields);
              // Log first product to debug
              if (mergedRows && mergedRows.length > 0) {
                console.log('Sample product from database:', {
                  ebay_item_id: mergedRows[0].ebay_item_id,
                  title: mergedRows[0].title,
                  price: mergedRows[0].price,
                  allFields: Object.keys(mergedRows[0]),
                  categoryLevel1: mergedRows[0].categoryLevel1,
                  categoryLevel2: mergedRows[0].categoryLevel2,
                  listingType: mergedRows[0].listingType
                });
              }
              resolve(mergedRows);
            }
          }
        );
      });
    } else {
      // Sync all products from database
      productsToSync = await new Promise((resolve, reject) => {
        dbInstance.all(
          'SELECT * FROM products WHERE tenant_id = ?',
          [tenantId],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              // Merge custom_fields back into products
              const mergedRows = (rows || []).map(mergeCustomFields);
              // Log first product to debug
              if (mergedRows && mergedRows.length > 0) {
                console.log('Sample product from database:', {
                  ebay_item_id: mergedRows[0].ebay_item_id,
                  title: mergedRows[0].title,
                  price: mergedRows[0].price,
                  allFields: Object.keys(mergedRows[0]),
                  categoryLevel1: mergedRows[0].categoryLevel1,
                  categoryLevel2: mergedRows[0].categoryLevel2,
                  listingType: mergedRows[0].listingType
                });
              }
              resolve(mergedRows);
            }
          }
        );
      });
    }

    // Transform and sync each product
    let syncedCount = 0;
    let failedCount = 0;
    const errors = [];

    for (const ebayProduct of productsToSync) {
      try {
        // Log product data from database before transformation
        console.log(`=== SYNC: Product ${ebayProduct.ebay_item_id} from database (AFTER mergeCustomFields) ===`);
        console.log('Title:', ebayProduct.title);
        console.log('Description:', ebayProduct.description);
        console.log('Price:', ebayProduct.price);
        console.log('Currency:', ebayProduct.currency);
        console.log('Category:', ebayProduct.category);
        console.log('CategoryLevel1:', ebayProduct.categoryLevel1);
        console.log('CategoryLevel2:', ebayProduct.categoryLevel2);
        console.log('All fields:', Object.keys(ebayProduct));
        console.log('All values:', JSON.stringify(ebayProduct, null, 2));
        
        // Apply field mappings
        // CRITICAL: Pass the EXACT product object to buildSharetribePayload
        // If applyFieldMappings returns empty, use ebayProduct directly as fallback
        let transformedProduct = this.applyFieldMappings(ebayProduct, fieldMappings);
        
        // SAFETY CHECK: If transformedProduct is empty or missing critical fields, use original product
        if (!transformedProduct || Object.keys(transformedProduct).length === 0) {
          console.error(`❌ FATAL: applyFieldMappings returned empty object for ${ebayProduct.ebay_item_id}. Using original product.`);
          transformedProduct = { ...ebayProduct };
          // Remove metadata but keep all data fields
          const metadataColumns = ['id', 'tenant_id', 'synced', 'sharetribe_listing_id', 'last_synced_at', 'created_at', 'updated_at', 'user_id'];
          metadataColumns.forEach(col => delete transformedProduct[col]);
        }
        
        // Ensure critical fields are present
        if (!transformedProduct.title && ebayProduct.title) transformedProduct.title = ebayProduct.title;
        if (!transformedProduct.description && ebayProduct.description) transformedProduct.description = ebayProduct.description;
        if (transformedProduct.price === undefined && ebayProduct.price !== undefined) transformedProduct.price = ebayProduct.price;
        if (!transformedProduct.currency && ebayProduct.currency) transformedProduct.currency = ebayProduct.currency;
        if (!transformedProduct.ebay_item_id && ebayProduct.ebay_item_id) transformedProduct.ebay_item_id = ebayProduct.ebay_item_id;
        
        // Ensure custom fields are copied
        Object.keys(ebayProduct).forEach(key => {
          if (!['id', 'tenant_id', 'synced', 'sharetribe_listing_id', 'last_synced_at', 'created_at', 'updated_at', 'user_id'].includes(key)) {
            if (transformedProduct[key] === undefined && ebayProduct[key] !== undefined) {
              transformedProduct[key] = ebayProduct[key];
            }
          }
        });
        
        console.log(`=== SYNC: Product ${ebayProduct.ebay_item_id} after applyFieldMappings ===`);
        console.log('Title:', transformedProduct.title);
        console.log('Description:', transformedProduct.description);
        console.log('Price:', transformedProduct.price);
        console.log('Currency:', transformedProduct.currency);
        console.log('All fields:', Object.keys(transformedProduct));
        console.log('All values:', JSON.stringify(transformedProduct, null, 2));
        
        // Log product data after transformation
        console.log(`Product ${ebayProduct.ebay_item_id} after transformation:`, {
          title: transformedProduct.title,
          price: transformedProduct.price,
          description: transformedProduct.description,
          allFields: Object.keys(transformedProduct),
          allValues: Object.entries(transformedProduct).map(([k, v]) => `${k}: ${v}`).join(', ')
        });
        
        // Validate required fields before syncing
        // Check both transformedProduct and ebayProduct as fallback
        const titleToUse = transformedProduct.title || ebayProduct.title;
        
        if (!titleToUse || (typeof titleToUse === 'string' && titleToUse.trim() === '')) {
          const availableFields = Object.keys(transformedProduct).filter(k => transformedProduct[k] !== null && transformedProduct[k] !== undefined).join(', ');
          const nullFields = Object.keys(transformedProduct).filter(k => transformedProduct[k] === null).map(k => `${k}(NULL)`).join(', ');
          const dbFields = Object.keys(ebayProduct).filter(k => ebayProduct[k] !== null && ebayProduct[k] !== undefined).join(', ');
          const dbNullFields = Object.keys(ebayProduct).filter(k => ebayProduct[k] === null && ['title', 'description', 'price', 'currency', 'quantity'].includes(k)).map(k => `${k}(NULL)`).join(', ');
          
          let errorMsg = `Product ${ebayProduct.ebay_item_id} is missing required field: title. `;
          errorMsg += `Transformed keys: ${Object.keys(transformedProduct).join(', ')}. `;
          errorMsg += `DB keys: ${Object.keys(ebayProduct).join(', ')}. `;
          if (availableFields) {
            errorMsg += `Available fields with values: ${availableFields}. `;
          }
          if (nullFields) {
            errorMsg += `Fields with NULL values: ${nullFields}. `;
          }
          if (dbNullFields) {
            errorMsg += `Database has NULL for: ${dbNullFields}. `;
          }
          errorMsg += `This suggests the CSV import did not map columns correctly. Please check your CSV column mappings and ensure "Title" is mapped correctly.`;
          
          throw new Error(errorMsg);
        }
        
        // Ensure title is set in transformedProduct (use fallback if needed)
        if (!transformedProduct.title && titleToUse) {
          transformedProduct.title = titleToUse;
        }
        
        console.log(`Syncing product ${ebayProduct.ebay_item_id}:`, {
          title: transformedProduct.title,
          price: transformedProduct.price,
          hasDescription: !!transformedProduct.description,
          allFields: Object.keys(transformedProduct)
        });
        
        // Add user location and configuration to product data if available
        if (userLocation) {
          transformedProduct.location = userLocation;
        }
        
        // Add user parcel configuration to product data if available
        if (userConfig && userConfig.parcel) {
          transformedProduct.parcel = userConfig.parcel;
        }
        
        // Add user configuration defaults to product data
        if (userConfig) {
          console.log(`🔍 [${ebayProduct.ebay_item_id}] Applying userConfig for user ${sharetribeUserId}:`, {
            hasDefaultImageId: !!userConfig.defaultImageId,
            defaultImageId: userConfig.defaultImageId,
            pickupEnabled: userConfig.pickupEnabled,
            shippingEnabled: userConfig.shippingEnabled
          });
          
          transformedProduct.pickupEnabled = userConfig.pickupEnabled;
          transformedProduct.shippingEnabled = userConfig.shippingEnabled;
          transformedProduct.shippingMeasurement = userConfig.shippingMeasurement;
          transformedProduct.transactionProcessAlias = userConfig.transactionProcessAlias;
          transformedProduct.unitType = userConfig.unitType;
          // Store default image path for later upload (we'll upload it fresh for each listing)
          if (userConfig.defaultImagePath) {
            transformedProduct.defaultImagePath = userConfig.defaultImagePath;
            console.log(`✅ Added default image path ${userConfig.defaultImagePath} to product ${ebayProduct.ebay_item_id}`);
          } else if (userConfig.defaultImageId) {
            // Fallback: if path not available but ID is, log warning
            transformedProduct.defaultImageId = userConfig.defaultImageId;
            console.log(`⚠️ Default image ID available but no file path - image may not work for multiple listings`);
          } else {
            console.log(`⚠️ No default image configured for user ${sharetribeUserId}`);
          }
        } else {
          console.warn(`⚠️ [${ebayProduct.ebay_item_id}] userConfig is null/undefined - no user configuration will be applied`);
          console.warn(`   sharetribeUserId: ${sharetribeUserId}`);
        }
        
        // Sync to ShareTribe (use existing sharetribe_listing_id if product was already synced)
        const result = await sharetribeService.createOrUpdateListing(
          transformedProduct,
          ebayProduct.sharetribe_listing_id || null
        );

        // Update or insert product in database
        await this.upsertProduct(tenantId, {
          ...ebayProduct,
          sharetribe_listing_id: result.listingId,
          synced: true,
          last_synced_at: new Date().toISOString(),
          user_id: sharetribeUserId || null
        });

        syncedCount++;
      } catch (error) {
        failedCount++;
        errors.push({
          itemId: ebayProduct.ebay_item_id,
          error: error.message
        });
        console.error(`Error syncing product ${ebayProduct.ebay_item_id}:`, error);
      }
    }

    return {
      synced: syncedCount,
      failed: failedCount,
      errors: errors
    };
  }

  async applyFieldMappings(product, mappings) {
    // Products from CSV already have ShareTribe field names (from CSV column mapping)
    // Products from eBay have eBay field names (need mapping via field_mappings table)
    
    // Debug logging
    console.log('applyFieldMappings input:', {
      ebay_item_id: product.ebay_item_id,
      hasTitle: 'title' in product,
      titleValue: product.title,
      titleType: typeof product.title,
      allKeys: Object.keys(product),
      productKeys: Object.getOwnPropertyNames(product)
    });
    
    // Check if product has ShareTribe field names (columns exist in database)
    // Even if values are NULL, if the columns exist, it's a CSV product
    const hasShareTribeColumns = 'title' in product || 
                                 'description' in product || 
                                 'price' in product ||
                                 product.title !== undefined ||
                                 product.description !== undefined ||
                                 product.price !== undefined;
    
    console.log('hasShareTribeColumns:', hasShareTribeColumns, 'mappings.length:', mappings.length);
    
    // If product has ShareTribe columns, it's from CSV - use as-is
    // Simply copy all fields except database metadata
    if (hasShareTribeColumns || mappings.length === 0) {
      const metadataColumns = ['id', 'tenant_id', 'synced', 'sharetribe_listing_id', 'last_synced_at', 'created_at', 'updated_at', 'user_id'];
      
      // Build cleaned product by explicitly copying each field
      // This is more reliable than spread operator with SQLite row objects
      const cleanedProduct = {};
      
      // Get ALL keys from the product object (including non-enumerable if needed)
      const allKeys = Object.keys(product).concat(Object.getOwnPropertyNames(product));
      const uniqueKeys = [...new Set(allKeys)];
      
      // Copy all fields except metadata
      uniqueKeys.forEach(key => {
        if (!metadataColumns.includes(key)) {
          // Explicitly copy the value
          cleanedProduct[key] = product[key];
        }
      });
      
      // CRITICAL: Explicitly ensure all important fields are set
      // This handles cases where properties might not be enumerable or spread didn't work
      if (product.title !== undefined) cleanedProduct.title = product.title;
      if (product.description !== undefined) cleanedProduct.description = product.description;
      if (product.price !== undefined) cleanedProduct.price = product.price;
      if (product.currency !== undefined) cleanedProduct.currency = product.currency;
      if (product.quantity !== undefined) cleanedProduct.quantity = product.quantity;
      if (product.images !== undefined) cleanedProduct.images = product.images;
      if (product.category !== undefined) cleanedProduct.category = product.category;
      if (product.condition !== undefined) cleanedProduct.condition = product.condition;
      if (product.brand !== undefined) cleanedProduct.brand = product.brand;
      if (product.sku !== undefined) cleanedProduct.sku = product.sku;
      if (product.ebay_item_id !== undefined) cleanedProduct.ebay_item_id = product.ebay_item_id;
      
      // Copy ALL custom fields (categoryLevel1, categoryLevel2, gearbrand, helmetsize, newused, etc.)
      uniqueKeys.forEach(key => {
        if (!metadataColumns.includes(key) && cleanedProduct[key] === undefined && product[key] !== undefined) {
          cleanedProduct[key] = product[key];
        }
      });
      
      console.log('applyFieldMappings output:', {
        ebay_item_id: cleanedProduct.ebay_item_id,
        hasTitle: 'title' in cleanedProduct,
        titleValue: cleanedProduct.title,
        hasDescription: 'description' in cleanedProduct,
        descriptionValue: cleanedProduct.description,
        hasPrice: 'price' in cleanedProduct,
        priceValue: cleanedProduct.price,
        allKeys: Object.keys(cleanedProduct),
        keyCount: Object.keys(cleanedProduct).length,
        allValues: JSON.stringify(cleanedProduct, null, 2)
      });
      
      // SAFETY CHECK: If cleanedProduct is empty, something went wrong
      if (Object.keys(cleanedProduct).length === 0) {
        console.error(`❌ FATAL: applyFieldMappings produced empty object for ${product.ebay_item_id}`);
        console.error('Input product keys:', Object.keys(product));
        console.error('Input product:', JSON.stringify(product, null, 2));
        // Return a minimal product with at least the title
        return {
          ebay_item_id: product.ebay_item_id,
          title: product.title || 'Unknown',
          description: product.description,
          price: product.price,
          currency: product.currency
        };
      }
      
      return cleanedProduct;
    }
    
    // Product has eBay field names, apply mappings
    const mappedProduct = {};
    
    for (const mapping of mappings) {
      const sourceValue = product[mapping.ebay_field];
      if (sourceValue !== undefined && sourceValue !== null && sourceValue !== '') {
        mappedProduct[mapping.sharetribe_field] = sourceValue;
      }
    }
    
    // Copy over other fields that aren't mapped (like ebay_item_id, id, etc.)
    for (const key in product) {
      if (product.hasOwnProperty(key) && !mappedProduct.hasOwnProperty(key)) {
        // Keep non-mapped fields that aren't eBay-specific
        if (!key.startsWith('ebay_') || key === 'ebay_item_id') {
          mappedProduct[key] = product[key];
        }
      }
    }

    return mappedProduct;
  }

  async getApiConfig(tenantId = 1) {
    return new Promise((resolve, reject) => {
      const dbInstance = db.getDb();
      dbInstance.get(
        'SELECT * FROM api_config WHERE tenant_id = ?',
        [tenantId],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          if (!row) {
            resolve({ ebay: null, sharetribe: null });
            return;
          }

          resolve({
            ebay: {
              appId: row.ebay_app_id,
              certId: row.ebay_cert_id,
              devId: row.ebay_dev_id,
              accessToken: row.ebay_access_token,
              refreshToken: row.ebay_refresh_token,
              sandbox: row.ebay_sandbox !== undefined ? row.ebay_sandbox === 1 : true, // Default to sandbox if not set
              redirectUri: row.ebay_redirect_uri || null
            },
            sharetribe: {
              apiKey: row.sharetribe_api_key,
              apiSecret: row.sharetribe_api_secret,
              marketplaceApiClientId: row.sharetribe_marketplace_api_client_id,
              marketplaceId: row.sharetribe_marketplace_id,
              userId: row.sharetribe_user_id
            }
          });
        }
      );
    });
  }

  async getFieldMappings(tenantId = 1) {
    return new Promise((resolve, reject) => {
      const dbInstance = db.getDb();
      dbInstance.all(
        'SELECT * FROM field_mappings WHERE tenant_id = ?',
        [tenantId],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  }

  async getProductByEbayId(tenantId, ebayItemId) {
    return new Promise((resolve, reject) => {
      const dbInstance = db.getDb();
      dbInstance.get(
        'SELECT * FROM products WHERE tenant_id = ? AND ebay_item_id = ?',
        [tenantId, ebayItemId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row || null);
          }
        }
      );
    });
  }

  async upsertProduct(tenantId, productData) {
    return new Promise((resolve, reject) => {
      const dbInstance = db.getDb();
      
      // Define standard columns that are stored directly
      const standardColumns = [
        'id', 'tenant_id', 'user_id', 'ebay_item_id', 'title', 'description', 
        'price', 'currency', 'quantity', 'images', 'category', 'condition', 
        'brand', 'sku', 'synced', 'sharetribe_listing_id', 'last_synced_at',
        'created_at', 'updated_at', 'custom_fields',
        // Price fields (store in custom_fields but ensure they're accessible)
        'start_price', 'start_price_currency', 'buy_now_price', 'buy_now_price_currency',
        'current_price', 'current_price_currency'
      ];
      
      // Extract custom fields (everything not in standard columns)
      const customFields = {};
      for (const key in productData) {
        if (!standardColumns.includes(key) && productData[key] !== undefined && productData[key] !== null) {
          customFields[key] = productData[key];
        }
      }
      
      // Log categoryLevel fields being saved
      if (productData.categoryLevel1 || productData.categoryLevel2 || productData.categoryLevel3) {
        console.log(`Saving categoryLevel fields for product ${productData.ebay_item_id}:`, {
          categoryLevel1: productData.categoryLevel1,
          categoryLevel2: productData.categoryLevel2,
          categoryLevel3: productData.categoryLevel3,
          inCustomFields: {
            categoryLevel1: customFields.categoryLevel1,
            categoryLevel2: customFields.categoryLevel2,
            categoryLevel3: customFields.categoryLevel3
          }
        });
      }
      
      const customFieldsJson = Object.keys(customFields).length > 0 ? JSON.stringify(customFields) : null;
      
      // First check if product exists
      dbInstance.get(
        'SELECT id FROM products WHERE tenant_id = ? AND ebay_item_id = ?',
        [tenantId, productData.ebay_item_id],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          if (row) {
            // Update existing product
            console.log(`Updating product ${productData.ebay_item_id}:`, {
              title: productData.title,
              titleType: typeof productData.title,
              description: productData.description,
              price: productData.price,
              allFields: Object.keys(productData),
              customFields: customFields,
              allValues: Object.entries(productData).map(([k, v]) => `${k}: ${v !== null && v !== undefined ? v : 'NULL/UNDEFINED'}`).join(', ')
            });
            dbInstance.run(
              `UPDATE products SET
                title = ?, description = ?, price = ?, currency = ?, quantity = ?,
                images = ?, category = ?, condition = ?, brand = ?, sku = ?,
                synced = ?, sharetribe_listing_id = ?, last_synced_at = ?,
                user_id = ?, custom_fields = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
              [
                productData.title || null,
                productData.description || null,
                productData.price || 0,
                productData.currency || 'USD',
                productData.quantity || 0,
                productData.images || null,
                productData.category || null,
                productData.condition || null,
                productData.brand || null,
                productData.sku || null,
                productData.synced ? 1 : 0,
                productData.sharetribe_listing_id || null,
                productData.last_synced_at || null,
                productData.user_id || null,
                customFieldsJson,
                row.id
              ],
              function(updateErr) {
                if (updateErr) {
                  reject(updateErr);
                } else {
                  resolve({ id: row.id });
                }
              }
            );
          } else {
            // Insert new product
            dbInstance.run(
              `INSERT INTO products (
                tenant_id, user_id, ebay_item_id, title, description, price, currency, quantity,
                images, category, condition, brand, sku, synced, sharetribe_listing_id, last_synced_at, custom_fields
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                tenantId,
                productData.user_id || null,
                productData.ebay_item_id,
                productData.title,
                productData.description,
                productData.price,
                productData.currency,
                productData.quantity,
                productData.images,
                productData.category,
                productData.condition,
                productData.brand,
                productData.sku,
                productData.synced ? 1 : 0,
                productData.sharetribe_listing_id,
                productData.last_synced_at,
                customFieldsJson
              ],
              function(insertErr) {
                if (insertErr) {
                  reject(insertErr);
                } else {
                  resolve({ id: this.lastID });
                }
              }
            );
          }
        }
      );
    });
  }

  async refreshProductsFromEbay(tenantId = 1, sharetribeUserId = null, debug = false) {
    const config = await this.getApiConfig(tenantId);
    if (!config.ebay) {
      throw new Error('eBay API configuration missing');
    }

    const dbInstance = db.getDb();
    let ebayUserId = null;
    let useSandbox = true;

    // If ShareTribe user ID is provided, get eBay account associated with that user
    // sharetribeUserId can be either the database ID (integer) or sharetribe_user_id (UUID)
    if (sharetribeUserId) {
      // Try to find by database ID first (most common case)
      let sharetribeUser = await new Promise((resolve, reject) => {
        dbInstance.get(
          `SELECT id, sharetribe_user_id, ebay_user_id FROM sharetribe_users WHERE id = ?`,
          [sharetribeUserId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      // If not found by ID, try by sharetribe_user_id (UUID)
      if (!sharetribeUser) {
        sharetribeUser = await new Promise((resolve, reject) => {
          dbInstance.get(
            `SELECT id, sharetribe_user_id, ebay_user_id FROM sharetribe_users WHERE sharetribe_user_id = ?`,
            [sharetribeUserId],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });
      }

      if (!sharetribeUser) {
        throw new Error(`ShareTribe user ${sharetribeUserId} not found. Please check the user ID.`);
      }

      console.log(`🔍 Found ShareTribe user:`, {
        id: sharetribeUser.id,
        sharetribe_user_id: sharetribeUser.sharetribe_user_id,
        ebay_user_id: sharetribeUser.ebay_user_id
      });

      if (sharetribeUser.ebay_user_id) {
        ebayUserId = sharetribeUser.ebay_user_id;
        console.log(`✅ Using eBay account ${ebayUserId} associated with ShareTribe user (ID: ${sharetribeUser.id}, UUID: ${sharetribeUser.sharetribe_user_id})`);
        
        // Get sandbox flag from eBay user
        const ebayUser = await new Promise((resolve, reject) => {
          dbInstance.get(
            `SELECT sandbox FROM ebay_users WHERE tenant_id = ? AND ebay_user_id = ?`,
            [tenantId, ebayUserId],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });
        
        if (ebayUser) {
          useSandbox = ebayUser.sandbox === 1;
        } else {
          throw new Error(`eBay user ${ebayUserId} not found in database. The association may be invalid.`);
        }
      } else {
        throw new Error(`No eBay account connected for ShareTribe user (ID: ${sharetribeUser.id}, UUID: ${sharetribeUser.sharetribe_user_id}). Please connect an eBay account for this user in API Configuration.`);
      }
    } else {
      // Fallback: Get any connected eBay user
      const ebayUsers = await new Promise((resolve, reject) => {
        dbInstance.all(
          `SELECT ebay_user_id, sandbox FROM ebay_users WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
          [tenantId],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      if (!ebayUsers || ebayUsers.length === 0) {
        throw new Error('No eBay accounts connected. Please connect an eBay account first in API Configuration.');
      }

      // Use the first connected eBay user (most recent)
      const ebayUser = ebayUsers[0];
      ebayUserId = ebayUser.ebay_user_id;
      useSandbox = ebayUser.sandbox === 1;
    }

    // Create eBay service with user ID so it can load tokens from database
    const ebayConfig = {
      ...config.ebay,
      sandbox: useSandbox
    };
    const ebayService = new eBayService(ebayConfig, ebayUserId, tenantId);
    
    // Load tokens from database
    await ebayService.loadTokensFromDatabase();
    
    const result = await ebayService.getActiveListings({ debug });

    // Handle debug mode response
    if (result.debug) {
      return result; // Return debug response as-is
    }

    const products = result.items || result;

    if (!products || products.length === 0) {
      console.log('⚠️ No listings found from eBay');
      return { items: [], count: 0 };
    }

    console.log(`✅ Fetched ${products.length} listings from eBay`);

    for (const product of products) {
      await this.upsertProduct(tenantId, {
        ...product,
        synced: false // Mark as needing sync
      });
    }

    return { items: products, count: products.length };
  }
}

module.exports = new SyncService();

