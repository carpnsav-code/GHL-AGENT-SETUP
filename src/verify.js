#!/usr/bin/env node
import { GHLClient } from './client.js';
import { loadConfig, loadDotEnv, ConfigError } from './config.js';

// Each probe is a read-only call that proves one scope is actually granted.
const PROBES = [
  { scope: 'locations.readonly', label: 'Account / location', run: (c) => c.getLocation() },
  { scope: 'contacts.readonly', label: 'Contacts', run: (c) => c.listContacts({ limit: 1 }) },
  { scope: 'users.readonly', label: 'Users', run: (c) => c.listUsers() },
  { scope: 'locations/customFields.readonly', label: 'Custom fields', run: (c) => c.listCustomFields() },
  { scope: 'locations/tags.readonly', label: 'Tags', run: (c) => c.listTags() },
  { scope: 'opportunities.readonly', label: 'Pipelines', run: (c) => c.listPipelines() },
  { scope: 'conversations.readonly', label: 'Conversations', run: (c) => c.searchConversations({ limit: 1 }) },
  { scope: 'calendars.readonly', label: 'Calendars', run: (c) => c.listCalendars() },
];

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function main() {
  loadDotEnv();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${bad('✗')} ${error.message}`);
      console.error(`  ${dim(error.hint)}`);
      process.exit(2);
    }
    throw error;
  }

  console.log('GoHighLevel connection check');
  console.log(`  endpoint    ${config.baseUrl}`);
  console.log(`  token       ${config.tokenFingerprint} (${config.tokenKind})`);
  console.log(`  location    ${config.locationId}`);
  console.log('');

  const client = new GHLClient(config);

  // Step 1: does the token authenticate at all?
  let location;
  try {
    location = await client.getLocation();
  } catch (error) {
    console.error(`${bad('✗ Connection failed')} — ${error.message}`);
    if (error.hint) console.error(`  ${dim(error.hint)}`);
    process.exit(1);
  }

  const name = location?.location?.name ?? location?.name ?? '(unnamed)';
  console.log(`${ok('✓ Connected')} to "${name}"`);
  const details = location?.location ?? location ?? {};
  for (const key of ['companyId', 'timezone', 'country', 'email', 'website']) {
    if (details[key]) console.log(`  ${key.padEnd(11)} ${details[key]}`);
  }
  console.log('');

  // Step 2: which capabilities does this token actually have?
  console.log('Granted scopes:');
  const granted = [];
  const missing = [];

  for (const probe of PROBES) {
    try {
      await probe.run(client);
      granted.push(probe.scope);
      console.log(`  ${ok('✓')} ${probe.label.padEnd(16)} ${dim(probe.scope)}`);
    } catch (error) {
      // 401/403 means the scope is absent; anything else is a real fault.
      const denied = error.status === 401 || error.status === 403;
      missing.push({ ...probe, error });
      const mark = denied ? warn('–') : bad('✗');
      const note = denied ? 'not granted' : `${error.status ?? 'error'}: ${error.message}`;
      console.log(`  ${mark} ${probe.label.padEnd(16)} ${dim(probe.scope)} ${dim(`(${note})`)}`);
    }
  }

  console.log('');
  console.log(`${granted.length}/${PROBES.length} capabilities available.`);
  if (missing.length) {
    console.log(
      dim('Add missing scopes in GoHighLevel: Settings -> Private Integrations -> edit the token.'),
    );
  }
}

main().catch((error) => {
  console.error(`${bad('✗ Unexpected error')} — ${error.message}`);
  process.exit(1);
});
