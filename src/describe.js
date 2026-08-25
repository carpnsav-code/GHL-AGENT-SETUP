#!/usr/bin/env node
// Prints the structural shape of the connected sub-account -- the pipelines,
// stages, calendars, custom fields and tags an agent needs to address records.
// Deliberately reports counts only for contacts/conversations so no personal
// data is written to the terminal or logs.
import { createClient } from './index.js';
import { loadDotEnv } from './config.js';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const list = (payload, ...keys) => {
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return Array.isArray(payload) ? payload : [];
};

async function safe(label, fn) {
  try {
    return await fn();
  } catch (error) {
    console.log(`${bold(label)}\n  ${dim(`unavailable — ${error.message}`)}\n`);
    return null;
  }
}

async function main() {
  loadDotEnv();
  const client = createClient();

  const location = await safe('Account', () => client.getLocation());
  const details = location?.location ?? location ?? {};
  console.log(bold('Account'));
  console.log(`  ${details.name ?? '(unnamed)'}  ${dim(client.locationId)}`);
  console.log(`  ${dim(`${details.timezone ?? '?'} · ${details.country ?? '?'}`)}\n`);

  const pipelines = await safe('Pipelines', () => client.listPipelines());
  if (pipelines) {
    const items = list(pipelines, 'pipelines');
    console.log(bold(`Pipelines (${items.length})`));
    for (const pipeline of items) {
      console.log(`  ${pipeline.name}  ${dim(pipeline.id)}`);
      for (const stage of pipeline.stages ?? []) {
        console.log(`    ${dim('·')} ${stage.name} ${dim(stage.id)}`);
      }
    }
    console.log('');
  }

  const calendars = await safe('Calendars', () => client.listCalendars());
  if (calendars) {
    const items = list(calendars, 'calendars');
    console.log(bold(`Calendars (${items.length})`));
    for (const calendar of items) {
      console.log(`  ${calendar.name}  ${dim(calendar.id)}`);
    }
    console.log('');
  }

  const fields = await safe('Custom fields', () => client.listCustomFields());
  if (fields) {
    const items = list(fields, 'customFields');
    console.log(bold(`Custom fields (${items.length})`));
    for (const field of items) {
      console.log(`  ${field.name} ${dim(`${field.dataType ?? '?'} · ${field.fieldKey ?? field.id}`)}`);
    }
    console.log('');
  }

  const tags = await safe('Tags', () => client.listTags());
  if (tags) {
    const items = list(tags, 'tags');
    console.log(bold(`Tags (${items.length})`));
    console.log(`  ${items.map((t) => t.name).join(', ') || dim('none')}\n`);
  }

  const users = await safe('Users', () => client.listUsers());
  if (users) {
    const items = list(users, 'users');
    console.log(bold(`Users (${items.length})`));
    for (const user of items) {
      console.log(`  ${user.name ?? user.firstName} ${dim(user.roles?.role ?? '')}`);
    }
    console.log('');
  }

  // Counts only -- never the records themselves.
  const contacts = await safe('Contacts', () => client.listContacts({ limit: 1 }));
  if (contacts) {
    const total = contacts.meta?.total ?? contacts.total ?? list(contacts, 'contacts').length;
    console.log(`${bold('Contacts')}\n  ${total} total\n`);
  }
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
