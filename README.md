# SC-gpt

A personal, read-only SoundCloud MCP server for an MCP-compatible assistant.

Unofficial community project. Not affiliated with SoundCloud.

## Tools

| Tool | What it does |
| --- | --- |
| `search_tracks` | Search public SoundCloud tracks |
| `search_playlists` | Search public playlists |
| `get_playlist` | Read a public playlist and its tracks |
| `get_my_playlists` | List playlists from the connected account |
| `get_my_likes` | List liked tracks from the connected account |

This first version is read-only. It cannot upload, like, follow, repost, comment, create playlists, or modify your library.

## Deploy on Render

1. In Render, choose **New > Blueprint** and select `Lh29007/SC-gpt`.
2. Deploy the service. Render will generate `MCP_API_KEY` and `AUTH_SETUP_KEY`.
3. Open the service's **Environment** page and set:
   - `SOUNDCLOUD_CLIENT_ID`
   - `SOUNDCLOUD_CLIENT_SECRET`
   - `SOUNDCLOUD_REDIRECT_URI` to `https://YOUR-SERVICE.onrender.com/auth/callback`
4. Open your SoundCloud app settings at <https://soundcloud.com/you/apps/> and register that exact redirect URI.
5. Redeploy if Render asks you to.

The callback URL must match exactly in both places. Use the actual public URL shown by Render; do not assume the service name is the URL.

## Connect your SoundCloud account

1. Open `https://YOUR-SERVICE.onrender.com/auth/start` in a browser.
2. When the browser asks for HTTP Basic Authentication, use any username and the value of `AUTH_SETUP_KEY` as the password.
3. Sign in to SoundCloud and approve the app.
4. You should see **SoundCloud connected!**

The server uses OAuth 2.1 Authorization Code with PKCE and refreshes expiring tokens automatically. Tokens are kept in server memory in this first version. A Render free instance can sleep or restart, which clears the session; if that happens, connect again using `/auth/start`.

## Connect an MCP client

- Transport: Streamable HTTP
- Endpoint: `https://YOUR-SERVICE.onrender.com/mcp`
- Header: `Authorization: Bearer YOUR_MCP_API_KEY`

Treat both keys as passwords. Never commit them, paste them into public issues, or share screenshots containing them.

MCP client support varies by product and account plan. Hosting this endpoint does not automatically make custom MCP connections available in every ChatGPT plan.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env
# Fill in the SoundCloud app credentials and local redirect URI.
npm start
```

Register `http://localhost:3000/auth/callback` in your SoundCloud app for local testing. The local MCP endpoint is `http://localhost:3000/mcp`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `SOUNDCLOUD_CLIENT_ID` | SoundCloud application Client ID |
| `SOUNDCLOUD_CLIENT_SECRET` | SoundCloud application secret |
| `SOUNDCLOUD_REDIRECT_URI` | Exact OAuth callback URL registered with SoundCloud |
| `MCP_API_KEY` | Bearer key required for MCP requests in production |
| `AUTH_SETUP_KEY` | Password protecting the browser login-start page |
| `PORT` | HTTP port; Render sets this automatically |

## Security and limitations

- Keep the Render service and its secrets under your control.
- The MCP endpoint is protected by a bearer key; the OAuth start page has separate Basic Auth protection.
- OAuth tokens are memory-only in this MVP. Restarting the service requires reconnecting SoundCloud.
- The server is read-only by design.
- SoundCloud API behavior and rate limits may change.
- Render's free service may sleep when idle and take time to wake up.
