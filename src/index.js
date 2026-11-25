import express from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
const CLIENT_SECRET = process.env.SOUNDCLOUD_CLIENT_SECRET;
const REDIRECT_URI = process.env.SOUNDCLOUD_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const MCP_API_KEY = process.env.MCP_API_KEY;
const AUTH_SETUP_KEY = process.env.AUTH_SETUP_KEY;
const AUTH_URL = "https://secure.soundcloud.com/authorize";
const TOKEN_URL = "https://secure.soundcloud.com/oauth/token";
const API_URL = "https://api.soundcloud.com";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Single-user, in-memory OAuth storage for this personal Render deployment.
// Render free instances can restart/sleep; if that happens, reconnect SoundCloud.
let userTokens = null;
let publicTokens = null;
const pendingAuth = new Map();

app.get("/", (_req, res) => {
  res.type("text").send("SC-gpt MCP server is running. MCP: /mcp | SoundCloud login: /auth/start");
});
app.get("/health", (_req, res) => res.json({ ok: true, service: "sc-gpt" }));

function authorized(req) {
  if (!MCP_API_KEY) return process.env.NODE_ENV !== "production";
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(MCP_API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.use("/mcp", (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized. Supply the MCP bearer token." });
  next();
});

function requireAppCredentials() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Set SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET in the server environment.");
  }
}

function base64url(buffer) {
  return buffer.toString("base64").replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}

async function tokenRequest(params, basicAuth = false) {
  requireAppCredentials();
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (basicAuth) {
    headers.Authorization = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers,
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`SoundCloud OAuth failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function getPublicToken() {
  if (publicTokens && publicTokens.expiresAt > Date.now() + 60000) return publicTokens.access_token;
  const tokens = await tokenRequest({ grant_type: "client_credentials" }, true);
  publicTokens = { ...tokens, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
  return publicTokens.access_token;
}

async function getUserToken() {
  if (!userTokens) throw new Error("SoundCloud is not connected. Open /auth/start on your Render service and approve access first.");
  if (userTokens.expiresAt > Date.now() + 60000) return userTokens.access_token;
  if (!userTokens.refresh_token) throw new Error("SoundCloud login expired. Reconnect at /auth/start.");
  const tokens = await tokenRequest({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: userTokens.refresh_token
  });
  userTokens = { ...tokens, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
  return userTokens.access_token;
}

async function soundcloud(path, params = {}, { user = false } = {}) {
  const token = user ? await getUserToken() : await getPublicToken();
  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { Accept: "application/json; charset=utf-8", Authorization: `OAuth ${token}` },
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`SoundCloud API returned HTTP ${response.status}: ${body.slice(0, 400)}`);
  try { return JSON.parse(body); }
  catch { throw new Error("SoundCloud returned an unexpected response."); }
}

app.get("/auth/start", (req, res) => {
  if (!AUTH_SETUP_KEY && process.env.NODE_ENV === "production") {
    return res.status(503).type("text").send("Set AUTH_SETUP_KEY in the server environment before connecting SoundCloud.");
  }
  if (AUTH_SETUP_KEY) {
    const header = req.headers.authorization || "";
    const supplied = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8").split(":").slice(1).join(":") : "";
    const a = Buffer.from(supplied);
    const b = Buffer.from(AUTH_SETUP_KEY);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.set("WWW-Authenticate", 'Basic realm="SC-gpt SoundCloud setup"');
      return res.status(401).type("text").send("Authentication required.");
    }
  }
  try {
    requireAppCredentials();
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    pendingAuth.set(state, { verifier, createdAt: Date.now() });
    for (const [key, value] of pendingAuth) {
      if (Date.now() - value.createdAt > 10 * 60 * 1000) pendingAuth.delete(key);
    }
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  } catch (error) {
    res.status(500).type("text").send(error.message);
  }
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).type("text").send(`SoundCloud authorization was not completed: ${String(error)}`);
  const pending = pendingAuth.get(String(state || ""));
  if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
    return res.status(400).type("text").send("Invalid or expired login state. Start again at /auth/start.");
  }
  pendingAuth.delete(String(state));
  if (typeof code !== "string") return res.status(400).type("text").send("SoundCloud did not return an authorization code.");
  try {
    const tokens = await tokenRequest({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
      code
    });
    userTokens = { ...tokens, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
    res.type("html").send("<h2>SoundCloud connected!</h2><p>You can close this page and use SC-gpt in your MCP client.</p>");
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    res.status(500).type("text").send("SoundCloud connection failed. Check server logs and try again.");
  }
});

app.post("/auth/disconnect", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    if (userTokens?.access_token) {
      await fetch(`${API_URL}/disconnect`, {
        method: "POST",
        headers: { Authorization: `OAuth ${userTokens.access_token}` },
        signal: AbortSignal.timeout(10000)
      });
    }
  } catch (error) {
    console.warn("SoundCloud disconnect request failed:", error.message);
  }
  userTokens = null;
  res.json({ ok: true, connected: false });
});

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
  const server = new McpServer({ name: "sc-gpt", version: "0.2.0" });

  server.tool("search_tracks", "Search public SoundCloud tracks.", {
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(20)
  }, async ({ query, limit }) => {
    const data = await soundcloud("/tracks", { q: query, limit, linked_partitioning: 1 });
    return result((data.collection || []).map(compactTrack));
  });

  server.tool("search_playlists", "Search public SoundCloud playlists.", {
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(20)
  }, async ({ query, limit }) => {
    const data = await soundcloud("/playlists", { q: query, limit, linked_partitioning: 1 });
    return result((data.collection || []).map(compactPlaylist));
  });

  server.tool("get_playlist", "Get a public SoundCloud playlist and its tracks.", {
    playlist_urn: z.string().min(1).max(200)
  }, async ({ playlist_urn }) => {
    const data = await soundcloud(`/playlists/${encodeURIComponent(playlist_urn)}`);
    return result({ ...compactPlaylist(data), tracks: (data.tracks || []).map(compactTrack) });
  });

  server.tool("get_my_playlists", "List playlists from the connected SoundCloud account.", {
    limit: z.number().int().min(1).max(50).default(25)
  }, async ({ limit }) => {
    const data = await soundcloud("/me/playlists", { limit, linked_partitioning: 1 }, { user: true });
    return result((data.collection || []).map(compactPlaylist));
  });

  server.tool("get_my_likes", "List liked tracks from the connected SoundCloud account.", {
    limit: z.number().int().min(1).max(50).default(25)
  }, async ({ limit }) => {
    const data = await soundcloud("/me/likes/tracks", { limit, linked_partitioning: 1 }, { user: true });
    return result((data.collection || []).map((item) => compactTrack(item.track || item)));
  });

  return server;
}

app.all("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
  if (!CLIENT_ID || !CLIENT_SECRET) console.warn("SoundCloud app credentials are not configured.");
});
