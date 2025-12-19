import React, { useState, useEffect } from 'react';
import ProductsTab from './components/ProductsTab';
import SyncLogsTab from './components/SyncLogsTab';
import ApiConfigTab from './components/ApiConfigTab';
import FieldMappingTab from './components/FieldMappingTab';
import PrivacyPolicy from './components/PrivacyPolicy';
import AuthAccepted from './components/AuthAccepted';
import AuthDeclined from './components/AuthDeclined';
import { Package, FileText, Settings, ArrowLeftRight } from 'lucide-react';

function App() {
  const [activeTab, setActiveTab] = useState('products');

  const tabs = [
    { id: 'products', label: 'Products & Sync', icon: Package },
    { id: 'logs', label: 'Sync Logs', icon: FileText },
    { id: 'config', label: 'API Configuration', icon: Settings },
    { id: 'mapping', label: 'Field Mapping', icon: ArrowLeftRight },
  ];

  // Check if we're on a special route
  const path = window.location.pathname;
  if (path === '/privacy-policy') {
    return <PrivacyPolicy />;
  }
  if (path === '/auth/accepted') {
    return <AuthAccepted />;
  }
  if (path === '/auth/declined') {
    return <AuthDeclined />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <h1 className="text-2xl font-bold text-gray-900">
            eBay to ShareTribe Sync
          </h1>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Tabs */}
        <div className="border-b border-gray-200 mb-6">
          <nav className="-mb-px flex space-x-8">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`
                    flex items-center space-x-2 py-4 px-1 border-b-2 font-medium text-sm
                    ${
                      activeTab === tab.id
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }
                  `}
                >
                  <Icon size={18} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Tab Content */}
        <div>
          {activeTab === 'products' && <ProductsTab />}
          {activeTab === 'logs' && <SyncLogsTab />}
          {activeTab === 'config' && <ApiConfigTab />}
          {activeTab === 'mapping' && <FieldMappingTab />}
        </div>
      </div>
    </div>
  );
}

export default App;


