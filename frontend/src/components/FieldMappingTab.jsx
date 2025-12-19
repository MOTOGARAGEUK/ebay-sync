import React, { useState, useEffect } from 'react';
import { Save, ArrowRight, Plus, X, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { getFieldMappings, saveFieldMappings, getShareTribeMetadata } from '../services/api';

// Default eBay fields
const DEFAULT_EBAY_FIELDS = [
  { id: 'title', label: 'Title', type: 'text' },
  { id: 'description', label: 'Description', type: 'text' },
  { id: 'price', label: 'Price', type: 'number' },
  { id: 'currency', label: 'Currency', type: 'text' },
  { id: 'quantity', label: 'Quantity', type: 'number' },
  { id: 'images', label: 'Images', type: 'array' },
  { id: 'category', label: 'Category', type: 'text' },
  { id: 'condition', label: 'Condition', type: 'text' },
  { id: 'brand', label: 'Brand', type: 'text' },
  { id: 'sku', label: 'SKU', type: 'text' },
];

const FieldMappingTab = () => {
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shareTribeFields, setShareTribeFields] = useState([]);
  const [listingTypes, setListingTypes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [metadataError, setMetadataError] = useState(null);
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState(null); // Filter fields by category

  useEffect(() => {
    loadMappings();
    loadShareTribeMetadata();
  }, []);

  const loadShareTribeMetadata = async () => {
    setLoadingMetadata(true);
    setMetadataError(null);
    try {
      const response = await getShareTribeMetadata();
      const { listingTypes = [], categories = [], defaultFields = [], listingFields = [] } = response.data || {};
      
      console.log('ShareTribe metadata loaded:', {
        listingTypesCount: listingTypes.length,
        categoriesCount: categories.length,
        defaultFieldsCount: defaultFields.length,
        listingFieldsCount: listingFields.length,
        sampleListingType: listingTypes[0],
        sampleCategory: categories[0],
        sampleDefaultField: defaultFields[0],
        sampleListingField: listingFields[0]
      });
      
      setListingTypes(listingTypes);
      setCategories(categories);
      
      // Transform listing fields into our format
      // Handle different possible API response structures
      const transformedListingFields = listingFields.map(field => {
        // Handle different field structures from API
        const fieldId = field.id || field.key || field.name || field.fieldId;
        const fieldLabel = field.label || field.name || field.title || fieldId;
        const fieldType = field.type || field.fieldType || 'text';
        const isRequired = field.required !== undefined ? field.required : 
                          (field.mandatory !== undefined ? field.mandatory : false);
        
        // Extract listing type restrictions
        const listingTypeIds = field.listingTypeIds || field.listing_types || field.applicableListingTypes || [];
        const categoryIds = field.categoryIds || field.categories || field.applicableCategories || [];
        
        // Normalize enum options: ensure they're strings, not objects
        let normalizedOptions = field.options || field.enumOptions || null;
        if (normalizedOptions && Array.isArray(normalizedOptions) && normalizedOptions.length > 0) {
          normalizedOptions = normalizedOptions.map(option => {
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
          }).filter(opt => opt !== null && opt !== undefined && opt !== ''); // Remove null/undefined/empty values
        }
        
        return {
          id: fieldId,
          label: fieldLabel,
          type: fieldType,
          required: isRequired,
          options: normalizedOptions, // Normalized to array of strings
          listingTypeIds: Array.isArray(listingTypeIds) ? listingTypeIds : [],
          categoryIds: Array.isArray(categoryIds) ? categoryIds : [],
          // Store original field for reference
          originalField: field
        };
      });
      
      // Use defaultFields from API (or fallback to standard fields if not provided)
      const defaultFieldsList = defaultFields.length > 0 ? defaultFields : [
        { id: 'title', label: 'Title', type: 'text', required: true, listingTypeIds: [], categoryIds: [] },
        { id: 'description', label: 'Description', type: 'text', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'price', label: 'Price', type: 'number', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'currency', label: 'Currency', type: 'text', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'quantity', label: 'Quantity', type: 'number', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'images', label: 'Images', type: 'array', required: false, listingTypeIds: [], categoryIds: [] }
      ];
      
      // Combine default fields and listing fields, keeping them separate for display
      // Default fields first, then listing fields
      const allFields = [
        ...defaultFieldsList.map(f => ({ ...f, isDefault: true })),
        ...transformedListingFields.map(f => ({ ...f, isDefault: false }))
      ];
      
      // Sort fields: required first, then alphabetically
      allFields.sort((a, b) => {
        if (a.required && !b.required) return -1;
        if (!a.required && b.required) return 1;
        return a.label.localeCompare(b.label);
      });
      
      setShareTribeFields(allFields);
      setMetadataLoaded(true);
    } catch (error) {
      console.error('Error loading ShareTribe metadata:', error);
      setMetadataError(error.response?.data?.error || error.message);
      // Fallback to default fields if API fails
      setShareTribeFields([
        { id: 'title', label: 'Title', type: 'text', required: true, listingTypeIds: [], categoryIds: [] },
        { id: 'description', label: 'Description', type: 'text', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'price', label: 'Price', type: 'number', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'currency', label: 'Currency', type: 'text', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'quantity', label: 'Quantity', type: 'number', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'images', label: 'Images', type: 'array', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'category', label: 'Category', type: 'text', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'condition', label: 'Condition', type: 'text', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'brand', label: 'Brand', type: 'text', required: false, listingTypeIds: [], categoryIds: [] },
        { id: 'sku', label: 'SKU', type: 'text', required: false, listingTypeIds: [], categoryIds: [] },
      ]);
    } finally {
      setLoadingMetadata(false);
    }
  };

  const loadMappings = async () => {
    setLoading(true);
    try {
      const response = await getFieldMappings();
      setMappings(response.data || []);
    } catch (error) {
      console.error('Error loading mappings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddMapping = () => {
    setMappings([
      ...mappings,
      { ebay_field: '', sharetribe_field: '', transformation: '' }
    ]);
  };

  const handleRemoveMapping = (index) => {
    setMappings(mappings.filter((_, i) => i !== index));
  };

  const handleUpdateMapping = (index, field, value) => {
    const newMappings = [...mappings];
    newMappings[index][field] = value;
    setMappings(newMappings);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Filter out incomplete mappings
      const validMappings = mappings.filter(
        m => m.ebay_field && m.sharetribe_field
      );
      await saveFieldMappings(validMappings);
      alert('Field mappings saved successfully!');
      await loadMappings();
    } catch (error) {
      console.error('Error saving mappings:', error);
      alert('Failed to save field mappings: ' + (error.response?.data?.error || error.message));
    } finally {
      setSaving(false);
    }
  };

  const getAvailableEbayFields = (currentIndex) => {
    const usedFields = mappings
      .map((m, i) => i !== currentIndex ? m.ebay_field : null)
      .filter(f => f);
    return DEFAULT_EBAY_FIELDS.filter(f => !usedFields.includes(f.id));
  };

  // Flatten categories for dropdown (including all subcategories)
  // Builds full category paths including all parent IDs
  const flattenCategories = (cats, result = [], prefix = '', parentPath = []) => {
    if (!cats || !Array.isArray(cats)) return result;
    cats.forEach(cat => {
      const catId = cat.id || cat.key;
      const catName = cat.name || cat.label || cat.title || catId;
      
      // Build full path: all parent IDs + current category ID
      const fullPath = [...parentPath, catId];
      
      result.push({
        id: catId,
        label: `${prefix}${catName}`,
        fullPath: fullPath, // Array of all parent IDs + current ID
        parentId: cat.parentId || null,
        level: cat.level || parentPath.length
      });
      
      // Recursively process subcategories with updated parent path
      if (cat.subcategories && cat.subcategories.length > 0) {
        flattenCategories(cat.subcategories, result, `${prefix}${catName} > `, fullPath);
      }
    });
    return result;
  };

  const flattenedCategories = flattenCategories(categories);

  // Get all parent category IDs for a given category (including the category itself)
  const getCategoryHierarchy = (categoryId) => {
    if (!categoryId) return [];
    
    // Find the category in the flattened list
    const category = flattenedCategories.find(cat => cat.id === categoryId);
    if (!category) return [categoryId]; // If not found, just return the ID itself
    
    // Get the full path (which includes parent IDs)
    const fullPath = category.fullPath || [categoryId];
    
    // Return all IDs in the hierarchy (parent to child)
    return Array.isArray(fullPath) ? fullPath : [categoryId];
  };

  // Filter fields by selected category (including parent categories)
  const getFieldsForCategory = (categoryId) => {
    if (!categoryId) return shareTribeFields; // Show all fields if no category selected
    
    // Get all category IDs in the hierarchy (parent categories + selected category)
    const categoryHierarchy = getCategoryHierarchy(categoryId);
    
    return shareTribeFields.filter(field => {
      // Show default fields (they apply to all categories)
      if (field.isDefault) return true;
      
      // Show fields with no category restrictions
      if (!field.categoryIds || field.categoryIds.length === 0) return true;
      
      // Show fields that include this category OR any of its parent categories in their categoryIds
      return categoryHierarchy.some(catId => field.categoryIds.includes(catId));
    });
  };

  const getAvailableShareTribeFields = (currentIndex) => {
    const usedFields = mappings
      .map((m, i) => i !== currentIndex ? m.sharetribe_field : null)
      .filter(f => f);
    
    // Get fields filtered by selected category
    const categoryFilteredFields = selectedCategoryFilter 
      ? getFieldsForCategory(selectedCategoryFilter)
      : shareTribeFields;
    
    return categoryFilteredFields.filter(f => !usedFields.includes(f.id));
  };

  // Initialize with default mappings if empty
  useEffect(() => {
    if (mappings.length === 0 && !loading && shareTribeFields.length > 0) {
      const defaultMappings = DEFAULT_EBAY_FIELDS.map(ebayField => {
        const matchingField = shareTribeFields.find(
          stField => stField.id === ebayField.id
        );
        return {
          ebay_field: ebayField.id,
          sharetribe_field: matchingField ? matchingField.id : '',
          transformation: ''
        };
      }).filter(m => m.sharetribe_field);
      if (defaultMappings.length > 0) {
        setMappings(defaultMappings);
      }
    }
  }, [mappings.length, loading, shareTribeFields.length]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold text-gray-900">Field Mapping</h2>
        <div className="flex items-center space-x-3">
          <button
            onClick={loadShareTribeMetadata}
            disabled={loadingMetadata}
            className="flex items-center space-x-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            title="Sync listing types, categories, and fields from ShareTribe"
          >
            <RefreshCw size={18} className={loadingMetadata ? 'animate-spin' : ''} />
            <span>{loadingMetadata ? 'Syncing...' : 'Sync from ShareTribe'}</span>
          </button>
          <button
            onClick={handleAddMapping}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={18} />
            <span>Add Mapping</span>
          </button>
        </div>
      </div>

      {/* Metadata Status */}
      {metadataError && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-start space-x-3">
          <AlertCircle className="text-yellow-600 mt-0.5" size={20} />
          <div className="flex-1">
            <h3 className="font-semibold text-yellow-900 mb-1">Could not sync from ShareTribe</h3>
            <p className="text-sm text-yellow-800">{metadataError}</p>
            <p className="text-sm text-yellow-800 mt-1">Using default fields. Make sure ShareTribe API is configured correctly.</p>
          </div>
        </div>
      )}
      
      {metadataLoaded && !metadataError && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start space-x-3">
          <CheckCircle className="text-green-600 mt-0.5" size={20} />
          <div className="flex-1">
            <h3 className="font-semibold text-green-900 mb-1">ShareTribe metadata synced</h3>
            <p className="text-sm text-green-800">
              Loaded {shareTribeFields.filter(f => f.isDefault).length} default fields, {shareTribeFields.filter(f => !f.isDefault).length} listing fields, {listingTypes.length} listing types, {categories.length} categories
            </p>
          </div>
        </div>
      )}

      {/* Category Filter for Fields */}
      {categories.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="font-semibold text-blue-900 mb-2">View Fields by Category</h3>
          <p className="text-sm text-blue-800 mb-3">
            Select a category to see all fields that apply to that category (e.g., "Helmet Size" only shows for Helmet categories)
          </p>
          <select
            value={selectedCategoryFilter || ''}
            onChange={(e) => setSelectedCategoryFilter(e.target.value || null)}
            className="w-full md:w-1/2 px-3 py-2 border border-blue-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          >
            <option value="">Select a category to view its fields...</option>
            {flattenedCategories.map(cat => (
              <option key={cat.id} value={cat.id}>
                {cat.label}
              </option>
            ))}
          </select>
          {selectedCategoryFilter && (() => {
            const categoryFields = getFieldsForCategory(selectedCategoryFilter);
            const defaultFields = categoryFields.filter(f => f.isDefault);
            const listingFields = categoryFields.filter(f => !f.isDefault);
            const selectedCategoryName = flattenedCategories.find(c => c.id === selectedCategoryFilter)?.label;
            
            return (
              <div className="mt-4 space-y-4">
                <div className="text-sm text-blue-800">
                  <strong>Fields for category:</strong> {selectedCategoryName}
                  <span className="ml-2 text-blue-600">
                    ({categoryFields.length} field{categoryFields.length !== 1 ? 's' : ''} total)
                  </span>
                </div>
                
                {/* Default Fields */}
                {defaultFields.length > 0 && (
                  <div className="bg-white border border-blue-200 rounded-lg p-4">
                    <h4 className="font-semibold text-gray-900 mb-2">Default Fields ({defaultFields.length})</h4>
                    <p className="text-xs text-gray-600 mb-3">These fields apply to all categories</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                      {defaultFields.map(field => (
                        <div key={field.id} className="flex items-start space-x-2 p-2 bg-gray-50 rounded border border-gray-200">
                          <div className="flex-1">
                            <div className="font-medium text-sm text-gray-900">{field.label}</div>
                            <div className="text-xs text-gray-600">{field.type}</div>
                            {field.required && (
                              <span className="inline-block mt-1 px-1.5 py-0.5 bg-red-100 text-red-800 text-xs rounded">Required</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Category-Specific Listing Fields */}
                {listingFields.length > 0 && (
                  <div className="bg-white border border-blue-200 rounded-lg p-4">
                    <h4 className="font-semibold text-gray-900 mb-2">Category-Specific Fields ({listingFields.length})</h4>
                    <p className="text-xs text-gray-600 mb-3">These fields are specific to this category</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                      {listingFields.map(field => {
                        const applicableCategoryIds = field.categoryIds || [];
                        const applicableCategories = applicableCategoryIds.length > 0
                          ? flattenedCategories.filter(cat => applicableCategoryIds.includes(cat.id))
                          : [];
                        
                        return (
                          <div key={field.id} className="flex items-start space-x-2 p-2 bg-blue-50 rounded border border-blue-200">
                            <div className="flex-1">
                              <div className="font-medium text-sm text-gray-900">{field.label}</div>
                              <div className="text-xs text-gray-600">{field.type}</div>
                              {field.required && (
                                <span className="inline-block mt-1 px-1.5 py-0.5 bg-red-100 text-red-800 text-xs rounded">Required</span>
                              )}
                              {field.options && Array.isArray(field.options) && field.options.length > 0 && (
                                <div className="mt-2 bg-blue-50 border border-blue-200 rounded p-2">
                                  <div className="font-medium text-blue-900 text-xs mb-1">📋 Allowed Values ({field.options.length}):</div>
                                  <div className="flex flex-wrap gap-1">
                                    {field.options.map((option, idx) => (
                                      <span key={idx} className="px-1.5 py-0.5 bg-white border border-blue-300 rounded text-blue-800 font-mono text-xs">
                                        "{typeof option === 'string' ? option : String(option)}"
                                      </span>
                                    ))}
                                  </div>
                                  <div className="text-blue-700 mt-1 text-xs italic">
                                    💡 CSV values must match exactly (case-sensitive)
                                  </div>
                                </div>
                              )}
                              {applicableCategories.length > 0 && applicableCategories.length <= 3 && (
                                <div className="mt-1 text-xs text-blue-600">
                                  Also applies to: {applicableCategories.map(c => c.label.split(' > ').pop()).join(', ')}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                
                {categoryFields.length === 0 && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
                    No specific fields found for this category. Only default fields apply.
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Listing Types and Categories Info */}
      {(listingTypes.length > 0 || categories.length > 0) && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <h3 className="font-semibold text-gray-900 mb-3">ShareTribe Configuration</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {listingTypes.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">Listing Types ({listingTypes.length})</h4>
                <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                  {listingTypes.map((type, idx) => {
                    const typeId = type.id || type.key || idx;
                    const typeName = type.name || type.label || type.title || `Type ${idx + 1}`;
                    return (
                      <span key={idx} className="px-2 py-1 bg-white border border-gray-300 rounded text-xs" title={typeId}>
                        {typeName}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            {categories.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">
                  Categories ({(() => {
                    // Count all categories including nested subcategories
                    const countAll = (cats) => {
                      let count = cats.length;
                      cats.forEach(cat => {
                        if (cat.subcategories && cat.subcategories.length > 0) {
                          count += countAll(cat.subcategories);
                        }
                      });
                      return count;
                    };
                    return countAll(categories);
                  })()})
                </h4>
                <div className="max-h-64 overflow-y-auto border border-gray-200 rounded p-2 bg-white">
                  {categories.map((cat, idx) => {
                    const renderCategory = (category, level = 0) => {
                      const catId = category.id || category.key || idx;
                      const catName = category.name || category.label || category.title || `Category ${idx + 1}`;
                      const hasSubcategories = category.subcategories && category.subcategories.length > 0;
                      
                      return (
                        <div key={catId} className="mb-1">
                          <div 
                            className={`px-2 py-1 rounded text-xs inline-block ${
                              level === 0 ? 'font-semibold bg-blue-50 border border-blue-200' : 
                              level === 1 ? 'bg-gray-50 border border-gray-200 ml-4' : 
                              'bg-white border border-gray-100 ml-8'
                            }`}
                            title={catId}
                            style={{ marginLeft: `${level * 16}px` }}
                          >
                            {level > 0 && '└─ '}
                            {catName}
                            {hasSubcategories && <span className="text-gray-500 ml-1">({category.subcategories.length})</span>}
                          </div>
                          {hasSubcategories && (
                            <div className="mt-1">
                              {category.subcategories.map(subcat => renderCategory(subcat, level + 1))}
                            </div>
                          )}
                        </div>
                      );
                    };
                    
                    return renderCategory(cat);
                  })}
                </div>
              </div>
            )}
          </div>
          {/* Show required fields summary */}
          {shareTribeFields.filter(f => f.required).length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-300">
              <h4 className="text-sm font-medium text-gray-700 mb-2">
                Required Fields ({shareTribeFields.filter(f => f.required).length})
              </h4>
              <div className="flex flex-wrap gap-2">
                {shareTribeFields.filter(f => f.required).map(field => (
                  <span key={field.id} className="px-2 py-1 bg-red-100 border border-red-300 rounded text-xs text-red-800">
                    {field.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSave} className="bg-white rounded-lg shadow p-6">
        <div className="space-y-4">
          {/* Header */}
          <div className="grid grid-cols-12 gap-4 pb-4 border-b border-gray-200 font-semibold text-sm text-gray-700">
            <div className="col-span-5">eBay Field</div>
            <div className="col-span-1"></div>
            <div className="col-span-5">ShareTribe Field</div>
            <div className="col-span-1">Actions</div>
          </div>

          {/* Mappings */}
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading mappings...</div>
          ) : mappings.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No field mappings configured. Click "Add Mapping" to create one.
            </div>
          ) : (
            mappings.map((mapping, index) => (
              <div key={index} className="grid grid-cols-12 gap-4 items-center">
                <div className="col-span-5">
                  <select
                    value={mapping.ebay_field}
                    onChange={(e) => handleUpdateMapping(index, 'ebay_field', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">Select eBay field...</option>
                    {getAvailableEbayFields(index).map(field => (
                      <option key={field.id} value={field.id}>
                        {field.label} ({field.type})
                      </option>
                    ))}
                    {/* Show currently selected field even if it's "used" */}
                    {mapping.ebay_field && !getAvailableEbayFields(index).find(f => f.id === mapping.ebay_field) && (
                      <option value={mapping.ebay_field}>
                        {DEFAULT_EBAY_FIELDS.find(f => f.id === mapping.ebay_field)?.label || mapping.ebay_field}
                      </option>
                    )}
                  </select>
                </div>
                <div className="col-span-1 flex justify-center">
                  <ArrowRight className="text-gray-400" size={20} />
                </div>
                <div className="col-span-5">
                  <select
                    value={mapping.sharetribe_field}
                    onChange={(e) => handleUpdateMapping(index, 'sharetribe_field', e.target.value)}
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                      shareTribeFields.find(f => f.id === mapping.sharetribe_field)?.required 
                        ? 'border-red-300 bg-red-50' 
                        : 'border-gray-300'
                    }`}
                  >
                    <option value="">Select ShareTribe field...</option>
                    {/* Group required fields first */}
                    {getAvailableShareTribeFields(index)
                      .filter(f => f.required)
                      .map(field => {
                        // Show allowed values if available
                        const optionsInfo = field.options && Array.isArray(field.options) && field.options.length > 0
                          ? ` - Values: ${field.options.slice(0, 5).join(', ')}${field.options.length > 5 ? ` (+${field.options.length - 5} more)` : ''}`
                          : '';
                        return (
                          <option key={field.id} value={field.id}>
                            ⚠️ {field.label} ({field.type}) - Required{optionsInfo}
                          </option>
                        );
                      })}
                    {/* Then optional fields */}
                    {getAvailableShareTribeFields(index)
                      .filter(f => !f.required)
                      .map(field => {
                        const listingTypeInfo = field.listingTypeIds && field.listingTypeIds.length > 0
                          ? ` [${field.listingTypeIds.length} listing type${field.listingTypeIds.length > 1 ? 's' : ''}]`
                          : '';
                        
                        // Show category info - which categories this field applies to
                        const applicableCategoryIds = field.categoryIds || [];
                        const applicableCategories = applicableCategoryIds.length > 0
                          ? flattenedCategories.filter(cat => applicableCategoryIds.includes(cat.id))
                          : [];
                        const categoryInfo = applicableCategories.length > 0
                          ? ` [${applicableCategories.length} categor${applicableCategories.length > 1 ? 'ies' : 'y'}: ${applicableCategories.slice(0, 2).map(c => c.label.split(' > ').pop()).join(', ')}${applicableCategories.length > 2 ? '...' : ''}]`
                          : field.isDefault ? ' [All categories]' : '';
                        
                        // Show allowed values if available
                        const optionsInfo = field.options && Array.isArray(field.options) && field.options.length > 0
                          ? ` - Values: ${field.options.slice(0, 5).join(', ')}${field.options.length > 5 ? ` (+${field.options.length - 5} more)` : ''}`
                          : '';
                        
                        return (
                          <option key={field.id} value={field.id}>
                            {field.label} ({field.type}){listingTypeInfo}{categoryInfo}{optionsInfo}
                          </option>
                        );
                      })}
                    {/* Show currently selected field even if it's "used" */}
                    {mapping.sharetribe_field && !getAvailableShareTribeFields(index).find(f => f.id === mapping.sharetribe_field) && (
                      <option value={mapping.sharetribe_field}>
                        {shareTribeFields.find(f => f.id === mapping.sharetribe_field)?.required ? '⚠️ ' : ''}
                        {shareTribeFields.find(f => f.id === mapping.sharetribe_field)?.label || mapping.sharetribe_field}
                        {shareTribeFields.find(f => f.id === mapping.sharetribe_field)?.required ? ' (required)' : ''}
                      </option>
                    )}
                  </select>
                  {/* Show field details if selected */}
                  {mapping.sharetribe_field && shareTribeFields.find(f => f.id === mapping.sharetribe_field) && (() => {
                    const selectedField = shareTribeFields.find(f => f.id === mapping.sharetribe_field);
                    const applicableListingTypes = selectedField.listingTypeIds && selectedField.listingTypeIds.length > 0
                      ? listingTypes.filter(lt => selectedField.listingTypeIds.includes(lt.id || lt.key))
                      : [];
                    // Get applicable categories (flattened for display)
                    const applicableCategoryIds = selectedField.categoryIds || [];
                    const applicableCategories = applicableCategoryIds.length > 0
                      ? flattenedCategories.filter(cat => applicableCategoryIds.includes(cat.id))
                      : [];
                    
                    const hasOptions = selectedField.options && Array.isArray(selectedField.options) && selectedField.options.length > 0;
                    
                    if (selectedField.required || applicableListingTypes.length > 0 || applicableCategories.length > 0 || hasOptions) {
                      return (
                        <div className="mt-1 text-xs text-gray-600 space-y-1">
                          {selectedField.required && (
                            <div className="text-red-600 font-medium">⚠️ Required field</div>
                          )}
                          {hasOptions && (
                            <div className="bg-blue-50 border border-blue-200 rounded p-2 mt-1">
                              <div className="font-medium text-blue-900 mb-1">📋 Allowed Values ({selectedField.options.length}):</div>
                              <div className="flex flex-wrap gap-1">
                                {selectedField.options.map((option, idx) => (
                                  <span key={idx} className="px-2 py-0.5 bg-white border border-blue-300 rounded text-blue-800 font-mono text-xs">
                                    "{option}"
                                  </span>
                                ))}
                              </div>
                              <div className="text-blue-700 mt-1 italic">
                                💡 CSV values must match exactly (case-sensitive)
                              </div>
                            </div>
                          )}
                          {applicableListingTypes.length > 0 && (
                            <div>
                              <span className="font-medium">Listing Types:</span> {applicableListingTypes.map(lt => lt.name || lt.label || lt.id).join(', ')}
                            </div>
                          )}
                          {applicableCategories.length > 0 && (
                            <div>
                              <span className="font-medium">Categories:</span> {applicableCategories.map(cat => cat.label).join(', ')}
                            </div>
                          )}
                          {applicableCategories.length === 0 && !selectedField.isDefault && (
                            <div className="text-gray-500 italic">Applies to all categories</div>
                          )}
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
                <div className="col-span-1">
                  <button
                    type="button"
                    onClick={() => handleRemoveMapping(index)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-6 pt-6 border-t border-gray-200 flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center space-x-2 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            <Save size={18} />
            <span>{saving ? 'Saving...' : 'Save Mappings'}</span>
          </button>
        </div>
      </form>

      {/* Help Text */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-2">How Field Mapping Works</h3>
        <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
          <li>Map eBay product fields to corresponding ShareTribe listing fields</li>
          <li>Each eBay field can be mapped to one ShareTribe field</li>
          <li>Products will be synced using these mappings when you run a sync</li>
          <li>You can add custom transformations if needed (future feature)</li>
        </ul>
      </div>
    </div>
  );
};

export default FieldMappingTab;

