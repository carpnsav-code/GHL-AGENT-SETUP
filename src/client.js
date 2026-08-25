import { loadConfig, fingerprint } from './config.js';

// GoHighLevel pins each API group to a different `Version` header date.
// Sending the wrong one yields a confusing 404/422, so map them explicitly.
export const API_VERSIONS = {
  contacts: '2021-07-28',
  locations: '2021-07-28',
  opportunities: '2021-07-28',
  users: '2021-07-28',
  forms: '2021-07-28',
  workflows: '2021-07-28',
  conversations: '2021-04-15',
  calendars: '2021-04-15',
};

export class GHLError extends Error {
  constructor(message, { status, statusText, body, path, method } = {}) {
    super(message);
    this.name = 'GHLError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.path = path;
    this.method = method;
  }

  // Turns the raw API failure into something a human can act on.
  get hint() {
    switch (this.status) {
      case 401:
        return 'Token is missing, expired, or malformed. Regenerate the Private Integration Token.';
      case 403:
        return 'Token is valid but lacks the scope for this endpoint. Add the scope in Private Integrations and reissue the token.';
      case 404:
        return 'Resource or location not found. Check GHL_LOCATION_ID, and that the token belongs to that sub-account.';
      case 422:
        return 'Request was rejected as invalid. Check required fields and the Version header for this API group.';
      case 429:
        return 'Rate limited. The client already retries; sustained 429s mean the burst limit (100 req/10s) is being exceeded.';
      default:
        return null;
    }
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GHLClient {
  constructor(config = loadConfig(), { maxRetries = 3, timeoutMs = 30_000 } = {}) {
    this.config = config;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
  }

  get locationId() {
    return this.config.locationId;
  }

  headers(version = this.config.apiVersion) {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Version: version,
      Accept: 'application/json',
    };
  }

  /**
   * Single entry point for every call. Handles query building, JSON encoding,
   * timeouts, retry-with-backoff and error normalisation.
   */
  async request(path, { method = 'GET', query, body, version, headers = {} } = {}) {
    const url = new URL(this.config.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const init = {
      method,
      headers: { ...this.headers(version), ...headers },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.backoffMs(attempt, lastError));

      let response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (cause) {
        // Network failure or timeout -- retryable.
        lastError = new GHLError(`Network error calling ${method} ${path}: ${cause.message}`, {
          path,
          method,
        });
        if (attempt === this.maxRetries) throw lastError;
        continue;
      }

      const payload = await this.parseBody(response);

      if (response.ok) return payload;

      lastError = new GHLError(
        this.errorMessage(response, payload, method, path),
        {
          status: response.status,
          statusText: response.statusText,
          body: payload,
          path,
          method,
        },
      );
      lastError.retryAfter = Number(response.headers.get('retry-after')) || undefined;

      if (!RETRYABLE.has(response.status) || attempt === this.maxRetries) throw lastError;
    }

    throw lastError;
  }

  async parseBody(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  errorMessage(response, payload, method, path) {
    const detail =
      (payload && typeof payload === 'object' && (payload.message ?? payload.error)) ||
      (typeof payload === 'string' ? payload.slice(0, 200) : '') ||
      response.statusText;
    const text = Array.isArray(detail) ? detail.join('; ') : detail;
    return `${method} ${path} failed with ${response.status}: ${text}`;
  }

  backoffMs(attempt, lastError) {
    if (lastError?.retryAfter) return lastError.retryAfter * 1000;
    // Exponential backoff with jitter: ~500ms, 1s, 2s.
    const base = 500 * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * 250);
  }

  // ---- Account -----------------------------------------------------------

  getLocation(locationId = this.locationId) {
    return this.request(`/locations/${locationId}`, { version: API_VERSIONS.locations });
  }

  listUsers(locationId = this.locationId) {
    return this.request('/users/', {
      query: { locationId },
      version: API_VERSIONS.users,
    });
  }

  listCustomFields(locationId = this.locationId) {
    return this.request(`/locations/${locationId}/customFields`, {
      version: API_VERSIONS.locations,
    });
  }

  listTags(locationId = this.locationId) {
    return this.request(`/locations/${locationId}/tags`, { version: API_VERSIONS.locations });
  }

  // ---- Contacts ----------------------------------------------------------

  listContacts({ limit = 20, startAfterId, startAfter, query } = {}) {
    return this.request('/contacts/', {
      query: { locationId: this.locationId, limit, startAfterId, startAfter, query },
      version: API_VERSIONS.contacts,
    });
  }

  getContact(contactId) {
    return this.request(`/contacts/${contactId}`, { version: API_VERSIONS.contacts });
  }

  createContact(contact) {
    return this.request('/contacts/', {
      method: 'POST',
      body: { locationId: this.locationId, ...contact },
      version: API_VERSIONS.contacts,
    });
  }

  updateContact(contactId, updates) {
    return this.request(`/contacts/${contactId}`, {
      method: 'PUT',
      body: updates,
      version: API_VERSIONS.contacts,
    });
  }

  // ---- Pipelines & opportunities ----------------------------------------

  listPipelines() {
    return this.request('/opportunities/pipelines', {
      query: { locationId: this.locationId },
      version: API_VERSIONS.opportunities,
    });
  }

  searchOpportunities({ limit = 20, pipelineId, status } = {}) {
    return this.request('/opportunities/search', {
      query: { location_id: this.locationId, limit, pipeline_id: pipelineId, status },
      version: API_VERSIONS.opportunities,
    });
  }

  // ---- Conversations -----------------------------------------------------

  searchConversations({ limit = 20 } = {}) {
    return this.request('/conversations/search', {
      query: { locationId: this.locationId, limit },
      version: API_VERSIONS.conversations,
    });
  }

  sendMessage({ contactId, type = 'SMS', message, ...rest }) {
    return this.request('/conversations/messages', {
      method: 'POST',
      body: { type, contactId, message, ...rest },
      version: API_VERSIONS.conversations,
    });
  }

  // ---- Calendars ---------------------------------------------------------

  listCalendars() {
    return this.request('/calendars/', {
      query: { locationId: this.locationId },
      version: API_VERSIONS.calendars,
    });
  }

  toString() {
    return `GHLClient(location=${this.locationId}, token=${fingerprint(this.config.token)})`;
  }
}

export function createClient(options) {
  return new GHLClient(loadConfig(), options);
}
