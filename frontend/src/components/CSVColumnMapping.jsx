import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowRight, X, Check, AlertCircle, ChevronRight, ChevronLeft, CheckCircle, ChevronDown, Search } from 'lucide-react';
import { getShareTribeMetadata } from '../services/api';

const CSVColumnMapping = ({ csvColumns, sampleRows, fileId, csvPreview, onCancel, onConfirm, isEbayProducts = false }) => {
  const [step, setStep] = useState(1); // 1: Default fields, 2: Category mapping, 3: Value validation, 4: Category fields, 5: Final validation & unmapped fields
  const [defaultMappings, setDefaultMappings] = useState({}); // Maps CSV columns to default fields (title, description, etc.)
  const [categoryColumn, setCategoryColumn] = useState(null); // Which CSV column contains category IDs
  const [categoryFieldMappings, setCategoryFieldMappings] = useState({}); // Maps category ID -> { field mappings }
  const [categoryShareTribeMappings, setCategoryShareTribeMappings] = useState({}); // Maps CSV category ID -> ShareTribe category
  const [categoryListingTypeMappings, setCategoryListingTypeMappings] = useState({}); // Maps CSV category ID -> ShareTribe listing type ID
  const [valueMappings, setValueMappings] = useState({}); // Maps: "categoryId:fieldId:csvValue" -> "shareTribeValue"
  const [unmappedFieldValues, setUnmappedFieldValues] = useState({}); // Maps: "categoryId:fieldId" -> "defaultValue"
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
    if (!sampleRows) return [];
    
    const categories = new Set();
    sampleRows.forEach(row => {
      const categoryValue = row[categoryColumn];
      if (categoryValue && categoryValue.toString().trim() !== '') {
        categories.add(categoryValue.toString().trim());
      }
    });
    
    return Array.from(categories).sort();
  }, [categoryColumn, sampleRows, csvPreview]);

  // Get unique category IDs from CSV (wrapper function)
  const getUniqueCSVCategories = useCallback(() => {
    return uniqueCategories;
  }, [uniqueCategories]);

  // Get sample product titles for a category
  const getSampleTitlesForCategory = useCallback((csvCategoryId) => {
    if (!categoryColumn || !sampleRows) return [];
    
    const titleColumn = Object.keys(defaultMappings).find(col => defaultMappings[col] === 'title');
    if (!titleColumn) return [];
    
    return sampleRows
      .filter(row => row[categoryColumn] === csvCategoryId)
      .slice(0, 3)
      .map(row => row[titleColumn])
      .filter(Boolean);
  }, [categoryColumn, defaultMappings, sampleRows]);

  useEffect(() => {
    // Load ShareTribe metadata
    const loadFields = async () => {
      try {
        const response = await getShareTribeMetadata();
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
          if (csvColumns && csvColumns.length > 0) {
            csvColumns.forEach(csvCol => {
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
    sampleRows.forEach(row => {
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
    if (validateStep1(defaultMappings)) {
      onConfirm({
        defaultMappings,
        categoryColumn,
        categoryShareTribeMappings,
        categoryFieldMappings,
        categoryListingTypeMappings, // Include listing type mappings
        valueMappings, // Include value mappings for invalid enum values
        unmappedFieldValues // Include default values for unmapped ShareTribe fields
      });
    }
  };

  const getFieldLabel = (fieldId) => {
    const field = availableFields.find(f => f.id === fieldId);
    return field ? field.label : fieldId;
  };

  const groupedFields = {
    required: availableFields.filter(f => f.group === 'required'),
    default: availableFields.filter(f => f.group === 'default'),
    listing: availableFields.filter(f => f.group === 'listing')
  };

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
  const getFieldsForCategory = useCallback((categoryId) => {
    if (!categoryId) return groupedFields.listing; // Show all listing fields if no category
    
    // Get all category IDs in the hierarchy (parent categories + selected category)
    const categoryHierarchy = getCategoryHierarchy(categoryId);
    
    return groupedFields.listing.filter(field => {
      // Show fields with no category restrictions
      if (!field.categoryIds || field.categoryIds.length === 0) return true;
      
      // Show fields that include this category OR any of its parent categories in their categoryIds
      return categoryHierarchy.some(catId => field.categoryIds.includes(catId));
    });
  }, [groupedFields.listing, getCategoryHierarchy]);

  // Get CSV columns not mapped to default fields
  const getUnmappedColumns = useMemo(() => {
    const mappedColumns = new Set(Object.keys(defaultMappings));
    return csvColumns ? csvColumns.filter(col => !mappedColumns.has(col)) : [];
  }, [defaultMappings, csvColumns]);

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

                {csvColumns.map(csvColumn => {
                  const mappedField = defaultMappings[csvColumn];
                  const sampleValue = sampleRows[0]?.[csvColumn] || '';
                  
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
                    if (sampleRows && Array.isArray(sampleRows) && categoryColumn) {
                      sampleRows.forEach(row => {
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
                const unmappedColumns = getUnmappedColumns.filter(col => col !== categoryColumn);
                
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
                      <p className="text-sm text-gray-500 italic">No additional columns to map for this category.</p>
                    ) : (
                      <div className="space-y-3">
                        {unmappedColumns
                          .filter(csvColumn => {
                            // Only show columns that have values in the sample rows for this category
                            const sampleValue = sampleRows.find(row => row[categoryColumn] === csvCategoryId)?.[csvColumn];
                            return sampleValue !== null && sampleValue !== undefined && sampleValue !== '' && 
                                   (typeof sampleValue !== 'string' || sampleValue.trim() !== '');
                          })
                          .map(csvColumn => {
                          const currentMapping = categoryFieldMapping[csvColumn];
                          const sampleValue = sampleRows.find(row => row[categoryColumn] === csvCategoryId)?.[csvColumn] || '';
                          
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

          {/* Step 5: Final Validation & Unmapped Fields */}
          {step === 5 && (() => {
            // Collect all validation issues and unmapped fields
            const validationIssues = [];
            const unmappedFieldsByCategory = {};
            
            // Get all unique values from CSV preview if available (more comprehensive than sampleRows)
            // Use csvPreview.uniqueValues if available (scans all rows), otherwise use sampleRows
            const allCSVValues = (() => {
              const valuesByCategoryAndColumn = {};
              
              // Try to use csvPreview.uniqueValues first (if it exists and has the structure we need)
              // Otherwise fall back to sampleRows
              let dataSource = sampleRows || [];
              
              // If csvPreview has uniqueValues, try to use it
              // Note: csvPreview.uniqueValues might be structured differently, so we'll use sampleRows as primary
              // The backend should provide uniqueValues in a structured format if needed
              
              if (categoryColumn && Array.isArray(dataSource)) {
                dataSource.forEach(row => {
                  if (!row || !row[categoryColumn]) return;
                  
                  const csvCategoryId = String(row[categoryColumn]).trim();
                  if (!csvCategoryId) return;
                  
                  if (!valuesByCategoryAndColumn[csvCategoryId]) {
                    valuesByCategoryAndColumn[csvCategoryId] = {};
                  }
                  
                  // Collect values from all CSV columns
                  Object.keys(row).forEach(csvColumn => {
                    if (csvColumn === categoryColumn) return;
                    
                    const value = String(row[csvColumn] || '').trim();
                    if (value) {
                      if (!valuesByCategoryAndColumn[csvCategoryId][csvColumn]) {
                        valuesByCategoryAndColumn[csvCategoryId][csvColumn] = new Set();
                      }
                      valuesByCategoryAndColumn[csvCategoryId][csvColumn].add(value);
                    }
                  });
                });
              }
              
              return valuesByCategoryAndColumn;
            })();
            
            // Check all mapped values for validity (both default and category-specific fields)
            getUniqueCSVCategories().forEach(csvCategoryId => {
              const categoryMapping = categoryShareTribeMappings[csvCategoryId];
              const shareTribeCategoryId = categoryMapping?.categoryId;
              const categoryFieldMapping = categoryFieldMappings[csvCategoryId] || {};
              
              if (!shareTribeCategoryId) return;
              
              // Get applicable fields for this category
              const applicableFields = getFieldsForCategory(shareTribeCategoryId);
              
              // Check default field mappings (from Step 1)
              Object.keys(defaultMappings).forEach(csvColumn => {
                const shareTribeFieldId = defaultMappings[csvColumn];
                if (!shareTribeFieldId) return;
                
                const field = availableFields.find(f => f.id === shareTribeFieldId);
                if (!field) return;
                
                // Only validate enum fields
                if (!field.options || !Array.isArray(field.options) || field.options.length === 0) {
                  return;
                }
                
                // Get all unique values for this CSV column in this category
                const uniqueValues = allCSVValues[csvCategoryId]?.[csvColumn] || new Set();
                
                // Also check sampleRows as fallback
                if (uniqueValues.size === 0 && sampleRows && Array.isArray(sampleRows) && categoryColumn) {
                  sampleRows.forEach(row => {
                    if (row && row[categoryColumn] === csvCategoryId && row[csvColumn]) {
                      const value = String(row[csvColumn]).trim();
                      if (value) {
                        uniqueValues.add(value);
                      }
                    }
                  });
                }
                
                // Validate each value
                uniqueValues.forEach(csvValue => {
                  // Check if value mapping exists
                  const mappingKey = `${csvCategoryId}:${shareTribeFieldId}:${csvValue}`;
                  const mappedValue = valueMappings[mappingKey];
                  const finalValue = mappedValue || csvValue;
                  
                  // Normalize for comparison (ShareTribe enum values are case-sensitive, but we'll check both)
                  const normalizedFinalValue = String(finalValue).trim();
                  const normalizedOptions = field.options.map(opt => String(opt).trim());
                  
                  // Validate against allowed options (exact match required)
                  if (!normalizedOptions.includes(normalizedFinalValue)) {
                    validationIssues.push({
                      csvCategoryId,
                      csvCategoryName: csvCategoryId,
                      shareTribeCategoryPath: categoryMapping?.categoryPath || csvCategoryId,
                      csvColumn,
                      shareTribeFieldId,
                      shareTribeFieldLabel: field.label || shareTribeFieldId,
                      csvValue,
                      mappedValue,
                      finalValue: normalizedFinalValue,
                      allowedValues: field.options,
                      mappingKey,
                      isDefaultField: true
                    });
                  }
                });
              });
              
              // Check category-specific field mappings (from Step 4)
              Object.keys(categoryFieldMapping).forEach(csvColumn => {
                const shareTribeFieldId = categoryFieldMapping[csvColumn];
                if (!shareTribeFieldId) return;
                
                const field = availableFields.find(f => f.id === shareTribeFieldId);
                if (!field) return;
                
                // Only validate enum fields
                if (!field.options || !Array.isArray(field.options) || field.options.length === 0) {
                  return;
                }
                
                // Get all unique values for this CSV column in this category
                const uniqueValues = allCSVValues[csvCategoryId]?.[csvColumn] || new Set();
                
                // Also check sampleRows as fallback
                if (uniqueValues.size === 0 && sampleRows && Array.isArray(sampleRows) && categoryColumn) {
                  sampleRows.forEach(row => {
                    if (row && row[categoryColumn] === csvCategoryId && row[csvColumn]) {
                      const value = String(row[csvColumn]).trim();
                      if (value) {
                        uniqueValues.add(value);
                      }
                    }
                  });
                }
                
                // Validate each value
                uniqueValues.forEach(csvValue => {
                  // Check if value mapping exists
                  const mappingKey = `${csvCategoryId}:${shareTribeFieldId}:${csvValue}`;
                  const mappedValue = valueMappings[mappingKey];
                  const finalValue = mappedValue || csvValue;
                  
                  // Normalize for comparison (ShareTribe enum values are case-sensitive, but we'll check both)
                  const normalizedFinalValue = String(finalValue).trim();
                  const normalizedOptions = field.options.map(opt => String(opt).trim());
                  
                  // Validate against allowed options (exact match required)
                  if (!normalizedOptions.includes(normalizedFinalValue)) {
                    validationIssues.push({
                      csvCategoryId,
                      csvCategoryName: csvCategoryId,
                      shareTribeCategoryPath: categoryMapping?.categoryPath || csvCategoryId,
                      csvColumn,
                      shareTribeFieldId,
                      shareTribeFieldLabel: field.label || shareTribeFieldId,
                      csvValue,
                      mappedValue,
                      finalValue: normalizedFinalValue,
                      allowedValues: field.options,
                      mappingKey,
                      isDefaultField: false
                    });
                  }
                });
              });
              
              // Find unmapped ShareTribe fields for this category
              const mappedFieldIds = new Set([
                ...Object.values(defaultMappings),
                ...Object.values(categoryFieldMapping)
              ]);
              const unmappedFields = applicableFields.filter(field => {
                // Skip if already mapped
                if (mappedFieldIds.has(field.id)) return false;
                // Skip if it's a default field (already handled in Step 1)
                if (field.group === 'default') return false;
                // Only show required fields or fields with enum options (user might want to set defaults)
                return field.required || (field.options && field.options.length > 0);
              });
              
              if (unmappedFields.length > 0) {
                unmappedFieldsByCategory[csvCategoryId] = {
                  categoryMapping,
                  fields: unmappedFields
                };
              }
            });
            
            return (
              <div className="space-y-6">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">Final Validation & Unmapped Fields</h3>
                  <p className="text-sm text-gray-600">
                    Review validation issues and optionally set default values for unmapped ShareTribe fields.
                  </p>
                </div>
                
                {/* Validation Issues Section */}
                {validationIssues.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="font-semibold text-red-900 mb-2">⚠️ Validation Issues ({validationIssues.length})</h4>
                    <div className="space-y-3">
                      {validationIssues.map((issue, idx) => {
                        const mappingKey = issue.mappingKey;
                        const currentMapping = valueMappings[mappingKey];
                        
                        return (
                          <div key={idx} className="border border-red-200 rounded-lg p-4 bg-red-50">
                            <div className="grid grid-cols-12 gap-4 items-center">
                              <div className="col-span-5">
                                <div className="space-y-1">
                                  <div className="font-medium text-gray-900">
                                    {issue.csvColumn} = &quot;{issue.csvValue}&quot;
                                  </div>
                                  <div className="text-xs text-gray-600">
                                    Category: {issue.csvCategoryName} → {issue.shareTribeCategoryPath}
                                  </div>
                                  <div className="text-xs text-red-700 font-medium">
                                    ❌ Invalid value for {issue.shareTribeFieldLabel}
                                  </div>
                                </div>
                              </div>
                              <div className="col-span-1 flex justify-center">
                                <ArrowRight className="text-gray-400" size={20} />
                              </div>
                              <div className="col-span-6">
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                  Map to valid value:
                                </label>
                                <select
                                  value={currentMapping || ''}
                                  onChange={(e) => {
                                    const newMappings = { ...valueMappings };
                                    if (e.target.value) {
                                      newMappings[mappingKey] = e.target.value;
                                    } else {
                                      delete newMappings[mappingKey];
                                    }
                                    setValueMappings(newMappings);
                                  }}
                                  className="w-full px-3 py-2 border border-red-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent bg-white"
                                >
                                  <option value="">Select a valid value...</option>
                                  {issue.allowedValues.map((allowedValue, valIdx) => (
                                    <option key={valIdx} value={allowedValue}>
                                      &quot;{allowedValue}&quot;
                                    </option>
                                  ))}
                                </select>
                                {currentMapping && (
                                  <div className="mt-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded p-2">
                                    ✅ Mapped: &quot;{issue.csvValue}&quot; → &quot;{currentMapping}&quot;
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
                
                {/* Unmapped Fields Section */}
                {Object.keys(unmappedFieldsByCategory).length > 0 && (
                  <div className="space-y-4">
                    <h4 className="font-semibold text-blue-900 mb-2">
                      ℹ️ Unmapped ShareTribe Fields ({Object.values(unmappedFieldsByCategory).reduce((sum, cat) => sum + cat.fields.length, 0)})
                    </h4>
                    <p className="text-sm text-gray-600">
                      These ShareTribe fields are available for this category but haven&apos;t been mapped. You can optionally set default values for them.
                    </p>
                    <div className="space-y-4">
                      {Object.keys(unmappedFieldsByCategory).map(csvCategoryId => {
                        const { categoryMapping, fields } = unmappedFieldsByCategory[csvCategoryId];
                        
                        return (
                          <div key={csvCategoryId} className="border border-blue-200 rounded-lg p-4 bg-blue-50">
                            <div className="mb-3">
                              <h5 className="font-semibold text-gray-900">Category: {csvCategoryId}</h5>
                              {categoryMapping && (
                                <p className="text-sm text-gray-600">
                                  ShareTribe: {categoryMapping.categoryPath}
                                </p>
                              )}
                            </div>
                            <div className="space-y-3">
                              {fields.map(field => {
                                const fieldKey = `${csvCategoryId}:${field.id}`;
                                const currentValue = unmappedFieldValues[fieldKey];
                                
                                return (
                                  <div key={field.id} className="bg-white rounded-lg p-3 border border-blue-200">
                                    <div className="flex items-start justify-between mb-2">
                                      <div>
                                        <label className="font-medium text-gray-900">
                                          {field.label} {field.required && <span className="text-red-600">*</span>}
                                        </label>
                                        {field.options && field.options.length > 0 && (
                                          <div className="text-xs text-gray-600 mt-1">
                                            Type: {field.type} | Options: {field.options.slice(0, 5).join(', ')}{field.options.length > 5 ? '...' : ''}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    {field.options && Array.isArray(field.options) && field.options.length > 0 ? (
                                      <select
                                        value={currentValue || ''}
                                        onChange={(e) => {
                                          const newValues = { ...unmappedFieldValues };
                                          if (e.target.value) {
                                            newValues[fieldKey] = e.target.value;
                                          } else {
                                            delete newValues[fieldKey];
                                          }
                                          setUnmappedFieldValues(newValues);
                                        }}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                      >
                                        <option value="">No default value</option>
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
                                        onChange={(e) => {
                                          const newValues = { ...unmappedFieldValues };
                                          if (e.target.value) {
                                            newValues[fieldKey] = e.target.value;
                                          } else {
                                            delete newValues[fieldKey];
                                          }
                                          setUnmappedFieldValues(newValues);
                                        }}
                                        placeholder={field.required ? 'Required - enter a value' : 'Optional - enter a default value'}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                      />
                                    )}
                                    {currentValue && (
                                      <div className="mt-1 text-xs text-green-700">
                                        ✓ Default value set: &quot;{currentValue}&quot;
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                
                {/* Success Message */}
                {validationIssues.length === 0 && Object.keys(unmappedFieldsByCategory).length === 0 && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
                    <CheckCircle className="text-green-600 mx-auto mb-2" size={32} />
                    <h4 className="font-semibold text-green-900 mb-1">All validations passed!</h4>
                    <p className="text-sm text-green-800">
                      All mapped values are valid and there are no unmapped required fields. You can proceed to import.
                    </p>
                  </div>
                )}
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
                disabled={!isValidStep1}
                className="flex items-center space-x-2 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
