// AWS Service - Route to correct API endpoint
import cookieService from './cookieService.js';

const API_BASE_URL = "https://b665o7k8bc.execute-api.us-gov-east-1.amazonaws.com/prod";

const aws = {
  getBaseUrl() {
    return API_BASE_URL;
  },

  // Make authenticated API calls
  async call(endpoint, options = {}) {
    const url = `${this.getBaseUrl()}${endpoint}`;
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };

    // Send auth token via Authorization header (cross-origin cookies won't work)
    const token = cookieService.get('builting-user');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      headers,
      ...options,
    });

    // 401 on the auth endpoint = wrong credentials, not session expiry
    if (response.status === 401) {
      const isAuthEndpoint = endpoint === '/api/auth';
      const errBody = await response.json().catch(() => ({}));
      if (!isAuthEndpoint) {
        cookieService.delete('builting-user');
        window.location.href = '/';
      }
      throw new Error(errBody.error || errBody.message || (isAuthEndpoint ? 'Invalid credentials.' : 'Session expired. Please log in again.'));
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `API error: ${response.status}`);
    }

    return response.json();
  },
};

export default aws;
