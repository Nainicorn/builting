import aws from './aws.js';

const rendersService = {
  async getRenders() {
    return await aws.call('/api/renders', { method: 'GET' });
  },

  async getRender(renderId) {
    return await aws.call(`/api/renders/${renderId}`, { method: 'GET' });
  },

  async deleteRender(renderId) {
    return await aws.call(`/api/renders/${renderId}`, { method: 'DELETE' });
  },

  async getDownloadUrl(renderId, format = 'ifc') {
    const query = format !== 'ifc' ? `?format=${format}` : '';
    return await aws.call(`/api/renders/${renderId}/download${query}`, { method: 'GET' });
  },

  async getSourceFile(renderId, fileName) {
    return await aws.call(`/api/renders/${renderId}/sources/${encodeURIComponent(fileName)}`, { method: 'GET' });
  },

  async getVerificationReport(renderId) {
    return await aws.call(`/api/renders/${renderId}/report`, { method: 'GET' });
  },

  // Alias used by pipeline trace polling — returns { report, pipelineTrace }
  async getReport(renderId) {
    return await aws.call(`/api/renders/${renderId}/report`, { method: 'GET' });
  },

  async retryRender(renderId) {
    return await aws.call(`/api/renders/${renderId}/retry`, { method: 'POST' });
  },

  async refineRender(renderId, refinement) {
    return await aws.call(`/api/renders/${renderId}/refine`, {
      method: 'POST',
      body: JSON.stringify({ refinement })
    });
  },

  async getDiagnosticsUrl(renderId) {
    return await aws.call(`/api/renders/${renderId}/diagnostics`, { method: 'GET' });
  }
};

export default rendersService;
