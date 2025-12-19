import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowRight, X, Check, AlertCircle, ChevronRight, ChevronLeft, CheckCircle, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { getShareTribeMetadata } from '../services/api';

const CSVColumnMapping = ({ csvColumns, sampleRows, fileId, csvPreview, onCancel, onConfirm, isEbayProducts = false }) => {
  // Log props for debugging
  console.log('CSVColumnMapping: Received props:', {
    csvColumns: csvColumns?.length,
    sampleRows: sampleRows?.length,
    fileId,
    csvPreview: !!csvPreview,
    csvPreviewColumns: csvPreview?.columns?.length,
    csvPreviewSampleRows: csvPreview?.sampleRows?.length,
    isEbayProducts
  });
  
  // Early validation - ensure we have required props
  const safeCsvColumns = csvColumns || csvPreview?.columns || [];
  const safeSampleRows = sampleRows || csvPreview?.sampleRows || [];
  
  console.log('CSVColumnMapping: Safe props:', {
    safeCsvColumns: safeCsvColumns?.length,
    safeSampleRows: safeSampleRows?.length,
    isArray: Array.isArray(safeCsvColumns)
  });
  
  if (!Array.isArray(safeCsvColumns) || safeCsvColumns.length === 0) {
    console.error('CSVColumnMapping: Missing or invalid csvColumns', { 
      csvColumns, 
      csvPreview,
      safeCsvColumns,
      safeSampleRows
    });
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Error</h2>
          <p className="text-gray-600 mb-2">Missing CSV columns data. Please try refreshing from eBay again.</p>
          <details className="mb-4">
            <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700 mb-2">Debug Info</summary>
            <pre className="bg-gray-100 p-3 rounded text-xs overflow-x-auto mt-2">
              {JSON.stringify({ csvColumns, csvPreview, safeCsvColumns, safeSampleRows }, null, 2)}
            </pre>
          </details>
          <button
            onClick={onCancel}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  const [step, setStep] = useState(1); // 1: Default fields, 2: Category mapping, 3: Value validation, 4: Category fields, 5: Final validation & unmapped fields
  const [defaultMappings, setDefaultMappings] = useState({}); // Maps CSV columns to default fields (title, description, etc.)
  const [categoryColumn, setCategoryColumn] = useState(null); // Which CSV column contains category IDs
  const [categoryFieldMappings, setCategoryFieldMappings] = useState({}); // Maps category ID -> { field mappings } (used for Step 4, kept for backward compatibility)
  const [categoryShareTribeMappings, setCategoryShareTribeMappings] = useState({}); // Maps CSV category ID -> ShareTribe category
  const [categoryListingTypeMappings, setCategoryListingTypeMappings] = useState({}); // Maps CSV category ID -> ShareTribe listing type ID
  const [valueMappings, setValueMappings] = useState({}); // Maps: "categoryId:fieldId:csvValue" -> "shareTribeValue"
  const [unmappedFieldValues, setUnmappedFieldValues] = useState({}); // Maps: "categoryId:fieldId" -> "defaultValue" (kept for backward compatibility)
  // Product-level mappings (for Step 5)
  const [productFieldMappings, setProductFieldMappings] = useState({}); // Maps: "productId:csvColumn" -> "shareTribeFieldId"
  const [productUnmappedFieldValues, setProductUnmappedFieldValues] = useState({}); // Maps: "productId:fieldId" -> "defaultValue"
  const [expandedCategories, setExpandedCategories] = useState({}); // Track which category groups are expanded
  const [errors, setErrors] = useState({});
  const [availableFields, setAvailableFields] = useState([]);
  const [availableCategories, setAvailableCategories] = useState([]);
  const [availableListingTypes, setAvailableListingTypes] = useState([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [categorySearchOpen, setCategorySearchOpen] = useState({}); // Track which category dropdown is open
  const [categorySearchTerm, setCategorySearchTerm] = useState({}); // Track search terms for each category
  const categoryDropdownRefs = useRef({});

  // Default fields that apply to all categories
  // Based on ShareTribe API: title, description, price (object with currency/amount), images, geolocation
  // Note: authorId and state are set automatically by the system and should NOT be shown in mapping
  // Default fields that apply to all categories - this is now used for validation only
  // The actual fields shown come from availableFields (from ShareTribe API)
  // Note: ebay_item_id is automatically extracted from CSV and stored in privateData, no mapping needed
  // Note: authorId is set automatically when selecting ShareTribe user in Products tab
  // Note: Only price.amount is collected (currency is set automatically)
  const DEFAULT_FIELDS = ['title', 'description', 'images', 'price.amount', 'geolocation'];

  // Flatten categories recursively for mapping, preserving parent info
  const flattenCategories = useCallback((categories, result = [], prefix = '', parentPath = [], parentIds = [], seenIds = new Set()) => {
    if (!categories || !Array.isArray(categories)) {
      return result;
    }
    
    categories.forEach(cat => {
      if (!cat) return;
      
      const catId = cat.id || cat.key;
      const catName = cat.name || cat.label || catId;
      const currentPath = [...parentPath, catName];
      const currentIds = [...parentIds, catId];
      
      // Create unique ID to avoid duplicates
      const uniqueId = `category_${catId}_${seenIds.size}`;
      const categoryKey = `category_${catId}`;
      
      // Only add if we haven't seen this exact category ID at this level before
      if (!seenIds.has(categoryKey)) {
        seenIds.add(categoryKey);
        
        result.push({
          id: uniqueId, // Use unique ID for React key
          key: categoryKey, // Use category ID for value matching
          label: `${prefix}${catName}`,
          type: 'category',
          required: false,
          categoryId: catId,
          categoryPath: currentPath.join(' > '),
          parentIds: parentIds.length > 0 ? parentIds : null,
          fullCategoryPath: currentIds
        });
      }
      
      if (cat.subcategories && Array.isArray(cat.subcategories) && cat.subcategories.length > 0) {
        flattenCategories(cat.subcategories, result, `${prefix}${catName} > `, currentPath, currentIds, seenIds);
      }
    });
    return result;
  }, []);

  // Get unique category IDs from CSV (memoized to avoid recalculation)
  // Use uniqueCategories from preview if available (scans all rows), otherwise fall back to sampleRows
  const uniqueCategories = useMemo(() => {
    if (!categoryColumn) return [];
    
    // If we have uniqueCategories data from the preview (which scans all rows), use that
    if (csvPreview?.uniqueCategories?.[categoryColumn]) {
      return csvPreview.uniqueCategories[categoryColumn];
    }
    
    // Otherwise, extract from sampleRows (limited to what's in the preview)
    if (!safeSampleRows || !Array.isArray(safeSampleRows) || safeSampleRows.length === 0) return [];
    
    const categories = new Set();
    safeSampleRows.forEach(row => {
      if (row && row[categoryColumn]) {
        const categoryValue = row[categoryColumn];
        if (categoryValue && categoryValue.toString().trim() !== '') {
          categories.add(categoryValue.toString().trim());
        }
      }
    });
    
    return Array.from(categories).sort();
  }, [categoryColumn, safeSampleRows, csvPreview]);

  // Get unique category IDs from CSV (wrapper function)
  const getUniqueCSVCategories = useCallback(() => {
    return uniqueCategories;
  }, [uniqueCategories]);

  // Get sample product titles for a category
  const getSampleTitlesForCategory = useCallback((csvCategoryId) => {
    if (!categoryColumn || !safeSampleRows || !Array.isArray(safeSampleRows)) return [];
    
    const titleColumn = Object.keys(defaultMappings).find(col => defaultMappings[col] === 'title');
    if (!titleColumn) return [];
    
    return safeSampleRows
      .filter(row => row && row[categoryColumn] === csvCategoryId)
      .slice(0, 3)
      .map(row => row[titleColumn])
      .filter(Boolean);
  }, [categoryColumn, defaultMappings, safeSampleRows]);

  useEffect(() => {
    // Load ShareTribe metadata
    const loadFields = async () => {
      try {
        console.log('CSVColumnMapping: Loading ShareTribe metadata...', {
          safeCsvColumns: safeCsvColumns?.length,
          safeSampleRows: safeSampleRows?.length,
          csvPreview: !!csvPreview
        });
        
        if (!safeCsvColumns || safeCsvColumns.length === 0) {
          console.warn('CSVColumnMapping: No CSV columns available, skipping field loading');
          setLoadingFields(false);
          return;
        }
        
        const response = await getShareTribeMetadata();
        console.log('CSVColumnMapping: ShareTribe metadata loaded:', response?.data);
        const { defaultFields = [], listingFields = [], categories = [], listingTypes = [] } = response.data || {};
        
        const fields = [];
        
        // Note: ebay_item_id is automatically extracted from CSV and stored in privateData
        // No need to show it in the mapping UI
        
        // Default fields - include ShareTribe default fields, but exclude:
        // - authorId (set automatically when selecting ShareTribe user)
        // - state (set automatically)
        // - price (only collect price.amount, not the full price object)
        // - price.currency (only collect price.amount, currency is set automatically)
        const excludedFieldIds = ['authorId', 'state', 'price', 'price.currency'];
        defaultFields.forEach(field => {
          if (!excludedFieldIds.includes(field.id)) {
            fields.push({ ...field, group: 'default' });
          }
        });
        
        // Listing fields - ensure categoryIds are included
        listingFields.forEach(field => {
          const categoryIds = field.categoryIds || field.categories || field.applicableCategories || [];
          fields.push({ 
            ...field, 
            group: 'listing',
            categoryIds: Array.isArray(categoryIds) ? categoryIds : []
          });
        });
        
        // Categories
        if (categories && categories.length > 0) {
          try {
            const flattenedCategories = flattenCategories(categories);
            setAvailableCategories(flattenedCategories);
          } catch (catError) {
            console.error('Error flattening categories:', catError);
            setAvailableCategories([]);
          }
        } else {
          setAvailableCategories([]);
        }
        
        // Listing Types
        if (listingTypes && listingTypes.length > 0) {
          setAvailableListingTypes(listingTypes);
        } else {
          // Default listing type if none available
          setAvailableListingTypes([{ id: 'list-new-item', name: 'List New Item', label: 'List New Item' }]);
        }
        
        setAvailableFields(fields);
        setLoadingFields(false);
        
        // Auto-map default fields if CSV column names match exactly (case-insensitive)
        // Only set mappings if they haven't been set yet (to avoid overwriting user changes)
        setDefaultMappings(prevMappings => {
          if (Object.keys(prevMappings).length > 0) {
            return prevMappings; // Don't overwrite existing mappings
          }
          
    const autoMappings = {};
          if (safeCsvColumns && safeCsvColumns.length > 0) {
            safeCsvColumns.forEach(csvCol => {
              const normalizedCsvCol = csvCol.toLowerCase().trim();
              
              DEFAULT_FIELDS.forEach(fieldId => {
                if (normalizedCsvCol === fieldId.toLowerCase()) {
                  autoMappings[csvCol] = fieldId;
                }
              });
              
              // Also try matching against field labels
              fields.forEach(field => {
                if (normalizedCsvCol === field.label.toLowerCase().trim() && DEFAULT_FIELDS.includes(field.id)) {
                  autoMappings[csvCol] = field.id;
                }
              });
            });
          }
          
          return autoMappings;
        });
      } catch (error) {
        console.error('Error loading ShareTribe fields:', error);
        const fallbackFields = [
          // Note: ebay_item_id is automatically extracted from CSV and stored in privateData
          // Note: authorId is set automatically when selecting ShareTribe user in Products tab
          // Note: state is set automatically
          // Note: Only price.amount is collected (currency is set automatically)
          { id: 'title', label: 'Title', required: true, type: 'string', description: 'Listing title (1-1000 characters)', group: 'default' },
          { id: 'description', label: 'Description', required: false, type: 'string', description: 'Listing description (1-5000 characters)', group: 'default' },
          { id: 'geolocation', label: 'Geolocation', required: false, type: 'object', description: 'Latitude (lat) and longitude (lng)', group: 'default' },
          { id: 'price.amount', label: 'Price Amount', required: false, type: 'integer', description: 'Amount in minor unit (e.g., cents for USD)', group: 'default' },
          { id: 'availabilityPlan', label: 'Availability Plan', required: false, type: 'object', description: 'Listing availability plan', group: 'default' },
          { id: 'publicData', label: 'Public Data', required: false, type: 'object', description: 'Public data object (max 50KB)', group: 'default' },
          { id: 'privateData', label: 'Private Data', required: false, type: 'object', description: 'Private data object (max 50KB)', group: 'default' },
          { id: 'metadata', label: 'Metadata', required: false, type: 'object', description: 'Public metadata object (max 50KB)', group: 'default' },
          { id: 'images', label: 'Images', required: false, type: 'array', description: 'Array of image IDs', group: 'default' }
        ];
        setAvailableFields(fallbackFields);
        setLoadingFields(false);
      }
    };
    
    loadFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      Object.keys(categoryDropdownRefs.current).forEach(categoryId => {
        const ref = categoryDropdownRefs.current[categoryId];
        if (ref && !ref.contains(event.target)) {
          setCategorySearchOpen(prev => ({
            ...prev,
            [categoryId]: false
          }));
        }
      });
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Reset component state when a new CSV file is loaded (fileId changes)
  useEffect(() => {
    if (fileId) {
      // Reset all mapping state when new CSV is loaded
      setStep(1);
      setDefaultMappings({});
      setCategoryColumn(null);
      setCategoryFieldMappings({});
      setCategoryShareTribeMappings({});
      setCategoryListingTypeMappings({});
      setErrors({});
      setCategorySearchOpen({});
      setCategorySearchTerm({});
      setUnmappedFieldValues({});
      setProductFieldMappings({});
      setProductUnmappedFieldValues({});
      setExpandedCategories({});
      console.log('Reset CSV mapping state for new file:', fileId);
    }
  }, [fileId]);

  const handleDefaultMappingChange = (csvColumn, targetField) => {
    const newMappings = { ...defaultMappings };
    
    // Remove previous mapping for this target field if it exists
    Object.keys(newMappings).forEach(key => {
      if (newMappings[key] === targetField && key !== csvColumn) {
        delete newMappings[key];
      }
    });
    
    if (targetField && targetField !== '') {
      newMappings[csvColumn] = targetField;
    } else {
      delete newMappings[csvColumn];
    }
    
    setDefaultMappings(newMappings);
    validateStep1(newMappings);
  };

  const handleCategoryColumnChange = (csvColumn) => {
    setCategoryColumn(csvColumn);
    // Initialize field mappings for existing categories
    const uniqueCategories = new Set();
    safeSampleRows.forEach(row => {
      const categoryValue = row[csvColumn];
      if (categoryValue && categoryValue.toString().trim() !== '') {
        uniqueCategories.add(categoryValue.toString().trim());
      }
    });
    
    const newCategoryFieldMappings = {};
    uniqueCategories.forEach(catId => {
      if (!categoryFieldMappings[catId]) {
        newCategoryFieldMappings[catId] = {};
      } else {
        newCategoryFieldMappings[catId] = categoryFieldMappings[catId];
      }
    });
    setCategoryFieldMappings(newCategoryFieldMappings);
  };

  const handleCategoryShareTribeMapping = (csvCategoryId, shareTribeCategoryId) => {
    const newMappings = { ...categoryShareTribeMappings };
    if (shareTribeCategoryId) {
      // Find category by key or id (key is the category_ prefix version, id is unique)
      const category = availableCategories.find(c => (c.key || c.id) === shareTribeCategoryId);
      if (category) {
        newMappings[csvCategoryId] = {
          categoryId: category.categoryId,
          categoryPath: category.categoryPath,
          fullCategoryPath: category.fullCategoryPath || [category.categoryId],
          parentIds: category.parentIds
        };
      }
    } else {
      delete newMappings[csvCategoryId];
    }
    setCategoryShareTribeMappings(newMappings);
  };

  const handleCategoryFieldMapping = (csvCategoryId, csvColumn, targetField) => {
    const newMappings = { ...categoryFieldMappings };
    if (!newMappings[csvCategoryId]) {
      newMappings[csvCategoryId] = {};
    }
    
    // Remove previous mapping for this target field if it exists
    Object.keys(newMappings[csvCategoryId]).forEach(key => {
      if (newMappings[csvCategoryId][key] === targetField && key !== csvColumn) {
        delete newMappings[csvCategoryId][key];
      }
    });
    
    if (targetField) {
      newMappings[csvCategoryId][csvColumn] = targetField;
    } else {
      delete newMappings[csvCategoryId][csvColumn];
    }
    
    setCategoryFieldMappings(newMappings);
  };

  // Get product ID from a row (for product-level mappings)
  const getProductId = useCallback((row) => {
    // For eBay products, use ebay_item_id
    if (isEbayProducts && row.ebay_item_id) {
      return row.ebay_item_id;
    }
    // For CSV, try to find a unique identifier
    // Check common ID fields
    const idFields = ['id', 'item_id', 'product_id', 'sku', 'ebay_item_id'];
    for (const field of idFields) {
      if (row[field]) {
        return String(row[field]);
      }
    }
    // Fallback: use a combination of title and first available column
    const title = row.title || row.Title || '';
    const firstCol = safeCsvColumns.find(col => row[col]);
    return `${title}_${firstCol || 'unknown'}`;
  }, [isEbayProducts, safeCsvColumns]);

  // Handle product-level field mapping
  const handleProductFieldMapping = (productId, csvColumn, targetField) => {
    const newMappings = { ...productFieldMappings };
    const mappingKey = `${productId}:${csvColumn}`;
    
    if (targetField) {
      newMappings[mappingKey] = targetField;
    } else {
      delete newMappings[mappingKey];
    }
    
    setProductFieldMappings(newMappings);
  };

  // Handle product-level unmapped field value
  const handleProductUnmappedFieldValue = (productId, fieldId, defaultValue) => {
    const newValues = { ...productUnmappedFieldValues };
    const valueKey = `${productId}:${fieldId}`;
    
    if (defaultValue && String(defaultValue).trim() !== '') {
      newValues[valueKey] = defaultValue;
    } else {
      delete newValues[valueKey];
    }
    
    setProductUnmappedFieldValues(newValues);
  };

  // Toggle category expansion
  const toggleCategoryExpansion = (csvCategoryId) => {
    setExpandedCategories(prev => ({
      ...prev,
      [csvCategoryId]: !prev[csvCategoryId]
    }));
  };

  // Validation function that doesn't set state (for use during render)
  // Note: ebay_item_id is automatically extracted from CSV, no validation needed
  const isValidStep1 = React.useMemo(() => {
    return !!categoryColumn;
  }, [categoryColumn]);

  // Validation function that sets errors (for use in handlers)
  // Note: ebay_item_id is automatically extracted from CSV, no validation needed
  const validateStep1 = (mappingsToValidate) => {
    const newErrors = {};
    // No required field validations needed - ebay_item_id is handled automatically
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const canProceedToStep2 = React.useMemo(() => {
    return isValidStep1;
  }, [isValidStep1]);

  // Group fields by type - must be defined before getFieldsForCategory
  const groupedFields = useMemo(() => {
    if (!availableFields || !Array.isArray(availableFields)) {
      return {
        required: [],
        default: [],
        listing: []
      };
    }
    return {
      required: availableFields.filter(f => f.group === 'required'),
      default: availableFields.filter(f => f.group === 'default'),
      listing: availableFields.filter(f => f.group === 'listing')
    };
  }, [availableFields]);

  // Get all parent category IDs for a given category (including the category itself)
  const getCategoryHierarchy = useCallback((categoryId) => {
    if (!categoryId) return [];
    
    // Find the category in the flattened list
    const category = availableCategories.find(cat => cat.categoryId === categoryId || cat.id === categoryId);
    if (!category) return [categoryId]; // If not found, just return the ID itself
    
    // Get the full path (which includes parent IDs)
    const fullPath = category.fullCategoryPath || category.parentIds || [categoryId];
    
    // Return all IDs in the hierarchy (parent to child) + the category itself
    const hierarchy = Array.isArray(fullPath) ? [...fullPath, categoryId] : [categoryId];
    // Remove duplicates
    return [...new Set(hierarchy)];
  }, [availableCategories]);

  // Filter fields by category (including parent categories)
  // NOTE: This must be defined BEFORE hasUnmappedRequiredFields since it's used in its dependency array
  const getFieldsForCategory = useCallback((categoryId) => {
    if (!groupedFields || !groupedFields.listing || !Array.isArray(groupedFields.listing)) {
      return []; // Return empty array if fields not loaded yet
    }
    
    if (!categoryId) return groupedFields.listing; // Show all listing fields if no category
    
    try {
      // Get all category IDs in the hierarchy (parent categories + selected category)
      const categoryHierarchy = getCategoryHierarchy(categoryId);
      
      return groupedFields.listing.filter(field => {
        // Show fields with no category restrictions
        if (!field.categoryIds || field.categoryIds.length === 0) return true;
        
        // Show fields that include this category OR any of its parent categories in their categoryIds
        return categoryHierarchy.some(catId => field.categoryIds.includes(catId));
      });
    } catch (error) {
      console.error(`Error filtering fields for category ${categoryId}:`, error);
      return groupedFields.listing; // Return all fields as fallback
    }
  }, [groupedFields, getCategoryHierarchy]);

  // Check if there are unmapped required ShareTribe fields (for Step 5)
  // This checks product-level mappings to see if any product has unmapped required fields
  const hasUnmappedRequiredFields = useMemo(() => {
    if (step !== 5) return false;
    if (!categoryColumn) return false; // Can't check if no category column selected
    if (!groupedFields || !groupedFields.listing) return false; // Fields not loaded yet
    if (!safeSampleRows || !Array.isArray(safeSampleRows) || safeSampleRows.length === 0) return false;
    
    try {
      // Check each product individually
      for (const row of safeSampleRows) {
        if (!row || !row[categoryColumn]) continue;
        
        const csvCategoryId = String(row[categoryColumn]).trim();
        if (!csvCategoryId) continue;
        
        const categoryMapping = categoryShareTribeMappings[csvCategoryId];
        const shareTribeCategoryId = categoryMapping?.categoryId;
        
        if (!shareTribeCategoryId) continue;
        
        const productId = getProductId(row);
        
        // Get applicable fields for this category
        let applicableFields = [];
        try {
          applicableFields = getFieldsForCategory(shareTribeCategoryId);
        } catch (error) {
          console.error(`Error getting fields for category ${shareTribeCategoryId}:`, error);
          continue;
        }
        
        if (!applicableFields || !Array.isArray(applicableFields)) continue;
        
        // Get all mapped field IDs for this product (default + category + product-level)
        const mappedFieldIds = new Set([
          ...Object.values(defaultMappings),
          ...Object.values(categoryFieldMappings[csvCategoryId] || {}),
          ...Object.keys(productFieldMappings)
            .filter(key => key.startsWith(`${productId}:`))
            .map(key => productFieldMappings[key])
        ]);
        
        // Find unmapped required ShareTribe fields for this product
        const unmappedRequired = applicableFields.filter(field => {
          if (mappedFieldIds.has(field.id)) return false;
          if (field.group === 'default') return false;
          return field.required === true;
        });
        
        // Check if required fields have values set (product-level)
        for (const field of unmappedRequired) {
          const valueKey = `${productId}:${field.id}`;
          const defaultValue = productUnmappedFieldValues[valueKey];
          // If no default value is set (or it's empty), it's still unmapped
          if (!defaultValue || String(defaultValue).trim() === '') {
            return true; // Found a product with unmapped required field
          }
        }
      }
      
      return false; // All products have required fields mapped and valid enum values
    } catch (error) {
      console.error('Error checking unmapped required fields:', error);
      return false; // Don't block import if there's an error checking
    }
  }, [step, categoryColumn, categoryShareTribeMappings, categoryFieldMappings, defaultMappings, productUnmappedFieldValues, valueMappings, getFieldsForCategory, safeSampleRows, getProductId, groupedFields, availableFields]);

  const canProceedToStep3 = useMemo(() => {
    return uniqueCategories.length > 0 && uniqueCategories.every(catId => categoryShareTribeMappings[catId]);
  }, [uniqueCategories, categoryShareTribeMappings]);

  const handleNext = () => {
    if (step === 1 && canProceedToStep2) {
      setStep(2);
    } else if (step === 2 && canProceedToStep3) {
      setStep(3);
    } else if (step === 3) {
      setStep(4);
    } else if (step === 4) {
      setStep(5);
    }
  };

  const handleBack = () => {
    if (step > 1) {
      setStep(step - 1);
    }
  };

  const handleConfirm = () => {
    if (!validateStep1(defaultMappings)) {
      return;
    }

    // Check for unmapped required ShareTribe fields (only on Step 5)
    if (step === 5) {
      const unmappedRequiredFields = [];
      
      getUniqueCSVCategories().forEach(csvCategoryId => {
        const categoryMapping = categoryShareTribeMappings[csvCategoryId];
        const shareTribeCategoryId = categoryMapping?.categoryId;
        const categoryFieldMapping = categoryFieldMappings[csvCategoryId] || {};
        
        if (!shareTribeCategoryId) return;
        
        // Get applicable fields for this category
        const applicableFields = getFieldsForCategory(shareTribeCategoryId);
        
        // Find unmapped required ShareTribe fields
        const mappedFieldIds = new Set([
          ...Object.values(defaultMappings),
          ...Object.values(categoryFieldMapping)
        ]);
        
        const unmappedRequired = applicableFields.filter(field => {
          // Skip if already mapped
          if (mappedFieldIds.has(field.id)) return false;
          // Skip if it's a default field (already handled in Step 1)
          if (field.group === 'default') return false;
          // Only check required fields
          return field.required === true;
        });
        
        if (unmappedRequired.length > 0) {
          unmappedRequiredFields.push({
            categoryId: csvCategoryId,
            categoryPath: categoryMapping?.categoryPath || csvCategoryId,
            fields: unmappedRequired.map(f => f.label || f.id)
          });
        }
      });
      
      // Show warning if there are unmapped required ShareTribe fields
      if (unmappedRequiredFields.length > 0) {
        const totalUnmapped = unmappedRequiredFields.reduce((sum, cat) => sum + cat.fields.length, 0);
        const categoriesList = unmappedRequiredFields.map(cat => 
          `  • ${cat.categoryPath}: ${cat.fields.join(', ')}`
        ).join('\n');
        
        const message = `⚠️ Warning: Some required ShareTribe fields are unmapped (${totalUnmapped} field${totalUnmapped !== 1 ? 's' : ''}):\n\n${categoriesList}\n\nUnmapped eBay/CSV fields are okay, but unmapped ShareTribe fields may cause issues.\n\nAre you sure you want to continue?`;
        
        if (!window.confirm(message)) {
          return; // User cancelled, don't proceed
        }
      }
    }

    onConfirm({
      defaultMappings,
      categoryColumn,
      categoryShareTribeMappings,
      categoryFieldMappings, // Keep for backward compatibility (Step 4)
      categoryListingTypeMappings, // Include listing type mappings
      valueMappings, // Include value mappings for invalid enum values
      unmappedFieldValues, // Keep for backward compatibility
      productFieldMappings, // Product-level field mappings (Step 5)
      productUnmappedFieldValues // Product-level unmapped field values (Step 5)
    });
  };

  const getFieldLabel = (fieldId) => {
    const field = availableFields.find(f => f.id === fieldId);
    return field ? field.label : fieldId;
  };

  // Get CSV columns not mapped to default fields
  const getUnmappedColumns = useMemo(() => {
    const mappedColumns = new Set(Object.keys(defaultMappings));
    return safeCsvColumns.filter(col => !mappedColumns.has(col));
  }, [defaultMappings, safeCsvColumns]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex justify-between items-center mb-4">
          <div>
              <h2 className="text-xl font-semibold text-gray-900">{isEbayProducts ? 'Mapping Modal' : 'Map CSV Columns'}</h2>
            <p className="text-sm text-gray-500 mt-1">
                Step {step} of 5: {step === 1 ? 'Map Default Fields' : step === 2 ? 'Map Categories' : step === 3 ? 'Validate Values' : step === 4 ? 'Map Category-Specific Fields' : 'Final Validation & Unmapped Fields'}
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={24} />
          </button>
          </div>
          
          {/* Progress Steps */}
          <div className="flex items-center space-x-2">
            <div className={`flex items-center ${step >= 1 ? 'text-blue-600' : 'text-gray-400'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 1 ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
                {step > 1 ? <Check size={16} /> : '1'}
              </div>
              <span className="ml-2 text-sm font-medium">Default Fields</span>
            </div>
            <ChevronRight className="text-gray-400" size={20} />
            <div className={`flex items-center ${step >= 2 ? 'text-blue-600' : 'text-gray-400'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 2 ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
                {step > 2 ? <Check size={16} /> : '2'}
              </div>
              <span className="ml-2 text-sm font-medium">Categories</span>
            </div>
            <ChevronRight className="text-gray-400" size={20} />
            <div className={`flex items-center ${step >= 3 ? 'text-blue-600' : 'text-gray-400'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 3 ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
                {step > 3 ? <Check size={16} /> : '3'}
              </div>
              <span className="ml-2 text-sm font-medium">Validate Values</span>
            </div>
            <ChevronRight className="text-gray-400" size={20} />
            <div className={`flex items-center ${step >= 4 ? 'text-blue-600' : 'text-gray-400'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 4 ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
                {step > 4 ? <Check size={16} /> : '4'}
              </div>
              <span className="ml-2 text-sm font-medium">Category Fields</span>
            </div>
            <ChevronRight className="text-gray-400" size={20} />
            <div className={`flex items-center ${step >= 5 ? 'text-blue-600' : 'text-gray-400'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 5 ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
                5
              </div>
              <span className="ml-2 text-sm font-medium">Final Review</span>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Step 1: Default Fields Mapping */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Map Default Fields</h3>
                <p className="text-sm text-gray-600">
                  Map these ShareTribe default fields that apply to all products: Title, Description, Price (with currency and amount), Images, Geolocation.
                  Note: Author ID and State are set automatically by the system.
                </p>
              </div>

              {/* Note: eBay Item ID is automatically extracted from CSV and stored in ShareTribe privateData */}

          <div className="space-y-4">
            <div className="grid grid-cols-12 gap-4 pb-2 border-b border-gray-200 font-semibold text-sm text-gray-700">
              <div className="col-span-5">CSV Column</div>
              <div className="col-span-1"></div>
                  <div className="col-span-6">ShareTribe Default Field</div>
            </div>

                {safeCsvColumns.map(csvColumn => {
                  const mappedField = defaultMappings[csvColumn];
                  const sampleValue = safeSampleRows[0]?.[csvColumn] || '';
              
              return (
                    <div key={csvColumn} className="grid grid-cols-12 gap-4 items-center">
                  <div className="col-span-5">
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
                          <div className="font-medium text-gray-900 mb-1">{csvColumn}</div>
                          {sampleValue && (
                            <div className="text-xs text-gray-600 break-words mt-1">
                              <span className="text-gray-500">Sample: </span>
                              <span className="font-mono">{sampleValue}</span>
                            </div>
                          )}
                    </div>
                  </div>
                  <div className="col-span-1 flex justify-center">
                    <ArrowRight className="text-gray-400" size={20} />
                  </div>
                      <div className="col-span-6">
                        <select
                          value={mappedField || ''}
                          onChange={(e) => handleDefaultMappingChange(csvColumn, e.target.value)}
                          disabled={loadingFields}
                          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent border-gray-300"
                        >
                          <option value="">N/A - Don&apos;t map</option>
                          
                          {/* Default Fields */}
                          {groupedFields.default.length > 0 && (
                            <optgroup label="Default Fields">
                              {groupedFields.default.map(field => {
                                const isMapped = Object.values(defaultMappings).includes(field.id) && defaultMappings[csvColumn] !== field.id;
                                return (
                                  <option 
                                    key={field.id} 
                                    value={field.id}
                                    disabled={isMapped}
                                  >
                                    {field.label} {field.required && '*'}
                                    {field.description && ` - ${field.description}`}
                                    {isMapped && ' (already mapped)'}
                                  </option>
                                );
                              })}
                            </optgroup>
                          )}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Category Column Selection */}
              <div className="mt-6 pt-6 border-t border-gray-200">
                <h4 className="text-md font-semibold text-gray-900 mb-2">Category Column</h4>
                <p className="text-sm text-gray-600 mb-3">
                  Select which CSV column contains the category IDs for your products.
                </p>
                <select
                  value={categoryColumn || ''}
                  onChange={(e) => handleCategoryColumnChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select category column...</option>
                  {getUnmappedColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Step 2: Category Mapping */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Map CSV Categories to ShareTribe Categories</h3>
                <p className="text-sm text-gray-600">
                  Map each unique category ID from your CSV to a ShareTribe category. Sample product titles are shown to help identify each category.
                </p>
              </div>

              {getUniqueCSVCategories().map(csvCategoryId => {
                const sampleTitles = getSampleTitlesForCategory(csvCategoryId);
                const currentMapping = categoryShareTribeMappings[csvCategoryId];
                
                return (
                  <div key={csvCategoryId} className="border border-gray-200 rounded-lg p-4">
                    <div className="mb-3">
                      <div className="font-semibold text-gray-900 mb-2">CSV Category: {csvCategoryId}</div>
                      {sampleTitles.length > 0 && (
                        <div className="px-3 py-2 bg-blue-50 rounded-lg border border-blue-200">
                          <div className="text-xs font-medium text-blue-900 mb-1">Sample products:</div>
                          <div className="space-y-1">
                            {sampleTitles.map((title, idx) => (
                              <div key={idx} className="text-sm text-blue-800">{title}</div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-12 gap-4 items-start">
                      <div className="col-span-4">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          CSV Category
                        </label>
                        <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-200 font-medium text-gray-900">
                          {csvCategoryId}
                        </div>
                      </div>
                      <div className="col-span-1 flex justify-center pt-8">
                        <ArrowRight className="text-gray-400" size={20} />
                      </div>
                      <div className="col-span-3">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          ShareTribe Category
                        </label>
                        <div className="relative" ref={el => categoryDropdownRefs.current[csvCategoryId] = el}>
                          <button
                            type="button"
                            onClick={() => {
                              setCategorySearchOpen(prev => ({
                                ...prev,
                                [csvCategoryId]: !prev[csvCategoryId]
                              }));
                              if (!categorySearchOpen[csvCategoryId]) {
                                setCategorySearchTerm(prev => ({
                                  ...prev,
                                  [csvCategoryId]: ''
                                }));
                              }
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white text-left flex items-center justify-between"
                          >
                            <span className={currentMapping ? 'text-gray-900' : 'text-gray-500'}>
                              {currentMapping ? currentMapping.categoryPath : 'Select category...'}
                            </span>
                            <ChevronDown className={`text-gray-400 transition-transform ${categorySearchOpen[csvCategoryId] ? 'rotate-180' : ''}`} size={18} />
                          </button>
                          
                          {categorySearchOpen[csvCategoryId] && (
                            <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-hidden">
                              <div className="p-2 border-b border-gray-200">
                                <div className="relative">
                                  <Search className="absolute left-2 top-2.5 text-gray-400" size={16} />
                                  <input
                                    type="text"
                                    placeholder="Search categories..."
                                    value={categorySearchTerm[csvCategoryId] || ''}
                                    onChange={(e) => {
                                      setCategorySearchTerm(prev => ({
                                        ...prev,
                                        [csvCategoryId]: e.target.value
                                      }));
                                    }}
                                    className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                                    autoFocus
                                  />
                                </div>
                              </div>
                              <div className="max-h-48 overflow-y-auto">
                                {(() => {
                                  const searchTerm = (categorySearchTerm[csvCategoryId] || '').toLowerCase();
                                  const filteredCategories = availableCategories.filter(cat => {
                                    if (!searchTerm) return true;
                                    return cat.label.toLowerCase().includes(searchTerm);
                                  });
                                  
                                  if (filteredCategories.length === 0) {
                                    return (
                                      <div className="px-3 py-2 text-sm text-gray-500 text-center">
                                        No categories found
                                      </div>
                                    );
                                  }
                                  
                                  return filteredCategories.map((cat, index) => {
                                    const isSelected = currentMapping?.categoryId === cat.categoryId;
                                    return (
                                      <button
                                        key={cat.id || `cat-${index}`}
                                        type="button"
                                        onClick={() => {
                                          handleCategoryShareTribeMapping(csvCategoryId, cat.key || cat.id || null);
                                          setCategorySearchOpen(prev => ({
                                            ...prev,
                                            [csvCategoryId]: false
                                          }));
                                          setCategorySearchTerm(prev => ({
                                            ...prev,
                                            [csvCategoryId]: ''
                                          }));
                                        }}
                                        className={`w-full px-3 py-2 text-left text-sm hover:bg-blue-50 transition-colors ${
                                          isSelected ? 'bg-blue-100 font-medium' : 'text-gray-900'
                                        }`}
                                      >
                                        {cat.label}
                                      </button>
                                    );
                                  });
                                })()}
                              </div>
                            </div>
                          )}
                        </div>
                        {currentMapping && (
                          <div className="mt-2 text-xs text-green-600">
                            ✓ {currentMapping.categoryPath}
                          </div>
                        )}
                      </div>
                      <div className="col-span-1 flex justify-center pt-8">
                        <ArrowRight className="text-gray-400" size={20} />
                      </div>
                      <div className="col-span-3">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Listing Type <span className="text-gray-500">(required)</span>
                        </label>
                        <select
                          value={categoryListingTypeMappings[csvCategoryId] || 'list-new-item'}
                          onChange={(e) => {
                            const newMappings = { ...categoryListingTypeMappings };
                            if (e.target.value) {
                              newMappings[csvCategoryId] = e.target.value;
                            } else {
                              delete newMappings[csvCategoryId];
                            }
                            setCategoryListingTypeMappings(newMappings);
                          }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          {availableListingTypes.map((lt) => (
                            <option key={lt.id} value={lt.id}>
                              {lt.label || lt.name || lt.id}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-xs text-gray-500">
                          Set in publicData.listingType
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Step 3: Value Validation */}
          {step === 3 && (() => {
            try {
              // Find all invalid values that need mapping
              const invalidValueMappings = [];
              
              // Check all category field mappings for invalid enum values
              // Only process if categoryFieldMappings exists and has entries
              if (categoryFieldMappings && typeof categoryFieldMappings === 'object') {
                Object.keys(categoryFieldMappings).forEach(csvCategoryId => {
                  const categoryMapping = categoryFieldMappings[csvCategoryId];
                  
                  // Skip if categoryMapping is not an object
                  if (!categoryMapping || typeof categoryMapping !== 'object') {
                    return;
                  }
                  
                  const shareTribeCategoryId = categoryShareTribeMappings[csvCategoryId]?.categoryId;
                  
                  if (!shareTribeCategoryId) return;
                  
                  Object.keys(categoryMapping).forEach(csvColumn => {
                    const shareTribeFieldId = categoryMapping[csvColumn];
                    if (!shareTribeFieldId) return;
                    
                    const field = availableFields.find(f => f.id === shareTribeFieldId);
                    
                    // Only check fields with enum options
                    if (!field || !field.options || !Array.isArray(field.options) || field.options.length === 0) {
                      return;
                    }
                    
                    // Get all unique values for this CSV column in this category
                    const uniqueValues = new Set();
                    if (safeSampleRows && Array.isArray(safeSampleRows) && categoryColumn) {
                      safeSampleRows.forEach(row => {
                        if (row && row[categoryColumn] === csvCategoryId && row[csvColumn]) {
                          const value = String(row[csvColumn]).trim();
                          if (value) {
                            uniqueValues.add(value);
                          }
                        }
                      });
                    }
                    
                    // Check each value against allowed options
                    uniqueValues.forEach(csvValue => {
                      const isValid = field.options.includes(csvValue);
                      if (!isValid) {
                        const mappingKey = `${csvCategoryId}:${shareTribeFieldId}:${csvValue}`;
                        const currentMapping = valueMappings[mappingKey];
                        
                        invalidValueMappings.push({
                          csvCategoryId,
                          csvCategoryName: csvCategoryId,
                          shareTribeCategoryId,
                          csvColumn,
                          shareTribeFieldId,
                          shareTribeFieldLabel: field.label || shareTribeFieldId,
                          csvValue,
                          allowedValues: field.options || [],
                          currentMapping: currentMapping || null,
                          mappingKey
                        });
                      }
                    });
                  });
                });
              }
              
              // Check if there are any category field mappings to validate
              const hasCategoryFieldMappings = categoryFieldMappings && 
                typeof categoryFieldMappings === 'object' && 
                Object.keys(categoryFieldMappings).length > 0;
              
              if (!hasCategoryFieldMappings) {
                // No category fields mapped yet - show info message
                return (
                  <div className="space-y-6">
                    <div className="mb-4">
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">Validate Field Values</h3>
                      <p className="text-sm text-gray-600">
                        Field value validation will happen after you map category-specific fields in the next step.
                      </p>
                    </div>
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
                      <AlertCircle className="text-blue-600 mx-auto mb-2" size={32} />
                      <h4 className="font-semibold text-blue-900 mb-1">No category fields mapped yet</h4>
                      <p className="text-sm text-blue-800">
                        Please proceed to the next step to map category-specific fields. Value validation will be available after mapping.
                      </p>
                    </div>
                  </div>
                );
              }
              
              return (
                <div className="space-y-6">
                  <div className="mb-4">
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Validate Field Values</h3>
                    <p className="text-sm text-gray-600">
                      Some CSV values don&apos;t match ShareTribe&apos;s allowed enum values. Please map each invalid value to a valid ShareTribe value.
                    </p>
                  </div>
                  
                  {invalidValueMappings.length === 0 ? (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
                      <CheckCircle className="text-green-600 mx-auto mb-2" size={32} />
                      <h4 className="font-semibold text-green-900 mb-1">All values are valid!</h4>
                      <p className="text-sm text-green-800">
                        All CSV values match ShareTribe&apos;s allowed enum values. You can proceed to the next step.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {invalidValueMappings.map((item, idx) => (
                        <div key={idx} className="border border-red-200 rounded-lg p-4 bg-red-50">
                          <div className="grid grid-cols-12 gap-4 items-center">
                  <div className="col-span-5">
                              <div className="space-y-1">
                                <div className="font-medium text-gray-900">
                                  {item.csvColumn} (sample: &quot;{item.csvValue}&quot;)
                                </div>
                                <div className="text-xs text-gray-600">
                                  Category: {item.csvCategoryName}
                                </div>
                                <div className="text-xs text-red-700 font-medium">
                                  ❌ &quot;{item.csvValue}&quot; is not an accepted value
                                </div>
                              </div>
                            </div>
                            <div className="col-span-1 flex justify-center">
                              <ArrowRight className="text-gray-400" size={20} />
                            </div>
                            <div className="col-span-6">
                              <div className="space-y-2">
                                <label className="block text-sm font-medium text-gray-700">
                                  {item.shareTribeFieldLabel} - Map to accepted value:
                                </label>
                                <select
                                  value={item.currentMapping || ''}
                                  onChange={(e) => {
                                    const newMappings = { ...valueMappings };
                                    if (e.target.value) {
                                      newMappings[item.mappingKey] = e.target.value;
                                    } else {
                                      delete newMappings[item.mappingKey];
                                    }
                                    setValueMappings(newMappings);
                                  }}
                                  className="w-full px-3 py-2 border border-red-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent bg-white"
                                >
                                  <option value="">Select a valid value...</option>
                                  {item.allowedValues && item.allowedValues.map((allowedValue, valIdx) => (
                                    <option key={valIdx} value={allowedValue}>
                                      &quot;{allowedValue}&quot;
                                    </option>
                                  ))}
                                </select>
                                {item.currentMapping && (
                                  <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded p-2">
                                    ✅ Mapped: &quot;{item.csvValue}&quot; → &quot;{item.currentMapping}&quot;
                                  </div>
                                )}
                                {item.allowedValues && item.allowedValues.length > 0 && (
                                  <div className="text-xs text-gray-600 mt-1">
                                    <strong>Allowed values ({item.allowedValues.length}):</strong>{' '}
                                    {item.allowedValues.slice(0, 5).map(v => `"${v}"`).join(', ')}
                                    {item.allowedValues.length > 5 && ` (+${item.allowedValues.length - 5} more)`}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            } catch (error) {
              console.error('Error in Step 3 validation:', error);
              return (
                <div className="space-y-6">
                  <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                    <h3 className="text-lg font-semibold text-red-900 mb-2">Error Loading Validation</h3>
                    <p className="text-sm text-red-800">
                      An error occurred while validating field values. Please try again or proceed to the next step.
                    </p>
                    <p className="text-xs text-red-600 mt-2">
                      Error: {error.message}
                    </p>
                  </div>
                </div>
              );
            }
          })()}

          {/* Step 4: Per-Category Field Mappings */}
          {step === 4 && (
            <div className="space-y-6">
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Map Category-Specific Fields</h3>
                <p className="text-sm text-gray-600">
                  Map additional fields for each category. Default fields (title, description, etc.) are already mapped and apply to all categories.
                </p>
              </div>

              {getUniqueCSVCategories().map(csvCategoryId => {
                const categoryMapping = categoryShareTribeMappings[csvCategoryId];
                const categoryFieldMapping = categoryFieldMappings[csvCategoryId] || {};
                // Filter out internal condition fields - only show 'condition' (display name)
                let unmappedColumns = getUnmappedColumns.filter(col => 
                  col !== categoryColumn && 
                  col !== 'conditionid' && 
                  col !== 'conditiondisplayname'
                );
                
                // For eBay products, also include ALL columns from csvColumns that aren't mapped yet
                // This ensures Item Specifics are visible even if they weren't in getUnmappedColumns
                // Filter out internal condition fields - only show 'condition' (display name)
                if (isEbayProducts && safeCsvColumns) {
                  const mappedColumnsSet = new Set(Object.keys(defaultMappings));
                  const allUnmapped = safeCsvColumns.filter(col => 
                    col !== categoryColumn && 
                    !mappedColumnsSet.has(col) &&
                    col !== 'conditionid' &&
                    col !== 'conditiondisplayname'
                  );
                  // Merge with existing unmappedColumns, avoiding duplicates
                  const existingSet = new Set(unmappedColumns);
                  allUnmapped.forEach(col => {
                    if (!existingSet.has(col)) {
                      unmappedColumns.push(col);
                    }
                  });
                }
                
                // Debug: Log columns for this category
                console.log(`Step 4 - Category ${csvCategoryId}:`, {
                  allColumns: csvColumns,
                  unmappedColumns: unmappedColumns,
                  categoryColumn: categoryColumn,
                  defaultMappings: Object.keys(defaultMappings),
                  itemSpecificsColumns: unmappedColumns.filter(col => {
                    const lowerCol = col.toLowerCase();
                    return !['id', 'tenant_id', 'user_id', 'ebay_item_id', 'title', 'description', 'price', 'currency', 
                             'quantity', 'images', 'category', 'condition', 'brand', 'sku', 'synced', 'sharetribe_listing_id', 
                             'last_synced_at', 'created_at', 'updated_at', 'categorylevel1', 'categorylevel2', 'categorylevel3',
                             'start_price', 'start_price_currency', 'buy_now_price', 'buy_now_price_currency',
                             'current_price', 'current_price_currency', 'listing_type', 'price_source'].includes(lowerCol);
                  }),
                  sampleRowKeys: safeSampleRows && safeSampleRows[0] ? Object.keys(safeSampleRows[0]) : []
                });
                
                // Get fields filtered by the mapped ShareTribe category
                const shareTribeCategoryId = categoryMapping?.categoryId;
                const applicableFields = shareTribeCategoryId 
                  ? getFieldsForCategory(shareTribeCategoryId)
                  : groupedFields.listing; // Show all fields if no category mapped
                
                return (
                  <div key={csvCategoryId} className="border border-gray-200 rounded-lg p-4">
                    <div className="mb-4 pb-4 border-b border-gray-200">
                      <h4 className="font-semibold text-gray-900">Category: {csvCategoryId}</h4>
                      {categoryMapping && (
                        <p className="text-sm text-gray-600 mt-1">
                          ShareTribe: {categoryMapping.categoryPath}
                          {shareTribeCategoryId && (
                            <span className="ml-2 text-xs text-blue-600">
                              ({applicableFields.length} applicable field{applicableFields.length !== 1 ? 's' : ''})
                            </span>
                          )}
                        </p>
                      )}
                    </div>

                    {unmappedColumns.length === 0 ? (
                      <div>
                        <p className="text-sm text-gray-500 italic mb-2">No additional columns to map for this category.</p>
                        {isEbayProducts && (
                          <p className="text-xs text-yellow-600">
                            ⚠️ If Item Specifics (brand, size, color, etc.) are missing, check browser console for debugging info.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {unmappedColumns
                          .filter(csvColumn => {
                            // For eBay products, show ALL columns (including Item Specifics) even if empty for this category
                            // They might have values in other products of the same category
                            if (isEbayProducts) {
                              // Check if ANY product in this category has a value for this column
                              const categoryRows = safeSampleRows.filter(row => {
                                if (!row || !categoryColumn) return false;
                                const rowCategory = row[categoryColumn];
                                return rowCategory !== null && rowCategory !== undefined && 
                                       String(rowCategory).trim() === String(csvCategoryId).trim();
                              });
                              
                              if (categoryRows.length === 0) {
                                // If no products for this category yet, show all columns
                                console.log(`Step 4 - No products found for category ${csvCategoryId}, showing all columns`);
                                return true;
                              }
                              
                              // Show if ANY product in this category has a value
                              const hasValue = categoryRows.some(row => {
                                const value = row[csvColumn];
                                const hasValueResult = value !== null && value !== undefined && value !== '' && 
                                       (typeof value !== 'string' || value.trim() !== '');
                                if (hasValueResult) {
                                  console.log(`Step 4 - Column ${csvColumn} has value in category ${csvCategoryId}:`, value);
                                }
                                return hasValueResult;
                              });
                              
                              if (!hasValue) {
                                console.log(`Step 4 - Column ${csvColumn} filtered out for category ${csvCategoryId} (no values found)`);
                              }
                              
                              return hasValue;
                            }
                            // For CSV imports, only show columns that have values in the sample rows for this category
                            const sampleValue = safeSampleRows.find(row => row[categoryColumn] === csvCategoryId)?.[csvColumn];
                            return sampleValue !== null && sampleValue !== undefined && sampleValue !== '' && 
                                   (typeof sampleValue !== 'string' || sampleValue.trim() !== '');
                          })
                          .map(csvColumn => {
                          const currentMapping = categoryFieldMapping[csvColumn];
                          const sampleValue = safeSampleRows.find(row => row[categoryColumn] === csvCategoryId)?.[csvColumn] || '';
                          
                          return (
                            <div key={csvColumn} className="grid grid-cols-12 gap-4 items-center">
                              <div className="col-span-5">
                                <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
                                  <div className="font-medium text-gray-900 mb-1">{csvColumn}</div>
                                  {sampleValue && (
                                    <div className="text-xs text-gray-600 break-words mt-1">
                                      <span className="text-gray-500">Sample: </span>
                                      <span className="font-mono">{sampleValue}</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div className="col-span-1 flex justify-center">
                                <ArrowRight className="text-gray-400" size={20} />
                              </div>
                              <div className="col-span-6">
                    <select
                      value={currentMapping || ''}
                                  onChange={(e) => handleCategoryFieldMapping(csvCategoryId, csvColumn, e.target.value || null)}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                >
                                  <option value="">N/A - Don&apos;t map</option>
                                  
                                  {applicableFields.length > 0 && (
                                    <optgroup label={`Listing Fields${shareTribeCategoryId ? ` (for ${categoryMapping?.categoryPath || csvCategoryId})` : ''}`}>
                                      {applicableFields.map(field => {
                                        const isMapped = Object.values(categoryFieldMapping).includes(field.id) && categoryFieldMapping[csvColumn] !== field.id;
                        return (
                          <option 
                            key={field.id} 
                            value={field.id}
                            disabled={isMapped}
                          >
                            {field.label} {field.required && '*'}
                            {isMapped && ' (already mapped)'}
                          </option>
                        );
                      })}
                                    </optgroup>
                                  )}
                                  {applicableFields.length === 0 && shareTribeCategoryId && (
                                    <option disabled>No fields available for this category</option>
                                  )}
                    </select>
                  </div>
                  </div>
                          );
                        })}
                      </div>
                    )}
                </div>
              );
            })}
          </div>
          )}

          {/* Step 5: Final Review - Product-Level Mappings */}
          {step === 5 && (() => {
            // Group products by category
            const productsByCategory = {};
            
            if (!categoryColumn || !safeSampleRows || !Array.isArray(safeSampleRows)) {
              return (
                <div className="text-center text-gray-500 py-8">
                  <p>No products to review. Please complete previous steps first.</p>
                </div>
              );
            }
            
            // Group products by category
            safeSampleRows.forEach((row, idx) => {
              if (!row || !row[categoryColumn]) return;
              
              const csvCategoryId = String(row[categoryColumn]).trim();
              if (!csvCategoryId) return;
              
              const productId = getProductId(row);
              
              if (!productsByCategory[csvCategoryId]) {
                productsByCategory[csvCategoryId] = [];
              }
              
              productsByCategory[csvCategoryId].push({
                productId,
                row,
                index: idx
              });
            });
            
            // Calculate unmapped fields per product
            const getUnmappedFieldsForProduct = (product, csvCategoryId) => {
              const categoryMapping = categoryShareTribeMappings[csvCategoryId];
              const shareTribeCategoryId = categoryMapping?.categoryId;
              
              if (!shareTribeCategoryId) return [];
              
              const applicableFields = getFieldsForCategory(shareTribeCategoryId);
              const productId = product.productId;
              
              // Get all mapped field IDs for this product (default + category-level mappings from Step 4)
              // Note: Step 5 is only for unmapped ShareTribe fields, not for mapping CSV columns
              // CSV column mappings are handled at category level in Step 4
              const mappedFieldIds = new Set([
                ...Object.values(defaultMappings),
                ...Object.values(categoryFieldMappings[csvCategoryId] || {})
              ]);
              
              // Find unmapped ShareTribe fields
              const unmappedFields = applicableFields.filter(field => {
                // Skip if already mapped
                if (mappedFieldIds.has(field.id)) return false;
                // Skip if it's a default field (already handled in Step 1)
                if (field.group === 'default') return false;
                // Only show required fields or fields with enum options
                return field.required || (field.options && field.options.length > 0);
              });
              
              return unmappedFields;
            };
            
            // Get validation issues for a product (invalid enum values)
            // Returns ALL issues (both unmapped and mapped) so they stay visible
            const getValidationIssuesForProduct = (product, csvCategoryId) => {
              const validationIssues = [];
              const productId = product.productId;
              const row = product.row;
              
              // Check default mappings (Step 1)
              Object.keys(defaultMappings).forEach(csvColumn => {
                const shareTribeFieldId = defaultMappings[csvColumn];
                if (!shareTribeFieldId) return;
                
                const field = availableFields.find(f => f.id === shareTribeFieldId);
                if (!field) return;
                
                // Only validate enum fields
                if (!field.options || !Array.isArray(field.options) || field.options.length === 0) {
                  return;
                }
                
                // Get the value from the product row
                const csvValue = row[csvColumn];
                if (!csvValue || String(csvValue).trim() === '') return;
                
                const value = String(csvValue).trim();
                
                // Check if value mapping exists (from Step 3 or Step 5)
                const mappingKey = `${csvCategoryId}:${shareTribeFieldId}:${value}`;
                const mappedValue = valueMappings[mappingKey];
                const finalValue = mappedValue || value;
                
                // Check if final value is valid
                const normalizedFinalValue = String(finalValue).trim();
                const normalizedOptions = field.options.map(opt => String(opt).trim());
                const isValid = normalizedOptions.includes(normalizedFinalValue);
                
                // Always include the issue if the original value is invalid, even if it's been mapped
                // This ensures the dropdown stays visible after mapping
                if (!normalizedOptions.includes(value.trim())) {
                  validationIssues.push({
                    csvColumn,
                    shareTribeFieldId,
                    shareTribeFieldLabel: field.label || shareTribeFieldId,
                    csvValue: value,
                    mappedValue: mappedValue || null,
                    finalValue: normalizedFinalValue,
                    allowedValues: field.options,
                    mappingKey,
                    isDefaultField: true,
                    isValid: isValid // Track if the mapped value is valid
                  });
                }
              });
              
              // Check category-level mappings (Step 4)
              const categoryFieldMapping = categoryFieldMappings[csvCategoryId] || {};
              Object.keys(categoryFieldMapping).forEach(csvColumn => {
                const shareTribeFieldId = categoryFieldMapping[csvColumn];
                if (!shareTribeFieldId) return;
                
                const field = availableFields.find(f => f.id === shareTribeFieldId);
                if (!field) return;
                
                // Only validate enum fields
                if (!field.options || !Array.isArray(field.options) || field.options.length === 0) {
                  return;
                }
                
                // Get the value from the product row
                const csvValue = row[csvColumn];
                if (!csvValue || String(csvValue).trim() === '') return;
                
                const value = String(csvValue).trim();
                
                // Check if value mapping exists (from Step 3 or Step 5)
                const mappingKey = `${csvCategoryId}:${shareTribeFieldId}:${value}`;
                const mappedValue = valueMappings[mappingKey];
                const finalValue = mappedValue || value;
                
                // Check if final value is valid
                const normalizedFinalValue = String(finalValue).trim();
                const normalizedOptions = field.options.map(opt => String(opt).trim());
                const isValid = normalizedOptions.includes(normalizedFinalValue);
                
                // Always include the issue if the original value is invalid, even if it's been mapped
                // This ensures the dropdown stays visible after mapping
                if (!normalizedOptions.includes(value.trim())) {
                  validationIssues.push({
                    csvColumn,
                    shareTribeFieldId,
                    shareTribeFieldLabel: field.label || shareTribeFieldId,
                    csvValue: value,
                    mappedValue: mappedValue || null,
                    finalValue: normalizedFinalValue,
                    allowedValues: field.options,
                    mappingKey,
                    isDefaultField: false,
                    isValid: isValid // Track if the mapped value is valid
                  });
                }
              });
              
              return validationIssues;
            };
            
            // Count products with unmapped required fields or unmapped validation errors
            let productsWithUnmappedRequired = 0;
            let productsWithValidationErrors = 0;
            Object.keys(productsByCategory).forEach(csvCategoryId => {
              productsByCategory[csvCategoryId].forEach(product => {
                const unmappedFields = getUnmappedFieldsForProduct(product, csvCategoryId);
                const validationIssues = getValidationIssuesForProduct(product, csvCategoryId);
                if (unmappedFields.some(f => f.required)) {
                  productsWithUnmappedRequired++;
                }
                // Only count products with unmapped validation errors (not mapped ones)
                const unmappedValidationErrors = validationIssues.filter(issue => !valueMappings[issue.mappingKey]);
                if (unmappedValidationErrors.length > 0) {
                  productsWithValidationErrors++;
                }
              });
            });
            
            return (
              <div className="space-y-6">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">Final Review - Unmapped ShareTribe Fields</h3>
                  <p className="text-sm text-gray-600">
                    Review and set values for unmapped ShareTribe fields for each product. Products are grouped by category for organization.
                  </p>
                </div>
                
                {/* Warning for products with unmapped required fields or validation errors */}
                {(productsWithUnmappedRequired > 0 || productsWithValidationErrors > 0) && (
                  <div className="bg-yellow-50 border-2 border-yellow-400 rounded-lg p-4">
                    <div className="flex items-start">
                      <AlertCircle className="text-yellow-600 mr-2 mt-0.5" size={20} />
                      <div>
                        <h4 className="font-semibold text-yellow-900 mb-1">
                          ⚠️ Warning: Issues Found
                        </h4>
                        <p className="text-sm text-yellow-800">
                          {productsWithUnmappedRequired > 0 && (
                            <span>{productsWithUnmappedRequired} product{productsWithUnmappedRequired !== 1 ? 's' : ''} with unmapped required fields. </span>
                          )}
                          {productsWithValidationErrors > 0 && (
                            <span>{productsWithValidationErrors} product{productsWithValidationErrors !== 1 ? 's' : ''} with invalid field values. </span>
                          )}
                          Please review and fix them before continuing.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Products grouped by category */}
                <div className="space-y-4">
                  {Object.keys(productsByCategory).map(csvCategoryId => {
                    const categoryMapping = categoryShareTribeMappings[csvCategoryId];
                    const shareTribeCategoryId = categoryMapping?.categoryId;
                    const isExpanded = expandedCategories[csvCategoryId] !== false; // Default to expanded
                    const products = productsByCategory[csvCategoryId];
                    const applicableFields = shareTribeCategoryId ? getFieldsForCategory(shareTribeCategoryId) : [];
                    
                    return (
                      <div key={csvCategoryId} className="border border-gray-300 rounded-lg overflow-hidden">
                        {/* Category Header */}
                        <button
                          onClick={() => toggleCategoryExpansion(csvCategoryId)}
                          className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 flex items-center justify-between text-left"
                        >
                          <div>
                            <h4 className="font-semibold text-gray-900">
                              {csvCategoryId}
                            </h4>
                            {categoryMapping && (
                              <p className="text-sm text-gray-600">
                                ShareTribe: {categoryMapping.categoryPath} • {products.length} product{products.length !== 1 ? 's' : ''}
                              </p>
                            )}
                          </div>
                          {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                        </button>
                        
                        {/* Products in this category */}
                        {isExpanded && (
                          <div className="p-4 space-y-6 bg-white">
                            {products.map((product, productIdx) => {
                              const productId = product.productId;
                              const unmappedFields = getUnmappedFieldsForProduct(product, csvCategoryId);
                              const validationIssues = getValidationIssuesForProduct(product, csvCategoryId);
                              const hasUnmappedRequired = unmappedFields.some(f => f.required);
                              // Only show error badge if there are unmapped validation errors
                              const unmappedValidationErrors = validationIssues.filter(issue => !valueMappings[issue.mappingKey]);
                              const hasValidationErrors = unmappedValidationErrors.length > 0;
                              
                              return (
                                <div 
                                  key={`${productId}-${productIdx}`} 
                                  className={`border rounded-lg p-4 ${
                                    hasUnmappedRequired || hasValidationErrors 
                                      ? 'border-yellow-300 bg-yellow-50' 
                                      : 'border-gray-200 bg-gray-50'
                                  }`}
                                >
                                  {/* Product Header */}
                                  <div className="flex items-start mb-4">
                                    {product.row.images && (
                                      <img
                                        src={product.row.images.split(',')[0]}
                                        alt={product.row.title || 'Product'}
                                        className="h-16 w-16 object-cover rounded mr-3"
                                        onError={(e) => { e.target.style.display = 'none'; }}
                                      />
                                    )}
                                    <div className="flex-1">
                                      <h5 className="font-semibold text-gray-900 mb-1">
                                        {product.row.title || 'Untitled Product'}
                                      </h5>
                                      <p className="text-xs text-gray-500">
                                        ID: {productId} {product.row.sku && `• SKU: ${product.row.sku}`}
                                      </p>
                                      {hasUnmappedRequired && (
                                        <span className="inline-block mt-1 px-2 py-0.5 bg-yellow-200 text-yellow-800 text-xs rounded mr-2">
                                          ⚠️ Has unmapped required fields
                  </span>
                                      )}
                                      {hasValidationErrors && (
                                        <span className="inline-block mt-1 px-2 py-0.5 bg-red-200 text-red-800 text-xs rounded">
                                          ❌ Has invalid field values ({validationIssues.length})
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  
                                  {/* Validation Issues */}
                                  {validationIssues.length > 0 && (
                                    <div className="mb-4">
                                      <h6 className="text-sm font-medium text-red-900 mb-2">
                                        Validation Errors ({validationIssues.length})
                                      </h6>
                                      <div className="space-y-2">
                                        {validationIssues.map((issue, issueIdx) => {
                                          const currentMapping = valueMappings[issue.mappingKey];
                                          const isMapped = !!currentMapping;
                                          
                                          return (
                                            <div 
                                              key={issueIdx} 
                                              className={`bg-white rounded p-2 border ${
                                                isMapped ? 'border-green-300' : 'border-red-300'
                                              }`}
                                            >
                                              <div className="grid grid-cols-12 gap-2 items-center">
                                                <div className="col-span-5">
                                                  <div className="text-sm font-medium text-gray-900">
                                                    {issue.csvColumn} = &quot;{issue.csvValue}&quot;
                                                  </div>
                                                  {!isMapped ? (
                                                    <div className="text-xs text-red-700 font-medium mt-0.5">
                                                      ❌ Invalid value for {issue.shareTribeFieldLabel}
                                                    </div>
                                                  ) : (
                                                    <div className="text-xs text-green-700 font-medium mt-0.5">
                                                      ✓ Value mapped for {issue.shareTribeFieldLabel}
                                                    </div>
                                                  )}
                                                </div>
                                                <div className="col-span-1 flex justify-center">
                                                  <ArrowRight className="text-gray-400" size={16} />
                                                </div>
                                                <div className="col-span-6">
                                                  <select
                                                    value={currentMapping || ''}
                                                    onChange={(e) => {
                                                      const newMappings = { ...valueMappings };
                                                      if (e.target.value) {
                                                        newMappings[issue.mappingKey] = e.target.value;
                                                      } else {
                                                        delete newMappings[issue.mappingKey];
                                                      }
                                                      setValueMappings(newMappings);
                                                    }}
                                                    className={`w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white ${
                                                      isMapped ? 'border-green-300' : 'border-red-300'
                                                    }`}
                                                  >
                                                    <option value="">Select a valid value...</option>
                                                    {issue.allowedValues.map((allowedValue, valIdx) => (
                                                      <option key={valIdx} value={allowedValue}>
                                                        &quot;{allowedValue}&quot;
                                                      </option>
                                                    ))}
                                                  </select>
                                                  {currentMapping && (
                                                    <div className="mt-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded p-1">
                                                      ✓ Value set: &quot;{currentMapping}&quot;
                                                    </div>
                                                  )}
                                                </div>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}
                                  
                                  {/* Unmapped ShareTribe Fields */}
                                  {unmappedFields.length > 0 ? (
                                    <div>
                                      <h6 className={`text-sm font-medium mb-2 ${hasUnmappedRequired ? 'text-yellow-900' : 'text-gray-700'}`}>
                                        Unmapped ShareTribe Fields ({unmappedFields.length})
                                      </h6>
                                      <div className="space-y-2">
                                        {unmappedFields.map(field => {
                                          const valueKey = `${productId}:${field.id}`;
                                          const currentValue = productUnmappedFieldValues[valueKey];
                                          
                                          return (
                                            <div key={field.id} className={`bg-white rounded p-2 border ${field.required ? 'border-yellow-300' : 'border-gray-200'}`}>
                                              <label className="text-sm font-medium text-gray-900 block mb-1">
                                                {field.label} {field.required && <span className="text-red-600">*</span>}
                                              </label>
                                              {field.options && Array.isArray(field.options) && field.options.length > 0 ? (
                                                <select
                                                  value={currentValue || ''}
                                                  onChange={(e) => handleProductUnmappedFieldValue(productId, field.id, e.target.value)}
                                                  className={`w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent ${field.required && !currentValue ? 'border-yellow-300' : 'border-gray-300'}`}
                                                >
                                                  <option value="">{field.required ? 'Required - select a value' : 'No value'}</option>
                                                  {field.options.map((option, optIdx) => (
                                                    <option key={optIdx} value={option}>
                                                      {option}
                                                    </option>
                                                  ))}
                                                </select>
                                              ) : (
                                                <input
                                                  type="text"
                                                  value={currentValue || ''}
                                                  onChange={(e) => handleProductUnmappedFieldValue(productId, field.id, e.target.value)}
                                                  placeholder={field.required ? 'Required - enter a value' : 'Optional - enter a value'}
                                                  className={`w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent ${field.required && !currentValue ? 'border-yellow-300' : 'border-gray-300'}`}
                                                />
                                              )}
                                              {currentValue && (
                                                <div className="mt-1 text-xs text-green-700">
                                                  ✓ Value set: &quot;{currentValue}&quot;
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-center py-2 text-sm text-green-700 bg-green-50 rounded border border-green-200">
                                      ✓ All ShareTribe fields mapped
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-between">
          <button
            onClick={handleBack}
            disabled={step === 1}
            className="flex items-center space-x-2 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={18} />
            <span>Back</span>
          </button>
          
          <div className="flex space-x-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
            {step < 5 ? (
              <button
                onClick={handleNext}
                disabled={(step === 1 && !canProceedToStep2) || (step === 2 && !canProceedToStep3)}
                className="flex items-center space-x-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>Next</span>
                <ChevronRight size={18} />
              </button>
            ) : (
          <button
            onClick={handleConfirm}
                disabled={!isValidStep1 || hasUnmappedRequiredFields}
            className="flex items-center space-x-2 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title={hasUnmappedRequiredFields ? 'Please map all required ShareTribe fields before importing' : ''}
          >
            <Check size={18} />
            <span>Import Products</span>
          </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CSVColumnMapping;
