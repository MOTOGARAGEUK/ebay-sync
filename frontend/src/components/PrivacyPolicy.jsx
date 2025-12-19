import React from 'react';

const PrivacyPolicy = () => {
  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white shadow rounded-lg p-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-6">Privacy Policy</h1>
          <div className="prose max-w-none">
            <p className="text-gray-600 mb-4">
              This privacy policy page is required by eBay for OAuth integration.
            </p>
            <p className="text-gray-600 mb-4">
              <strong>Last Updated:</strong> {new Date().toLocaleDateString()}
            </p>
            <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-4">Data Collection</h2>
            <p className="text-gray-600 mb-4">
              This application collects and processes data from your eBay account for the purpose of syncing listings to ShareTribe.
            </p>
            <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-4">Data Usage</h2>
            <p className="text-gray-600 mb-4">
              Your eBay account data is used solely for the purpose of product synchronization and is not shared with third parties.
            </p>
            <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-4">Contact</h2>
            <p className="text-gray-600">
              For questions about this privacy policy, please contact the application administrator.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PrivacyPolicy;

