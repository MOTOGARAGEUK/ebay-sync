const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

class CSVService {
  /**
   * Parse CSV file and convert to product objects
   * @param {string} filePath - Path to CSV file
   * @returns {Promise<Array>} Array of product objects
   */
  async parseCSV(filePath) {
    return new Promise((resolve, reject) => {
      const results = [];
      let rowCount = 0;
      let skippedCount = 0;
      let firstRowKeys = null;
      
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => {
          rowCount++;
          
          // Capture first row keys for debugging
          if (!firstRowKeys) {
            firstRowKeys = Object.keys(data);
            console.log('CSV Column headers detected:', firstRowKeys);
          }
          
          // Convert CSV row to product object
          // Map common eBay CSV column names to our product structure
          const product = this.mapCSVRowToProduct(data);
          // Only add valid products (not null and with ebay_item_id)
          if (product && product.ebay_item_id) {
            results.push(product);
          } else {
            skippedCount++;
          }
        })
        .on('end', () => {
          console.log(`CSV parsing complete: ${rowCount} rows processed, ${results.length} products extracted, ${skippedCount} rows skipped`);
          if (rowCount > 0 && results.length === 0) {
            console.warn('Warning: No products were extracted. Column names in CSV:', firstRowKeys);
          }
          resolve(results);
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  }

  /**
   * Map CSV row data to product object
   * Handles various eBay CSV export formats
   */
  mapCSVRowToProduct(row) {
    // Normalize row keys to lowercase for case-insensitive matching
    const normalizedRow = {};
    for (const key in row) {
      if (row.hasOwnProperty(key)) {
        const normalizedKey = key.toLowerCase().trim();
        normalizedRow[normalizedKey] = row[key];
        // Also create versions without spaces and with underscores
        normalizedRow[normalizedKey.replace(/\s+/g, '')] = row[key];
        normalizedRow[normalizedKey.replace(/\s+/g, '_')] = row[key];
      }
    }

    // Try to find item ID/SKU in various possible column names (case-insensitive)
    // Check multiple variations: with spaces, without spaces, with underscores
    const itemIdKeys = [
      'item id', 'itemid', 'item_id',
      'sku',
      'listing id', 'listingid', 'listing_id',
      'id',
      'ebay item id', 'ebayitemid', 'ebay_item_id',
      'product id', 'productid', 'product_id',
      'item number', 'itemnumber', 'item_number'
    ];
    
    let itemId = null;
    for (const key of itemIdKeys) {
      if (normalizedRow[key] && normalizedRow[key].toString().trim() !== '') {
        itemId = normalizedRow[key];
        break;
      }
    }

    if (!itemId || itemId.toString().trim() === '') {
      return null; // Skip rows without item ID
    }

    // Map common CSV columns to product fields
    // Handle multiple possible column name variations (case-insensitive)
    const getValue = (possibleKeys, defaultValue = null) => {
      for (const key of possibleKeys) {
        const normalizedKey = key.toLowerCase().trim();
        if (normalizedRow[normalizedKey] !== undefined && normalizedRow[normalizedKey] !== null && normalizedRow[normalizedKey] !== '') {
          return normalizedRow[normalizedKey].toString().trim();
        }
      }
      return defaultValue;
    };

    const product = {
      ebay_item_id: itemId.toString().trim(),
      title: getValue(['Title', 'title', 'Product Title', 'product_title', 'Item Title', 'Name', 'Product Name'], ''),
      description: getValue(['Description', 'description', 'Item Description', 'item_description', 'Details'], ''),
      price: parseFloat(getValue(['Price', 'price', 'Current Price', 'current_price', 'Sale Price', 'SalePrice', 'List Price'], 0)) || 0,
      currency: getValue(['Currency', 'currency', 'Currency Code', 'currency_code'], 'GBP'), // Default to GBP for UK marketplace
      quantity: parseInt(getValue(['Quantity', 'quantity', 'Qty', 'qty', 'Stock', 'stock', 'Available Quantity'], 0)) || 0,
      sku: getValue(['SKU', 'sku', 'Seller SKU', 'seller_sku', 'Product SKU'], itemId),
      category: getValue(['Category', 'category', 'Category ID', 'category_id', 'Category Name'], ''),
      condition: getValue(['Condition', 'condition', 'Item Condition', 'item_condition'], ''),
      brand: getValue(['Brand', 'brand', 'Manufacturer', 'manufacturer'], ''),
    };

    // Handle images - could be comma-separated or in separate columns (case-insensitive)
    const images = [];
    const imageKeys = ['image', 'images', 'image url', 'image_url', 'imageurl', 'picture', 'pictures'];
    for (const key of imageKeys) {
      if (normalizedRow[key]) {
        const imageUrls = normalizedRow[key].toString().split(',').map(url => url.trim()).filter(url => url);
        images.push(...imageUrls);
      }
    }
    // Also check for Image1, Image2, Image3, etc. (case-insensitive)
    for (let i = 1; i <= 10; i++) {
      const imageKeyVariations = [`image${i}`, `image ${i}`, `Image${i}`, `Image ${i}`];
      for (const keyVar of imageKeyVariations) {
        const normalizedKey = keyVar.toLowerCase();
        if (normalizedRow[normalizedKey] && normalizedRow[normalizedKey].toString().trim()) {
          images.push(normalizedRow[normalizedKey].toString().trim());
          break; // Only take the first match
        }
      }
    }
    product.images = images.length > 0 ? images.join(',') : '';

    return product;
  }

  /**
   * Parse CSV with custom column mappings and per-category field mappings
   * @param {string} filePath - Path to CSV file
   * @param {Object} columnMappings - Object mapping CSV column names to default product fields
   *   Example: { 'Item ID': 'ebay_item_id', 'Title': 'title', 'Price': 'price' }
   * @param {Object} categoryMappings - Object mapping CSV category values to ShareTribe categories
   *   Example: { 'Helmets': { categoryId: 'p-helmets', categoryPath: 'Riding Gear > Helmets', fullCategoryPath: ['p-riding-gear', 'p-helmets'] } }
   * @param {string} categoryColumn - CSV column name that contains category IDs
   * @param {Object} categoryFieldMappings - Object mapping category IDs to their field mappings
   *   Example: { 'Helmets': { 'Size': 'size', 'Color': 'color' } }
   * @param {Object} productFieldMappings - Object mapping product IDs to their field mappings (product-level, takes precedence)
   *   Example: { '205917057893:brand': 'gearbrand', '205917057893:size': 'helmetsize' }
   * @param {Object} productUnmappedFieldValues - Object mapping product IDs to unmapped field values
   *   Example: { '205917057893:gearbrand': 'Fox Racing' }
   * @returns {Promise<Array>} Array of product objects
   */
  async parseCSVWithMappings(filePath, columnMappings, categoryMappings = {}, categoryColumn = null, categoryFieldMappings = {}, defaultCurrency = null, valueMappings = {}, categoryListingTypeMappings = {}, unmappedFieldValues = {}, productFieldMappings = {}, productUnmappedFieldValues = {}) {
    return new Promise((resolve, reject) => {
      const results = [];
      let rowCount = 0;
      
      // Automatically detect ebay_item_id column from common CSV column names
      // This doesn't require user mapping - we'll auto-detect it
      const commonItemIdNames = [
        'ItemID', 'Item ID', 'itemid', 'item_id', 'item id',
        'eBay Item ID', 'ebay_item_id', 'ebay item id', 'ebayitemid',
        'Listing ID', 'listing_id', 'listing id', 'listingid',
        'SKU', 'sku',
        'Product ID', 'product_id', 'product id', 'productid',
        'Item Number', 'item_number', 'item number', 'itemnumber',
        'ID', 'id'
      ];
      
      let itemIdColumn = Object.keys(columnMappings).find(
        col => columnMappings[col] === 'ebay_item_id'
      );
      
      let firstRow = true;
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => {
          rowCount++;
          
          // Log CSV columns from first row and auto-detect itemIdColumn if needed
          if (firstRow) {
            console.log('CSV columns found:', Object.keys(data));
            console.log('Column mappings received:', JSON.stringify(columnMappings, null, 2));
            
            // If not mapped, try to auto-detect from CSV column names (using first row)
            if (!itemIdColumn) {
              for (const csvCol of Object.keys(data)) {
                if (commonItemIdNames.includes(csvCol) || 
                    commonItemIdNames.some(name => csvCol.toLowerCase().trim() === name.toLowerCase().trim())) {
                  itemIdColumn = csvCol;
                  console.log(`Auto-detected eBay Item ID column: "${csvCol}"`);
                  break;
                }
              }
            }
            
            // Validate itemIdColumn exists
            if (!itemIdColumn) {
              reject(new Error('Could not find eBay Item ID column in CSV. Please ensure your CSV has a column named "ItemID", "Item ID", "SKU", or similar.'));
              return;
            }
            
            firstRow = false;
          }
          
          // Map CSV row to product using column mappings, category mappings, and per-category field mappings
          const product = this.mapCSVRowWithMappings(data, columnMappings, categoryMappings, categoryColumn, categoryFieldMappings, itemIdColumn, defaultCurrency, valueMappings, categoryListingTypeMappings, unmappedFieldValues);
          
          // Ensure ebay_item_id is set (either from mapping or auto-detected)
          if (!product.ebay_item_id && itemIdColumn && data[itemIdColumn]) {
            product.ebay_item_id = data[itemIdColumn].toString().trim();
          }
          
          if (product && product.ebay_item_id) {
            results.push(product);
          }
        })
        .on('end', () => {
          console.log(`CSV parsing complete: ${rowCount} rows processed, ${results.length} products extracted`);
          resolve(results);
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  }

  /**
   * Map CSV row using custom column mappings and category mappings
   */
  mapCSVRowWithMappings(row, columnMappings, categoryMappings = {}, categoryColumn = null, categoryFieldMappings = {}, itemIdColumn = null, defaultCurrency = null, valueMappings = {}, categoryListingTypeMappings = {}, unmappedFieldValues = {}, productFieldMappings = {}, productUnmappedFieldValues = {}) {
    const product = {};
    
    // Get all available CSV column names (for debugging)
    const csvColumns = Object.keys(row);
    
    // Normalize row keys for case-insensitive and whitespace-tolerant matching
    const normalizedRow = {};
    for (const key in row) {
      if (row.hasOwnProperty(key)) {
        // Store original key
        normalizedRow[key] = row[key];
        // Also store normalized versions for matching (trimmed, lowercase)
        const normalizedKey = key.trim();
        const lowerKey = key.toLowerCase().trim();
        if (normalizedKey !== key) {
          normalizedRow[normalizedKey] = row[key];
        }
        if (lowerKey !== key && lowerKey !== normalizedKey) {
          normalizedRow[lowerKey] = row[key];
        }
      }
    }
    
    // Apply mappings with case-insensitive and whitespace-tolerant matching
    for (const csvColumn in columnMappings) {
      const targetField = columnMappings[csvColumn];
      
      // Skip if mapping is empty (N/A - Don't map)
      if (!targetField || targetField.trim() === '') {
        continue;
      }
      
      // Try multiple matching strategies:
      // 1. Exact match
      // 2. Trimmed match
      // 3. Case-insensitive match
      let value = row[csvColumn];
      
      if (value === undefined || value === null || value.toString().trim() === '') {
        // Try trimmed version
        value = normalizedRow[csvColumn.trim()];
      }
      
      if (value === undefined || value === null || value.toString().trim() === '') {
        // Try case-insensitive match
        value = normalizedRow[csvColumn.toLowerCase().trim()];
      }
      
      // If still not found, try finding by partial match (contains the column name)
      if (value === undefined || value === null || value.toString().trim() === '') {
        const searchKey = csvColumn.toLowerCase().trim();
        for (const rowKey in row) {
          if (rowKey.toLowerCase().trim() === searchKey) {
            value = row[rowKey];
            break;
          }
        }
      }
      
      if (value !== undefined && value !== null && value.toString().trim() !== '') {
        // Handle special field types
        if (targetField === 'price') {
          product[targetField] = parseFloat(value) || 0;
        } else if (targetField === 'price.amount') {
          // Convert price.amount to price field and set currency from marketplace config
          product.price = parseFloat(value) || 0;
          product.currency = defaultCurrency || null; // Set currency from marketplace config (or null if not available)
        } else if (targetField === 'quantity') {
          product[targetField] = parseInt(value) || 0;
        } else if (targetField === 'images') {
          // Handle comma-separated images
          const images = value.toString().split(',').map(img => img.trim()).filter(img => img);
          product[targetField] = images.join(',');
        } else if (targetField.startsWith('category_')) {
          // Category field - store the raw value for category mapping
          product.category = value.toString().trim();
        } else {
          product[targetField] = value.toString().trim();
        }
      } else {
        // Log when a mapping fails to find a value
        console.warn(`CSV mapping warning: Column "${csvColumn}" mapped to "${targetField}" but no value found in CSV row. Available CSV columns: ${csvColumns.join(', ')}`);
      }
    }
    
    // Get category ID from CSV row if categoryColumn is specified
    let csvCategoryId = null;
    if (categoryColumn && row[categoryColumn]) {
      csvCategoryId = row[categoryColumn].toString().trim();
    }
    
    // Apply per-category field mappings if category ID exists
    if (csvCategoryId && categoryFieldMappings[csvCategoryId]) {
      const catFieldMappings = categoryFieldMappings[csvCategoryId];
      
      // Normalize row keys for matching
      const normalizedRow = {};
      for (const key in row) {
        if (row.hasOwnProperty(key)) {
          normalizedRow[key] = row[key];
          const normalizedKey = key.trim();
          const lowerKey = key.toLowerCase().trim();
          if (normalizedKey !== key) normalizedRow[normalizedKey] = row[key];
          if (lowerKey !== key && lowerKey !== normalizedKey) normalizedRow[lowerKey] = row[key];
        }
      }
      
      // Apply category-specific field mappings
      for (const csvColumn in catFieldMappings) {
        const targetField = catFieldMappings[csvColumn];
        if (!targetField || targetField.trim() === '') continue;
        
        let value = row[csvColumn];
        if (value === undefined || value === null || value.toString().trim() === '') {
          value = normalizedRow[csvColumn.trim()] || normalizedRow[csvColumn.toLowerCase().trim()];
        }
        
        if (value !== undefined && value !== null && value.toString().trim() !== '') {
          let finalValue = value.toString().trim();
          
          // Apply value mapping if exists (for enum fields with invalid values)
          // Format: "categoryId:fieldId:csvValue" -> "shareTribeValue"
          const mappingKey = `${csvCategoryId}:${targetField}:${finalValue}`;
          if (valueMappings[mappingKey]) {
            finalValue = valueMappings[mappingKey];
            console.log(`Applied value mapping for category "${csvCategoryId}": "${value}" -> "${finalValue}" (field: ${targetField})`);
          }
          
          // Handle special field types
          if (targetField === 'price') {
            product[targetField] = parseFloat(finalValue) || 0;
          } else if (targetField === 'price.amount') {
            // Convert price.amount to price field and set currency from marketplace config
            product.price = parseFloat(finalValue) || 0;
            product.currency = defaultCurrency || null; // Set currency from marketplace config (or null if not available)
          } else if (targetField === 'quantity') {
            product[targetField] = parseInt(finalValue) || 0;
          } else if (targetField === 'images') {
            const images = finalValue.split(',').map(img => img.trim()).filter(img => img);
            product[targetField] = images.join(',');
          } else {
            product[targetField] = finalValue;
          }
          
          console.log(`Applied category-specific mapping for category "${csvCategoryId}": ${csvColumn} -> ${targetField} = "${finalValue}"`);
        }
      }
    }
    
    // Apply category ShareTribe mapping if category ID exists and mappings are provided
    if (csvCategoryId && Object.keys(categoryMappings).length > 0) {
      const categoryMapping = categoryMappings[csvCategoryId];
      
      if (categoryMapping) {
        // Use the mapped ShareTribe category ID
        product.category = categoryMapping.categoryId;
        
        // Set categoryLevel fields based on fullCategoryPath
        if (categoryMapping.fullCategoryPath && Array.isArray(categoryMapping.fullCategoryPath)) {
          categoryMapping.fullCategoryPath.forEach((catId, index) => {
            const level = index + 1;
            product[`categoryLevel${level}`] = catId;
          });
        }
        
        console.log(`Mapped CSV category "${csvCategoryId}" to ShareTribe category "${categoryMapping.categoryPath}" (ID: ${categoryMapping.categoryId})`);
      } else {
        console.log(`No ShareTribe mapping found for CSV category "${csvCategoryId}", keeping original value`);
      }
    }
    
    // Apply listing type mapping based on category
    if (csvCategoryId && categoryListingTypeMappings[csvCategoryId]) {
      const listingType = categoryListingTypeMappings[csvCategoryId];
      product.listingType = listingType;
      console.log(`Set listing type "${listingType}" for category "${csvCategoryId}"`);
    } else if (csvCategoryId) {
      // Default to list-new-item if no mapping specified
      product.listingType = 'list-new-item';
      console.log(`Using default listing type "list-new-item" for category "${csvCategoryId}"`);
    }
    
    // Get product ID for product-level mappings
    let productId = null;
    if (itemIdColumn && row[itemIdColumn]) {
      productId = row[itemIdColumn].toString().trim();
    } else if (product.ebay_item_id) {
      productId = product.ebay_item_id.toString().trim();
    }
    
    // Apply product-level field mappings (takes precedence over category-level mappings)
    // Format: "productId:csvColumn" -> "shareTribeFieldId"
    if (productId && Object.keys(productFieldMappings).length > 0) {
      Object.keys(productFieldMappings).forEach(mappingKey => {
        // Format: "productId:csvColumn"
        const [mappedProductId, csvColumn] = mappingKey.split(':');
        if (mappedProductId === productId && csvColumn) {
          const targetField = productFieldMappings[mappingKey];
          if (!targetField || targetField.trim() === '') return;
          
          let value = row[csvColumn];
          if (value === undefined || value === null || value.toString().trim() === '') {
            // Try normalized versions
            const normalizedRow = {};
            for (const key in row) {
              normalizedRow[key] = row[key];
              normalizedRow[key.trim()] = row[key];
              normalizedRow[key.toLowerCase().trim()] = row[key];
            }
            value = normalizedRow[csvColumn.trim()] || normalizedRow[csvColumn.toLowerCase().trim()];
          }
          
          if (value !== undefined && value !== null && value.toString().trim() !== '') {
            let finalValue = value.toString().trim();
            
            // Apply value mapping if exists
            const valueMappingKey = `${csvCategoryId}:${targetField}:${finalValue}`;
            if (valueMappings[valueMappingKey]) {
              finalValue = valueMappings[valueMappingKey];
              console.log(`Applied value mapping for product "${productId}": "${value}" -> "${finalValue}" (field: ${targetField})`);
            }
            
            // Handle special field types
            if (targetField === 'price') {
              product[targetField] = parseFloat(finalValue) || 0;
            } else if (targetField === 'price.amount') {
              product.price = parseFloat(finalValue) || 0;
              product.currency = defaultCurrency || null;
            } else if (targetField === 'quantity') {
              product[targetField] = parseInt(finalValue) || 0;
            } else if (targetField === 'images') {
              const images = finalValue.split(',').map(img => img.trim()).filter(img => img);
              product[targetField] = images.join(',');
            } else {
              product[targetField] = finalValue;
            }
            
            console.log(`Applied product-level mapping for product "${productId}": ${csvColumn} -> ${targetField} = "${finalValue}"`);
          }
        }
      });
    }
    
    // Apply unmapped field values (default values for unmapped ShareTribe fields)
    // First try product-level, then category-level
    // Product-level format: "productId:fieldId" -> "defaultValue"
    // Category-level format: "categoryId:fieldId" -> "defaultValue"
    if (productId && Object.keys(productUnmappedFieldValues).length > 0) {
      Object.keys(productUnmappedFieldValues).forEach(valueKey => {
        // Format: "productId:fieldId"
        const [mappedProductId, fieldId] = valueKey.split(':');
        if (mappedProductId === productId && fieldId) {
          const defaultValue = productUnmappedFieldValues[valueKey];
          if (defaultValue && String(defaultValue).trim() !== '') {
            product[fieldId] = String(defaultValue).trim();
            console.log(`Applied product-level unmapped field value for product "${productId}": ${fieldId} = "${defaultValue}"`);
          }
        }
      });
    }
    
    // Apply category-level unmapped field values (only if not set by product-level)
    if (csvCategoryId && Object.keys(unmappedFieldValues).length > 0) {
      Object.keys(unmappedFieldValues).forEach(fieldKey => {
        // Format: "categoryId:fieldId"
        const [categoryId, fieldId] = fieldKey.split(':');
        if (categoryId === csvCategoryId && fieldId) {
          // Only apply if product-level didn't already set this field
          if (product[fieldId] === undefined || product[fieldId] === null || product[fieldId] === '') {
            const defaultValue = unmappedFieldValues[fieldKey];
            if (defaultValue && String(defaultValue).trim() !== '') {
              product[fieldId] = String(defaultValue).trim();
              console.log(`Applied category-level unmapped field value for category "${csvCategoryId}": ${fieldId} = "${defaultValue}"`);
            }
          }
        }
      });
    }
    
    // Automatically extract ebay_item_id from CSV if not already mapped
    // First try the auto-detected itemIdColumn
    if ((!product.ebay_item_id || product.ebay_item_id.trim() === '') && itemIdColumn && row[itemIdColumn]) {
      product.ebay_item_id = row[itemIdColumn].toString().trim();
      console.log(`Auto-extracted eBay Item ID from column "${itemIdColumn}": ${product.ebay_item_id}`);
    }
    
    // If still not found, try common column names
    if (!product.ebay_item_id || product.ebay_item_id.trim() === '') {
      const commonItemIdNames = [
        'ItemID', 'Item ID', 'itemid', 'item_id', 'item id',
        'eBay Item ID', 'ebay_item_id', 'ebay item id', 'ebayitemid',
        'Listing ID', 'listing_id', 'listing id', 'listingid',
        'SKU', 'sku',
        'Product ID', 'product_id', 'product id', 'productid',
        'Item Number', 'item_number', 'item number', 'itemnumber',
        'ID', 'id'
      ];
      
      for (const colName of commonItemIdNames) {
        if (row[colName] !== undefined && row[colName] !== null && row[colName].toString().trim() !== '') {
          product.ebay_item_id = row[colName].toString().trim();
          console.log(`Auto-extracted eBay Item ID from column "${colName}": ${product.ebay_item_id}`);
          break;
        }
      }
    }
    
    // Ensure ebay_item_id exists
    if (!product.ebay_item_id || product.ebay_item_id.trim() === '') {
      return null;
    }
    
    // CRITICAL: Preserve price from source if not mapped
    // If price exists in the source row but wasn't mapped, preserve it
    // This handles eBay products where price already exists
    if (product.price === undefined || product.price === null || product.price === 0) {
      // Try to find price in the source row
      const priceKeys = ['price', 'Price', 'current_price', 'Current Price', 'sale_price', 'Sale Price'];
      for (const key of priceKeys) {
        if (row[key] !== undefined && row[key] !== null && row[key].toString().trim() !== '') {
          const priceValue = parseFloat(row[key]);
          if (!isNaN(priceValue) && priceValue > 0) {
            product.price = priceValue;
            console.log(`Auto-extracted price from source row key "${key}": ${product.price}`);
            break;
          }
        }
      }
    }
    
    // Set defaults for required fields
    // Note: currency is set from marketplace config when price.amount is mapped
    // Don't override it here - if not set, it will remain null
    if (product.price === undefined || product.price === null) {
      product.price = 0;
    }
    if (product.quantity === undefined || product.quantity === null) {
      product.quantity = 0;
    }
    
    // Log the mapped product for debugging
    console.log(`Mapped CSV row to product ${product.ebay_item_id}:`, {
      title: product.title,
      price: product.price,
      description: product.description ? product.description.substring(0, 50) + '...' : null,
      allFields: Object.keys(product),
      allValues: Object.entries(product).map(([k, v]) => `${k}: ${v}`).join(', ')
    });
    
    return product;
  }

  /**
   * Get column headers from CSV file for mapping UI
   */
  async getCSVHeaders(filePath) {
    return new Promise((resolve, reject) => {
      const headers = [];
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('headers', (headerList) => {
          headers.push(...headerList);
          // Stop after getting headers
          resolve(headers);
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  }
}

module.exports = new CSVService();

