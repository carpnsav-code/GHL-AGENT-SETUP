# GHL Agent Setup

Connection layer between this agent and a GoHighLevel (LeadConnector) sub-account.
Zero dependencies — built on the Node 20+ built-in `fetch`.

## Setup

1. **Create a Private Integration Token** in GoHighLevel:
   `Settings → Private Integrations → Create new integration`.
   Grant at minimum the read scopes below, plus any write scopes the agent needs.

2. **Copy your Location ID** from `Settings → Business Profile`.

3. **Configure credentials:**

   ```bash
   cp .env.example .env
   # then fill in GHL_API_TOKEN and GHL_LOCATION_ID
   ```

   `.env` is gitignored. In deployment, set the same variables in the process
   environment instead and skip the file entirely.

4. **Verify the connection:**

   ```bash
   npm run verify
   ```

   This authenticates, prints the connected account, then probes every API group
   to report which scopes the token actually has. It exits non-zero if the
   connection fails, so it works as a CI or startup health check.

5. **Inspect the account structure:**

   ```bash
   npm run describe
   ```

   Prints pipelines and their stage IDs, calendars, custom fields, tags and users —
   the identifiers needed to address records. Contacts are reported as a count only,
   so no personal data reaches the terminal or logs.

## Usage

```js
import { createClient } from './src/index.js';

const ghl = createClient();

const { contacts } = await ghl.listContacts({ limit: 10 });
const contact = await ghl.createContact({ firstName: 'Ada', email: 'ada@example.com' });
await ghl.updateContact(contact.contact.id, { tags: ['referral partner'] });

const { pipelines } = await ghl.listPipelines();
await ghl.sendMessage({ contactId: contact.contact.id, type: 'SMS', message: 'Hi!' });
```

Anything not covered by a helper goes through `request` directly:

```js
await ghl.request('/opportunities/', {
  method: 'POST',
  body: { locationId: ghl.locationId, pipelineId, name: 'New job' },
});
```

## Scopes probed by `npm run verify`

| Capability    | Scope                             |
| ------------- | --------------------------------- |
| Account       | `locations.readonly`              |
| Contacts      | `contacts.readonly`               |
| Users         | `users.readonly`                  |
| Custom fields | `locations/customFields.readonly` |
| Tags          | `locations/tags.readonly`         |
| Pipelines     | `opportunities.readonly`          |
| Conversations | `conversations.readonly`          |
| Calendars     | `calendars.readonly`              |

Write operations (`contacts.write`, `conversations/message.write`,
`opportunities.write`) are not probed, because probing them would create records.
Add them to the token when the agent needs to make changes.

## Notes

- **Version headers.** GoHighLevel pins each API group to a different `Version`
  date — Conversations and Calendars use `2021-04-15`, everything else
  `2021-07-28`. Sending the wrong one returns a misleading 404 or 422, so
  `API_VERSIONS` in `src/client.js` maps them per group.
- **Rate limits.** Burst limit is 100 requests / 10s per location. The client
  retries `429` and `5xx` with exponential backoff, honouring `Retry-After`.
- **Errors.** Failures throw `GHLError` carrying `status`, `body` and a `hint`
  that explains the likely cause (missing scope vs. expired token vs. wrong
  location).
- **Secrets.** The token is never logged. `config.tokenFingerprint` gives a safe
  last-4 reference for diagnostics.

## Files

| Path              | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `src/config.js`   | Credential loading and validation              |
| `src/client.js`   | API client: auth, retry, errors, helpers       |
| `src/verify.js`   | Connection check and scope prober              |
| `src/describe.js` | Account structure summary                      |
| `src/index.js`    | Public exports                                 |
