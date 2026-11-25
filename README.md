# SC-gpt

A small, **read-only** SoundCloud MCP server intended to let an MCP-compatible assistant search SoundCloud and inspect a connected account's playlists and likes.

Unofficial community project. Not affiliated with SoundCloud.

## Current tools

| Tool | Login required? |
| --- | --- |
| `search_tracks` | No |
| `search_playlists` | No |
| `get_playlist` | No (public playlists) |
| `get_my_playlists` | Yes |
| `get_my_likes` | Yes |

The server does not upload, like, follow, repost, comment, create playlists, or modify your library.

## Deploy on Render

1. In Render, choose **New > Blueprint** and select `Lh29007/SC-gpt`.
2. Create a SoundCloud application at <https://soundcloud.com/you/apps> and copy its Client ID.
3. In the Render service environment, set `SOUNDCLOUD_CLIENT_ID`.
4. Set `MCP_API_KEY` to a long random secret. The Render blueprint can generate one automatically.
5. Deploy. Render's health check is `/health`; the MCP endpoint is `/mcp`.

Keep the service private by treating the MCP API key like a password. Configure your MCP client to send:

```http
Authorization: Bearer YOUR_MCP_API_KEY
```

Do not put credentials in source code, commits, screenshots, or public issues.

## SoundCloud account access

Public search and public playlist reading only need the SoundCloud application Client ID.

Your own playlists and likes are private account data. Those tools additionally need a user OAuth access token in the Render environment variable `SOUNDCLOUD_ACCESS_TOKEN`. This first version does **not** implement the browser OAuth flow yet; do not expect private-library tools to work until a token has been obtained through a supported SoundCloud OAuth flow and configured securely.

Never paste a SoundCloud password, client secret, or access token into a GitHub file or chat. Use Render's Environment settings for secrets.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env
# Set SOUNDCLOUD_CLIENT_ID in .env
npm start
```

The server listens on `http://localhost:3000`. In local development, the API key can be omitted; in production, requests are rejected unless `MCP_API_KEY` is configured.

## MCP client connection

- Transport: Streamable HTTP
- Endpoint: `https://YOUR-RENDER-SERVICE.onrender.com/mcp`
- Header: `Authorization: Bearer YOUR_MCP_API_KEY`

MCP client support varies by product and account plan. Hosting this endpoint does not automatically make custom MCP connections available in every ChatGPT plan.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SOUNDCLOUD_CLIENT_ID` | Yes | SoundCloud application Client ID |
| `SOUNDCLOUD_ACCESS_TOKEN` | For private tools | OAuth access token for the account |
| `MCP_API_KEY` | Production | Protects the public MCP endpoint |
| `PORT` | No | HTTP port; Render sets this automatically |

## Limitations

- This is an early read-only MVP.
- Private account access requires a valid SoundCloud OAuth token.
- SoundCloud may change API behavior, scopes, or rate limits.
- A free Render service may sleep when idle and take time to wake up.
