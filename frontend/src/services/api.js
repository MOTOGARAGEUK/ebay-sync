import axios from 'axios';

const API_BASE_URL = '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // 30 second timeout
});

// API Configuration
export const getApiConfig = () => api.get('/config');
export const saveApiConfig = (config) => api.post('/config', config);
export const testApiConnections = () => api.post('/config/test');

// Field Mappings
export const getFieldMappings = () => api.get('/field-mappings');
export const saveFieldMappings = (mappings) => api.post('/field-mappings', mappings);
export const getShareTribeMetadata = () => api.get('/sharetribe/metadata');

// Products
export const getProducts = (params = {}) => api.get('/products', { params });
export const refreshProducts = (sharetribeUserId = null) => {
  const data = sharetribeUserId ? { sharetribe_user_id: sharetribeUserId } : {};
  return api.post('/products/refresh', data);
};
export const previewCSV = (file) => {
  const formData = new FormData();
  formData.append('csvFile', file);
  return api.post('/products/preview-csv', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
};
export const uploadCSV = (file, columnMappings, fileId, categoryMappings = {}, categoryColumn = null, categoryFieldMappings = {}, categoryListingTypeMappings = {}, valueMappings = {}, unmappedFieldValues = {}, sharetribeUserId = null) => {
  const formData = new FormData();
  formData.append('csvFile', file);
  formData.append('columnMappings', JSON.stringify(columnMappings));
  if (Object.keys(categoryMappings).length > 0) {
    formData.append('categoryMappings', JSON.stringify(categoryMappings));
  }
  if (categoryColumn) {
    formData.append('categoryColumn', categoryColumn);
  }
  if (Object.keys(categoryFieldMappings).length > 0) {
    formData.append('categoryFieldMappings', JSON.stringify(categoryFieldMappings));
  }
  if (Object.keys(categoryListingTypeMappings).length > 0) {
    formData.append('categoryListingTypeMappings', JSON.stringify(categoryListingTypeMappings));
  }
  if (Object.keys(valueMappings).length > 0) {
    formData.append('valueMappings', JSON.stringify(valueMappings));
  }
  if (Object.keys(unmappedFieldValues).length > 0) {
    formData.append('unmappedFieldValues', JSON.stringify(unmappedFieldValues));
  }
  if (fileId) formData.append('fileId', fileId);
  if (sharetribeUserId) {
    formData.append('sharetribe_user_id', sharetribeUserId);
  }
  return api.post('/products/upload-csv', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
};

// ShareTribe Users
export const getShareTribeUsers = () => api.get('/sharetribe-users');
export const queryShareTribeUsers = () => api.get('/sharetribe-users/query'); // Query users from ShareTribe API
export const createShareTribeUser = (userData) => api.post('/sharetribe-users', userData);
export const updateShareTribeUser = (id, userData) => api.put(`/sharetribe-users/${id}`, userData);
export const deleteShareTribeUser = (id) => api.delete(`/sharetribe-users/${id}`);
export const uploadUserImage = (id, imageFile) => {
  const formData = new FormData();
  formData.append('image', imageFile);
  return api.post(`/sharetribe-users/${id}/upload-image`, formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
};

// Sync
export const syncProducts = (itemIds = null, sharetribeUserId = null) => 
  api.post('/sync', { item_ids: itemIds, sharetribe_user_id: sharetribeUserId });

// Get sync progress
export const getSyncProgress = (jobId) => 
  api.get(`/sync/progress/${jobId}`);

// Get active sync job
export const getActiveSyncJob = (sharetribeUserId = null) => {
  const params = sharetribeUserId ? { sharetribe_user_id: sharetribeUserId } : {};
  return api.get('/sync/active', { params });
};

// Preview ShareTribe payload (without syncing)
export const previewPayload = (itemIds = null, sharetribeUserId = null) => 
  api.post('/sync/preview', { item_ids: itemIds, sharetribe_user_id: sharetribeUserId });

// Remove products (delete from database)
export const removeProducts = (itemIds = null, sharetribeUserId = null) => 
  api.post('/products/remove', { item_ids: itemIds, sharetribe_user_id: sharetribeUserId });

// Apply mappings to eBay products
export const applyEbayProductMappings = (columnMappings, categoryMappings = {}, categoryColumn = null, categoryFieldMappings = {}, categoryListingTypeMappings = {}, valueMappings = {}, unmappedFieldValues = {}, sharetribeUserId = null) => {
  return api.post('/products/apply-ebay-mappings', {
    columnMappings,
    categoryMappings,
    categoryColumn,
    categoryFieldMappings,
    categoryListingTypeMappings,
    valueMappings,
    unmappedFieldValues,
    sharetribe_user_id: sharetribeUserId
  });
};

// Sync Logs
export const getSyncLogs = (limit = 50) => 
  api.get('/sync-logs', { params: { limit } });

// eBay OAuth
export const getEbayAuthUrl = (sandbox = true, sharetribeUserId = null) => {
  const params = { sandbox: sandbox.toString() };
  if (sharetribeUserId) {
    params.sharetribe_user_id = sharetribeUserId;
  }
  return api.get('/auth/ebay', { params });
};
export const getEbayUsers = () => api.get('/ebay-users');
export const deleteEbayUser = (id) => api.delete(`/ebay-users/${id}`);
export const associateEbayUser = (sharetribeUserId, ebayUserId) => 
  api.post(`/sharetribe-users/${sharetribeUserId}/associate-ebay`, { ebay_user_id: ebayUserId });
export const disassociateEbayUser = (sharetribeUserId) => 
  api.delete(`/sharetribe-users/${sharetribeUserId}/ebay-association`);

export default api;

