import React from 'react';
import { XCircle } from 'lucide-react';

const AuthDeclined = () => {
  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white shadow rounded-lg p-8 text-center">
          <XCircle className="mx-auto h-16 w-16 text-red-500 mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 mb-4">Authorization Declined</h1>
          <p className="text-gray-600 mb-6">
            You have declined to authorize the eBay account connection.
          </p>
          <p className="text-sm text-gray-500">
            You can safely close this window and return to the application.
          </p>
        </div>
      </div>
    </div>
  );
};

export default AuthDeclined;

