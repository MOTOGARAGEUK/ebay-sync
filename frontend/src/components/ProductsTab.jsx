import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw, Upload, CheckCircle, XCircle, AlertCircle, FileUp, X, Eye } from 'lucide-react';
import { getProducts, refreshProducts, syncProducts, previewCSV, uploadCSV, removeProducts, getShareTribeUsers, previewPayload, applyEbayProductMappings } from '../services/api';
import CSVColumnMapping from './CSVColumnMapping';

const ProductsTab = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [removingFromSync, setRemovingFromSync] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState(new Set());
  const [filter, setFilter] = useState('all'); // all, synced, unsynced
  const [searchTerm, setSearchTerm] = useState('');
  const [uploadingCSV, setUploadingCSV] = useState(false);
  const [csvFile, setCsvFile] = useState(null);
  const [csvPreview, setCsvPreview] = useState(null);
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [selectedShareTribeUser, setSelectedShareTribeUser] = useState(null);
  const [shareTribeUsers, setShareTribeUsers] = useState([]);
  const [showPayloadPreview, setShowPayloadPreview] = useState(false);
  const [payloadPreviewData, setPayloadPreviewData] = useState(null);
  const [previewingPayload, setPreviewingPayload] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    loadProducts();
    loadShareTribeUsers();
  }, [filter, searchTerm]);

  const loadShareTribeUsers = async () => {
    try {
      const response = await getShareTribeUsers();
      setShareTribeUsers(response.data || []);
    } catch (error) {
      console.error('Error loading ShareTribe users:', error);
    }
  };

  const loadProducts = async () => {
    setLoading(true);
    try {
      const params = {};
      if (filter === 'synced') params.synced = 'true';
      if (filter === 'unsynced') params.synced = 'false';
      if (searchTerm) params.search = searchTerm;

      const response = await getProducts(params);
      setProducts(response.data);
    } catch (error) {
      console.error('Error loading products:', error);
      alert('Failed to load products: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshFromEbay = async () => {
    if (!selectedShareTribeUser) {
      alert('Please select a ShareTribe user first. The refresh will use the eBay account connected to that user.');
      return;
    }
    
    setLoading(true);
    try {
      const response = await refreshProducts(selectedShareTribeUser);
      // Backend returns { success: true, count: X, products: [...] }
      const products = Array.isArray(response?.data?.products) ? response.data.products : 
                      Array.isArray(response?.data) ? response.data : [];
      
      console.log('Products refreshed from eBay:', products.length, 'products');
      console.log('Response structure:', { 
        hasData: !!response?.data, 
        hasProducts: !!response?.data?.products,
        dataType: typeof response?.data,
        isArray: Array.isArray(response?.data),
        isProductsArray: Array.isArray(response?.data?.products)
      });
      
      // Reload products to show them in the UI
      await loadProducts();
      
      if (products.length === 0) {
        alert('No active buyer-visible listings found.\n\nPossible reasons:\n1. Your eBay account has no active listings\n2. All listings are auctions (not supported)\n3. Listings are outside the date range (last 120 days)\n\nMake sure you have active Fixed Price listings on eBay.');
      } else {
        alert(`✅ Found ${products.length} active buyer-visible eBay listing(s)`);
        // Show mapping modal for eBay products (similar to CSV mapping)
        // Convert eBay products to a format similar to CSV preview
        // Collect ALL unique columns from ALL products (not just the first one)
        // EXCLUDE internal fields that aren't from eBay (like sharetribe_listing_id)
        const excludedColumns = new Set([
          'sharetribe_listing_id',
          'id',
          'tenant_id',
          'user_id',
          'synced',
          'last_synced_at',
          'created_at',
          'updated_at',
          'custom_fields'
        ]);
        
        const allColumnsSet = new Set();
        const seenColumns = new Set(); // Track lowercase versions to prevent duplicates
        
        // Always include price fields even if they might be null (they're important for mapping)
        const importantPriceFields = ['price', 'currency', 'listing_type', 'price_source'];
        
        products.forEach(product => {
          Object.keys(product).forEach(key => {
            // Only include columns that have values in at least one product AND aren't excluded
            if (!excludedColumns.has(key)) {
              // For important price fields, always include them even if null (they might have values in other products)
              const isImportantPriceField = importantPriceFields.includes(key.toLowerCase());
              
              // Check if this column has a value in at least one product
              const hasValue = products.some(p => {
                const value = p[key];
                return value !== null && value !== undefined && value !== '' && 
                       (typeof value !== 'string' || value.trim() !== '');
              });
              
              // Include if it has a value OR if it's an important price field
              if (hasValue || isImportantPriceField) {
                // Check for duplicates (case-insensitive)
                const lowerKey = key.toLowerCase();
                if (!seenColumns.has(lowerKey)) {
                  seenColumns.add(lowerKey);
                  allColumnsSet.add(key); // Use original case for display
                } else {
                  // If we've seen a lowercase version, check if we should use this one instead
                  const existingKey = Array.from(allColumnsSet).find(k => k.toLowerCase() === lowerKey);
                  if (existingKey && key !== existingKey) {
                    // Prefer the version that appears more frequently or has better casing
                    const existingCount = products.filter(p => p[existingKey] != null && p[existingKey] !== '').length;
                    const currentCount = products.filter(p => p[key] != null && p[key] !== '').length;
                    if (currentCount > existingCount) {
                      allColumnsSet.delete(existingKey);
                      allColumnsSet.add(key);
                    }
                  }
                }
              }
            }
          });
        });
        const ebayProductColumns = Array.from(allColumnsSet).sort();
        
        // Log for debugging
        console.log('📊 eBay columns collected:', {
          totalColumns: ebayProductColumns.length,
          columns: ebayProductColumns,
          priceFields: ebayProductColumns.filter(c => c.toLowerCase().includes('price')),
          sampleProduct: products[0] ? {
            price: products[0].price,
            start_price: products[0].start_price,
            buy_now_price: products[0].buy_now_price,
            current_price: products[0].current_price
          } : null
        });
        
        // Use all products as sample rows (or limit to 50 for performance)
        const ebaySampleRows = Array.isArray(products) ? products.slice(0, 50) : [];
        
        // Extract unique categories if products have category fields
        const uniqueCategories = {};
        const categoryColumns = ['category', 'categoryLevel1', 'categoryLevel2', 'Category', 'Category ID'];
        categoryColumns.forEach(col => {
          const values = new Set();
          products.forEach(product => {
            const value = product[col];
            if (value && value.toString().trim() !== '') {
              values.add(value.toString().trim());
            }
          });
          if (values.size > 0) {
            uniqueCategories[col] = Array.from(values).sort();
          }
        });
        
        // Create a preview-like object for the mapping modal
        const ebayPreview = {
          columns: ebayProductColumns,
          sampleRows: ebaySampleRows,
          rowCount: products.length,
          uniqueCategories: uniqueCategories
        };
        
        console.log(`✅ Found ${products.length} products from eBay with ${ebayProductColumns.length} unique columns:`, ebayProductColumns);
        console.log('Sample product:', ebaySampleRows[0]);
        
        // Set up the mapping modal with eBay product data
        setCsvPreview(ebayPreview);
        setCsvFile({ name: 'eBay Products', type: 'application/json' }); // Fake file object for compatibility
        setShowMappingModal(true);
        
        console.log(`✅ Opening mapping modal for ${products.length} eBay products...`);
      }
    } catch (error) {
      console.error('Error refreshing products:', error);
      alert('Failed to refresh products: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  const handleSelectProduct = (productId) => {
    const newSelected = new Set(selectedProducts);
    if (newSelected.has(productId)) {
      newSelected.delete(productId);
    } else {
      newSelected.add(productId);
    }
    setSelectedProducts(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedProducts.size === products.length) {
      setSelectedProducts(new Set());
    } else {
      setSelectedProducts(new Set(products.map(p => p.ebay_item_id)));
    }
  };

  const handlePreviewPayload = async (itemIds = null) => {
    if (!selectedShareTribeUser) {
      alert('Please select a ShareTribe user to preview payload.');
      return;
    }

    setPreviewingPayload(true);
    try {
      const result = await previewPayload(itemIds, selectedShareTribeUser);
      setPayloadPreviewData(result.data);
      setShowPayloadPreview(true);
    } catch (error) {
      console.error('Error previewing payload:', error);
      alert('Failed to preview payload: ' + (error.response?.data?.error || error.message));
    } finally {
      setPreviewingPayload(false);
    }
  };

  const handleSync = async (itemIds = null) => {
    if (!selectedShareTribeUser) {
      alert('Please select a ShareTribe user to sync products on behalf of.');
      return;
    }

    setSyncing(true);
    try {
      const result = await syncProducts(itemIds, selectedShareTribeUser);
      const { synced, failed, errors } = result.data;
      
      if (failed > 0 && errors && errors.length > 0) {
        // Show all errors in alert
        const errorDetails = errors.map((e, idx) => `${idx + 1}. ${e.itemId}: ${e.error}`).join('\n');
        alert(`Sync completed!\n\nSynced: ${synced}\nFailed: ${failed}\n\nErrors:\n${errorDetails}`);
        console.error('Sync errors:', errors);
        // Also log each error individually for easier debugging
        errors.forEach((e, idx) => {
          console.error(`Error ${idx + 1} - ${e.itemId}:`, e.error);
        });
      } else {
        alert(`Sync completed! Synced: ${synced}, Failed: ${failed}`);
      }
      
      await loadProducts();
      setSelectedProducts(new Set());
    } catch (error) {
      console.error('Error syncing products:', error);
      alert('Failed to sync products: ' + (error.response?.data?.error || error.message));
    } finally {
      setSyncing(false);
    }
  };

  const handleRemoveProducts = async (itemIds = null) => {
    // If no itemIds provided, remove all filtered products (displayed in table)
    let productsToRemove = itemIds;
    if (!productsToRemove) {
      // Filter products based on current filter and search
      const filtered = products.filter(product => {
        if (filter === 'synced' && !product.synced) return false;
        if (filter === 'unsynced' && product.synced) return false;
        if (searchTerm && !product.title?.toLowerCase().includes(searchTerm.toLowerCase()) && 
            !product.description?.toLowerCase().includes(searchTerm.toLowerCase())) {
          return false;
        }
        return true;
      });
      productsToRemove = filtered.map(p => p.ebay_item_id);
    }

    const productCount = productsToRemove.length;
    const message = itemIds 
      ? `Are you sure you want to remove ${productCount} selected product(s)? This will permanently delete them from the database.`
      : `Are you sure you want to remove all ${productCount} displayed product(s)? This will permanently delete them from the database.`;
    
    if (!window.confirm(message)) {
      return;
    }

    setRemovingFromSync(true);
    try {
      const result = await removeProducts(productsToRemove);
      alert(`Successfully removed ${result.data.count} product(s).`);
      await loadProducts();
      setSelectedProducts(new Set());
    } catch (error) {
      console.error('Error removing products:', error);
      alert('Failed to remove products: ' + (error.response?.data?.error || error.message));
    } finally {
      setRemovingFromSync(false);
    }
  };

  const handleFileSelect = async (event) => {
    const file = event.target.files[0];
    if (file) {
      if (file.type === 'text/csv' || file.name.endsWith('.csv')) {
        setCsvFile(file);
        setUploadingCSV(true);
        
        try {
          // Preview CSV to get columns
          const preview = await previewCSV(file);
          setCsvPreview(preview.data);
          setShowMappingModal(true);
        } catch (error) {
          console.error('Error previewing CSV:', error);
          alert('Failed to preview CSV: ' + (error.response?.data?.error || error.message));
          setCsvFile(null);
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        } finally {
          setUploadingCSV(false);
        }
      } else {
        alert('Please select a CSV file');
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    }
  };

  const handleMappingConfirm = async (mappingData) => {
    // Check if this is eBay products mapping (csvFile.name === 'eBay Products') or CSV upload
    const isEbayMapping = csvFile?.name === 'eBay Products';
    
    if (!csvFile && !isEbayMapping) {
      alert('CSV file not found');
      return;
    }

    setUploadingCSV(true);
    setShowMappingModal(false);
    
    try {
      // Handle new multi-step format
      const { defaultMappings, categoryColumn, categoryShareTribeMappings, categoryFieldMappings, categoryListingTypeMappings, valueMappings, unmappedFieldValues } = mappingData;
      
      if (isEbayMapping) {
        // For eBay products, apply mappings to existing products in database
        // Convert to format expected by backend
        const columnMappings = { ...defaultMappings };
        const categoryMappings = categoryShareTribeMappings || {};
        
        try {
          const result = await applyEbayProductMappings(
            columnMappings,
            categoryMappings,
            categoryColumn,
            categoryFieldMappings,
            categoryListingTypeMappings,
            valueMappings,
            unmappedFieldValues
          );
          
          alert(`✅ eBay product mappings applied successfully!\n\nUpdated ${result.data.count || 0} product(s).\n\nYou can now sync these products to ShareTribe.`);
          
          // Reload products to show updated data
          await loadProducts();
        } catch (error) {
          console.error('Error applying eBay product mappings:', error);
          alert('Failed to apply mappings: ' + (error.response?.data?.error || error.message));
        } finally {
          setCsvFile(null);
          setCsvPreview(null);
        }
        return;
      }
      
      // Convert to format expected by backend
      const columnMappings = { ...defaultMappings };
      const categoryMappings = categoryShareTribeMappings || {};
      
      const result = await uploadCSV(csvFile, columnMappings, csvPreview?.fileId, categoryMappings, categoryColumn, categoryFieldMappings, categoryListingTypeMappings, valueMappings, unmappedFieldValues);
      
      // Log debug information
      console.log('CSV Import Result:', result.data);
      if (result.data.debug) {
        console.log('CSV Import Debug Info:', result.data.debug);
        if (result.data.debug.sampleProduct) {
          console.log('Sample imported product:', result.data.debug.sampleProduct);
          console.log('Sample product fields:', Object.keys(result.data.debug.sampleProduct));
          console.log('Sample product values:', Object.entries(result.data.debug.sampleProduct).map(([k, v]) => `${k}: ${v !== null && v !== undefined ? v : 'NULL'}`).join(', '));
        }
        if (result.data.debug.importDetails) {
          console.log('Import details:', result.data.debug.importDetails);
        }
      }
      
      const message = `CSV imported successfully! ${result.data.imported} products imported. ${result.data.errors > 0 ? `${result.data.errors} errors occurred.` : ''}`;
      alert(message);
      
      setCsvFile(null);
      setCsvPreview(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      await loadProducts();
    } catch (error) {
      console.error('Error uploading CSV:', error);
      console.error('Error response:', error.response?.data);
      alert('Failed to upload CSV: ' + (error.response?.data?.error || error.message));
    } finally {
      setUploadingCSV(false);
    }
  };

  const handleMappingCancel = () => {
    setShowMappingModal(false);
    setCsvPreview(null);
    setCsvFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const filteredProducts = products.filter(product => {
    if (filter === 'synced' && !product.synced) return false;
    if (filter === 'unsynced' && product.synced) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* ShareTribe User Selection */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select ShareTribe User (Products will be created on behalf of this user)
        </label>
        <select
          value={selectedShareTribeUser || ''}
          onChange={(e) => setSelectedShareTribeUser(e.target.value ? parseInt(e.target.value) : null)}
          className="w-full md:w-1/3 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          <option value="">-- Select ShareTribe User --</option>
          {shareTribeUsers.map(user => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.sharetribe_user_id})
            </option>
          ))}
        </select>
        {shareTribeUsers.length === 0 && (
          <p className="mt-2 text-xs text-gray-500">
            No ShareTribe users configured. Please add users in the API Configuration tab.
          </p>
        )}
      </div>

      {/* Header Actions */}
      <div className="flex justify-between items-center">
        <div className="flex space-x-4 flex-wrap gap-2">
          <button
            onClick={handleRefreshFromEbay}
            disabled={loading}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            <span>Refresh from eBay</span>
          </button>
          
          {/* CSV Upload Section */}
          <div className="flex items-center space-x-2 border border-gray-300 rounded-lg px-4 py-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileSelect}
              className="hidden"
              id="csv-upload"
            />
            <label
              htmlFor="csv-upload"
              className="flex items-center space-x-2 cursor-pointer text-gray-700 hover:text-gray-900"
            >
              <FileUp size={18} />
              <span>{csvFile ? csvFile.name : 'Upload CSV'}</span>
            </label>
          </div>
          <button
            onClick={() => handlePreviewPayload(null)}
            disabled={previewingPayload || products.length === 0 || !selectedShareTribeUser}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Eye size={18} className={previewingPayload ? 'animate-spin' : ''} />
            <span>Preview Payload</span>
          </button>
          <button
            onClick={() => handleSync(null)}
            disabled={syncing || products.length === 0}
            className="flex items-center space-x-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            <Upload size={18} className={syncing ? 'animate-spin' : ''} />
            <span>Sync All</span>
          </button>
          {selectedProducts.size > 0 && (
            <>
              <button
                onClick={() => handlePreviewPayload(Array.from(selectedProducts))}
                disabled={previewingPayload || !selectedShareTribeUser}
                className="flex items-center space-x-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                <Eye size={18} className={previewingPayload ? 'animate-spin' : ''} />
                <span>Preview Selected ({selectedProducts.size})</span>
              </button>
              <button
                onClick={() => handleSync(Array.from(selectedProducts))}
                disabled={syncing}
                className="flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
              >
                <Upload size={18} className={syncing ? 'animate-spin' : ''} />
                <span>Sync Selected ({selectedProducts.size})</span>
              </button>
            </>
          )}
          {selectedProducts.size > 0 && (
            <button
              onClick={() => handleRemoveProducts(Array.from(selectedProducts))}
              disabled={removingFromSync}
              className="flex items-center space-x-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              <X size={18} className={removingFromSync ? 'animate-spin' : ''} />
              <span>Remove Selected ({selectedProducts.size})</span>
            </button>
          )}
          <button
            onClick={() => handleRemoveProducts(null)}
            disabled={removingFromSync || filteredProducts.length === 0}
            className="flex items-center space-x-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            <X size={18} className={removingFromSync ? 'animate-spin' : ''} />
            <span>Remove All</span>
          </button>
        </div>
      </div>

      {/* CSV Upload Info */}
      {csvFile && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-sm text-blue-800">
            <strong>Selected file:</strong> {csvFile.name} ({(csvFile.size / 1024).toFixed(2)} KB)
            <br />
            <span className="text-xs">CSV should include columns like: Item ID, Title, Price, Quantity, Description, Images, etc.</span>
          </p>
        </div>
      )}

      {/* Filters */}
      <div className="flex space-x-4 items-center">
        <input
          type="text"
          placeholder="Search products..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          <option value="all">All Products</option>
          <option value="synced">Synced</option>
          <option value="unsynced">Unsynced</option>
        </select>
      </div>

      {/* Products Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <input
                    type="checkbox"
                    checked={selectedProducts.size === products.length && products.length > 0}
                    onChange={handleSelectAll}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Product
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Price
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Quantity
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Synced
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan="6" className="px-6 py-4 text-center text-gray-500">
                    Loading...
                  </td>
                </tr>
              ) : filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan="6" className="px-6 py-4 text-center text-gray-500">
                    No products found
                  </td>
                </tr>
              ) : (
                filteredProducts.map((product) => (
                  <tr key={product.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={selectedProducts.has(product.ebay_item_id)}
                        onChange={() => handleSelectProduct(product.ebay_item_id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        {product.images && (
                          <img
                            src={product.images.split(',')[0]}
                            alt={product.title}
                            className="h-12 w-12 object-cover rounded mr-3"
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                        )}
                        <div>
                          <div className="text-sm font-medium text-gray-900">
                            {product.title || 'No title'}
                          </div>
                          <div className="text-sm text-gray-500">SKU: {product.sku || product.ebay_item_id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {product.price ? `${product.currency || 'GBP'} ${product.price.toFixed(2)}` : 'N/A'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {product.quantity || 0}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {product.synced ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          <CheckCircle size={14} className="mr-1" />
                          Synced
                        </span>
                      ) : product.quantity > 0 ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                          <AlertCircle size={14} className="mr-1" />
                          Not Synced
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                          <XCircle size={14} className="mr-1" />
                          Out of Stock
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {product.last_synced_at
                        ? new Date(product.last_synced_at).toLocaleString()
                        : 'Never'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-sm text-gray-500">
        Showing {filteredProducts.length} of {products.length} products
      </div>

      {/* Mapping Modal (for CSV or eBay Products) */}
      {showMappingModal && csvPreview && (
        <CSVColumnMapping
          csvColumns={csvPreview.columns}
          sampleRows={csvPreview.sampleRows}
          fileId={csvPreview.fileId}
          csvPreview={csvPreview}
          onCancel={handleMappingCancel}
          onConfirm={handleMappingConfirm}
          isEbayProducts={csvFile?.name === 'eBay Products'}
        />
      )}

      {/* Payload Preview Modal */}
      {showPayloadPreview && payloadPreviewData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full mx-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-2xl font-bold text-gray-800">
                ShareTribe API Payload Preview
              </h2>
              <button
                onClick={() => setShowPayloadPreview(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="mb-4 text-sm text-gray-600">
                Showing payload for {payloadPreviewData.count} product(s). This is what will be sent to ShareTribe API.
              </div>
              {payloadPreviewData.previews && payloadPreviewData.previews.map((preview, index) => (
                <div key={index} className="mb-6 border border-gray-200 rounded-lg p-4">
                  <div className="mb-3">
                    <h3 className="text-lg font-semibold text-gray-800">
                      Product {index + 1}: {preview.title || preview.ebay_item_id}
                    </h3>
                    <p className="text-sm text-gray-600">eBay Item ID: {preview.ebay_item_id}</p>
                  </div>
                  {preview.error ? (
                    <div className="bg-red-50 border border-red-200 rounded p-3">
                      <p className="text-red-800 font-semibold">Error:</p>
                      <p className="text-red-600">{preview.error}</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <h4 className="text-sm font-semibold text-gray-700 mb-2">ShareTribe Payload:</h4>
                        <pre className="bg-gray-50 border border-gray-200 rounded p-4 overflow-x-auto text-xs">
                          {JSON.stringify(preview.payload, null, 2)}
                        </pre>
                      </div>
                      {preview.productData && (
                        <div>
                          <h4 className="text-sm font-semibold text-gray-700 mb-2">Product Data (before transformation):</h4>
                          <pre className="bg-blue-50 border border-blue-200 rounded p-4 overflow-x-auto text-xs">
                            {JSON.stringify(preview.productData, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end p-6 border-t">
              <button
                onClick={() => setShowPayloadPreview(false)}
                className="px-6 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProductsTab;

