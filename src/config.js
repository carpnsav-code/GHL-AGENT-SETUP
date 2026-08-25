import { existsSync } from 'node:fs';

const DEFAULTS = {
  baseUrl: 'https://services.leadconnectorhq.com',
  apiVersion: '2021-07-28',
};

// Node >=21.7 can read a .env file natively. Absent file is not an error --
// in deployment the variables normally come from the process environment.
export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return false;
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    return false;
  }
}

export class ConfigError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

/**
 * Reads and validates the GHL credentials. Never returns the raw token in any
 * field intended for logging -- use `tokenKind` / `tokenFingerprint` instead.
 */
export function loadConfig(env = process.env) {
  const token = (env.GHL_API_TOKEN ?? '').trim();
  const locationId = (env.GHL_LOCATION_ID ?? '').trim();

  if (!token) {
    throw new ConfigError(
      'GHL_API_TOKEN is not set.',
      'Create a Private Integration Token in GoHighLevel (Settings -> Private Integrations) and set it in .env',
    );
  }
  if (!locationId) {
    throw new ConfigError(
      'GHL_LOCATION_ID is not set.',
      'Copy the Location ID from GoHighLevel (Settings -> Business Profile) and set it in .env',
    );
  }

  return {
    token,
    locationId,
    baseUrl: (env.GHL_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
    apiVersion: env.GHL_API_VERSION ?? DEFAULTS.apiVersion,
    tokenKind: classifyToken(token),
    tokenFingerprint: fingerprint(token),
  };
}

// Private Integration Tokens are prefixed `pit-`; OAuth access tokens are JWTs.
export function classifyToken(token) {
  if (token.startsWith('pit-')) return 'private-integration-token';
  if (token.split('.').length === 3) return 'oauth-access-token';
  return 'unknown';
}

// A safe, non-reversible way to refer to a specific token in logs.
export function fingerprint(token) {
  return `***${token.slice(-4)}`;
}

export { DEFAULTS };
