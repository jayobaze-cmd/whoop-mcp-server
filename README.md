# Whoop MCP Server

A Model Context Protocol (MCP) server that connects your Whoop health data to Claude. Designed to be hosted remotely and used as a custom connector in Claude.ai.

Built using the [Whoop Developer API v2](https://developer.whoop.com/docs/introduction).

## Features

- **Recovery Data**: Daily recovery scores, HRV, resting heart rate, SpO2, skin temperature
- **Sleep Analysis**: Sleep duration, stages, efficiency, performance, respiratory rate
- **Strain Tracking**: Daily strain scores, calories burned, heart rate zones
- **Workout History**: All logged workouts with detailed metrics
- **Auto-Sync**: Automatically keeps data fresh with smart sync logic
- **90-Day History**: Maintains local cache of your health data for trend analysis

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_today` | Morning briefing with recovery, sleep, and strain |
| `get_recovery_trends` | Recovery patterns over time with HRV/RHR |
| `get_sleep_analysis` | Sleep quality trends and stage breakdowns |
| `get_strain_history` | Training load and calorie trends |
| `sync_data` | Manually trigger a data sync |
| `get_auth_url` | Get authorization URL for Whoop connection |

## Setup

### 1. Create a Whoop Developer App

1. Go to [developer.whoop.com](https://developer.whoop.com)
2. Create a new application
3. Note your **Client ID** and **Client Secret**
4. Set the redirect URI to your deployed server's callback URL (e.g., `https://your-app.railway.app/callback`)

### 2. Deploy to Railway

1. Fork/push this repo to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo
4. Add environment variables:
   - `WHOOP_CLIENT_ID`: Your Whoop app client ID
   - `WHOOP_CLIENT_SECRET`: Your Whoop app client secret
   - `WHOOP_REDIRECT_URI`: `https://your-app.railway.app/callback`
5. Add a volume mounted at `/data` for persistent SQLite storage
6. Deploy!

### 3. Connect to Claude

1. Visit `https://your-app.railway.app/health` to verify it's running
2. Go to Claude.ai settings → Connectors
3. Click "Add custom connector"
4. Enter:
   - **Name**: Whoop
   - **Remote MCP server URL**: `https://your-app.railway.app/mcp`
5. Claude will open the authorization flow — log in to Whoop and approve access
6. The initial 90-day sync begins automatically. Use it in any chat!

The server implements the MCP authorization spec: OAuth 2.0 discovery metadata (RFC 8414 / RFC 9728), dynamic client registration (RFC 7591), and an authorization-code flow with PKCE that chains into Whoop's own OAuth login. Claude never sees your Whoop credentials or tokens — it receives a separate bearer token issued by this server.

### OAuth Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/oauth-protected-resource` | Protected resource metadata (RFC 9728) |
| `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `POST /register` | Dynamic client registration (RFC 7591) |
| `GET /authorize` | Authorization endpoint (redirects to Whoop login) |
| `POST /token` | Token endpoint (authorization_code + refresh_token, PKCE S256) |
| `GET /callback` | Whoop OAuth callback (both connector and manual flows) |

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cat > .env << EOF
WHOOP_CLIENT_ID=your_client_id
WHOOP_CLIENT_SECRET=your_client_secret
WHOOP_REDIRECT_URI=http://localhost:3000/callback
MCP_MODE=http
EOF

# Run in development mode
npm run dev
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WHOOP_CLIENT_ID` | Whoop OAuth client ID | Required |
| `WHOOP_CLIENT_SECRET` | Whoop OAuth client secret | Required |
| `WHOOP_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/callback` |
| `DB_PATH` | SQLite database path | `./whoop.db` |
| `PORT` | HTTP server port | `3000` |
| `MCP_MODE` | `http` for remote, `stdio` for local | `http` |
| `PUBLIC_BASE_URL` | Public URL used in OAuth metadata (defaults to the request host) | — |
| `MCP_ALLOW_UNAUTHENTICATED` | Set to `true` to disable bearer auth on `/mcp` | `false` |

## Architecture

**The live server runs on Railway, not on your local machine.** Your local
clone of this repo is the *deploy source* — you edit it, commit, and push, and
Railway rebuilds and runs it. The running server, your Whoop tokens, and ~90
days of synced health data all live in a SQLite database on Railway's `/data`
volume. There is no local database or local copy of your data.

```
  Claude.ai (chat / custom connector)
        │   HTTPS + OAuth → https://<your-app>.up.railway.app/mcp
        ▼
┌─────────────────────────────────────────────────┐
│            RAILWAY  (the live server)            │
│                                                  │
│  ┌─────────────┐      ┌──────────────────────┐  │
│  │ MCP Server  │◄────►│  SQLite (/data volume)│  │
│  │ + OAuth     │      │  - cycles / recovery  │  │
│  │ (HTTP)      │      │  - sleep / workouts   │  │
│  └─────────────┘      │  - whoop tokens       │  │
│         │             │  - oauth clients/tokens│  │
│         ▼             └──────────────────────┘  │
│  ┌─────────────┐                                 │
│  │ Whoop API   │ → api.prod.whoop.com            │
│  │ Client      │                                 │
│  └─────────────┘                                 │
└─────────────────────────────────────────────────┘
        ▲
        │  git push  (rebuild & redeploy)
┌─────────────────────────────────────────────────┐
│  Local repo (C:\...\whoop-mcp-server)            │
│  Source code only — does NOT run, has NO data.   │
│  edit → git commit → git push → Railway deploys  │
└─────────────────────────────────────────────────┘
```

**Building automation on top of this?** Reach the data the same way Claude
does — call the MCP tools through the Railway URL — or run the new job *inside*
the Railway service so it shares the same database and Whoop tokens. Don't
assume a local database or local Whoop credentials; they only exist on Railway.

## API Endpoints Used

This server uses the following Whoop API v2 endpoints:

- `GET /v2/user/profile/basic` - User profile
- `GET /v2/user/measurement/body` - Body measurements
- `GET /v2/cycle` - Physiological cycles (strain data)
- `GET /v2/recovery` - Recovery scores
- `GET /v2/activity/sleep` - Sleep records
- `GET /v2/activity/workout` - Workout records

## License

MIT - See [LICENSE](LICENSE) for details.
