import React, { useState, useEffect } from 'react';
import { Save, TestTube, CheckCircle, XCircle, Plus, Trash2, Edit2 } from 'lucide-react';
import { getApiConfig, saveApiConfig, testApiConnections, getShareTribeUsers, queryShareTribeUsers, createShareTribeUser, updateShareTribeUser, deleteShareTribeUser, uploadUserImage, getEbayAuthUrl, getEbayUsers, deleteEbayUser, associateEbayUser, disassociateEbayUser } from '../services/api';

const ApiConfigTab = () => {
  const [config, setConfig] = useState({
    ebay_app_id: '',
    ebay_cert_id: '',
    ebay_dev_id: '',
    ebay_access_token: '',
    ebay_refresh_token: '',
    ebay_sandbox: true,
    ebay_redirect_uri: '',
    ebay_privacy_policy_url: '',
    ebay_auth_accepted_url: '',
    ebay_auth_declined_url: '',
    sharetribe_api_key: '',
    sharetribe_api_secret: '',
    sharetribe_marketplace_id: '',
    sharetribe_user_id: '',
  });
  const [ebayUsers, setEbayUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectingEbay, setConnectingEbay] = useState(false);
  const [testResults, setTestResults] = useState(null);
  const [shareTribeUsers, setShareTribeUsers] = useState([]);
  const [shareTribeApiUsers, setShareTribeApiUsers] = useState([]);
  const [selectedApiUser, setSelectedApiUser] = useState(null);
  const [loadingApiUsers, setLoadingApiUsers] = useState(false);
  const [showUserForm, setShowUserForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState({
    name: '',
    sharetribe_user_id: '',
    location: '',
    pickup_enabled: true,
    shipping_enabled: true,
    shipping_measurement: 'custom',
    parcel: '',
    transaction_process_alias: 'default-purchase/release-1',
    unit_type: 'item',
    default_image_id: null,
    default_image_path: null
  });
  const [uploadingImage, setUploadingImage] = useState(false);
  const [popupBlockedUrl, setPopupBlockedUrl] = useState(null);

  useEffect(() => {
    const initialize = async () => {
      await loadConfig();
      await loadShareTribeUsers();
      await loadEbayUsers();
      
      // Check if redirected from eBay OAuth callback
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('ebay_connected') === 'true') {
        const userId = urlParams.get('user_id');
        const sharetribeUserId = urlParams.get('sharetribe_user_id');
        console.log('eBay OAuth callback detected:', { userId, sharetribeUserId });
        
        if (sharetribeUserId) {
          alert(`eBay account connected successfully for ShareTribe user! eBay User ID: ${userId}`);
          // Reload ShareTribe users multiple times to ensure UI updates
          await loadShareTribeUsers();
          setTimeout(async () => {
            await loadShareTribeUsers();
            console.log('Reloaded ShareTribe users after OAuth callback');
          }, 1000);
        } else {
          alert(`eBay account connected successfully! User ID: ${userId}`);
          // Reload eBay users
          await loadEbayUsers();
        }
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    };
    
    initialize();
    
    // Poll for eBay connection status updates (in case callback happens in different tab)
    // This helps detect when eBay connection completes even if callback happens in another tab
    let pollCount = 0;
    const maxPolls = 30; // Poll for up to 60 seconds (30 * 2s)
    const checkInterval = setInterval(async () => {
      pollCount++;
      if (pollCount > maxPolls) {
        clearInterval(checkInterval);
        return;
      }
      await loadShareTribeUsers();
    }, 2000); // Check every 2 seconds
    
    return () => clearInterval(checkInterval);
  }, []);

  const loadShareTribeUsers = async () => {
    try {
      const response = await getShareTribeUsers();
      const users = response.data || [];
      console.log('Loaded ShareTribe users:', users.map(u => ({ id: u.id, name: u.name, ebay_user_id: u.ebay_user_id })));
      setShareTribeUsers(users);
    } catch (error) {
      console.error('Error loading ShareTribe users:', error);
    }
  };

  const loadEbayUsers = async () => {
    try {
      const response = await getEbayUsers();
      setEbayUsers(response.data || []);
    } catch (error) {
      console.error('Error loading eBay users:', error);
    }
  };

  const handleConnectEbay = async (sharetribeUserId = null) => {
    // Check if credentials are configured
    if (!config.ebay_app_id || !config.ebay_cert_id) {
      alert('Please configure eBay App ID and Cert ID first, then click "Save Configuration" before connecting.');
      return;
    }
    
    // Check if redirect URI is configured
    if (!config.ebay_redirect_uri) {
      alert('⚠️ OAuth Redirect URI (RuName) is required.\n\nYou can use either:\n1. Your RuName identifier (e.g., Tyler_Maddren-TylerMad-ShareT-jwplfdid)\n2. A full HTTPS URL (for ngrok/production)\n\nEnter it in the "OAuth Redirect URI" field above, then Save Configuration.');
      return;
    }
    
    setConnectingEbay(true);
    try {
      console.log('🔄 Requesting eBay OAuth URL...');
      const startTime = Date.now();
      // Pass sandbox flag as string 'true' or 'false' to match backend expectations
      const isSandbox = config.ebay_sandbox === true || config.ebay_sandbox === undefined || config.ebay_sandbox === 1;
      const response = await getEbayAuthUrl(isSandbox.toString(), sharetribeUserId);
      const duration = Date.now() - startTime;
      console.log(`✅ Received eBay OAuth URL in ${duration}ms:`, response.data.authUrl);
      
      if (!response.data.authUrl) {
        throw new Error('No authorization URL received from server');
      }
      
      // Open eBay OAuth page in new tab
      const newWindow = window.open(response.data.authUrl, '_blank', 'noopener,noreferrer');
      
      if (!newWindow || newWindow.closed || typeof newWindow.closed === 'undefined') {
        // Popup was blocked - show modal with copyable URL
        setPopupBlockedUrl(response.data.authUrl);
      } else {
        console.log('✅ Opened eBay OAuth page in new window');
      }
    } catch (error) {
      console.error('❌ Error initiating eBay OAuth:', error);
      const errorMessage = error.response?.data?.error || error.message;
      alert('Failed to start eBay connection: ' + errorMessage + '\n\nMake sure you have saved your eBay App ID, Cert ID, and Redirect URI first.\n\nCheck the browser console for more details.');
    } finally {
      setConnectingEbay(false);
    }
  };

  const handleDisconnectEbay = async (userId) => {
    if (!confirm('Are you sure you want to disconnect this eBay account?')) {
      return;
    }
    try {
      await deleteEbayUser(userId);
      await loadEbayUsers();
      alert('eBay account disconnected successfully');
    } catch (error) {
      console.error('Error disconnecting eBay user:', error);
      alert('Failed to disconnect eBay account: ' + (error.response?.data?.error || error.message));
    }
  };

  const loadConfig = async () => {
    try {
      const response = await getApiConfig();
      if (response.data) {
        setConfig({
          ebay_app_id: response.data.ebay_app_id || '',
          ebay_cert_id: response.data.ebay_cert_id || '',
          ebay_dev_id: response.data.ebay_dev_id || '',
          ebay_access_token: response.data.ebay_access_token || '',
          ebay_refresh_token: response.data.ebay_refresh_token || '',
          ebay_sandbox: response.data.ebay_sandbox !== undefined && response.data.ebay_sandbox !== null 
            ? response.data.ebay_sandbox === 1 
            : true, // Default to sandbox
          ebay_redirect_uri: response.data.ebay_redirect_uri || '',
          ebay_privacy_policy_url: response.data.ebay_privacy_policy_url || '',
          ebay_auth_accepted_url: response.data.ebay_auth_accepted_url || '',
          ebay_auth_declined_url: response.data.ebay_auth_declined_url || '',
          sharetribe_api_key: response.data.sharetribe_api_key || '',
          sharetribe_api_secret: response.data.sharetribe_api_secret || '',
          sharetribe_marketplace_api_client_id: response.data.sharetribe_marketplace_api_client_id || '',
          sharetribe_marketplace_id: response.data.sharetribe_marketplace_id || '',
          sharetribe_user_id: response.data.sharetribe_user_id || '',
        });
      }
    } catch (error) {
      console.error('Error loading config:', error);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await saveApiConfig(config);
      alert('Configuration saved successfully!');
    } catch (error) {
      console.error('Error saving config:', error);
      alert('Failed to save configuration: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResults(null);
    try {
      const response = await testApiConnections();
      setTestResults(response.data);
    } catch (error) {
      console.error('Error testing connections:', error);
      setTestResults({
        ebay: { success: false, message: error.response?.data?.error || error.message },
        sharetribe: { success: false, message: error.response?.data?.error || error.message },
      });
    } finally {
      setTesting(false);
    }
  };

  const handleChange = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold text-gray-900">API Configuration</h2>
        <button
          onClick={handleTest}
          disabled={testing}
          className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          <TestTube size={18} className={testing ? 'animate-spin' : ''} />
          <span>Test Connections</span>
        </button>
      </div>

      {/* Test Results */}
      {testResults && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">Connection Test Results</h3>
          <div className="space-y-4">
            {/* eBay API */}
            {testResults.ebay && (
              <div className="flex items-start space-x-2">
                {testResults.ebay.success ? (
                  <CheckCircle className="text-green-500 mt-0.5" size={20} />
                ) : (
                  <XCircle className="text-red-500 mt-0.5" size={20} />
                )}
                <div className="flex-1">
                  <div className="font-medium">eBay API</div>
                  <div className={`text-sm ${testResults.ebay.success ? 'text-green-600' : 'text-red-600'}`}>
                    {testResults.ebay.message || 'Unknown error'}
                  </div>
                  {testResults.ebay.success && testResults.ebay.itemCount !== undefined && (
                    <div className="text-xs text-gray-500 mt-1">
                      {testResults.ebay.itemCount === 0 
                        ? '⚠️ No inventory items found. Make sure you have active listings with available inventory in your eBay account.'
                        : `✅ ${testResults.ebay.itemCount} product(s) ready to sync`
                      }
                    </div>
                  )}
                  {testResults.ebay.authenticated === false && (
                    <div className="text-xs text-yellow-600 mt-1">
                      💡 Connect an eBay account in the "ShareTribe Users" section to see available products.
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {/* ShareTribe Marketplace API */}
            {testResults.sharetribe?.marketplace && (
              <div className="flex items-start space-x-2">
                {testResults.sharetribe.marketplace.success ? (
                  <CheckCircle className="text-green-500 mt-0.5" size={20} />
                ) : (
                  <XCircle className="text-red-500 mt-0.5" size={20} />
                )}
                <div className="flex-1">
                  <div className="font-medium">ShareTribe Marketplace API (Asset Delivery)</div>
                  <div className={`text-sm ${testResults.sharetribe.marketplace.success ? 'text-green-600' : 'text-red-600'}`}>
                    {testResults.sharetribe.marketplace.message || 'Unknown error'}
                  </div>
                </div>
              </div>
            )}
            
            {/* ShareTribe Integration API */}
            {testResults.sharetribe?.integration && (
              <div className="flex items-start space-x-2">
                {testResults.sharetribe.integration.success ? (
                  <CheckCircle className="text-green-500 mt-0.5" size={20} />
                ) : (
                  <XCircle className="text-red-500 mt-0.5" size={20} />
                )}
                <div className="flex-1">
                  <div className="font-medium">ShareTribe Integration API</div>
                  <div className={`text-sm ${testResults.sharetribe.integration.success ? 'text-green-600' : 'text-red-600'}`}>
                    {testResults.sharetribe.integration.message || 'Unknown error'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <form onSubmit={handleSave} className="bg-white rounded-lg shadow p-6 space-y-6">
        {/* eBay Configuration */}
        <div className="border-b border-gray-200 pb-6">
          <h3 className="text-lg font-semibold mb-4">eBay API Configuration</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                App ID (Client ID)
              </label>
              <input
                type="text"
                value={config.ebay_app_id || ''}
                onChange={(e) => handleChange('ebay_app_id', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter eBay App ID"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cert ID (Client Secret)
              </label>
              <input
                type="text"
                value={config.ebay_cert_id || ''}
                onChange={(e) => handleChange('ebay_cert_id', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter eBay Cert ID"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Dev ID
              </label>
              <input
                type="text"
                value={config.ebay_dev_id || ''}
                onChange={(e) => handleChange('ebay_dev_id', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter eBay Dev ID"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Access Token
              </label>
              <input
                type="password"
                value={config.ebay_access_token || ''}
                onChange={(e) => handleChange('ebay_access_token', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter eBay Access Token"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Refresh Token
              </label>
              <input
                type="password"
                value={config.ebay_refresh_token || ''}
                onChange={(e) => handleChange('ebay_refresh_token', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter eBay Refresh Token (or use OAuth below)"
              />
            </div>
            <div className="md:col-span-2">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={config.ebay_sandbox === true || config.ebay_sandbox === undefined}
                  onChange={(e) => handleChange('ebay_sandbox', e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-700">
                  Use Sandbox Environment (uncheck for production)
                </span>
              </label>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                OAuth Redirect URI (RuName) <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                value={config.ebay_redirect_uri || ''}
                onChange={(e) => handleChange('ebay_redirect_uri', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="https://your-ngrok-url.ngrok.io/api/ebay/callback or RuName"
              />
              <p className="text-xs text-gray-500 mt-1">
                ⚠️ eBay requires HTTPS for OAuth redirects. You can use either:
                <br />
                <strong>Option 1 - RuName (Recommended for Sandbox):</strong> Enter your RuName identifier (e.g., <code className="bg-gray-100 px-1 rounded">Tyler_Maddren-TylerMad-ShareT-jwplfdid</code>)
                <br />
                <strong>Option 2 - Full HTTPS URL (For Production/ngrok):</strong>
                <br />
                1. Copy your ngrok URL (e.g., https://abc123.ngrok-free.dev) and add <code className="bg-gray-100 px-1 rounded">/api/ebay/callback</code>
                <br />
                2. Enter: <code className="bg-gray-100 px-1 rounded">https://abc123.ngrok-free.dev/api/ebay/callback</code>
                <br />
                3. <strong>Important:</strong> In eBay Developer Portal → Settings → "Your auth accepted URL", use the same URL
                <br />
                4. The callback route is <code className="bg-gray-100 px-1 rounded">/api/ebay/callback</code> (not /api/auth/ebay/callback)
                <br />
                <br />
                <strong>⚠️ Enable OAuth Scopes:</strong> Before connecting, make sure to enable OAuth scopes in eBay Developer Portal:
                <br />
                1. Go to <strong>My Account → Application Keys</strong>
                <br />
                2. Click on your app (Sandbox or Production)
                <br />
                3. Go to <strong>OAuth Scopes</strong> tab
                <br />
                4. Enable <code className="bg-gray-100 px-1 rounded">https://api.ebay.com/oauth/api_scope/sell.inventory</code>
                <br />
                5. Save your changes
              </p>
            </div>
            <div className="md:col-span-2 border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold text-gray-900 mb-3">eBay Developer Portal Settings</h4>
              <p className="text-xs text-gray-600 mb-3">
                These URLs must be configured in your eBay Developer Portal → Your App → Settings.
                All URLs must be HTTPS (use ngrok for local development).
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Privacy Policy URL <span className="text-red-600">*</span>
              </label>
              <input
                type="url"
                value={config.ebay_privacy_policy_url || ''}
                onChange={(e) => handleChange('ebay_privacy_policy_url', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="https://your-ngrok-url.ngrok.io/privacy-policy"
              />
              <p className="text-xs text-gray-500 mt-1">
                Required by eBay. Must be HTTPS. This is where eBay links to your privacy policy.
                <br />
                <strong>For local dev:</strong> Use your ngrok URL + <code className="bg-gray-100 px-1 rounded">/privacy-policy</code>
                <br />
                <strong>Example:</strong> <code className="bg-gray-100 px-1 rounded">https://abc123.ngrok.io/privacy-policy</code>
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Auth Accepted URL (Optional)
              </label>
              <input
                type="url"
                value={config.ebay_auth_accepted_url || ''}
                onChange={(e) => handleChange('ebay_auth_accepted_url', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="https://your-ngrok-url.ngrok.io/auth/accepted"
              />
              <p className="text-xs text-gray-500 mt-1">
                Optional. Where eBay redirects after user accepts authorization. If left blank, eBay uses its default page.
                <br />
                <strong>Note:</strong> This is separate from the OAuth callback URL. The callback URL handles the OAuth code exchange.
                <br />
                <strong>For local dev:</strong> Use your ngrok URL + <code className="bg-gray-100 px-1 rounded">/auth/accepted</code>
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Auth Declined URL (Optional)
              </label>
              <input
                type="url"
                value={config.ebay_auth_declined_url || ''}
                onChange={(e) => handleChange('ebay_auth_declined_url', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="https://your-ngrok-url.ngrok.io/auth/declined"
              />
              <p className="text-xs text-gray-500 mt-1">
                Optional. Where eBay redirects after user declines authorization. If left blank, eBay uses its default page.
                <br />
                <strong>For local dev:</strong> Use your ngrok URL + <code className="bg-gray-100 px-1 rounded">/auth/declined</code>
              </p>
            </div>
          </div>
          
          {/* eBay OAuth Connection */}
          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h4 className="text-sm font-semibold text-gray-900 mb-2">Connect eBay Account (OAuth 2.0)</h4>
            <p className="text-xs text-gray-600 mb-3">
              Connect your eBay seller account using OAuth 2.0. This is required for accessing seller inventory and listings.
              You can connect multiple eBay accounts.
            </p>
            <div className="flex items-center space-x-3">
              <button
                type="button"
                onClick={handleConnectEbay}
                disabled={!config.ebay_app_id || !config.ebay_cert_id || connectingEbay}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm font-medium flex items-center space-x-2"
              >
                {connectingEbay ? (
                  <>
                    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>Connecting...</span>
                  </>
                ) : (
                  <span>Connect eBay Account ({config.ebay_sandbox !== false ? 'Sandbox' : 'Production'})</span>
                )}
              </button>
              {ebayUsers.length > 0 && (
                <div className="text-sm text-gray-600">
                  {ebayUsers.length} account{ebayUsers.length !== 1 ? 's' : ''} connected
                </div>
              )}
            </div>
            
            {/* Connected eBay Users */}
            {ebayUsers.length > 0 && (
              <div className="mt-3 space-y-2">
                {ebayUsers.map(user => (
                  <div key={user.id} className="flex items-center justify-between p-2 bg-white rounded border border-gray-200">
                    <div>
                      <span className="text-sm font-medium text-gray-900">{user.ebay_user_id}</span>
                      <span className={`ml-2 text-xs px-2 py-0.5 rounded ${user.sandbox ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}`}>
                        {user.sandbox ? 'Sandbox' : 'Production'}
                      </span>
                      {user.token_expired && (
                        <span className="ml-2 text-xs text-red-600">Token Expired</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDisconnectEbay(user.id)}
                      className="text-sm text-red-600 hover:text-red-800"
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ShareTribe Configuration */}
        <div>
          <h3 className="text-lg font-semibold mb-4">ShareTribe API Configuration</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Client ID
              </label>
              <input
                type="text"
                value={config.sharetribe_api_key}
                onChange={(e) => handleChange('sharetribe_api_key', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter ShareTribe Client ID"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Client Secret
              </label>
              <input
                type="password"
                value={config.sharetribe_api_secret}
                onChange={(e) => handleChange('sharetribe_api_secret', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter ShareTribe Client Secret"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Marketplace API Client ID <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={config.sharetribe_marketplace_api_client_id}
                onChange={(e) => handleChange('sharetribe_marketplace_api_client_id', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Marketplace API Client ID (for Asset Delivery API)"
              />
              <p className="mt-1 text-xs text-gray-500">
                Required for fetching listing types, categories, and fields. Get this from ShareTribe Console → Integrations → Marketplace API.
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Marketplace ID
              </label>
              <input
                type="text"
                value={config.sharetribe_marketplace_id}
                onChange={(e) => {
                  const value = e.target.value;
                  // If it looks like a URL, extract the marketplace ID
                  if (value.includes('console.sharetribe.com')) {
                    const match = value.match(/\/m\/([^\/]+)/);
                    if (match && match[1]) {
                      handleChange('sharetribe_marketplace_id', match[1]);
                    } else {
                      handleChange('sharetribe_marketplace_id', value);
                    }
                  } else {
                    handleChange('sharetribe_marketplace_id', value);
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Paste ShareTribe Console URL (e.g., https://console.sharetribe.com/o/org/m/marketplace-id/...)"
              />
              <p className="mt-1 text-xs text-gray-500">
                Paste your ShareTribe Console URL and the Marketplace ID will be extracted automatically. Or enter the Marketplace ID directly (the part after <code className="bg-gray-100 px-1 rounded">/m/</code> in the URL).
              </p>
              <p className="mt-2 text-xs text-blue-600">
                <strong>Note:</strong> Use your ShareTribe Client ID and Client Secret from the Console → Integrations section.
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                User ID (Author)
              </label>
              <input
                type="text"
                value={config.sharetribe_user_id}
                onChange={(e) => handleChange('sharetribe_user_id', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter ShareTribe User ID (UUID)"
              />
              <p className="mt-1 text-xs text-gray-500">
                The User ID (UUID) of the ShareTribe user account that will be listed as the author/owner of the products. This is a one-time developer setup. You can find user IDs in the ShareTribe Console → Users section.
              </p>
            </div>
          </div>
        </div>

        {/* ShareTribe Users Management */}
        <div className="mt-8">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="text-lg font-semibold">ShareTribe Users</h3>
              <p className="text-sm text-gray-500 mt-1">
                Manage users who can have products synced on their behalf. API credentials are shared from above.
              </p>
            </div>
            <button
              onClick={() => {
                setEditingUser(null);
                setUserForm({
                  name: '',
                  sharetribe_user_id: '',
                  location: '',
                  pickup_enabled: true,
                  shipping_enabled: true,
                  shipping_measurement: 'custom',
    parcel: '',
                  transaction_process_alias: 'default-purchase/release-1',
                  unit_type: 'item',
                  default_image_id: null
                });
                setShowUserForm(true);
              }}
              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Plus size={18} />
              <span>Add User</span>
            </button>
          </div>

          {showUserForm && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
              <h4 className="font-medium mb-4">{editingUser ? 'Edit' : 'Add'} ShareTribe User</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text"
                    value={userForm.name || ''}
                    onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    placeholder="User display name"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">ShareTribe User</label>
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <select
                        value={selectedApiUser?.id || ''}
                        onChange={(e) => {
                          const userId = e.target.value;
                          const user = shareTribeApiUsers.find(u => u.id === userId);
                          setSelectedApiUser(user || null);
                          if (user) {
                            setUserForm({ ...userForm, sharetribe_user_id: user.id });
                          }
                        }}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg"
                        disabled={loadingApiUsers}
                      >
                        <option value="">Select a user from ShareTribe...</option>
                        {shareTribeApiUsers.map(user => (
                          <option key={user.id} value={user.id}>
                            {user.profile?.displayName || user.email || user.id}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={async () => {
                          setLoadingApiUsers(true);
                          try {
                            const response = await queryShareTribeUsers();
                            if (response.data?.success && response.data?.users) {
                              setShareTribeApiUsers(response.data.users);
                            }
                          } catch (error) {
                            console.error('Error querying ShareTribe users:', error);
                            alert('Failed to fetch users from ShareTribe: ' + (error.response?.data?.error || error.message));
                          } finally {
                            setLoadingApiUsers(false);
                          }
                        }}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400"
                        disabled={loadingApiUsers}
                      >
                        {loadingApiUsers ? 'Loading...' : 'Refresh Users'}
                      </button>
                    </div>
                    {selectedApiUser && (
                      <div className="mt-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
                        <div className="space-y-1 text-sm">
                          <div><strong>Name:</strong> {selectedApiUser.profile?.displayName || 'N/A'}</div>
                          <div><strong>Email:</strong> {selectedApiUser.email || 'N/A'}</div>
                          <div><strong>User ID:</strong> <code className="text-xs bg-white px-1 py-0.5 rounded">{selectedApiUser.id}</code></div>
                          {selectedApiUser.stripeAccountId && (
                            <div><strong>Stripe Account ID:</strong> {selectedApiUser.stripeAccountId}</div>
                          )}
                          {Object.keys(selectedApiUser.publicData || {}).length > 0 && (
                            <div className="mt-2">
                              <strong>Public Data:</strong>
                              <div className="ml-4 mt-1 space-y-1">
                                {Object.entries(selectedApiUser.publicData).map(([key, value]) => (
                                  <div key={key} className="text-xs">
                                    <code className="bg-white px-1 py-0.5 rounded">{key}</code>: {String(value)}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <input
                      type="text"
                      value={userForm.sharetribe_user_id || ''}
                      onChange={(e) => {
                        setUserForm({ ...userForm, sharetribe_user_id: e.target.value });
                        setSelectedApiUser(null); // Clear selection when manually typing
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      placeholder="Or manually enter User UUID"
                    />
                  </div>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Location (JSON) - Address details for listings
                  </label>
                  <textarea
                    value={userForm.location ? (typeof userForm.location === 'string' ? userForm.location : JSON.stringify(userForm.location, null, 2)) : ''}
                    onChange={(e) => {
                      try {
                        // Try to parse and reformat JSON for better UX
                        const parsed = JSON.parse(e.target.value);
                        setUserForm({ ...userForm, location: JSON.stringify(parsed, null, 2) });
                      } catch {
                        // If invalid JSON, just store the raw string
                        setUserForm({ ...userForm, location: e.target.value });
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm"
                    placeholder='{"street1": "38 Rowan Drive", "address": "38 Rowan Drive, Maldon, CM9 4BW, United Kingdom", "city": "Maldon", "postcode": "CM9 4BW", "state": "England", "country": "gb", ...}'
                    rows={8}
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    JSON object with address details. This location will be automatically included in all listings synced for this user. Leave empty if not needed.
                  </p>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Parcel (JSON) - Shipping dimensions and weight details
                  </label>
                  <textarea
                    value={userForm.parcel ? (typeof userForm.parcel === 'string' ? userForm.parcel : JSON.stringify(userForm.parcel, null, 2)) : ''}
                    onChange={(e) => {
                      try {
                        // Try to parse and reformat JSON for better UX
                        const parsed = JSON.parse(e.target.value);
                        setUserForm({ ...userForm, parcel: JSON.stringify(parsed, null, 2) });
                      } catch {
                        // If invalid JSON, just store the raw string
                        setUserForm({ ...userForm, parcel: e.target.value });
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm"
                    rows={8}
                    placeholder='{"contactName": "Tyler", "parcelHeight": 28, "email": "support@motogarage.co.nz", "parcelLength": 38, "shippingMeasurement": "recommended", "massUnit": "kg", "parcelWeight": 2.3, "distanceUnit": "cm", "parcelWidth": 30, "phoneNumber": "07398178774", "company": null}'
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    JSON object with shipping parcel details (dimensions, weight, contact info). This parcel data will be automatically included in publicData for all listings synced for this user. Leave empty if not needed.
                  </p>
                </div>
                
                {/* Listing Configuration Fields */}
                <div className="md:col-span-2 border-t border-gray-200 pt-4 mt-4">
                  <h5 className="text-sm font-semibold text-gray-700 mb-3">Listing Configuration (Required Fields)</h5>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Pickup Enabled
                      </label>
                      <select
                        value={userForm.pickup_enabled ? 'true' : 'false'}
                        onChange={(e) => setUserForm({ ...userForm, pickup_enabled: e.target.value === 'true' })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="true">True</option>
                        <option value="false">False</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Shipping Enabled
                      </label>
                      <select
                        value={userForm.shipping_enabled ? 'true' : 'false'}
                        onChange={(e) => setUserForm({ ...userForm, shipping_enabled: e.target.value === 'true' })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="true">True</option>
                        <option value="false">False</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Shipping Measurement
                      </label>
                      <select
                        value={userForm.shipping_measurement || 'custom'}
                        onChange={(e) => setUserForm({ ...userForm, shipping_measurement: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="custom">custom</option>
                        <option value="recommended">recommended</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Transaction Process Alias
                      </label>
                      <input
                        type="text"
                        value={userForm.transaction_process_alias || ''}
                        onChange={(e) => setUserForm({ ...userForm, transaction_process_alias: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                        placeholder="default-purchase/release-1"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Unit Type
                      </label>
                      <input
                        type="text"
                        value={userForm.unit_type || ''}
                        onChange={(e) => setUserForm({ ...userForm, unit_type: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                        placeholder="item"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Default Image
                      </label>
                      <div className="flex items-center space-x-4">
                        {userForm.default_image_id && (
                          <div className="text-sm text-gray-600">
                            Image ID: <code className="bg-gray-100 px-2 py-1 rounded">{userForm.default_image_id}</code>
                          </div>
                        )}
                        <input
                          type="file"
                          accept="image/*"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            
                            if (editingUser) {
                              setUploadingImage(true);
                              try {
                                const response = await uploadUserImage(editingUser.id, file);
                                setUserForm({ ...userForm, default_image_id: response.data.imageId });
                                alert('Image uploaded successfully!');
                                await loadShareTribeUsers();
                              } catch (error) {
                                alert('Error uploading image: ' + (error.response?.data?.error || error.message));
                              } finally {
                                setUploadingImage(false);
                                e.target.value = ''; // Reset file input
                              }
                            } else {
                              alert('Please save the user first before uploading an image.');
                              e.target.value = '';
                            }
                          }}
                          disabled={!editingUser || uploadingImage}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                        {uploadingImage && <span className="text-sm text-gray-500">Uploading...</span>}
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        Upload a default image that will be used for listings when no image is available. The image will be uploaded to ShareTribe and its ID will be stored.
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    These fields will be automatically included in all listings synced for this user.
                  </p>
                </div>
              </div>
              <div className="flex justify-end space-x-2 mt-4">
                <button
                  onClick={() => {
                    setShowUserForm(false);
                    setEditingUser(null);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    try {
                      if (editingUser) {
                        await updateShareTribeUser(editingUser.id, userForm);
                        alert('User updated successfully!');
                      } else {
                        await createShareTribeUser(userForm);
                        alert('User added successfully!');
                      }
                      await loadShareTribeUsers();
                      setShowUserForm(false);
                      setEditingUser(null);
                      setUserForm({
                        name: '',
                        sharetribe_user_id: '',
                        location: '',
                        pickup_enabled: true,
                        shipping_enabled: true,
                        shipping_measurement: 'custom',
    parcel: '',
                        transaction_process_alias: 'default-purchase/release-1',
                        unit_type: 'item',
                        default_image_id: null,
                        default_image_path: null
                      });
                    } catch (error) {
                      alert('Error saving user: ' + (error.response?.data?.error || error.message));
                    }
                  }}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  {editingUser ? 'Update' : 'Add'} User
                </button>
              </div>
            </div>
          )}

          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">User ID</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">eBay Account</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {shareTribeUsers.length === 0 ? (
                  <tr>
                    <td colSpan="4" className="px-6 py-4 text-center text-gray-500">
                      No ShareTribe users configured. Click "Add User" to create one.
                    </td>
                  </tr>
                ) : (
                  shareTribeUsers.map(user => (
                    <tr key={user.id}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{user.name}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">{user.sharetribe_user_id}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        {user.ebay_user_id ? (
                          <div className="flex items-center space-x-2">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              <CheckCircle size={12} className="mr-1" />
                              Connected ({user.ebay_user_id})
                            </span>
                            <button
                              onClick={async () => {
                                if (!confirm(`Are you sure you want to disconnect the eBay account "${user.ebay_user_id}" from this ShareTribe user?`)) {
                                  return;
                                }
                                try {
                                  await disassociateEbayUser(user.id);
                                  alert('eBay account disconnected successfully');
                                  await loadShareTribeUsers();
                                } catch (error) {
                                  console.error('Error disconnecting eBay account:', error);
                                  alert('Failed to disconnect eBay account: ' + (error.response?.data?.error || error.message));
                                }
                              }}
                              className="text-xs text-red-600 hover:text-red-800 underline"
                              title="Remove eBay account association"
                            >
                              Disconnect
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            <button
                              onClick={() => handleConnectEbay(user.sharetribe_user_id)}
                              disabled={!config.ebay_app_id || !config.ebay_cert_id || !config.ebay_redirect_uri}
                              className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium bg-blue-100 text-blue-800 hover:bg-blue-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
                            >
                              Connect eBay Account
                            </button>
                            {ebayUsers.length > 0 && (
                              <select
                                onChange={async (e) => {
                                  if (e.target.value && e.target.value !== '') {
                                    try {
                                      await associateEbayUser(user.id, e.target.value);
                                      alert('eBay account associated successfully!');
                                      await loadShareTribeUsers();
                                    } catch (error) {
                                      alert('Failed to associate: ' + (error.response?.data?.error || error.message));
                                    }
                                    e.target.value = '';
                                  }
                                }}
                                className="text-xs px-2 py-1 border border-gray-300 rounded mt-1"
                                defaultValue=""
                              >
                                <option value="">Or select existing eBay account...</option>
                                {ebayUsers.map(ebayUser => (
                                  <option key={ebayUser.ebay_user_id} value={ebayUser.ebay_user_id}>
                                    {ebayUser.ebay_user_id} ({ebayUser.sandbox ? 'Sandbox' : 'Production'})
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <button
                          onClick={() => {
                            setEditingUser(user);
                            setUserForm({
                              name: user.name,
                              sharetribe_user_id: user.sharetribe_user_id,
                              location: user.location ? (typeof user.location === 'string' ? user.location : JSON.stringify(user.location, null, 2)) : '',
                              pickup_enabled: user.pickup_enabled !== undefined ? user.pickup_enabled : true,
                              shipping_enabled: user.shipping_enabled !== undefined ? user.shipping_enabled : true,
                              shipping_measurement: user.shipping_measurement || 'custom',
                        parcel: user.parcel ? (typeof user.parcel === 'string' ? user.parcel : JSON.stringify(user.parcel, null, 2)) : '',
                              transaction_process_alias: user.transaction_process_alias || 'default-purchase/release-1',
                              unit_type: user.unit_type || 'item',
                              default_image_id: user.default_image_id || null
                            });
                            setShowUserForm(true);
                          }}
                          className="text-blue-600 hover:text-blue-900 mr-3"
                        >
                          <Edit2 size={16} className="inline" />
                        </button>
                        <button
                          onClick={async () => {
                            if (window.confirm(`Are you sure you want to delete ${user.name}?`)) {
                              try {
                                await deleteShareTribeUser(user.id);
                                await loadShareTribeUsers();
                                alert('User deleted successfully!');
                              } catch (error) {
                                alert('Error deleting user: ' + (error.response?.data?.error || error.message));
                              }
                            }
                          }}
                          className="text-red-600 hover:text-red-900"
                        >
                          <Trash2 size={16} className="inline" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading}
            className="flex items-center space-x-2 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            <Save size={18} />
            <span>{loading ? 'Saving...' : 'Save Configuration'}</span>
          </button>
        </div>
      </form>

      {/* Popup Blocked Modal */}
      {popupBlockedUrl && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              ⚠️ Popup Blocked
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              Please allow popups for this site and try again, or copy the URL below and open it manually:
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                eBay Authorization URL:
              </label>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  readOnly
                  value={popupBlockedUrl}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-sm font-mono"
                  onClick={(e) => e.target.select()}
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(popupBlockedUrl);
                    alert('URL copied to clipboard!');
                  }}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
                >
                  Copy
                </button>
              </div>
            </div>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setPopupBlockedUrl(null)}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm font-medium"
              >
                Close
              </button>
              <button
                onClick={() => {
                  window.open(popupBlockedUrl, '_blank', 'noopener,noreferrer');
                  setPopupBlockedUrl(null);
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
              >
                Open URL
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApiConfigTab;

