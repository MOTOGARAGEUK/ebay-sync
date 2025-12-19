const axios = require('axios');
const crypto = require('crypto');

class eBayOAuthService {
  constructor(config) {
    this.appId = config.appId; // Client ID
    this.certId = config.certId; // Client Secret
    this.devId = config.devId;
    this.sandbox = config.sandbox !== false; // Default to sandbox
    this.redirectUri = config.redirectUri || 'http://localhost:3001/api/auth/ebay/callback';
    this.ruName = config.ruName || null; // RuName for token exchange (if different from redirectUri)
    
    // eBay OAuth URLs - eBay uses /oauth2/authorize endpoint
    this.authBaseUrl = this.sandbox 
      ? 'https://auth.sandbox.ebay.com' 
      : 'https://auth.ebay.com';
    this.apiBaseUrl = this.sandbox 
      ? 'https://api.sandbox.ebay.com' 
      : 'https://api.ebay.com';
  }

  /**
   * Generate OAuth authorization URL
   * @param {string} state - CSRF protection state token
   * @param {Array<string>} scopes - OAuth scopes (default: seller inventory read/write)
   * @returns {string} Authorization URL
   */
  getAuthorizationUrl(state, scopes = [
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account.readonly' // For getting user info
  ]) {
    // Note: eBay may require scopes to be requested exactly as they appear in Developer Portal
    // If you get invalid_scope error, verify the scope is enabled in:
    // eBay Developer Portal → My Account → Application Keys → Your App → OAuth Scopes
    // eBay OAuth 2.0 uses /oauth2/authorize endpoint
    // redirect_uri can be either:
    // 1. A full HTTPS URL (for production/ngrok)
    // 2. A RuName identifier (registered in eBay Developer Portal)
    // If redirectUri looks like a RuName (contains underscores/dashes, no https://), use it as-is
    // Otherwise, use it as a URL
    
    let redirectUriParam = this.redirectUri;
    
    // Check if it's a RuName (typically contains underscores/dashes and no protocol)
    if (!this.redirectUri.startsWith('http://') && !this.redirectUri.startsWith('https://')) {
      // It's a RuName - use as-is
      redirectUriParam = this.redirectUri;
    } else {
      // It's a URL - use as-is
      redirectUriParam = this.redirectUri;
    }
    
    // Ensure scopes are valid eBay OAuth scope URLs
    const validScopes = scopes.filter(scope => 
      scope.startsWith('https://api.ebay.com/oauth/api_scope/')
    );
    
    if (validScopes.length === 0) {
      throw new Error('No valid eBay OAuth scopes provided');
    }
    
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: redirectUriParam,
      response_type: 'code',
      scope: validScopes.join(' '),
      state: state
    });

    const authUrl = `${this.authBaseUrl}/oauth2/authorize?${params.toString()}`;
    console.log('🔗 eBay Authorization URL:', authUrl);
    console.log('📋 Requested scopes:', validScopes);
    console.log('🔗 Redirect URI type:', redirectUriParam.startsWith('http') ? 'Full URL' : 'RuName');
    console.log('🔗 Redirect URI value:', redirectUriParam);
    console.log('🔗 Client ID:', this.appId);
    console.log('🔗 Sandbox mode:', this.sandbox);
    
    return authUrl;
  }

  /**
   * Exchange authorization code for access token
   * @param {string} code - Authorization code from callback
   * @returns {Promise<Object>} Token response with access_token, refresh_token, expires_in
   */
  async exchangeCodeForToken(code) {
    try {
      // Create Basic Auth header (App ID:Client Secret base64 encoded)
      const credentials = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');
      
      // IMPORTANT: The redirect_uri in token exchange must be the RuName, not the ngrok URL
      // If we have a separate ruName, use it. Otherwise, if redirectUri is not a URL, it's a RuName
      let redirectUriParam = this.ruName || this.redirectUri;
      
      // If redirectUri is a full URL but we don't have ruName, try to use redirectUri as-is
      // But ideally, ruName should be provided separately
      if (this.redirectUri.startsWith('http://') || this.redirectUri.startsWith('https://')) {
        if (!this.ruName) {
          console.warn('⚠️ Redirect URI is a full URL but no RuName provided. Using redirectUri as-is.');
          console.warn('⚠️ This may fail if eBay requires RuName for token exchange.');
          redirectUriParam = this.redirectUri;
        } else {
          redirectUriParam = this.ruName;
        }
      }
      
      console.log('🔄 Exchanging code for token');
      // IMPORTANT: eBay token endpoint is on the API domain, not auth domain
      // Format: https://api.sandbox.ebay.com/identity/v1/oauth2/token
      const tokenEndpoint = `${this.apiBaseUrl}/identity/v1/oauth2/token`;
      console.log('📤 Token endpoint:', tokenEndpoint);
      console.log('📤 Using redirect_uri:', redirectUriParam.startsWith('http') ? redirectUriParam : 'RuName: ' + redirectUriParam);
      console.log('📤 Code (first 30 chars):', code ? code.substring(0, 30) + '...' : 'missing');
      
      // eBay OAuth 2.0 token endpoint is on the API domain: /identity/v1/oauth2/token
      const response = await axios.post(
        tokenEndpoint,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: redirectUriParam // Must be RuName if RuName was used in auth request
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`
          }
        }
      );

      return {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_in: response.data.expires_in,
        token_type: response.data.token_type || 'Bearer'
      };
    } catch (error) {
      console.error('Error exchanging code for token:', error.response?.data || error.message);
      throw new Error(`Failed to exchange authorization code: ${error.response?.data?.error_description || error.message}`);
    }
  }

  /**
   * Refresh access token using refresh token
   * @param {string} refreshToken - Refresh token
   * @returns {Promise<Object>} New token response
   */
  async refreshAccessToken(refreshToken) {
    try {
      // Create Basic Auth header (App ID:Client Secret base64 encoded)
      const credentials = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');
      
      // eBay OAuth 2.0 token endpoint is on the API domain: /identity/v1/oauth2/token
      const tokenEndpoint = `${this.apiBaseUrl}/identity/v1/oauth2/token`;
      const response = await axios.post(
        tokenEndpoint,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory'
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`
          }
        }
      );

      return {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token || refreshToken, // eBay may not return new refresh token
        expires_in: response.data.expires_in,
        token_type: response.data.token_type || 'Bearer'
      };
    } catch (error) {
      console.error('Error refreshing token:', error.response?.data || error.message);
      throw new Error(`Failed to refresh access token: ${error.response?.data?.error_description || error.message}`);
    }
  }

  /**
   * Get user info from eBay API
   * @param {string} accessToken - Access token
   * @returns {Promise<Object>} User info including eBay user ID
   */
  async getUserInfo(accessToken) {
    try {
      // Try multiple endpoints to get user info
      // First try: /sell/account/v1/account (requires sell.account scope)
      try {
        const response = await axios.get(
          `${this.apiBaseUrl}/sell/account/v1/account`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log('✅ Got user info from /sell/account/v1/account:', response.data);
        
        // Extract username from account response
        const username = response.data.accountRegistration?.username || 
                        response.data.username || 
                        response.data.userId ||
                        null;

        return {
          ebay_user_id: username,
          email: response.data.accountRegistration?.email || response.data.email || null,
          account_type: response.data.accountRegistration?.accountType || response.data.accountType || null
        };
      } catch (accountError) {
        console.warn('⚠️ /sell/account/v1/account failed, trying /commerce/identity/v1/user:', accountError.response?.status, accountError.response?.data);
        
        // Fallback: Try /commerce/identity/v1/user (requires commerce.identity scope)
        const response = await axios.get(
          `${this.apiBaseUrl}/commerce/identity/v1/user`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log('✅ Got user info from /commerce/identity/v1/user:', response.data);
        
        return {
          ebay_user_id: response.data.username || response.data.userId || null,
          email: response.data.email || null,
          account_type: response.data.accountType || null
        };
      }
    } catch (error) {
      console.error('❌ Error getting user info from all endpoints');
      console.error('❌ Status:', error.response?.status);
      console.error('❌ Data:', error.response?.data);
      console.error('❌ Message:', error.message);
      
      // Return a fallback - we'll try to get username from token or other means
      // For now, return null and let the caller handle it
      throw new Error(`Failed to get user info: ${error.response?.data?.error_description || error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Generate a random state token for CSRF protection
   * @returns {string} Random state token
   */
  generateStateToken() {
    return crypto.randomBytes(32).toString('hex');
  }
}

module.exports = eBayOAuthService;

