# nail

A Nostr mail bridge and web client that lets users send and receive email via Nostr.

Licensed under the [MIT License](LICENSE).

---

## What's in this repo

| Directory | Description |
|-----------|-------------|
| `nostr-bridge/` | Node.js LMTP server that translates between email and Nostr events |
| `client/` | React web UI for managing your Nostr mail identity |
| `landing/` | Marketing landing page |
| `e2e-nostr/` | End-to-end test suite (Vitest + mock relay) |

---

## How it integrates with mailcow

`nail` runs as a sidecar to a [mailcow-dockerized](https://github.com/mailcow/mailcow-dockerized) deployment. It does **not** modify mailcow's source — it only connects via standard protocols:

- **Inbound**: Postfix routes matching domains to the bridge via LMTP (`lmtp:inet:nostr-bridge:2400`)
- **Outbound**: The bridge injects replies back into Postfix via SMTP on port 25

### Adding nail to your mailcow docker-compose

In your mailcow `docker-compose.yml`, add:

```yaml
nostr-bridge:
  build: ${NOSTR_BRIDGE_PATH:-./nostr-bridge}
  container_name: nostr-bridge-mailcow
  restart: always
  env_file: .env
  environment:
    - BRIDGE_DOMAIN=${NOSTR_BRIDGE_DOMAIN:-nostr-forward.local}
    - POSTFIX_HOST=postfix
    - POSTFIX_PORT=25
  networks:
    mailcow-network:
      aliases:
        - nostr-bridge
```

Set `NOSTR_BRIDGE_PATH` in your mailcow `.env` to the absolute path of `nail/nostr-bridge`, for example:

```
NOSTR_BRIDGE_PATH=/opt/nail/nostr-bridge
NOSTR_BRIDGE_NSEC=nsec1...
NOSTR_BRIDGE_DOMAIN=mail.yourdomain.com
```

### Postfix transport routing

Add the following to your Postfix `custom_transport.pcre` (inside mailcow's `data/conf/postfix/`):

```
/@yourdomain\.com$/    lmtp:inet:nostr-bridge:2400
```

Then reload Postfix inside its container.

---

## Development

Run the bridge + a mock Nostr relay locally (no mailcow needed):

```bash
cp .env.example .env   # fill in NOSTR_BRIDGE_NSEC
docker compose up -d --build
```

Run the E2E test suite:

```bash
cd e2e-nostr
pnpm install
RELAY_URL=ws://127.0.0.1:4600 pnpm test
```
