import express from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
const ACCESS_TOKEN = process.env.SOUNDCLOUD_ACCESS_TOKEN;
const MCP_API_KEY = process.env.MCP_API_KEY;

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.type("text").send("SC-gpt MCP server is running. Connect an MCP client to /mcp.");
});
app.get("/health", (_req, res) => res.json({ ok: true, service: "sc-gpt" }));

function authorized(req) {
  // Require an API key whenever one has been configured.
  if (!MCP_API_KEY) return process.env.NODE_ENV !== "production";
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(MCP_API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.use("/mcp", (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized. Set the MCP bearer token." });
  next();
});

function requireClientId() {
  if (!CLIENT_ID) throw new Error("SOUNDCLOUD_CLIENT_ID is not configured on the server.");
}

async function soundcloud(path, params = {}, { user = false } = {}) {
  requireClientId();
  if (user && !ACCESS_TOKEN) {
    throw new Error("This tool needs a SoundCloud user token. Configure SOUNDCLOUD_ACCESS_TOKEN in the server environment.");
  }

  const url = new URL(`https://api-v2.soundcloud.com${path}`);
  url.searchParams.set("client_id", CLIENT_ID);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const headers = { Accept: "application/json" };
  if (user) headers.Authorization = `OAuth ${ACCESS_TOKEN}`;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  if (!response.ok) {
    const detail = body.slice(0, 500);
    throw new Error(`SoundCloud API returned HTTP ${response.status}: ${detail}`);
  }
  try { return JSON.parse(body); }
  catch { throw new Error("SoundCloud returned an unexpected response."); }
}

function compactTrack(track) {
  return {
    id: track.id,
    urn: track.urn,
    title: track.title,
    artist: track.user?.username,
    permalink_url: track.permalink_url,
    duration_ms: track.duration,
    playback_count: track.playback_count,
    likes_count: track.likes_count
  };
}

function compactPlaylist(playlist) {
  return {
    id: playlist.id,
    urn: playlist.urn,
    title: playlist.title,
    creator: playlist.user?.username,
    permalink_url: playlist.permalink_url,
    track_count: playlist.track_count
  };
}

function result(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function buildServer() {
  const server = new McpServer({ name: "sc-gpt", version: "0.1.0" });

  server.tool(
    "search_tracks",
    "Search public SoundCloud tracks.",
    { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) },
    async ({ query, limit }) => {
      const data = await soundcloud("/search/tracks", { q: query, limit });
      return result((data.collection || []).map(compactTrack));
    }
  );

  server.tool(
    "search_playlists",
    "Search public SoundCloud playlists.",
    { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) },
    async ({ query, limit }) => {
      const data = await soundcloud("/search/playlists", { q: query, limit });
      return result((data.collection || []).map(compactPlaylist));
    }
  );

  server.tool(
    "get_playlist",
    "Get a public SoundCloud playlist and its track listing.",
    { playlist_id: z.union([z.string(), z.number()]) },
    async ({ playlist_id }) => {
      const data = await soundcloud(`/playlists/${encodeURIComponent(String(playlist_id))}`);
      return result({
        ...compactPlaylist(data),
        tracks: (data.tracks || []).map(compactTrack)
      });
    }
  );

  server.tool(
    "get_my_playlists",
    "List playlists belonging to the connected SoundCloud account. Requires SOUNDCLOUD_ACCESS_TOKEN.",
    { limit: z.number().int().min(1).max(50).default(25) },
    async ({ limit }) => {
      const data = await soundcloud("/me/playlists", { limit }, { user: true });
      return result((data.collection || data || []).map(compactPlaylist));
    }
  );

  server.tool(
    "get_my_likes",
    "List liked tracks from the connected SoundCloud account. Requires SOUNDCLOUD_ACCESS_TOKEN.",
    { limit: z.number().int().min(1).max(50).default(25) },
    async ({ limit }) => {
      const data = await soundcloud("/me/likes/tracks", { limit }, { user: true });
      const items = data.collection || data || [];
      return result(items.map((item) => compactTrack(item.track || item)));
    }
  );

  return server;
}

app.all("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SC-gpt MCP server listening on port ${PORT}`);
  if (!CLIENT_ID) console.warn("SOUNDCLOUD_CLIENT_ID is not configured yet.");
  if (!ACCESS_TOKEN) console.warn("SOUNDCLOUD_ACCESS_TOKEN is not configured; personal-library tools will return setup guidance.");
});
