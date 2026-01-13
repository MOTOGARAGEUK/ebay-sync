// Simple in-memory store for ShareTribe API responses
// Stores the last 50 responses for debugging

class ResponseStore {
  constructor() {
    this.responses = [];
    this.maxSize = 50;
  }

  addResponse(responseData) {
    this.responses.unshift(responseData); // Add to beginning
    if (this.responses.length > this.maxSize) {
      this.responses = this.responses.slice(0, this.maxSize);
    }
  }

  getResponses(limit = 50) {
    return this.responses.slice(0, limit);
  }

  getResponseByListingId(listingId) {
    return this.responses.find(r => r.listingId === listingId);
  }

  clear() {
    this.responses = [];
  }
}

// Export singleton instance
module.exports = new ResponseStore();



