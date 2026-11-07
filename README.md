# Mint Concrete

Two things live in this repository:

1. **The Mint Concrete crew app** (`app/`) — accounts, a clock in / clock out
   time clock, and the company group chat. Runs on phones as an installable
   web app. See [Crew app](#crew-app).
2. **The GoHighLevel agent connection layer** (`src/`) — see
   [GHL Agent Setup](#ghl-agent-setup).

Both are zero-dependency Node (22.13+): `npm install` has nothing to install.

## Crew app

```bash
npm run app            # http://localhost:3000
```

Open it on a phone, tap **Create account**, and you're in. The first account
created becomes the `owner`; everyone after that is `crew`.

### What it does

- **Accounts & one-time login.** Each crew member creates their own account.
  The login is remembered on that device for a year (and extends itself with
  use), so after the first time the app opens straight to their own view.
  Passwords are hashed with scrypt; only a hash of the session token is stored.
- **Clock in / clock out.** One tap to start, one to stop, with an optional job
  site note. Every shift is saved to the database. The screen shows the running
  shift timer, today's and this week's hours, who else is on the clock right
  now, and the person's recent shifts.
- **Mint Concrete group chat.** One company-wide chat for everyone. Messages
  are saved and delivered live (Server-Sent Events, with polling as a fallback).
  An unread badge shows on the chat tab.
- **Installable.** Includes a web app manifest and service worker, so crew can
  "Add to Home Screen" on iPhone or tap Install on Android and get an app icon.

### Settings

| Variable            | Default                     | Purpose                                                        |
| ------------------- | --------------------------- | -------------------------------------------------------------- |
| `PORT`              | `3000`                      | Port to listen on                                              |
| `MC_DB_FILE`        | `data/mint-concrete.sqlite` | SQLite database file (created automatically; gitignored)       |
| `MC_JOIN_CODE`      | _(none)_                    | When set, creating an account requires this code. Recommended. |
| `MC_SECURE_COOKIES` | _(auto)_                    | `1`/`0` to force the `Secure` cookie flag on/off               |

Set `MC_JOIN_CODE` before giving the URL to the crew so strangers can't make
accounts and read the chat. Put the app behind HTTPS (any reverse proxy such as
Caddy, nginx or a hosting platform works); the server honours
`X-Forwarded-Proto` to mark cookies `Secure`.

### API

All endpoints are JSON under `/api`. Authentication is the `mc_session` cookie
set at login, or `Authorization: Bearer <token>`.

| Method | Path                    | Purpose                                                   |
| ------ | ----------------------- | --------------------------------------------------------- |
| POST   | `/api/auth/register`    | `{username, displayName, password, joinCode?}`            |
| POST   | `/api/auth/login`       | `{username, password}` → `{user, token}` + cookie         |
| POST   | `/api/auth/logout`      | Ends the session                                          |
| GET    | `/api/auth/me`          | Current user                                              |
| GET    | `/api/team`             | Everyone with an account                                  |
| GET    | `/api/time/status`      | Your open shift and who is clocked in now                 |
| POST   | `/api/time/clock-in`    | `{note?}`                                                 |
| POST   | `/api/time/clock-out`   | `{note?}`                                                 |
| GET    | `/api/time/entries`     | Your shifts, newest first (`?limit=`)                     |
| GET    | `/api/chat/messages`    | Latest messages, or `?after=<id>` / `?before=<id>`        |
| POST   | `/api/chat/messages`    | `{body}`                                                  |
| GET    | `/api/chat/stream`      | Live events (`message`, `clock`) as Server-Sent Events     |

### Files

| Path                         | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `app/server.js`              | HTTP server, static files, startup              |
| `app/api.js`                 | API routes                                      |
| `app/auth.js`                | Password hashing, sessions, cookies             |
| `app/db.js`                  | SQLite schema and queries                       |
| `app/public/`                | The web app (HTML, CSS, JS, manifest, icons)    |
| `test/app.test.js`           | End-to-end API tests (`npm test`)               |

## GHL Agent Setup

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
