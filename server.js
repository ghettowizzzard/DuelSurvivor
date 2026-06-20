const express = require("express");
const compression = require("compression");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();

app.set("trust proxy", true);

app.use((req, res, next) => {
  const host = String(req.headers.host || "").toLowerCase();
  const forwardedProto = String(req.headers["x-forwarded-proto"] || req.protocol || "").toLowerCase();

  const isDuelioDomain = host === "duelio.lol" || host === "www.duelio.lol";
  const needsCanonicalHost = host === "www.duelio.lol";
  const needsHttps = isDuelioDomain && forwardedProto && forwardedProto !== "https";

  if (isDuelioDomain && (needsCanonicalHost || needsHttps)) {
    return res.redirect(301, `https://duelio.lol${req.originalUrl}`);
  }

  next();
});

const SOCKET_MAX_HTTP_BUFFER_SIZE = 256 * 1024;

function normalizeBrowserOrigin(rawOrigin) {
  const value = String(rawOrigin || "").trim();
  if (!value) return "";

  try {
    const url = new URL(value);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }

    return url.origin;
  } catch (err) {
    return "";
  }
}

function splitAllowedOrigins(value) {
  return String(value || "")
    .split(",")
    .map(normalizeBrowserOrigin)
    .filter(Boolean);
}

const GAME_ALLOWED_ORIGINS = new Set([
  "https://duelio.lol",
  "https://www.duelio.lol",

  // itch.io HTML5 game iframe origins.
  "https://html.itch.zone",
  "https://html-classic.itch.zone",

  // Game Jolt main host origins.
  "https://gamejolt.com",
  "https://www.gamejolt.com",

  // Optional extra verified origins set in Render.
  ...splitAllowedOrigins(process.env.GAME_ALLOWED_ORIGINS),

  // Allows your direct Render URL only when Render provides it.
  normalizeBrowserOrigin(process.env.RENDER_EXTERNAL_URL)
].filter(Boolean));

function isAllowedBrowserOrigin(rawOrigin) {
  const origin = normalizeBrowserOrigin(rawOrigin);
  if (!origin) return false;

  if (GAME_ALLOWED_ORIGINS.has(origin)) {
    return true;
  }

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    // Production browser connections must use HTTPS.
    if (url.protocol !== "https:") {
      return (
        process.env.NODE_ENV === "development" &&
        (host === "localhost" || host === "127.0.0.1" || host === "[::1]")
      );
    }

    // Allows Game Jolt-owned HTTPS subdomains, but not unrelated domains.
    return host.endsWith(".gamejolt.com");
  } catch (err) {
    return false;
  }
}

const GAME_CORS_OPTIONS = Object.freeze({
  origin(origin, callback) {
    // Requests without an Origin header can still read public HTTP routes,
    // but browser CORS permission is not granted.
    callback(null, !!origin && isAllowedBrowserOrigin(origin));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86400,
  optionsSuccessStatus: 204
});

app.use(cors(GAME_CORS_OPTIONS));
app.use(express.json());

function shouldCompressResponse(req, res) {
  if (req.headers["x-no-compression"] || req.headers.range) return false;
  if (req.path.startsWith("/socket.io/")) return false;

  return compression.filter(req, res);
}

app.use(compression({
  threshold: "1kb",
  level: 4,
  filter: shouldCompressResponse
}));

const publicDir = path.join(__dirname, "public");

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://duelio.lol/</loc>
    <lastmod>2026-06-17</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/play</loc>
    <lastmod>2026-06-17</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/play.html</loc>
    <lastmod>2026-06-17</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/how-to-play/</loc>
    <lastmod>2026-06-17</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/cards-and-creatures/</loc>
    <lastmod>2026-06-17</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/updates/</loc>
    <lastmod>2026-06-17</lastmod>
  </url>
</urlset>`;

app.get("/robots.txt", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send([
    "User-agent: *",
    "Allow: /",
    "",
    "Sitemap: https://duelio.lol/sitemap.xml",
    "Sitemap: https://duelio.lol/sitemap-index.xml"
  ].join("\n"));
});

app.get(["/sitemap.xml", "/sitemap-index.xml"], (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(SITEMAP_XML);
});

app.get("/sitemap.txt", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send([
    "https://duelio.lol/",
    "https://duelio.lol/play",
    "https://duelio.lol/play.html",
    "https://duelio.lol/how-to-play/",
    "https://duelio.lol/cards-and-creatures/",
    "https://duelio.lol/updates/"
  ].join("\n"));
});

const STATIC_FINGERPRINT_RE = /(?:^|[._-])[a-f0-9]{8,}(?:[._-]|$)/i;
const STATIC_CACHEABLE_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".mjs",
  ".map",
  ".json",
  ".wasm",
  ".data",
  ".bin",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".gif",
  ".svg",
  ".ico",
  ".mp3",
  ".ogg",
  ".wav",
  ".webm",
  ".mp4",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf"
]);

function setStaticCacheHeaders(res, filePath) {
  const filename = path.basename(filePath).toLowerCase();
  const extension = path.extname(filename).toLowerCase();

  // Your main single-file game is the current release manifest.
  // Always revalidate HTML so players never get trapped on an old release.
  if (
    extension === ".html" ||
    filename === "manifest.json" ||
    filename === "manifest.webmanifest"
  ) {
    res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
    return;
  }

  // A full-year cache is only safe for filename-hashed assets,
  // such as game.83b71a4c.js or background.2a9cd8ef.webp.
  if (STATIC_FINGERPRINT_RE.test(filename)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }

  // Your current unversioned files remain update-safe while still
  // benefiting from browser/CDN caching on repeat visits.
  if (STATIC_CACHEABLE_EXTENSIONS.has(extension)) {
    res.setHeader(
      "Cache-Control",
      "public, max-age=3600, stale-while-revalidate=86400"
    );
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
}

const DEFAULT_VOICE_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302"
];

function splitVoiceIceUrls(value) {
  return String(value || "")
    .split(",")
    .map(url => url.trim())
    .filter(Boolean);
}

function getVoiceIceConfig() {
  const stunUrls = splitVoiceIceUrls(process.env.VOICE_STUN_URLS);
  const turnUrls = splitVoiceIceUrls(process.env.VOICE_TURN_URLS);
  const turnUsername = String(process.env.VOICE_TURN_USERNAME || "").trim();
  const turnCredential = String(process.env.VOICE_TURN_CREDENTIAL || "").trim();

  const iceServers = [
    { urls: stunUrls.length ? stunUrls : DEFAULT_VOICE_STUN_URLS }
  ];

  if (turnUrls.length && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential
    });
  }

  return {
    iceServers,
    usingTurn: iceServers.length > 1
  };
}

app.get("/voice-config", (req, res) => {
  const config = getVoiceIceConfig();

  res.status(200);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    iceServers: config.iceServers,
    usingTurn: config.usingTurn,
    warning: config.usingTurn ? "" : "TURN is not configured. Voice can fail on strict NAT, mobile carrier, school, or workplace networks."
  });
});

if (!getVoiceIceConfig().usingTurn) {
  console.warn("[voice] TURN relay is not configured. WebRTC voice will fall back to public STUN only and may fail on strict NAT networks.");
}

app.use(express.static(publicDir, {
  cacheControl: false,
  etag: true,
  lastModified: true,
  setHeaders: setStaticCacheHeaders
}));

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: GAME_CORS_OPTIONS,

  // CORS headers alone do not stop every WebSocket handshake.
  // Reject browser connections not coming from approved game hosts.
  allowRequest(req, callback) {
    callback(null, isAllowedBrowserOrigin(req.headers.origin));
  },

  // Global per-message Socket.IO cap.
  // Large enough for sanitized world snapshots, but rejects oversized floods.
  maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,

  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 10000;

const players = new Map();
const idToSocket = new Map();
const parties = new Map();
const matches = new Map();
const leaderboardProfiles = new Map();

const PLAYER_SESSION_SECRET = String(process.env.PLAYER_SESSION_SECRET || "").trim();
const PLAYER_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 180;
const PLAYER_ID_BYTES = 18;
const MATCH_STATE_MIN_MS = 35;
const MATCH_MAX_MOVE_PER_SECOND = 420;
const MATCH_MOVE_GRACE_DISTANCE = 190;
const MATCH_WORLD_WIDTH = 7600;
const MATCH_WORLD_HEIGHT = 11200;
const MATCH_QUEUE_WORLD_SIZE = 1200;
const MATCH_MAX_DAMAGE_PACKET = 100;
const MATCH_DAMAGE_MIN_INTERVAL_MS = 95;
const MATCH_DAMAGE_BUDGET_WINDOW_MS = 1000;
const MATCH_DAMAGE_BUDGET_PER_WINDOW = 220;

const MATCH_ACTION_MAX_PAYLOAD_BYTES = 8 * 1024;
const MATCH_ACTION_CAST_ORIGIN_MAX_DISTANCE = 950;
const MATCH_ACTION_PING_EXTRA_RANGE = 280;
const MATCH_ACTION_REVIVE_RANGE = 135;
const MATCH_ACTION_AIRDROP_MIN_INTERVAL_MS = 90000;

const MATCH_ACTION_RULES = Object.freeze({
  monsterCast: { cooldownMs: 75, windowMs: 1000, maxInWindow: 12 },
  magicUse: { cooldownMs: 90, windowMs: 1000, maxInWindow: 10 },
  meleeSwing: { cooldownMs: 35, windowMs: 1000, maxInWindow: 28 },
  matchPing: { cooldownMs: 500, windowMs: 10000, maxInWindow: 8 },
  revivePlayer: { cooldownMs: 900, windowMs: 10000, maxInWindow: 3 },
  playerEmote: { cooldownMs: 550, windowMs: 10000, maxInWindow: 8 },
  airdropRoute: {
    cooldownMs: MATCH_ACTION_AIRDROP_MIN_INTERVAL_MS,
    windowMs: 120000,
    maxInWindow: 1
  }
});

const MATCH_ACTION_PING_TYPES = new Set([
  "move",
  "follow",
  "loot",
  "enemy",
  "danger",
  "revive",
  "building",
  "storm"
]);

const MATCH_ACTION_EMOTE_IDS = new Set([
  "heart",
  "heart_eyes",
  "smile_devil",
  "angry",
  "puke",
  "laugh",
  "nerd",
  "cry",
  "skull",
  "fire",
  "gg",
  "sparkle",
  "bp_magic_crown",
  "bp_crystal_heart",
  "bp_reaper_laugh",
  "bp_mana_bloom",
  "bp_dragon_fire",
  "share_ufo_alien"
]);

const RANKED_STATE_FILENAME = "ranked-season-state.json";
const RANKED_LEGACY_STATE_DIR = path.join(__dirname, "data");
const RANKED_LEGACY_STATE_FILE = path.join(RANKED_LEGACY_STATE_DIR, RANKED_STATE_FILENAME);
const RANKED_RENDER_DISK_DIR = path.join("/var", "data", "duel-survivor");
const IS_RENDER_RUNTIME = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);

function rankedResolvePath(rawPath) {
  const clean = String(rawPath || "").trim();
  if (!clean) return "";
  return path.isAbsolute(clean) ? clean : path.resolve(__dirname, clean);
}

function rankedCanUseStateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const testFile = path.join(dir, `.ranked-write-test-${process.pid}`);
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    console.warn(`[ranked] storage candidate rejected: ${dir}`, err.message);
    return false;
  }
}

function rankedChooseStateStorage() {
  const candidates = [];

  if (process.env.RANKED_STATE_FILE) {
    const file = rankedResolvePath(process.env.RANKED_STATE_FILE);
    candidates.push({
      label: "RANKED_STATE_FILE",
      durable: true,
      dir: path.dirname(file),
      file
    });
  }

  if (process.env.RANKED_STATE_DIR) {
    const dir = rankedResolvePath(process.env.RANKED_STATE_DIR);
    candidates.push({
      label: "RANKED_STATE_DIR",
      durable: true,
      dir,
      file: path.join(dir, RANKED_STATE_FILENAME)
    });
  }

  if (IS_RENDER_RUNTIME || fs.existsSync(RANKED_RENDER_DISK_DIR)) {
    candidates.push({
      label: "render-disk-default",
      durable: true,
      dir: RANKED_RENDER_DISK_DIR,
      file: path.join(RANKED_RENDER_DISK_DIR, RANKED_STATE_FILENAME)
    });
  }

  candidates.push({
    label: "legacy-local-data",
    durable: false,
    dir: RANKED_LEGACY_STATE_DIR,
    file: RANKED_LEGACY_STATE_FILE
  });

  for (const candidate of candidates) {
    if (rankedCanUseStateDir(candidate.dir)) return candidate;
  }

  return {
    label: "legacy-local-data-unverified",
    durable: false,
    dir: RANKED_LEGACY_STATE_DIR,
    file: RANKED_LEGACY_STATE_FILE
  };
}

const RANKED_STATE_STORAGE = rankedChooseStateStorage();
const RANKED_STATE_DIR = RANKED_STATE_STORAGE.dir;
const RANKED_STATE_FILE = RANKED_STATE_STORAGE.file;

const RANKED_FILE_STORAGE_LABEL = RANKED_STATE_STORAGE.label;
const RANKED_FILE_STORAGE_DURABLE = !!RANKED_STATE_STORAGE.durable;

const RANKED_STORAGE_DRIVER = String(process.env.RANKED_STORAGE_DRIVER || "file").trim().toLowerCase();
const RANKED_UPSTASH_REST_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
const RANKED_UPSTASH_REST_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const RANKED_UPSTASH_KEY = String(process.env.RANKED_UPSTASH_KEY || "duel-survivor:ranked-state:v1").trim();

const RANKED_UPSTASH_ENABLED =
  RANKED_STORAGE_DRIVER === "upstash" &&
  !!RANKED_UPSTASH_REST_URL &&
  !!RANKED_UPSTASH_REST_TOKEN &&
  !!RANKED_UPSTASH_KEY;

const RANKED_STATE_STORAGE_LABEL = RANKED_UPSTASH_ENABLED ? "upstash-redis" : RANKED_FILE_STORAGE_LABEL;
const RANKED_STATE_DURABLE = RANKED_UPSTASH_ENABLED ? true : RANKED_FILE_STORAGE_DURABLE;

const RANKED_ADMIN_KEY = process.env.RANKED_ADMIN_KEY || "";
const rankedSeasonArchives = new Map();
const rankedRewardInbox = new Map();
let rankedStateSaveTimer = null;
let rankedStateEverLoaded = false;
let rankedHighestKnownProfileCount = 0;
let rankedLastSuccessfulSaveAt = 0;

if (RANKED_UPSTASH_ENABLED) {
  console.log(`[ranked] state storage: upstash-redis (${RANKED_UPSTASH_KEY})`);
  console.log(`[ranked] local fallback file: ${RANKED_STATE_FILE} (${RANKED_FILE_STORAGE_LABEL})`);
} else {
  console.log(`[ranked] state file: ${RANKED_STATE_FILE} (${RANKED_STATE_STORAGE_LABEL})`);
}

if (!RANKED_STATE_DURABLE) {
  console.warn("[ranked] WARNING: ranked/leaderboard state is using non-durable local storage. Configure Upstash env vars or a Render persistent disk before launch.");
}

if (RANKED_STORAGE_DRIVER === "upstash" && !RANKED_UPSTASH_ENABLED) {
  console.warn("[ranked] WARNING: RANKED_STORAGE_DRIVER=upstash, but UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN / RANKED_UPSTASH_KEY is missing.");
}

const PARTY_MAX_SIZE = 4;
const MATCH_TOTAL_SLOTS = 100;
const MATCH_HUMAN_RESERVED_SLOTS = 15;
const MATCH_BOT_MIN = 25;
const MATCH_BOT_COMMON_MAX = 68;
const MATCH_BOT_HIGH_MIN = 69;
const MATCH_BOT_HIGH_MAX = 80;
const MATCH_BOT_MAX = 85;
const MATCH_BOT_RARE_MAX_CHANCE = 0.10;
const ONLINE_QUEUE_MS = 15000;
const WORLD_SNAPSHOT_MIN_MS = 160;
const MATCH_RECONNECT_GRACE_MS = 45000;
const PROFILE_MAX_LEVEL = 100;

function profileXpForNextLevel(level = 1) {
  const safeLevel = Math.max(1, Math.min(PROFILE_MAX_LEVEL, Math.round(Number(level || 1))));
  if (safeLevel >= PROFILE_MAX_LEVEL) return 0;
  return Math.round(220 + Math.pow(safeLevel, 1.82) * 72);
}

const TEAM_SIZE_BY_MODE = {
  duo: 2,
  team: 4
};

function createSecurePlayerId() {
  return `ds_${crypto.randomBytes(PLAYER_ID_BYTES).toString("hex")}`;
}

function encodePlayerSession(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signPlayerSession(encodedPayload) {
  return crypto
    .createHmac("sha256", PLAYER_SESSION_SECRET)
    .update(encodedPayload)
    .digest("base64url");
}

function issuePlayerSessionToken(playerId) {
  if (!PLAYER_SESSION_SECRET) return "";

  const now = Date.now();
  const encodedPayload = encodePlayerSession({
    v: 1,
    playerId,
    issuedAt: now,
    expiresAt: now + PLAYER_SESSION_TTL_MS
  });

  return `${encodedPayload}.${signPlayerSession(encodedPayload)}`;
}

function verifyPlayerSessionToken(token) {
  if (!PLAYER_SESSION_SECRET || typeof token !== "string") return null;

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = signPlayerSession(encodedPayload);
  const expected = Buffer.from(expectedSignature);
  const provided = Buffer.from(signature);

  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));

    if (
      !payload ||
      payload.v !== 1 ||
      typeof payload.playerId !== "string" ||
      !payload.playerId.startsWith("ds_") ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }

    return payload;
  } catch (err) {
    return null;
  }
}

function privatePlayerProfile(p) {
  return {
    ...publicPlayer(p),
    sessionToken: p?.sessionToken || ""
  };
}

function clampFiniteNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function getMatchBounds(match, gameState = "MATCH") {
  if (gameState === "QUEUE_LOBBY") {
    return {
      width: MATCH_QUEUE_WORLD_SIZE,
      height: MATCH_QUEUE_WORLD_SIZE
    };
  }

  return {
    width: MATCH_WORLD_WIDTH,
    height: MATCH_WORLD_HEIGHT
  };
}

function sanitizeMatchCoordinate(value, fallback, limit) {
  return clampFiniteNumber(value, fallback, 0, limit);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function matchActionPayloadTooLarge(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") > MATCH_ACTION_MAX_PAYLOAD_BYTES;
  } catch (err) {
    return true;
  }
}

function sanitizeMatchActionId(value, maxLength = 64) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > maxLength) return "";
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? id : "";
}

function sanitizeMatchActionText(value, maxLength = 64, fallback = "") {
  const text = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
    : "";

  return (text || fallback).slice(0, maxLength);
}

function sanitizeMatchActionColor(value, fallback = "#38bdf8") {
  const color = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
}

function getServerMatchPhase(match, now = Date.now()) {
  return now < Number(match?.deployAt || 0)
    ? "QUEUE_LOBBY"
    : "MATCH";
}

function getMatchEntryFloor(entry) {
  return sanitizeMatchActionText(entry?.state?.floor, 64, "surface") || "surface";
}

function isActiveMatchEntry(entry) {
  return !!(
    entry &&
    !entry.leftMatch &&
    !entry.disconnected &&
    entry.alive !== false
  );
}

function getMatchEntryPoint(entry) {
  const x = Number(entry?.x);
  const y = Number(entry?.y);

  return Number.isFinite(x) && Number.isFinite(y)
    ? { x, y }
    : null;
}

function isPointInBounds(x, y, bounds, margin = 0) {
  return Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= -margin &&
    x <= bounds.width + margin &&
    y >= -margin &&
    y <= bounds.height + margin;
}

function sameMatchTeam(a, b) {
  if (!a || !b) return false;

  return String(a.teamId || a.socketId) ===
    String(b.teamId || b.socketId);
}

function allowMatchAction(entry, type, now = Date.now()) {
  const rule = MATCH_ACTION_RULES[type];
  if (!entry || !rule) return false;

  if (!isPlainObject(entry.matchActionRate)) {
    entry.matchActionRate = Object.create(null);
  }

  const bucket = entry.matchActionRate[type] || {
    lastAt: 0,
    windowStartedAt: now,
    count: 0
  };

  if (now - Number(bucket.lastAt || 0) < rule.cooldownMs) {
    return false;
  }

  if (now - Number(bucket.windowStartedAt || 0) >= rule.windowMs) {
    bucket.windowStartedAt = now;
    bucket.count = 0;
  }

  if (Number(bucket.count || 0) >= rule.maxInWindow) {
    return false;
  }

  bucket.lastAt = now;
  bucket.count = Number(bucket.count || 0) + 1;
  entry.matchActionRate[type] = bucket;

  return true;
}

function sanitizeMatchActionWeapon(rawWeapon) {
  if (!isPlainObject(rawWeapon)) return null;

  const id = sanitizeMatchActionId(rawWeapon.id, 64);
  if (!id) return null;

  return {
    id,
    name: sanitizeMatchActionText(rawWeapon.name, 64, id),
    rarity: sanitizeMatchActionText(rawWeapon.rarity, 32, "Common"),
    damage: clampFiniteNumber(rawWeapon.damage, 0, 0, MATCH_MAX_DAMAGE_PACKET),
    objectDamage: clampFiniteNumber(rawWeapon.objectDamage, 0, 0, MATCH_MAX_DAMAGE_PACKET),
    range: clampFiniteNumber(rawWeapon.range, 60, 20, 260),
    cooldownMs: clampFiniteNumber(rawWeapon.cooldownMs, 450, 80, 30000),
    swingDuration: clampFiniteNumber(rawWeapon.swingDuration, 130, 60, 1000),
    color: sanitizeMatchActionColor(rawWeapon.color, "#e0f2fe"),
    iconSymbol: sanitizeMatchActionText(rawWeapon.iconSymbol, 16, ""),
    shape: sanitizeMatchActionId(rawWeapon.shape, 32)
  };
}

function emitMatchActionToTeam(match, teamId, payload, excludedSocketId = null) {
  if (!match) return;

  for (const [socketId, entry] of match.players) {
    if (socketId === excludedSocketId) continue;
    if (!isActiveMatchEntry(entry)) continue;

    if (String(entry.teamId || socketId) !== String(teamId || socketId)) {
      continue;
    }

    io.to(socketId).emit("matchAction", payload);
  }
}

function resolveServerDamage(target, rawAmount) {
  const incoming = Math.max(0, Math.min(MATCH_MAX_DAMAGE_PACKET, Math.round(rawAmount || 0)));
  const shieldBefore = Math.max(0, Math.round(target.shieldHp || 0));
  const armorBefore = Math.max(0, Math.round(target.armorHp || 0));
  const hpBefore = Math.max(0, Math.round(target.hp || 0));

  let remaining = incoming;
  const shieldDamage = Math.min(shieldBefore, remaining);
  remaining -= shieldDamage;

  const armorDamage = Math.min(armorBefore, remaining);
  remaining -= armorDamage;

  const hpDamage = Math.min(hpBefore, remaining);

  target.shieldHp = shieldBefore - shieldDamage;
  target.armorHp = armorBefore - armorDamage;
  target.hp = hpBefore - hpDamage;

  if (target.shieldHp <= 0) target.shieldMax = 0;

  return {
    rawDamage: incoming,
    hpDamage,
    armorDamage,
    shieldDamage
  };
}

function getMatchHumanCount(match) {
  if (!match) return 0;
  return [...match.players.values()].filter(p => p && !p.leftMatch && !p.disconnected).length;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rollMatchBotTarget(humanCount = 1) {
  const safeHumanCount = Math.max(1, Number(humanCount) || 1);
  const reservedCap = Math.max(0, MATCH_TOTAL_SLOTS - safeHumanCount);
  const preferredCap = Math.max(0, MATCH_TOTAL_SLOTS - safeHumanCount - MATCH_HUMAN_RESERVED_SLOTS + Math.min(safeHumanCount, MATCH_HUMAN_RESERVED_SLOTS));
  const maxBotsForSlots = Math.min(MATCH_BOT_MAX, reservedCap, Math.max(MATCH_BOT_MIN, preferredCap));

  if (maxBotsForSlots <= 0) return 0;

  const minBots = Math.min(MATCH_BOT_MIN, maxBotsForSlots);
  const activeOnline = Math.max(safeHumanCount, players.size || safeHumanCount);
  const popularityRatio = clampNumber((activeOnline - safeHumanCount) / Math.max(1, MATCH_TOTAL_SLOTS - safeHumanCount), 0, 1);

  let low = minBots;
  let high = Math.min(MATCH_BOT_COMMON_MAX, maxBotsForSlots);
  const roll = Math.random();

  if (roll > 1 - MATCH_BOT_RARE_MAX_CHANCE) {
    low = Math.min(MATCH_BOT_HIGH_MAX, maxBotsForSlots);
    high = maxBotsForSlots;
  } else if (roll > 0.70) {
    low = Math.min(MATCH_BOT_HIGH_MIN, maxBotsForSlots);
    high = Math.min(MATCH_BOT_HIGH_MAX, maxBotsForSlots);
  }

  const popularityTrim = Math.round(popularityRatio * 18);
  high = Math.max(low, high - popularityTrim);

  const target = low + Math.floor(Math.random() * Math.max(1, high - low + 1));
  return Math.round(clampNumber(target, minBots, maxBotsForSlots));
}

function getMatchBotTarget(match, humanCount = getMatchHumanCount(match)) {
  const maxBotsForSlots = Math.max(0, MATCH_TOTAL_SLOTS - Math.max(0, humanCount));
  const configured = Number(match?.botTarget);

  if (Number.isFinite(configured)) {
    return Math.max(0, Math.min(maxBotsForSlots, Math.round(configured)));
  }

  return Math.min(MATCH_BOT_MIN, maxBotsForSlots);
}

function isEligibleWorldAuthority(match, socketId) {
  if (!match || !socketId) return false;

  const entry = match.players.get(socketId);
  const socket = io.sockets.sockets.get(socketId);

  return !!(
    entry &&
    socket?.connected &&
    !entry.leftMatch &&
    !entry.disconnected &&
    entry.alive !== false
  );
}

function chooseWorldAuthority(match) {
  if (!match) return null;

  const current = match.worldAuthoritySocketId;
  if (isEligibleWorldAuthority(match, current)) return current;

  const next = [...match.players.keys()].find(socketId => isEligibleWorldAuthority(match, socketId)) || null;
  match.worldAuthoritySocketId = next;
  return next;
}

function reconcileWorldAuthority(match, reason = "sync") {
  if (!match) {
    return {
      changed: false,
      previousSocketId: null,
      worldAuthoritySocketId: null
    };
  }

  const previousSocketId = match.worldAuthoritySocketId || null;
  const worldAuthoritySocketId = chooseWorldAuthority(match);
  const changed = previousSocketId !== worldAuthoritySocketId;

  if (changed) {
    io.to(match.matchId).emit("worldAuthorityChanged", {
      matchId: match.matchId,
      previousSocketId,
      worldAuthoritySocketId,
      reason,
      serverNow: Date.now(),
      worldSnapshot: match.worldSnapshot || null
    });
  }

  return {
    changed,
    previousSocketId,
    worldAuthoritySocketId
  };
}

function makeMatchSyncPayload(match) {
  const humanCount = getMatchHumanCount(match);
  const botCount = getMatchBotTarget(match, humanCount);
  const worldAuthoritySocketId = chooseWorldAuthority(match);

  return {
    matchId: match.matchId,
    seed: match.seed,
    mode: match.mode,
    teamSize: match.teamSize || 2,
    totalSlots: MATCH_TOTAL_SLOTS,
    humanCount,
    botCount,
    populationTarget: Math.min(MATCH_TOTAL_SLOTS, humanCount + botCount),
    serverNow: Date.now(),
    queueStartAt: match.queueStartAt,
    deployAt: match.deployAt,
    worldAuthoritySocketId,
    players: [...match.players.values()].map(entry => ({
      socketId: entry.socketId,
      playerId: entry.playerId,
      name: entry.name,
      teamId: entry.teamId,
      alive: entry.alive !== false,
      hp: entry.hp ?? 100,
      health: entry.hp ?? 100,
      maxHp: entry.maxHp ?? entry.state?.maxHp ?? 100,
      shieldHp: entry.shieldHp ?? entry.state?.shieldHp ?? 0,
      shieldMax: entry.shieldMax ?? entry.state?.shieldMax ?? 0,
      armorHp: entry.armorHp ?? entry.state?.armorHp ?? 0,
      armorMax: entry.armorMax ?? entry.state?.armorMax ?? 100,
      x: entry.x || 0,
      y: entry.y || 0,
      angle: entry.angle || 0,
      state: entry.state || {}
    }))
  };
}

function broadcastMatchSync(match, authorityReason = "sync") {
  if (!match) return null;

  reconcileWorldAuthority(match, authorityReason);

  const payload = makeMatchSyncPayload(match);
  io.to(match.matchId).emit("matchSync", payload);
  return payload;
}

function sanitizeWorldSnapshot(snapshot) {
  return {
    seq: Number(snapshot?.seq || 0),
    state: String(snapshot?.state || "MATCH").slice(0, 32),
    serverNow: Date.now(),
    bots: Array.isArray(snapshot?.bots) ? snapshot.bots.slice(0, MATCH_TOTAL_SLOTS).map(bot => ({
      id: String(bot.id || ""),
      name: String(bot.name || "Bot").slice(0, 32),
      x: Number(bot.x || 0),
      y: Number(bot.y || 0),
      angle: Number(bot.angle || 0),
      lookAngle: Number(bot.lookAngle || bot.angle || 0),
      hp: Number(bot.hp ?? 100),
      maxHp: Number(bot.maxHp ?? 100),
      alive: bot.alive !== false,
      isEliminated: !!bot.isEliminated,
      isDowned: !!bot.isDowned,
      floor: String(bot.floor || "surface").slice(0, 48),
      color: String(bot.color || "#ef4444").slice(0, 24),
      teamId: bot.teamId ? String(bot.teamId).slice(0, 48) : null
    })) : [],
    items: Array.isArray(snapshot?.items) ? snapshot.items.slice(0, 160).map(item => ({
      id: String(item.id || ""),
      x: Number(item.x || 0),
      y: Number(item.y || 0),
      floor: String(item.floor || "surface").slice(0, 48),
      type: String(item.type || "loot").slice(0, 32),
      name: String(item.name || "Loot").slice(0, 64),
      cardId: item.cardId ? String(item.cardId).slice(0, 64) : null,
      cardName: item.cardName ? String(item.cardName).slice(0, 64) : null,
      rarity: item.rarity ? String(item.rarity).slice(0, 32) : null,
      visualColor: item.visualColor ? String(item.visualColor).slice(0, 24) : null,
      iconSymbol: item.iconSymbol ? String(item.iconSymbol).slice(0, 8) : null,
      radius: Number(item.radius || 12),
      healAmount: Number(item.healAmount || 0),
      shieldAmount: Number(item.shieldAmount || 0),
      armorAmount: Number(item.armorAmount || 0),
      amount: Number(item.amount || 0),
      meleeId: item.meleeId ? String(item.meleeId).slice(0, 64) : null,
      damage: Number(item.damage || 0),
      objectDamage: Number(item.objectDamage || 0),
      cooldownMs: Number(item.cooldownMs || 0)
    })) : [],
    crates: Array.isArray(snapshot?.crates) ? snapshot.crates.slice(0, 220).map(crate => ({
      id: String(crate.id || ""),
      hp: Number(crate.hp || 0),
      alive: crate.alive !== false,
      destroyed: !!crate.destroyed
    })) : [],
    storm: snapshot?.storm || null
  };
}

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    name: "Duel Survivor Multiplayer Server",
    onlinePlayers: players.size,
    parties: parties.size,
    matches: matches.size,
    uptime: process.uptime()
  });
});

app.get("/debug", (req, res) => {
  if (process.env.ENABLE_DEBUG_API !== "true") {
    return res.status(404).json({ ok: false, error: "Debug API disabled." });
  }

  res.json({
    ok: true,
    onlinePlayers: [...players.values()].map(publicPlayer),
    parties: [...parties.values()].map(p => ({
      partyId: p.partyId,
      leaderId: p.leaderId,
      members: p.members,
      status: p.status,
      ready: p.ready
    })),
    matches: [...matches.values()].map(m => ({
      matchId: m.matchId,
      mode: m.mode,
      playerCount: m.players.size
    }))
  });
});

app.get("/admin/ranked/current", (req, res) => {
  if (!requireRankedAdmin(req, res)) return;
  finalizeExpiredRankedSeasons("admin_current_check");
  res.json({
    ok: true,
    state: rankedStatePayload(),
    leaderboards: getLeaderboardPayload()
  });
});

app.get("/admin/ranked/seasons", (req, res) => {
  if (!requireRankedAdmin(req, res)) return;
  res.json({
    ok: true,
    activeSeason: getRankedSeasonInfo(),
    archives: [...rankedSeasonArchives.values()],
    rewardInbox: [...rankedRewardInbox.entries()].map(([playerId, rewards]) => ({ playerId, rewards }))
  });
});

app.post("/admin/ranked/finalize", (req, res) => {
  if (!requireRankedAdmin(req, res)) return;

  const currentSeason = getRankedSeasonInfo();
  const requestedSeasonId = String(req.body?.seasonId || "").trim();
  const forceActive = req.body?.forceActive === true || req.body?.forceActive === "true";

  if (!requestedSeasonId) {
    const archives = finalizeExpiredRankedSeasons("admin_finalize_expired");
    rankedScheduleSave();
    broadcastLeaderboards();
    return res.json({ ok: true, activeSeason: currentSeason, archives });
  }

  if (requestedSeasonId === currentSeason.id && !forceActive) {
    return res.status(409).json({
      ok: false,
      error: "Refusing to finalize the active ranked season without forceActive=true.",
      activeSeason: currentSeason
    });
  }

  if (forceActive) {
    rankedSeasonArchives.delete(requestedSeasonId);
  }

  const archive = createRankedSeasonArchive(
    requestedSeasonId,
    requestedSeasonId === currentSeason.id ? "admin_force_active_snapshot" : "admin_finalize"
  );

  rankedScheduleSave();
  broadcastLeaderboards();

  res.json({ ok: true, activeSeason: currentSeason, archive });
});

app.post("/admin/ranked/reward-paid", (req, res) => {
  if (!requireRankedAdmin(req, res)) return;

  const playerId = String(req.body?.playerId || "").trim();
  const rewardId = String(req.body?.rewardId || "").trim();
  const rewards = rankedRewardInbox.get(playerId) || [];
  const reward = rewards.find(entry => entry.id === rewardId);

  if (!reward) return res.status(404).json({ ok: false, error: "Reward not found." });

  reward.claimed = true;
  reward.paidAt = Date.now();

  rankedScheduleSave();
  res.json({ ok: true, reward });
});

app.get("/admin/ranked/storage", async (req, res) => {
  if (!requireRankedAdmin(req, res)) return;

  let stat = null;
  let backups = [];

  try {
    if (fs.existsSync(RANKED_STATE_FILE)) {
      const s = fs.statSync(RANKED_STATE_FILE);
      stat = {
        size: s.size,
        modifiedAt: s.mtimeMs
      };
    }

    const dir = path.dirname(RANKED_STATE_FILE);
    const base = path.basename(RANKED_STATE_FILE);
    backups = fs.readdirSync(dir)
      .filter(name => name.startsWith(`${base}.`) && name.endsWith(".bak"))
      .slice(-12);
  } catch (err) {}

  const upstash = await rankedInspectUpstashState();

  res.json({
    ok: true,
    durable: RANKED_STATE_DURABLE,
    label: RANKED_STATE_STORAGE_LABEL,
    key: RANKED_UPSTASH_ENABLED ? RANKED_UPSTASH_KEY : "",
    driver: RANKED_STORAGE_DRIVER,
    upstash,
    runtime: {
      stateEverLoaded: rankedStateEverLoaded,
      highestKnownProfileCount: rankedHighestKnownProfileCount,
      currentProfileCount: leaderboardProfiles.size,
      lastSuccessfulSaveAt: rankedLastSuccessfulSaveAt
    },
    localFallback: {
      durable: RANKED_FILE_STORAGE_DURABLE,
      label: RANKED_FILE_STORAGE_LABEL,
      dir: RANKED_STATE_DIR,
      file: RANKED_STATE_FILE,
      exists: !!stat,
      stat,
      backups
    },
    warning: RANKED_STATE_DURABLE ? "" : "Non-durable storage. Configure Upstash env vars or Render persistent disk."
  });
});

app.post("/admin/ranked/save", async (req, res) => {
  if (!requireRankedAdmin(req, res)) return;

  const result = await rankedSaveStateNow();

  res.status(result.ok ? 200 : 503).json({
    ok: result.ok,
    durable: result.durable,
    label: result.label,
    key: result.key,
    file: result.file,
    upstashSaved: result.upstashSaved,
    fileBackupSaved: result.fileBackupSaved,
    error: result.error
  });
});

app.get("/play", (req, res) => {
  res.sendFile(path.join(publicDir, "play.html"));
});

function makeSurvivorId() {
  let id;
  do {
    id = "Survivor" + Math.floor(1000 + Math.random() * 9000);
  } while (idToSocket.has(id));
  return id;
}

function makePartyId() {
  return "party_" + Math.random().toString(36).slice(2, 10);
}

function makeMatchId() {
  return "match_" + Math.random().toString(36).slice(2, 10);
}

function makeSeed() {
  return Math.floor(Math.random() * 2147483647);
}

function getPlayer(socketId) {
  return players.get(socketId) || null;
}

function getSocketByPlayerId(playerId) {
  const sid = idToSocket.get(playerId);
  if (!sid) return null;
  return io.sockets.sockets.get(sid) || null;
}

function publicPlayer(p) {
  if (!p) return null;

  return {
    socketId: p.socketId,
    playerId: p.playerId,
    name: p.name,
    rank: p.rank || "SURVIVOR",
    level: Math.max(1, Math.min(PROFILE_MAX_LEVEL, Number(p.level || 1))),
    profileXp: Math.max(0, Number(p.profileXp || 0)),
    xpToNext: profileXpForNextLevel(p.level || 1),
    wins: p.wins || 0,
    kills: p.kills || 0,
    deaths: p.deaths || 0,
    losses: p.losses || 0,
    revives: p.revives || 0,
    gold: p.gold || 0,
    gems: p.gems || 0,
    color: p.color || "#38bdf8",
    icon: p.icon || "DS",
    partyId: p.partyId || null,
    inMatch: !!p.inMatch,
    voiceReady: !!p.voiceReady,
    voiceMuted: !!p.voiceMuted,
    voiceMode: p.voiceMode || "ptt",
    voiceRange: Number(p.voiceRange || 650),
    seasonRewards: rankedFilterRewardsForPlayer(p.playerId)
  };
}

function broadcastOnlineList() {
  io.emit("onlinePlayers", [...players.values()].map(publicPlayer));
}

function getSpectatorCountsPayload() {
  const counts = {};

  for (const p of players.values()) {
    const targetSocketId = p.spectatingSocketId;
    if (!targetSocketId || targetSocketId === p.socketId || !players.has(targetSocketId)) continue;
    counts[targetSocketId] = (counts[targetSocketId] || 0) + 1;
  }

  return counts;
}

function broadcastSpectatorCounts() {
  io.emit("spectatorCounts", getSpectatorCountsPayload());
}

function getRankedSeasonInfo(time = Date.now()) {
  const nowMs = Number(time || Date.now());
  const seasonOneStart = Date.UTC(2026, 0, 1);
  const seasonTwoStart = Date.UTC(2027, 0, 1);

  let index;
  let startAt;
  let endAt;

  if (nowMs < seasonTwoStart) {
    index = 1;
    startAt = seasonOneStart;
    endAt = seasonTwoStart;
  } else {
    const d = new Date(nowMs);
    const year = d.getUTCFullYear();
    const half = d.getUTCMonth() < 6 ? 0 : 1;
    index = 2 + (year - 2027) * 2 + half;
    startAt = Date.UTC(year, half === 0 ? 0 : 6, 1);
    endAt = half === 0 ? Date.UTC(year, 6, 1) : Date.UTC(year + 1, 0, 1);
  }

  const label = `SEASON ${String(index).padStart(2, "0")}`;

  return {
    index,
    id: `ranked_${String(index).padStart(2, "0")}`,
    label,
    startAt,
    endAt,
    updatedAt: Date.now()
  };
}

function rankedSeasonIndexFromId(seasonId = "") {
  const match = String(seasonId || "").match(/ranked_(\d+)/i);
  return match ? Number(match[1]) || 0 : 0;
}

function rankedIsRewardExpired(reward, time = Date.now()) {
  const rewardSeasonIndex = rankedSeasonIndexFromId(reward?.seasonId);
  if (!rewardSeasonIndex) return false;
  return getRankedSeasonInfo(time).index >= rewardSeasonIndex + 2;
}

function rankedFilterRewardsForPlayer(playerId, options = {}) {
  const rewards = rankedRewardInbox.get(playerId) || [];
  const includeClaimed = !!options.includeClaimed;
  let changed = false;

  const fresh = rewards.filter(reward => {
    const expired = rankedIsRewardExpired(reward);
    if (expired) changed = true;
    return !expired;
  });

  if (changed) {
    rankedRewardInbox.set(playerId, fresh);
    rankedScheduleSave();
  }

  return fresh.filter(reward => includeClaimed || !reward.claimed);
}

function defaultServerRankedBucket() {
  const season = getRankedSeasonInfo();

  return {
    seasonId: season.id,
    seasonName: season.label,
    rating: 1000,
    seasonalRating: 1000,
    wins: 0,
    losses: 0,
    kills: 0,
    deaths: 0,
    revives: 0,
    matches: 0,
    bestPlacement: null,
    updatedAt: Date.now()
  };
}

function applyRankedProfileToEntry(entry, ranked = {}) {
  if (!entry.ranked || typeof entry.ranked !== "object") {
    entry.ranked = {
      solo: defaultServerRankedBucket(),
      duo: defaultServerRankedBucket()
    };
  }

  for (const mode of ["solo", "duo"]) {
    const incoming = ranked?.[mode] || {};
    const current = entry.ranked[mode] || defaultServerRankedBucket();

    entry.ranked[mode] = {
      ...current,
      ...incoming,
      rating: Math.max(safeStatInt(current.rating, 1000, 999999), safeStatInt(incoming.rating, 1000, 999999)),
      seasonalRating: Math.max(safeStatInt(current.seasonalRating, 1000, 999999), safeStatInt(incoming.seasonalRating, 1000, 999999)),
      wins: Math.max(safeStatInt(current.wins), safeStatInt(incoming.wins)),
      losses: Math.max(safeStatInt(current.losses), safeStatInt(incoming.losses)),
      kills: Math.max(safeStatInt(current.kills), safeStatInt(incoming.kills)),
      deaths: Math.max(safeStatInt(current.deaths), safeStatInt(incoming.deaths)),
      revives: Math.max(safeStatInt(current.revives), safeStatInt(incoming.revives)),
      matches: Math.max(safeStatInt(current.matches), safeStatInt(incoming.matches)),
      updatedAt: Date.now()
    };
  }

  entry.rankedPoints = Math.max(entry.ranked.solo.rating || 1000, entry.ranked.duo.rating || 1000, safeStatInt(entry.rankedPoints, 1000, 999999));
}

function normalizeRankedReport(data = {}) {
  if (!data || !data.active) return null;
  const mode = data.mode === "duo" ? "duo" : "solo";
  const season = getRankedSeasonInfo();

  return {
    active: true,
    mode,
    seasonId: String(data.seasonId || season.id).slice(0, 32),
    seasonName: String(data.seasonName || season.label).slice(0, 32),
    rating: safeStatInt(data.rating, 1000, 999999),
    seasonalRating: safeStatInt(data.seasonalRating ?? data.rating, 1000, 999999),
    delta: Math.max(-999, Math.min(999, Math.round(Number(data.delta || 0)))),
    wins: safeStatInt(data.wins, data.won ? 1 : 0, 1),
    losses: safeStatInt(data.losses, data.won ? 0 : 1, 1),
    kills: safeStatInt(data.kills, 0, 100),
    deaths: safeStatInt(data.deaths, data.won ? 0 : 1, 1),
    revives: safeStatInt(data.revives, 0, 25),
    placement: safeStatInt(data.placement, 0, 100),
    updatedAt: Date.now()
  };
}

function applyRankedReportToEntry(entry, rankedReport) {
  if (!rankedReport?.active) return;

  if (!entry.ranked || typeof entry.ranked !== "object") {
    entry.ranked = {
      solo: defaultServerRankedBucket(),
      duo: defaultServerRankedBucket()
    };
  }

  const bucket = entry.ranked[rankedReport.mode] || defaultServerRankedBucket();

  if (bucket.seasonId && bucket.seasonId !== rankedReport.seasonId) {
    entry.ranked[rankedReport.mode] = {
      ...defaultServerRankedBucket(),
      seasonId: rankedReport.seasonId,
      seasonName: rankedReport.seasonName
    };
  }

  const next = entry.ranked[rankedReport.mode];

  next.seasonId = rankedReport.seasonId;
  next.seasonName = rankedReport.seasonName;
  next.rating = Math.max(0, rankedReport.rating);
  next.seasonalRating = Math.max(0, rankedReport.seasonalRating);
  next.wins += rankedReport.wins;
  next.losses += rankedReport.losses;
  next.kills += rankedReport.kills;
  next.deaths += rankedReport.deaths;
  next.revives += rankedReport.revives;
  next.matches += 1;
  next.bestPlacement = next.bestPlacement ? Math.min(next.bestPlacement, rankedReport.placement || 999) : rankedReport.placement || null;
  next.updatedAt = Date.now();

  entry.rankedPoints = Math.max(entry.ranked.solo.rating || 1000, entry.ranked.duo.rating || 1000);
  entry.rank = entry.rankedPoints >= 2600 ? "MYTHIC" :
    entry.rankedPoints >= 2200 ? "DIAMOND" :
    entry.rankedPoints >= 1800 ? "PLATINUM" :
    entry.rankedPoints >= 1450 ? "GOLD" :
    entry.rankedPoints >= 1150 ? "SILVER" :
    "BRONZE";
}

function publicRankedLeaderboardEntry(entry, mode, index = 0) {
  const bucket = entry.ranked?.[mode] || defaultServerRankedBucket();

  return {
    position: index + 1,
    playerId: entry.playerId,
    name: entry.name,
    rank: entry.rank || "SURVIVOR",
    level: Math.max(1, Math.min(PROFILE_MAX_LEVEL, Number(entry.level || 1))),
    mode,
    seasonId: bucket.seasonId,
    seasonName: bucket.seasonName,
    rating: safeStatInt(bucket.rating, 1000, 999999),
    wins: safeStatInt(bucket.wins),
    losses: safeStatInt(bucket.losses),
    kills: safeStatInt(bucket.kills),
    deaths: safeStatInt(bucket.deaths),
    revives: safeStatInt(bucket.revives),
    matches: safeStatInt(bucket.matches),
    bestPlacement: bucket.bestPlacement || null,
    score: safeStatInt(bucket.rating, 1000, 999999) + safeStatInt(bucket.wins) * 60 + safeStatInt(bucket.kills) * 8 + safeStatInt(bucket.revives) * 5 - safeStatInt(bucket.losses) * 12,
    updatedAt: bucket.updatedAt || entry.updatedAt || Date.now()
  };
}

function sortedRankedLeaderboardRows(mode = "solo") {
  const season = getRankedSeasonInfo();

  const rows = [...leaderboardProfiles.values()]
    .map(entry => publicRankedLeaderboardEntry(entry, mode))
    .filter(row => row.seasonId === season.id && (row.matches > 0 || row.rating > 1000));

  rows.sort((a, b) =>
    (b.rating - a.rating) ||
    (b.wins - a.wins) ||
    (b.kills - a.kills) ||
    (a.losses - b.losses)
  );

  return rows.slice(0, 50).map((row, index) => ({ ...row, position: index + 1 }));
}

function safeStatInt(value, fallback = 0, max = 999999) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.round(n)));
}

function normalizeLeaderboardName(name = "") {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isCanonicalLeaderboardName(name = "") {
  const key = normalizeLeaderboardName(name);
  if (key.length < 3) return false;
  if (key === "survivor") return false;
  if (/^survivor\d{3,}$/i.test(key)) return false;
  return true;
}

function findLeaderboardEntryByName(name = "", exceptPlayerId = "") {
  if (!isCanonicalLeaderboardName(name)) return null;

  const key = normalizeLeaderboardName(name);
  const except = String(exceptPlayerId || "").trim();

  for (const entry of leaderboardProfiles.values()) {
    if (except && entry.playerId === except) continue;
    if (normalizeLeaderboardName(entry.name) === key) return entry;
  }

  return null;
}

function mergeRewardInboxPlayerId(fromPlayerId, toPlayerId) {
  if (!fromPlayerId || !toPlayerId || fromPlayerId === toPlayerId) return;

  const fromRewards = rankedRewardInbox.get(fromPlayerId) || [];
  if (!fromRewards.length) return;

  const toRewards = rankedRewardInbox.get(toPlayerId) || [];
  const seen = new Set(toRewards.map(reward => reward?.id).filter(Boolean));

  for (const reward of fromRewards) {
    if (!reward?.id || seen.has(reward.id)) continue;
    toRewards.push({ ...reward, playerId: toPlayerId });
    seen.add(reward.id);
  }

  rankedRewardInbox.set(toPlayerId, toRewards);
  rankedRewardInbox.delete(fromPlayerId);
}

function mergeLeaderboardEntries(target, source = {}) {
  if (!target || !source) return target;

  const sourceReportKeys = source.reportKeys instanceof Set
    ? source.reportKeys
    : new Set(Array.isArray(source.reportKeys) ? source.reportKeys : []);

  if (!(target.reportKeys instanceof Set)) {
    target.reportKeys = new Set(Array.isArray(target.reportKeys) ? target.reportKeys : []);
  }

  for (const key of sourceReportKeys) target.reportKeys.add(key);
  if (target.reportKeys.size > 120) target.reportKeys = new Set([...target.reportKeys].slice(-80));

  target.rank = String(target.rank || source.rank || "SURVIVOR").trim().slice(0, 32);
  target.level = Math.max(safeStatInt(target.level, 1, PROFILE_MAX_LEVEL), safeStatInt(source.level, 1, PROFILE_MAX_LEVEL));
  target.profileXp = Math.max(safeStatInt(target.profileXp, 0, 999999999), safeStatInt(source.profileXp ?? source.xp, 0, 999999999));
  if (target.level >= PROFILE_MAX_LEVEL) target.profileXp = 0;
  target.wins = Math.max(safeStatInt(target.wins), safeStatInt(source.wins));
  target.kills = Math.max(safeStatInt(target.kills), safeStatInt(source.kills));
  target.deaths = Math.max(safeStatInt(target.deaths), safeStatInt(source.deaths));
  target.losses = Math.max(safeStatInt(target.losses), safeStatInt(source.losses));
  target.revives = Math.max(safeStatInt(target.revives), safeStatInt(source.revives));
  target.rankedPoints = Math.max(safeStatInt(target.rankedPoints, 1000, 999999), safeStatInt(source.rankedPoints, 1000, 999999));
  target.color = target.color || source.color || "#38bdf8";
  target.icon = target.icon || source.icon || "DS";
  target.firstSeenAt = Math.min(Number(target.firstSeenAt || Date.now()), Number(source.firstSeenAt || Date.now()));
  target.updatedAt = Math.max(Number(target.updatedAt || 0), Number(source.updatedAt || 0), Date.now());

  applyRankedProfileToEntry(target, source.ranked || {});

  for (const mode of ["solo", "duo"]) {
    const targetBucket = target.ranked?.[mode];
    const sourceBucket = source.ranked?.[mode];
    if (!targetBucket || !sourceBucket?.bestPlacement) continue;
    targetBucket.bestPlacement = targetBucket.bestPlacement
      ? Math.min(targetBucket.bestPlacement, sourceBucket.bestPlacement)
      : sourceBucket.bestPlacement;
  }

  if (source.playerId && target.playerId && source.playerId !== target.playerId) {
    mergeRewardInboxPlayerId(source.playerId, target.playerId);
  }

  return target;
}

function serializeLeaderboardEntry(entry = {}) {
  return {
    ...entry,
    reportKeys: [...(entry.reportKeys instanceof Set ? entry.reportKeys : new Set())]
  };
}

function hydrateLeaderboardEntry(raw = {}) {
  if (!raw.playerId) return;

  const entry = {
    ...raw,
    reportKeys: new Set(Array.isArray(raw.reportKeys) ? raw.reportKeys : [])
  };

  if (!entry.ranked || typeof entry.ranked !== "object") {
    entry.ranked = {
      solo: defaultServerRankedBucket(),
      duo: defaultServerRankedBucket()
    };
  }

  if (!entry.ranked.solo) entry.ranked.solo = defaultServerRankedBucket();
  if (!entry.ranked.duo) entry.ranked.duo = defaultServerRankedBucket();

  entry.gold = safeStatInt(entry.gold, 1000, 999999999);
  entry.gems = safeStatInt(entry.gems, 0, 999999999);

  const existingById = leaderboardProfiles.get(entry.playerId);
  if (existingById) {
    mergeLeaderboardEntries(existingById, entry);
    return;
  }

  leaderboardProfiles.set(entry.playerId, entry);
}

function rankedStatePayload() {
  return {
    version: 1,
    savedAt: Date.now(),
    activeSeason: getRankedSeasonInfo(),
    storage: {
      label: RANKED_STATE_STORAGE_LABEL,
      durable: RANKED_STATE_DURABLE,
      key: RANKED_UPSTASH_ENABLED ? RANKED_UPSTASH_KEY : "",
      file: RANKED_STATE_FILE,
      localFallbackLabel: RANKED_FILE_STORAGE_LABEL,
      localFallbackDurable: RANKED_FILE_STORAGE_DURABLE
    },
    profiles: [...leaderboardProfiles.values()].map(serializeLeaderboardEntry),
    archives: [...rankedSeasonArchives.values()],
    rewardInbox: [...rankedRewardInbox.entries()].map(([playerId, rewards]) => ({
      playerId,
      rewards
    }))
  };
}

async function rankedUpstashCommand(command, ...args) {
  if (!RANKED_UPSTASH_ENABLED) {
    throw new Error("Upstash ranked storage is not configured.");
  }

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available. Render must run this with Node 18+.");
  }

  const response = await fetch(RANKED_UPSTASH_REST_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RANKED_UPSTASH_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([command, ...args])
  });

  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Upstash returned non-JSON response (${response.status}): ${text.slice(0, 180)}`);
  }

  if (!response.ok || body?.error) {
    throw new Error(body?.error || `Upstash HTTP ${response.status}`);
  }

  return body.result;
}

function rankedParseStatePayload(raw, sourceLabel = "ranked-state") {
  if (!raw) return null;

  if (typeof raw === "string") {
    const clean = raw.trim();
    if (!clean) return null;
    return JSON.parse(clean);
  }

  if (typeof raw === "object") {
    return raw;
  }

  throw new Error(`Unsupported ranked state payload from ${sourceLabel}.`);
}

function rankedApplyLoadedState(data, sourceLabel = "ranked-state") {
  if (!data || typeof data !== "object") return false;

  const rawProfileCount = Array.isArray(data.profiles) ? data.profiles.length : 0;

  leaderboardProfiles.clear();
  for (const raw of data.profiles || []) {
    hydrateLeaderboardEntry(raw);
  }

  rankedSeasonArchives.clear();
  for (const archive of data.archives || []) {
    if (archive?.seasonId) {
      rankedSeasonArchives.set(archive.seasonId, archive);
    }
  }

  rankedRewardInbox.clear();
  for (const row of data.rewardInbox || []) {
    if (row?.playerId) {
      rankedRewardInbox.set(row.playerId, Array.isArray(row.rewards) ? row.rewards : []);
    }
  }

  console.log(`[ranked] loaded ${leaderboardProfiles.size} profiles and ${rankedSeasonArchives.size} season archives from ${sourceLabel}.`);
  rankedStateEverLoaded = true;
  rankedHighestKnownProfileCount = Math.max(rankedHighestKnownProfileCount, leaderboardProfiles.size);
  if (rawProfileCount > leaderboardProfiles.size) rankedScheduleSave();
  return true;
}

async function rankedInspectUpstashState() {
  const info = {
    enabled: RANKED_UPSTASH_ENABLED,
    key: RANKED_UPSTASH_KEY,
    exists: false,
    bytes: 0,
    savedAt: null,
    profiles: 0,
    archives: 0,
    error: ""
  };

  if (!RANKED_UPSTASH_ENABLED) {
    return info;
  }

  try {
    const raw = await rankedUpstashCommand("GET", RANKED_UPSTASH_KEY);

    if (!raw) {
      return info;
    }

    info.exists = true;
    info.bytes = typeof raw === "string"
      ? Buffer.byteLength(raw, "utf8")
      : Buffer.byteLength(JSON.stringify(raw), "utf8");

    const data = rankedParseStatePayload(raw, "upstash-inspect");

    info.savedAt = data?.savedAt || null;
    info.profiles = Array.isArray(data?.profiles) ? data.profiles.length : 0;
    info.archives = Array.isArray(data?.archives) ? data.archives.length : 0;
  } catch (err) {
    info.error = err.message;
  }

  return info;
}

async function rankedGetExistingUpstashState() {
  if (!RANKED_UPSTASH_ENABLED) return null;

  const raw = await rankedUpstashCommand("GET", RANKED_UPSTASH_KEY);
  if (!raw) return null;

  return rankedParseStatePayload(raw, `upstash:${RANKED_UPSTASH_KEY}`);
}

async function rankedValidateNonDestructiveUpstashSave(payload) {
  if (!RANKED_UPSTASH_ENABLED) return { ok: true, existingProfiles: 0 };

  const incomingProfiles = Array.isArray(payload?.profiles) ? payload.profiles.length : 0;
  const allowProfileShrink = process.env.RANKED_ALLOW_PROFILE_SHRINK === "true";

  if (!rankedStateEverLoaded && incomingProfiles === 0) {
    return {
      ok: false,
      existingProfiles: rankedHighestKnownProfileCount,
      error: "Refusing to save empty ranked state before any successful load."
    };
  }

  let existing = null;

  try {
    existing = await rankedGetExistingUpstashState();
  } catch (err) {
    return {
      ok: false,
      existingProfiles: rankedHighestKnownProfileCount,
      error: `Refusing Upstash overwrite because existing state could not be inspected: ${err.message}`
    };
  }

  const existingProfiles = Array.isArray(existing?.profiles) ? existing.profiles.length : 0;
  const baselineProfiles = Math.max(existingProfiles, rankedHighestKnownProfileCount);

  if (!allowProfileShrink && baselineProfiles > 0 && incomingProfiles < baselineProfiles) {
    return {
      ok: false,
      existingProfiles: baselineProfiles,
      error: `Refusing to overwrite Upstash ranked state with fewer profiles (${incomingProfiles} < ${baselineProfiles}). Set RANKED_ALLOW_PROFILE_SHRINK=true only for an intentional full reset.`
    };
  }

  return { ok: true, existingProfiles };
}

function rankedTrimStateBackups(maxBackups = 12) {
  try {
    const dir = path.dirname(RANKED_STATE_FILE);
    const base = path.basename(RANKED_STATE_FILE);
    const backups = fs.readdirSync(dir)
      .filter(name => name.startsWith(`${base}.`) && name.endsWith(".bak"))
      .map(name => {
        const file = path.join(dir, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const backup of backups.slice(maxBackups)) {
      fs.unlinkSync(backup.file);
    }
  } catch (err) {
    console.warn("[ranked] backup trim failed:", err.message);
  }
}

function rankedSaveStateFileBackup(payload) {
  try {
    fs.mkdirSync(RANKED_STATE_DIR, { recursive: true });

    if (fs.existsSync(RANKED_STATE_FILE)) {
      fs.copyFileSync(RANKED_STATE_FILE, `${RANKED_STATE_FILE}.${Date.now()}.bak`);
    }

    const tmp = `${RANKED_STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, RANKED_STATE_FILE);
    rankedTrimStateBackups();
    return { ok: true, file: RANKED_STATE_FILE };
  } catch (err) {
    console.error("[ranked] local fallback save failed:", err);
    return { ok: false, file: RANKED_STATE_FILE, error: err.message };
  }
}

async function rankedSaveStateNow() {
  const payload = rankedStatePayload();
  const result = {
    ok: true,
    durable: RANKED_STATE_DURABLE,
    label: RANKED_STATE_STORAGE_LABEL,
    key: RANKED_UPSTASH_ENABLED ? RANKED_UPSTASH_KEY : "",
    file: RANKED_STATE_FILE,
    upstashSaved: false,
    fileBackupSaved: false,
    error: ""
  };

  if (RANKED_UPSTASH_ENABLED) {
    try {
      const guard = await rankedValidateNonDestructiveUpstashSave(payload);
      if (!guard.ok) {
        throw new Error(guard.error);
      }

      await rankedUpstashCommand("SET", RANKED_UPSTASH_KEY, JSON.stringify(payload));
      result.upstashSaved = true;
      rankedStateEverLoaded = true;
      rankedHighestKnownProfileCount = Math.max(
        rankedHighestKnownProfileCount,
        Array.isArray(payload.profiles) ? payload.profiles.length : 0,
        guard.existingProfiles || 0
      );
      rankedLastSuccessfulSaveAt = Date.now();
    } catch (err) {
      result.ok = false;
      result.error = err.message;
      console.error("[ranked] Upstash save failed:", err.message);
    }
  }

  const fileBackup = rankedSaveStateFileBackup(payload);
  result.fileBackupSaved = !!fileBackup.ok;

  if (!RANKED_UPSTASH_ENABLED && !fileBackup.ok) {
    result.ok = false;
    result.error = fileBackup.error || "Local file save failed.";
  }

  return result;
}

function rankedScheduleSave() {
  if (rankedStateSaveTimer) clearTimeout(rankedStateSaveTimer);
  rankedStateSaveTimer = setTimeout(() => {
    rankedStateSaveTimer = null;
    rankedSaveStateNow().catch(err => {
      console.error("[ranked] scheduled save failed:", err);
    });
  }, 1500);
  rankedStateSaveTimer.unref?.();
}

function rankedLoadCandidateFiles() {
  const files = [];
  const add = file => {
    if (file && !files.includes(file) && fs.existsSync(file)) files.push(file);
  };

  add(RANKED_STATE_FILE);
  add(RANKED_LEGACY_STATE_FILE);

  try {
    const dir = path.dirname(RANKED_STATE_FILE);
    const base = path.basename(RANKED_STATE_FILE);
    fs.readdirSync(dir)
      .filter(name => name.startsWith(`${base}.`) && name.endsWith(".bak"))
      .map(name => {
        const file = path.join(dir, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .forEach(entry => add(entry.file));
  } catch (err) {}

  return files;
}

async function rankedLoadState() {
  try {
    let loaded = null;

    if (RANKED_UPSTASH_ENABLED) {
      try {
        const raw = await rankedUpstashCommand("GET", RANKED_UPSTASH_KEY);

        if (raw) {
          loaded = {
            file: `upstash:${RANKED_UPSTASH_KEY}`,
            data: rankedParseStatePayload(raw, `upstash:${RANKED_UPSTASH_KEY}`)
          };
        } else {
          console.warn(`[ranked] Upstash key ${RANKED_UPSTASH_KEY} is empty. Will try local fallback files.`);
        }
      } catch (err) {
        console.warn("[ranked] Upstash load failed. Will try local fallback files:", err.message);
      }
    }

    if (!loaded) {
      for (const file of rankedLoadCandidateFiles()) {
        try {
          loaded = {
            file,
            data: rankedParseStatePayload(fs.readFileSync(file, "utf8"), file)
          };
          break;
        } catch (err) {
          console.warn(`[ranked] could not load state candidate ${file}:`, err.message);
        }
      }
    }

    if (!loaded) {
      console.warn(`[ranked] no saved ranked state found. New state will be created in ${RANKED_STATE_STORAGE_LABEL}.`);
      return;
    }

    rankedApplyLoadedState(loaded.data, loaded.file);

    if (RANKED_UPSTASH_ENABLED && !String(loaded.file).startsWith("upstash:")) {
      console.warn(`[ranked] migrated local state from ${loaded.file} into Upstash key ${RANKED_UPSTASH_KEY}.`);
      rankedScheduleSave();
    }

    if (!RANKED_UPSTASH_ENABLED && loaded.file !== RANKED_STATE_FILE) {
      console.warn(`[ranked] migrated state from ${loaded.file} to ${RANKED_STATE_FILE}.`);
      rankedScheduleSave();
    }
  } catch (err) {
    console.error("[ranked] load failed:", err);
  }
}

function sortedRankedLeaderboardRowsForSeason(mode = "solo", seasonId = getRankedSeasonInfo().id) {
  const rows = [...leaderboardProfiles.values()]
    .map(entry => publicRankedLeaderboardEntry(entry, mode))
    .filter(row => row.seasonId === seasonId && (row.matches > 0 || row.rating > 1000));

  rows.sort((a, b) =>
    (b.rating - a.rating) ||
    (b.wins - a.wins) ||
    (b.kills - a.kills) ||
    (a.losses - b.losses)
  );

  return rows.slice(0, 50).map((row, index) => ({ ...row, position: index + 1 }));
}

function rankedRewardForPosition(position = 999, mode = "solo") {
  if (position === 1) return { gold: 25000, gems: 1200, title: `${mode.toUpperCase()} SEASON CHAMPION` };
  if (position <= 3) return { gold: 18000, gems: 800, title: `${mode.toUpperCase()} TOP 3` };
  if (position <= 10) return { gold: 12000, gems: 450, title: `${mode.toUpperCase()} TOP 10` };
  if (position <= 25) return { gold: 7000, gems: 220, title: `${mode.toUpperCase()} TOP 25` };
  return { gold: 2500, gems: 75, title: `${mode.toUpperCase()} TOP 50` };
}

function rankedQueueReward(playerId, reward) {
  if (!playerId || !reward?.id) return;

  const rewards = rankedFilterRewardsForPlayer(playerId, { includeClaimed: true });
  if (rewards.some(existing => existing.id === reward.id)) return;

  const seasonIndex = rankedSeasonIndexFromId(reward.seasonId);

  rewards.push({
    ...reward,
    seasonIndex,
    expiresAfterSeasonIndex: seasonIndex ? seasonIndex + 1 : null,
    claimed: false,
    paidAt: null,
    createdAt: Date.now()
  });

  rankedRewardInbox.set(playerId, rewards);
}

function createRankedSeasonArchive(seasonId, reason = "auto_rollover") {
  if (!seasonId || rankedSeasonArchives.has(seasonId)) return rankedSeasonArchives.get(seasonId) || null;

  const solo = sortedRankedLeaderboardRowsForSeason("solo", seasonId);
  const duo = sortedRankedLeaderboardRowsForSeason("duo", seasonId);

  const archive = {
    seasonId,
    reason,
    finalizedAt: Date.now(),
    rankedSolo: solo,
    rankedDuo: duo,
    payouts: []
  };

  for (const mode of ["solo", "duo"]) {
    const rows = mode === "solo" ? solo : duo;

    for (const row of rows.slice(0, 50)) {
      const reward = rankedRewardForPosition(row.position, mode);
      const payout = {
        id: `${seasonId}:${mode}:${row.position}:${row.playerId}`,
        seasonId,
        mode,
        position: row.position,
        playerId: row.playerId,
        name: row.name,
        rating: row.rating,
        ...reward
      };

      archive.payouts.push(payout);
      if (row.position <= 50) rankedQueueReward(row.playerId, payout);
    }
  }

  rankedSeasonArchives.set(seasonId, archive);
  return archive;
}

function finalizeExpiredRankedSeasons(reason = "auto_rollover") {
  const current = getRankedSeasonInfo();
  const expiredSeasonIds = new Set();

  for (const entry of leaderboardProfiles.values()) {
    for (const mode of ["solo", "duo"]) {
      const bucket = entry.ranked?.[mode];
      if (bucket?.seasonId && bucket.seasonId !== current.id && safeStatInt(bucket.matches) > 0) {
        expiredSeasonIds.add(bucket.seasonId);
      }
    }
  }

  if (!expiredSeasonIds.size) return [];

  const archives = [];

  for (const seasonId of expiredSeasonIds) {
    const archive = createRankedSeasonArchive(seasonId, reason);
    if (archive) archives.push(archive);
  }

  for (const entry of leaderboardProfiles.values()) {
    for (const mode of ["solo", "duo"]) {
      if (entry.ranked?.[mode]?.seasonId && entry.ranked[mode].seasonId !== current.id) {
        entry.ranked[mode] = defaultServerRankedBucket();
      }
    }
    entry.rankedPoints = Math.max(entry.ranked?.solo?.rating || 1000, entry.ranked?.duo?.rating || 1000);
  }

  rankedScheduleSave();
  broadcastLeaderboards();
  return archives;
}

function requireRankedAdmin(req, res) {
  const provided = String(req.headers["x-admin-key"] || req.query.key || "");
  if (!RANKED_ADMIN_KEY) {
    res.status(503).json({ ok: false, error: "RANKED_ADMIN_KEY is not configured." });
    return false;
  }
  if (provided !== RANKED_ADMIN_KEY) {
    res.status(403).json({ ok: false, error: "Invalid admin key." });
    return false;
  }
  return true;
}

function getOrCreateLeaderboardEntry(profile = {}) {
  const playerId = String(profile.playerId || "").trim() || createSecurePlayerId();
  const requestedName = String(profile.name || "Survivor").trim().slice(0, 24) || "Survivor";

  let entry = leaderboardProfiles.get(playerId);

  if (!entry) {
    entry = {
      playerId,
      name: requestedName,
      rank: "SURVIVOR",
      level: 1,
      profileXp: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      losses: 0,
      revives: 0,
      gold: 1000,
      gems: 0,
      rankedPoints: 1000,
      ranked: {
        solo: defaultServerRankedBucket(),
        duo: defaultServerRankedBucket()
      },
      color: String(profile.color || "#38bdf8").slice(0, 24),
      icon: String(profile.icon || "DS").slice(0, 12),
      reportKeys: new Set(),
      firstSeenAt: Date.now(),
      updatedAt: Date.now()
    };

    leaderboardProfiles.set(playerId, entry);
  }

  if (!(entry.reportKeys instanceof Set)) entry.reportKeys = new Set();

  if (!entry.ranked || typeof entry.ranked !== "object") {
    entry.ranked = {
      solo: defaultServerRankedBucket(),
      duo: defaultServerRankedBucket()
    };
  }

  if (!entry.ranked.solo) entry.ranked.solo = defaultServerRankedBucket();
  if (!entry.ranked.duo) entry.ranked.duo = defaultServerRankedBucket();

  entry.name = requestedName || entry.name || "Survivor";
  entry.color = String(profile.color || entry.color || "#38bdf8").slice(0, 24);
  entry.icon = String(profile.icon || entry.icon || "DS").slice(0, 12);
  entry.rank = String(entry.rank || "SURVIVOR").slice(0, 32);
  entry.level = safeStatInt(entry.level, 1, PROFILE_MAX_LEVEL);
  entry.profileXp = entry.level >= PROFILE_MAX_LEVEL
    ? 0
    : safeStatInt(entry.profileXp, 0, 999999999);
  entry.wins = safeStatInt(entry.wins);
  entry.kills = safeStatInt(entry.kills);
  entry.deaths = safeStatInt(entry.deaths);
  entry.losses = safeStatInt(entry.losses);
  entry.revives = safeStatInt(entry.revives);
  entry.gold = safeStatInt(entry.gold, 1000, 999999999);
  entry.gems = safeStatInt(entry.gems, 0, 999999999);
  entry.rankedPoints = safeStatInt(entry.rankedPoints, 1000, 999999);
  entry.updatedAt = Date.now();

  return entry;
}

function publicLeaderboardEntry(entry, index = 0) {
  const wins = safeStatInt(entry.wins);
  const kills = safeStatInt(entry.kills);
  const deaths = safeStatInt(entry.deaths);
  const losses = safeStatInt(entry.losses);
  const revives = safeStatInt(entry.revives);

  return {
    position: index + 1,
    playerId: entry.playerId,
    name: entry.name,
    rank: entry.rank || "SURVIVOR",
    level: Math.max(1, Math.min(PROFILE_MAX_LEVEL, Number(entry.level || 1))),
    profileXp: Math.max(0, Number(entry.profileXp || 0)),
    xpToNext: profileXpForNextLevel(entry.level || 1),
    wins,
    kills,
    deaths,
    losses,
    revives,
    score: wins * 1000 + kills * 25 + revives * 12 - deaths * 4 - losses * 10,
    color: entry.color || "#38bdf8",
    icon: entry.icon || "DS",
    updatedAt: entry.updatedAt || Date.now()
  };
}

function sortedLeaderboardRows(sortKey = "kills") {
  const rows = [...leaderboardProfiles.values()].map(publicLeaderboardEntry);

  rows.sort((a, b) => {
    if (sortKey === "wins") return (b.wins - a.wins) || (b.kills - a.kills) || (a.losses - b.losses);
    if (sortKey === "overall") return (b.score - a.score) || (b.wins - a.wins) || (b.kills - a.kills);
    return (b.kills - a.kills) || (b.wins - a.wins) || (a.deaths - b.deaths);
  });

  return rows.slice(0, 100).map((row, index) => ({ ...row, position: index + 1 }));
}

function getLeaderboardPayload() {
  return {
    kills: sortedLeaderboardRows("kills"),
    wins: sortedLeaderboardRows("wins"),
    overall: sortedLeaderboardRows("overall"),
    rankedSolo: sortedRankedLeaderboardRows("solo"),
    rankedDuo: sortedRankedLeaderboardRows("duo"),
    rankedSeason: getRankedSeasonInfo(),
    rankedArchives: [...rankedSeasonArchives.values()]
      .sort((a, b) => Number(b.finalizedAt || 0) - Number(a.finalizedAt || 0))
      .slice(0, 8),
    updatedAt: Date.now()
  };
}

function broadcastLeaderboards() {
  io.emit("leaderboards", getLeaderboardPayload());
}

function applyLeaderboardMatchReport(socketId, data = {}) {
  const p = getPlayer(socketId);
  if (!p) return { ok: false };

  const entry = getOrCreateLeaderboardEntry({
    ...p,
    ...(data.profile || {})
  });

  if (entry.playerId !== p.playerId) {
    if (p.playerId && idToSocket.get(p.playerId) === socket.id) idToSocket.delete(p.playerId);
    p.playerId = entry.playerId;
    idToSocket.set(p.playerId, socket.id);
  }

  const reportKey = String(data.reportKey || `${entry.playerId}:${data.matchId || Date.now()}`).slice(0, 160);
  if (entry.reportKeys.has(reportKey)) {
    return { ok: true, duplicate: true };
  }

  entry.reportKeys.add(reportKey);
  if (entry.reportKeys.size > 80) {
    entry.reportKeys = new Set([...entry.reportKeys].slice(-40));
  }

  const stats = data.stats || {};
  const won = !!data.won;

  entry.kills += safeStatInt(stats.kills, 0, 100);
  entry.deaths += stats.deaths == null ? (won ? 0 : 1) : safeStatInt(stats.deaths, 0, 1);
  entry.wins += stats.wins == null ? (won ? 1 : 0) : safeStatInt(stats.wins, 0, 1);
  entry.losses += stats.losses == null ? (won ? 0 : 1) : safeStatInt(stats.losses, 0, 1);
  entry.revives += safeStatInt(stats.revives, 0, 25);

  const rankedReport = normalizeRankedReport(data.ranked);
  if (rankedReport) {
    applyRankedReportToEntry(entry, rankedReport);
  }

  entry.updatedAt = Date.now();
  rankedScheduleSave();

  p.rank = entry.rank;
  p.level = entry.level;
  p.profileXp = entry.profileXp || 0;
  p.wins = entry.wins;
  p.kills = entry.kills;
  p.deaths = entry.deaths;
  p.losses = entry.losses;
  p.revives = entry.revives;

  return { ok: true, entry };
}

function getVoiceRoomId(p) {
  if (!p) return null;
  if (p.matchId && matches.has(p.matchId)) return `match:${p.matchId}`;
  if (p.partyId && parties.has(p.partyId)) return `party:${p.partyId}`;
  return "menu:global";
}

function getVoicePeerPayload(p) {
  const voiceRoomId = p.voiceRoomId || getVoiceRoomId(p);

  return {
    ...publicPlayer(p),
    socketId: p.socketId,
    matchId: p.matchId || null,
    partyId: p.partyId || null,
    voiceRoomId
  };
}

function getVoiceMatchPeerIds(socketId) {
  const p = getPlayer(socketId);
  const roomId = p?.voiceRoomId || getVoiceRoomId(p);
  if (!p || !roomId) return [];

  if (roomId.startsWith("match:")) {
    const matchId = roomId.slice("match:".length);
    const match = matches.get(matchId);
    if (match) return [...match.players.keys()].filter(id => id !== socketId && io.sockets.sockets.has(id));
  }

  if (roomId.startsWith("party:")) {
    const partyId = roomId.slice("party:".length);
    const party = parties.get(partyId);
    if (party) return party.members.filter(id => id !== socketId && io.sockets.sockets.has(id));
  }

  return [...players.values()]
    .filter(other => other.socketId !== socketId && (other.voiceRoomId || getVoiceRoomId(other)) === roomId)
    .map(other => other.socketId)
    .filter(id => io.sockets.sockets.has(id));
}

function emitVoicePeerLeft(socketId, reason = "left") {
  const p = getPlayer(socketId);
  const roomId = p?.voiceRoomId || getVoiceRoomId(p);
  if (!p || !roomId) return;

  for (const peerId of getVoiceMatchPeerIds(socketId)) {
    io.to(peerId).emit("voicePeerLeft", {
      socketId,
      playerId: p.playerId,
      name: p.name,
      reason
    });
  }
}

function emitPartyUpdate(partyId) {
  const party = parties.get(partyId);
  if (!party) return;

  const members = party.members
    .map(id => getPlayer(id))
    .filter(Boolean)
    .map(p => ({
      ...publicPlayer(p),
      ready: !!party.ready[p.socketId],
      leader: p.socketId === party.leaderId
    }));

  const payload = {
    partyId,
    leaderId: party.leaderId,
    status: party.status,
    matchId: party.matchId || null,
    seed: party.seed || null,
    modeIntent: party.modeIntent || "duo",
    teamSize: party.teamSize || TEAM_SIZE_BY_MODE[party.modeIntent || "duo"] || 2,
    maxSize: party.maxSize || PARTY_MAX_SIZE,
    members
  };

  for (const socketId of party.members) {
    io.to(socketId).emit("partyUpdate", payload);
  }
}

function leaveParty(socketId) {
  const p = getPlayer(socketId);
  if (!p || !p.partyId) return;

  const partyId = p.partyId;
  const party = parties.get(partyId);
  p.partyId = null;

  if (!party) return;

  party.members = party.members.filter(id => id !== socketId);
  delete party.ready[socketId];

  if (party.members.length <= 0) {
    parties.delete(partyId);
    return;
  }

  if (party.leaderId === socketId) {
    party.leaderId = party.members[0];
  }

  emitPartyUpdate(partyId);
}

function kickPlayerFromParty(leaderId, targetSocketId) {
  const leader = getPlayer(leaderId);
  if (!leader || !leader.partyId) return { ok: false, error: "You are not in a party." };

  const party = parties.get(leader.partyId);
  if (!party) return { ok: false, error: "Party not found." };
  if (party.leaderId !== leaderId) return { ok: false, error: "Only the party leader can kick players." };
  if (party.status === "matching") return { ok: false, error: "Cannot kick players while queued or in match." };
  if (!targetSocketId || targetSocketId === leaderId) return { ok: false, error: "Invalid party member." };
  if (!party.members.includes(targetSocketId)) return { ok: false, error: "That player is not in your party." };

  const target = getPlayer(targetSocketId);
  party.members = party.members.filter(id => id !== targetSocketId);
  delete party.ready[targetSocketId];

  if (target) target.partyId = null;

  const targetSocket = io.sockets.sockets.get(targetSocketId);
  if (targetSocket) {
    targetSocket.emit("partyKicked", {
      reason: "You were removed from the party.",
      partyId: party.partyId
    });
  }

  for (const id of party.members) {
    party.ready[id] = false;
  }

  emitPartyUpdate(party.partyId);
  broadcastOnlineList();

  return { ok: true };
}

function makeParty(leaderId) {
  const leader = getPlayer(leaderId);
  if (!leader) return null;

  leaveParty(leaderId);

  const partyId = makePartyId();

  const party = {
    partyId,
    leaderId,
    members: [leaderId],
    ready: {
      [leaderId]: false
    },
    status: "lobby",
    matchId: null,
    seed: null,
    modeIntent: "duo",
    teamSize: 2,
    maxSize: PARTY_MAX_SIZE
  };

  parties.set(partyId, party);
  leader.partyId = partyId;

  return party;
}

function addPlayerToParty(party, socketId) {
  const p = getPlayer(socketId);

  if (!party || !p) {
    return { ok: false, error: "Player not found." };
  }

  if (p.partyId && p.partyId !== party.partyId) {
    return { ok: false, error: "That player is already in a party." };
  }

  if (party.members.includes(socketId)) {
    return { ok: true, party };
  }

  if (party.members.length >= (party.maxSize || PARTY_MAX_SIZE)) {
    return { ok: false, error: "Party is already full." };
  }

  party.members.push(socketId);
  party.ready[socketId] = false;
  p.partyId = party.partyId;

  return { ok: true, party };
}

function addGuestToLeaderParty(leaderId, guestId) {
  const leader = getPlayer(leaderId);
  const guest = getPlayer(guestId);

  if (!leader || !guest) return null;
  if (guest.partyId) return null;

  let party = leader.partyId ? parties.get(leader.partyId) : null;

  if (party && party.leaderId !== leaderId) return null;
  if (!party) party = makeParty(leaderId);
  if (!party) return null;

  const added = addPlayerToParty(party, guestId);
  if (!added.ok) return null;

  party.status = "lobby";
  party.matchId = null;
  party.seed = null;

  for (const id of party.members) {
    party.ready[id] = false;
  }

  emitPartyUpdate(party.partyId);
  broadcastOnlineList();

  return party;
}

function createParty(leaderId, guestId) {
  return addGuestToLeaderParty(leaderId, guestId);
}

function createMatchFromParty(party, mode = "duo") {
  const cleanMode = mode === "team" ? "team" : "duo";
  const teamSize = TEAM_SIZE_BY_MODE[cleanMode] || 2;
  const matchId = makeMatchId();
  const seed = makeSeed();
  const now = Date.now();

  const match = {
    matchId,
    seed,
    mode: cleanMode,
    partyId: party.partyId,
    teamSize,
    totalSlots: MATCH_TOTAL_SLOTS,
    queueStartAt: now,
    deployAt: now + ONLINE_QUEUE_MS,
    worldAuthoritySocketId: party.leaderId || party.members[0] || null,
    worldSnapshot: null,
    lastWorldSnapshotAt: 0,
    ranked: !!party.rankedIntent,
    players: new Map()
  };

  for (const socketId of party.members) {
    const p = getPlayer(socketId);
    if (!p) continue;

    p.inMatch = true;
    p.matchId = matchId;

    match.players.set(socketId, {
      socketId,
      playerId: p.playerId,
      name: p.name,
      teamId: party.partyId,
      alive: true,
      hp: 100,
      x: 0,
      y: 0,
      angle: 0
    });

    const socket = io.sockets.sockets.get(socketId);
    if (socket) socket.join(matchId);
  }

  matches.set(matchId, match);

  party.matchId = matchId;
  party.seed = seed;
  party.status = "matching";
  party.modeIntent = cleanMode;
  party.teamSize = teamSize;

  const teammates = party.members
    .map(id => getPlayer(id))
    .filter(Boolean)
    .map(publicPlayer);

  const humanCount = Math.max(1, teammates.length);
  const botTarget = rollMatchBotTarget(humanCount);
  match.botTarget = botTarget;
  match.populationTarget = Math.min(MATCH_TOTAL_SLOTS, humanCount + botTarget);

  const botFillSlots = Math.max(0, teamSize - teammates.length);

  for (const socketId of party.members) {
    io.to(socketId).emit("partyMatchStart", {
      matchId,
      seed,
      partyId: party.partyId,
      mode: cleanMode,
      teamSize,
      botFillSlots,
      totalSlots: MATCH_TOTAL_SLOTS,
      botCount: botTarget,
      populationTarget: match.populationTarget,
      queueMs: ONLINE_QUEUE_MS,
      serverNow: now,
      deployAt: match.deployAt,
      worldAuthoritySocketId: match.worldAuthoritySocketId,
      ranked: !!match.ranked,
      teammates
    });
  }

  broadcastMatchSync(match);

  emitPartyUpdate(party.partyId);
  broadcastOnlineList();
}

function createDuoMatchFromParty(party) {
  createMatchFromParty(party, "duo");
}

function cleanQuickMatchMode(mode = "duo") {
  return mode === "team" ? "team" : "duo";
}

function publicMatchTeammates(match) {
  return [...match.players.values()]
    .map(entry => getPlayer(entry.socketId))
    .filter(Boolean)
    .map(publicPlayer);
}

function findJoinablePublicMatch(mode = "duo") {
  const cleanMode = cleanQuickMatchMode(mode);
  const teamSize = TEAM_SIZE_BY_MODE[cleanMode] || 2;
  const now = Date.now();

  return [...matches.values()]
    .filter(match => {
      if (!match || !match.publicQueue) return false;
      if (match.mode !== cleanMode) return false;
      if (match.ranked) return false;

      // Keep a small safety window so nobody joins right as deployment fires.
      if (now >= (match.deployAt || 0) - 2500) return false;

      // Public quick-match is random-teammate based: Duo max 2 humans, Squad max 4 humans.
      if (getMatchHumanCount(match) >= teamSize) return false;

      return true;
    })
    .sort((a, b) => {
      const humanDiff = getMatchHumanCount(b) - getMatchHumanCount(a);
      if (humanDiff !== 0) return humanDiff;

      // Prefer the lobby that is closer to deploying, as long as it is still joinable.
      return (a.deployAt || 0) - (b.deployAt || 0);
    })[0] || null;
}

function createPublicQuickMatch(mode = "duo") {
  const cleanMode = cleanQuickMatchMode(mode);
  const teamSize = TEAM_SIZE_BY_MODE[cleanMode] || 2;
  const matchId = makeMatchId();
  const seed = makeSeed();
  const now = Date.now();

  const match = {
    matchId,
    seed,
    mode: cleanMode,
    partyId: null,
    publicQueue: true,
    teamSize,
    totalSlots: MATCH_TOTAL_SLOTS,
    queueStartAt: now,
    deployAt: now + ONLINE_QUEUE_MS,
    worldAuthoritySocketId: null,
    worldSnapshot: null,
    lastWorldSnapshotAt: 0,
    ranked: false,
    players: new Map()
  };

  matches.set(matchId, match);
  return match;
}

function emitPublicMatchTeamUpdate(match) {
  if (!match) return;

  const teammates = publicMatchTeammates(match);
  const humanCount = Math.max(1, teammates.length);
  const botTarget = getMatchBotTarget(match, humanCount);

  match.populationTarget = Math.min(MATCH_TOTAL_SLOTS, humanCount + botTarget);

  for (const entry of match.players.values()) {
    io.to(entry.socketId).emit("matchTeamUpdate", {
      matchId: match.matchId,
      mode: match.mode,
      teamSize: match.teamSize || TEAM_SIZE_BY_MODE[match.mode] || 2,
      teammates,
      botFillSlots: Math.max(0, (match.teamSize || 2) - teammates.length),
      humanCount,
      botCount: botTarget,
      populationTarget: match.populationTarget,
      worldAuthoritySocketId: match.worldAuthoritySocketId
    });
  }
}

function joinPublicQuickMatch(socket, mode = "duo") {
  const p = getPlayer(socket.id);
  if (!p) return { ok: false, error: "Not registered." };
  if (p.inMatch) return { ok: false, error: "You are already in a match." };

  // Parties should continue using the normal party-ready matchmaking path.
  if (p.partyId) return { ok: false, error: "Leave your party or use party ready check." };

  const cleanMode = cleanQuickMatchMode(mode);
  const teamSize = TEAM_SIZE_BY_MODE[cleanMode] || 2;

  let match = findJoinablePublicMatch(cleanMode);
  const joinedExisting = !!match;

  if (!match) {
    match = createPublicQuickMatch(cleanMode);
  }

  if (!match.worldAuthoritySocketId || !io.sockets.sockets.has(match.worldAuthoritySocketId)) {
    match.worldAuthoritySocketId = socket.id;
  }

  p.inMatch = true;
  p.matchId = match.matchId;

  // Public quick-match randoms are teammates in Duo/Squad.
  match.players.set(socket.id, {
    socketId: socket.id,
    playerId: p.playerId,
    name: p.name,
    teamId: "player_team",
    alive: true,
    hp: 100,
    x: 0,
    y: 0,
    angle: 0
  });

  socket.join(match.matchId);

  const humanCount = getMatchHumanCount(match);
  const botTarget = getMatchBotTarget(match, humanCount);
  match.botTarget = botTarget;
  match.populationTarget = Math.min(MATCH_TOTAL_SLOTS, humanCount + botTarget);

  const teammates = publicMatchTeammates(match);

  socket.emit("partyMatchStart", {
    matchId: match.matchId,
    seed: match.seed,
    partyId: null,
    mode: cleanMode,
    teamSize,
    botFillSlots: Math.max(0, teamSize - teammates.length),
    totalSlots: MATCH_TOTAL_SLOTS,
    botCount: botTarget,
    populationTarget: match.populationTarget,
    queueMs: Math.max(0, match.deployAt - Date.now()),
    serverNow: Date.now(),
    deployAt: match.deployAt,
    worldAuthoritySocketId: match.worldAuthoritySocketId,
    ranked: false,
    teammates,
    joinedExisting
  });

  emitPublicMatchTeamUpdate(match);
  broadcastMatchSync(match);
  broadcastOnlineList();

  return { ok: true, match, joinedExisting };
}

function cancelMatchBackToPartyLobby(match, reason = "Queue cancelled.") {
  if (!match) return;

  const party = match.partyId ? parties.get(match.partyId) : null;

  for (const entry of match.players.values()) {
    const profile = getPlayer(entry.socketId);
    const socket = io.sockets.sockets.get(entry.socketId);

    if (profile) {
      profile.inMatch = false;
      profile.matchId = null;
    }

    if (socket) {
      socket.leave(match.matchId);
      socket.emit("matchQueueCancelled", {
        matchId: match.matchId,
        reason
      });
    }
  }

  if (party) {
    party.status = "lobby";
    party.matchId = null;
    party.seed = null;

    for (const id of party.members) {
      party.ready[id] = false;
    }

    emitPartyUpdate(party.partyId);
  }

  matches.delete(match.matchId);
  broadcastOnlineList();
}

function finalizeServerMatchResults(match, winners) {
  if (!match || match.resultsFinalized) return;

  match.resultsFinalized = true;

  const winnerSocketIds = new Set(winners.map(entry => entry.socketId));

  for (const entry of match.players.values()) {
    if (!entry?.playerId) continue;

    const won = winnerSocketIds.has(entry.socketId);
    const profileEntry = getOrCreateLeaderboardEntry({
      playerId: entry.playerId,
      name: entry.name || "Survivor"
    });

    const verifiedKills = safeStatInt(entry.matchKills, 0, MATCH_TOTAL_SLOTS);

    profileEntry.kills += verifiedKills;
    profileEntry.wins += won ? 1 : 0;
    profileEntry.losses += won ? 0 : 1;
    profileEntry.deaths += won ? 0 : 1;
    profileEntry.updatedAt = Date.now();

    const liveProfile = getPlayer(entry.socketId);

    if (liveProfile) {
      liveProfile.rank = profileEntry.rank;
      liveProfile.level = profileEntry.level;
      liveProfile.profileXp = profileEntry.profileXp || 0;
      liveProfile.wins = profileEntry.wins;
      liveProfile.kills = profileEntry.kills;
      liveProfile.deaths = profileEntry.deaths;
      liveProfile.losses = profileEntry.losses;
      liveProfile.revives = profileEntry.revives;

      io.to(entry.socketId).emit("profileAssigned", privatePlayerProfile(liveProfile));
    }
  }

  rankedScheduleSave();
  broadcastLeaderboards();
}

function checkMatchWinner(match) {
  if (!match || match.resultsFinalized) return;

  const alive = [...match.players.values()].filter(entry => entry.alive);
  if (alive.length <= 0) return;

  const aliveTeams = [...new Set(alive.map(entry => entry.teamId || entry.socketId))];
  if (aliveTeams.length !== 1) return;

  const winners = alive.filter(entry => (entry.teamId || entry.socketId) === aliveTeams[0]);

  finalizeServerMatchResults(match, winners);

  for (const entry of match.players.values()) {
    const won = winners.some(winner => winner.socketId === entry.socketId);

    io.to(entry.socketId).emit("matchWinner", {
      matchId: match.matchId,
      won,
      winners
    });

    const profile = getPlayer(entry.socketId);

    if (profile) {
      profile.inMatch = false;
      profile.matchId = null;
    }
  }

  matches.delete(match.matchId);
  broadcastOnlineList();
}

function makeReconnectPlayerPayload(entry) {
  const state = entry?.state || {};

  return {
    ...state,
    socketId: entry.socketId,
    playerId: entry.playerId,
    name: entry.name,
    teamId: entry.teamId,
    alive: entry.alive !== false,
    hp: entry.hp ?? state.hp ?? state.health ?? 100,
    health: entry.hp ?? state.hp ?? state.health ?? 100,
    maxHp: entry.maxHp ?? state.maxHp ?? 100,
    shieldHp: entry.shieldHp ?? state.shieldHp ?? 0,
    shieldMax: entry.shieldMax ?? state.shieldMax ?? 0,
    armorHp: entry.armorHp ?? state.armorHp ?? 0,
    armorMax: entry.armorMax ?? state.armorMax ?? 100,
    x: entry.x ?? state.x ?? 0,
    y: entry.y ?? state.y ?? 0,
    angle: entry.angle ?? state.angle ?? 0,
    disconnected: !!entry.disconnected,
    leftMatch: !!entry.leftMatch
  };
}

function removeExpiredMatchPartyMember(match, socketId) {
  const party = match?.partyId ? parties.get(match.partyId) : null;
  if (!party) return;

  party.members = party.members.filter(id => id !== socketId);
  delete party.ready[socketId];

  if (party.members.length <= 0) {
    parties.delete(party.partyId);
    return;
  }

  if (party.leaderId === socketId) {
    party.leaderId = party.members[0];
  }

  emitPartyUpdate(party.partyId);
}

function expireDisconnectedMatchPlayer(matchId, socketId, playerId) {
  const match = matches.get(matchId);
  const entry = match?.players.get(socketId);

  if (!match || !entry || entry.playerId !== playerId || !entry.disconnected) return;

  const disconnectedFor = Date.now() - Number(entry.disconnectedAt || 0);

  if (disconnectedFor < MATCH_RECONNECT_GRACE_MS) {
    entry.reconnectTimer = setTimeout(() => {
      expireDisconnectedMatchPlayer(matchId, socketId, playerId);
    }, MATCH_RECONNECT_GRACE_MS - disconnectedFor);

    entry.reconnectTimer.unref?.();
    return;
  }

  entry.disconnected = false;
  entry.leftMatch = true;
  entry.reconnectExpired = true;
  entry.alive = false;
  entry.hp = 0;
  entry.state = {
    ...(entry.state || {}),
    alive: false,
    hp: 0,
    health: 0,
    isDowned: false,
    updatedAt: Date.now()
  };

  removeExpiredMatchPartyMember(match, socketId);

  io.to(matchId).emit("matchPlayerLeft", {
    socketId,
    playerId,
    name: entry.name,
    reason: "reconnect_timeout",
    finalLeave: true
  });

  broadcastMatchSync(match);
  checkMatchWinner(match);
  broadcastOnlineList();
}

function holdMatchPlayerForReconnect(match, entry, player) {
  if (!match || !entry || !player) return;

  clearTimeout(entry.reconnectTimer);

  const now = Date.now();

  entry.disconnected = true;
  entry.disconnectedAt = now;
  entry.reconnectGraceUntil = now + MATCH_RECONNECT_GRACE_MS;
  entry.leftMatch = false;
  entry.reconnectExpired = false;
  entry.state = {
    ...(entry.state || {}),
    updatedAt: now
  };

  entry.reconnectTimer = setTimeout(() => {
    expireDisconnectedMatchPlayer(match.matchId, entry.socketId, entry.playerId);
  }, MATCH_RECONNECT_GRACE_MS);

  entry.reconnectTimer.unref?.();

  io.to(match.matchId).emit("matchPlayerLeft", {
    socketId: entry.socketId,
    playerId: entry.playerId,
    name: entry.name,
    reason: "disconnected",
    finalLeave: false,
    reconnectGraceMs: MATCH_RECONNECT_GRACE_MS
  });

  broadcastMatchSync(match);
}

let rankedSeasonTimer = null;

async function startServer() {
  await rankedLoadState();
  finalizeExpiredRankedSeasons("server_startup");

  rankedSeasonTimer = setInterval(() => {
    finalizeExpiredRankedSeasons("scheduled_check");
  }, 60 * 60 * 1000);
  rankedSeasonTimer.unref?.();

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Duel Survivor multiplayer server running on ${PORT}`);
  });
}

function shutdownRankedServer(signal) {
  console.log(`[server] ${signal} received. Saving ranked state before shutdown...`);

  const forceExit = setTimeout(() => process.exit(0), 2500);
  forceExit.unref?.();

  rankedSaveStateNow()
    .catch(err => console.error("[ranked] shutdown save failed:", err))
    .finally(() => process.exit(0));
}

process.on("SIGINT", () => shutdownRankedServer("SIGINT"));
process.on("SIGTERM", () => shutdownRankedServer("SIGTERM"));

io.on("connection", socket => {
  console.log("[socket] connected:", socket.id);

  socket.on("register", data => {
    if (!PLAYER_SESSION_SECRET) {
      socket.emit("securityError", "Server account security is not configured.");
      return;
    }

    const session = verifyPlayerSessionToken(data?.sessionToken);
    const playerId = session?.playerId || createSecurePlayerId();
    const existingSocketId = idToSocket.get(playerId);

    if (existingSocketId && existingSocketId !== socket.id) {
      const existingSocket = io.sockets.sockets.get(existingSocketId);
      const existingPlayer = players.get(existingSocketId);

      if (existingPlayer) existingPlayer.replacedBySocketId = socket.id;

      if (existingSocket?.connected) {
        existingSocket.emit("profileSessionReplaced", { playerId });
        existingSocket.disconnect(true);
      } else {
        players.delete(existingSocketId);
      }

      idToSocket.delete(playerId);
    }

    const profileEntry = getOrCreateLeaderboardEntry({
      playerId,
      name: String(data?.name || "Survivor").trim().slice(0, 24),
      color: data?.color,
      icon: data?.icon
    });

    const p = {
      socketId: socket.id,
      playerId,
      name: profileEntry.name,
      rank: profileEntry.rank,
      level: profileEntry.level,
      profileXp: profileEntry.profileXp || 0,
      wins: profileEntry.wins,
      kills: profileEntry.kills,
      deaths: profileEntry.deaths,
      losses: profileEntry.losses,
      revives: profileEntry.revives,
      gold: profileEntry.gold,
      gems: profileEntry.gems,
      color: profileEntry.color,
      icon: profileEntry.icon,
      partyId: null,
      inMatch: false,
      matchId: null,
      sessionToken: issuePlayerSessionToken(playerId)
    };

    idToSocket.set(playerId, socket.id);
    players.set(socket.id, p);

    socket.emit("profileAssigned", privatePlayerProfile(p));
    broadcastOnlineList();
    broadcastLeaderboards();
  });

  socket.on("renamePlayer", (data, cb) => {
    const p = getPlayer(socket.id);
    if (!p) return cb?.({ ok: false, error: "Not registered." });

    const nextName = String(data?.name || "").trim().slice(0, 24);
    if (nextName.length < 3) {
      return cb?.({ ok: false, error: "Name must be at least 3 characters." });
    }

    const duplicate = [...players.values()].some(other =>
      other.socketId !== socket.id &&
      other.name.toLowerCase() === nextName.toLowerCase()
    );

    if (duplicate) {
      return cb?.({ ok: false, error: "That name is already online." });
    }

    p.name = nextName;
    cb?.({ ok: true, player: publicPlayer(p) });

    if (p.partyId) emitPartyUpdate(p.partyId);
    broadcastOnlineList();
  });

  socket.on("searchPlayers", (data, cb) => {
    const q = String(data?.q || "").trim().toLowerCase();

    if (!q) return cb?.({ ok: true, results: [] });

    const results = [...players.values()]
      .filter(p =>
        p.socketId !== socket.id &&
        (p.playerId.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      )
      .slice(0, 20)
      .map(publicPlayer);

    cb?.({ ok: true, results });
  });

  socket.on("friendRequest", data => {
    const from = getPlayer(socket.id);
    const targetSocket = getSocketByPlayerId(data?.targetId);

    if (!from) return;
    if (!targetSocket) return socket.emit("friendRequestFailed", "Player not found or offline.");

    targetSocket.emit("friendRequestIncoming", {
      fromSocketId: socket.id,
      fromPlayer: publicPlayer(from)
    });

    socket.emit("friendRequestSent", { targetId: data?.targetId });
  });

  socket.on("friendResponse", data => {
    const me = getPlayer(socket.id);
    const fromSocket = io.sockets.sockets.get(data?.fromSocketId);
    const from = getPlayer(data?.fromSocketId);

    if (!me || !fromSocket || !from) return;

    if (data?.accepted) {
      socket.emit("friendAccepted", { friend: publicPlayer(from) });
      fromSocket.emit("friendAccepted", { friend: publicPlayer(me) });
    } else {
      fromSocket.emit("friendDeclined", { player: publicPlayer(me) });
    }
  });

    socket.on("quickMatch", (data, cb) => {
    const mode = cleanQuickMatchMode(data?.mode || "duo");
    const result = joinPublicQuickMatch(socket, mode);

    if (!result.ok) {
      cb?.({
        ok: false,
        error: result.error || "Could not join quick match."
      });
      return;
    }

    cb?.({
      ok: true,
      matchId: result.match.matchId,
      joinedExisting: result.joinedExisting,
      mode: result.match.mode
    });
  });

  socket.on("partyInvite", data => {
    const from = getPlayer(socket.id);
    const targetSocket = getSocketByPlayerId(data?.targetId);
    const target = targetSocket ? getPlayer(targetSocket.id) : null;

    if (!from) return;
    if (!targetSocket || !target) return socket.emit("partyInviteFailed", "Friend is offline.");
    if (target.partyId) return socket.emit("partyInviteFailed", "That player is already in a party.");

    const party = from.partyId ? parties.get(from.partyId) : null;

    if (party && party.leaderId !== socket.id) {
      return socket.emit("partyInviteFailed", "Only the party leader can invite players.");
    }

    if (party && party.members.length >= (party.maxSize || PARTY_MAX_SIZE)) {
      return socket.emit("partyInviteFailed", "Party is already full.");
    }

    targetSocket.emit("partyInviteIncoming", {
      fromSocketId: socket.id,
      fromPlayer: publicPlayer(from),
      partySize: party ? party.members.length : 1,
      maxSize: PARTY_MAX_SIZE
    });

    socket.emit("partyInviteSent", { targetId: data?.targetId });
  });

  socket.on("partyInviteResponse", data => {
    const inviterSocket = io.sockets.sockets.get(data?.fromSocketId);
    const inviter = getPlayer(data?.fromSocketId);
    const me = getPlayer(socket.id);

    if (!me || !inviterSocket || !inviter) return;

    if (!data?.accepted) {
      inviterSocket.emit("partyInviteDeclined", { player: publicPlayer(me) });
      return;
    }

    const party = createParty(inviter.socketId, socket.id);

    if (!party) {
      socket.emit("partyInviteFailed", "Could not create Duo lobby.");
      inviterSocket.emit("partyInviteFailed", "Could not create Duo lobby.");
    }
  });

  socket.on("leaveParty", () => {
    leaveParty(socket.id);
    broadcastOnlineList();
  });

  socket.on("partyKick", data => {
    const result = kickPlayerFromParty(socket.id, data?.socketId);
    if (!result.ok) socket.emit("partyError", result.error || "Could not kick party member.");
  });

  function startPartyReadyCheck(mode = "duo", options = {}) {
    const cleanMode = mode === "team" ? "team" : "duo";

    const p = getPlayer(socket.id);
    if (!p || !p.partyId) return;

    const party = parties.get(p.partyId);
    if (!party) return;

    if (party.leaderId !== socket.id) {
      return socket.emit("partyError", "Only the party leader can start ready check.");
    }

    if (party.members.length < 2) {
      return socket.emit("partyError", "Invite at least one teammate first, or queue alone with NPC teammates from the client.");
    }

    if (cleanMode === "duo" && party.members.length > 2) {
      return socket.emit("partyError", "Duo only supports 2 players. Use Team Mode for 3-4 players.");
    }

    if (party.members.length > PARTY_MAX_SIZE) {
      return socket.emit("partyError", "Party is too large.");
    }

    party.status = "readying";
    party.modeIntent = cleanMode;
    party.rankedIntent = cleanMode === "duo" && !!options?.ranked;
    party.teamSize = TEAM_SIZE_BY_MODE[cleanMode] || 2;

    for (const id of party.members) {
      party.ready[id] = false;
    }

    emitPartyUpdate(party.partyId);
  }

  socket.on("partyStartModeReady", data => {
    startPartyReadyCheck(data?.mode || "duo", data || {});
  });

  socket.on("partyStartDuoReady", () => {
    startPartyReadyCheck("duo");
  });

  socket.on("partyReady", ready => {
    const p = getPlayer(socket.id);
    if (!p || !p.partyId) return;

    const party = parties.get(p.partyId);
    if (!party) return;

    party.ready[socket.id] = !!ready;
    emitPartyUpdate(party.partyId);

    const allReady =
      party.members.length >= 2 &&
      party.members.every(id => party.ready[id]);

    if (party.status === "readying" && allReady) {
      createMatchFromParty(party, party.modeIntent || "duo");
    }
  });

  socket.on("matchReconnectRequest", data => {
    const p = getPlayer(socket.id);
    const session = data?.session || {};
    const requestedMatchId = String(session.matchId || "").trim();

    if (!p || !requestedMatchId) {
      socket.emit("matchReconnectRejected", {
        reason: "Reconnect request is missing match information.",
        clearSession: true
      });
      return;
    }

    if (session.playerId && session.playerId !== p.playerId) {
      socket.emit("matchReconnectRejected", {
        reason: "Reconnect profile does not match this session.",
        clearSession: true
      });
      return;
    }

    const match = matches.get(requestedMatchId);

    if (!match) {
      socket.emit("matchReconnectRejected", {
        reason: "That match is no longer active.",
        clearSession: true
      });
      return;
    }

    const entry = [...match.players.values()].find(candidate => candidate?.playerId === p.playerId);

    if (
      !entry ||
      !entry.disconnected ||
      entry.leftMatch ||
      entry.reconnectExpired ||
      Date.now() > Number(entry.reconnectGraceUntil || 0)
    ) {
      socket.emit("matchReconnectRejected", {
        reason: "Your reconnect window has expired.",
        clearSession: true
      });
      return;
    }

    const oldSocketId = entry.socketId;

    clearTimeout(entry.reconnectTimer);

    match.players.delete(oldSocketId);

    entry.socketId = socket.id;
    entry.playerId = p.playerId;
    entry.name = p.name;
    entry.disconnected = false;
    entry.disconnectedAt = 0;
    entry.reconnectGraceUntil = 0;
    entry.reconnectExpired = false;
    entry.leftMatch = false;
    entry.reconnectTimer = null;
    entry.state = {
      ...(entry.state || {}),
      socketId: socket.id,
      playerId: p.playerId,
      name: p.name,
      updatedAt: Date.now()
    };

    match.players.set(socket.id, entry);

    p.inMatch = true;
    p.matchId = match.matchId;
    p.partyId = match.partyId || null;

    socket.join(match.matchId);

    const party = match.partyId ? parties.get(match.partyId) : null;

    if (party) {
      const memberIndex = party.members.indexOf(oldSocketId);

      if (memberIndex >= 0) {
        party.members[memberIndex] = socket.id;
      } else if (!party.members.includes(socket.id)) {
        party.members.push(socket.id);
      }

      party.ready[socket.id] = party.ready[oldSocketId] ?? false;
      delete party.ready[oldSocketId];

      if (party.leaderId === oldSocketId) {
        party.leaderId = socket.id;
      }

      emitPartyUpdate(party.partyId);
    }

    if (match.worldAuthoritySocketId === oldSocketId) {
      match.worldAuthoritySocketId = socket.id;
    }

    const serverNow = Date.now();
    const playerPayload = makeReconnectPlayerPayload(entry);
    const teammates = publicMatchTeammates(match);
    const gameState =
      entry.state?.gameState ||
      (serverNow < Number(match.deployAt || 0) ? "QUEUE_LOBBY" : "MATCH");

    socket.emit("matchReconnectAccepted", {
      matchId: match.matchId,
      seed: match.seed,
      mode: match.mode,
      teamSize: match.teamSize || TEAM_SIZE_BY_MODE[match.mode] || 2,
      totalSlots: match.totalSlots || MATCH_TOTAL_SLOTS,
      queueStartAt: match.queueStartAt,
      deployAt: match.deployAt,
      serverNow,
      worldAuthoritySocketId: chooseWorldAuthority(match),
      teammates,
      players: [...match.players.values()].map(makeReconnectPlayerPayload),
      player: playerPayload,
      storm: match.worldSnapshot?.storm || null,
      worldSnapshot: match.worldSnapshot || null,
      session: {
        matchId: match.matchId,
        seed: match.seed,
        mode: match.mode,
        playerId: p.playerId,
        teammates,
        gameState,
        isSpectator: !!session.isSpectator || entry.alive === false,
        spectateTargetKey: session.spectateTargetKey || null,
        player: playerPayload,
        storm: match.worldSnapshot?.storm || null
      }
    });

    socket.to(match.matchId).emit("matchPlayerReconnected", {
      oldSocketId,
      socketId: socket.id,
      playerId: p.playerId,
      name: p.name,
      alive: entry.alive !== false,
      player: playerPayload
    });

    if (match.publicQueue) {
      emitPublicMatchTeamUpdate(match);
    }

    broadcastMatchSync(match);
    broadcastOnlineList();
  });

  socket.on("matchJoin", data => {
    const p = getPlayer(socket.id);
    if (!p || !data?.matchId) return;

    const match = matches.get(data.matchId);
    if (!match) return;

    socket.join(data.matchId);
    p.inMatch = true;
    p.matchId = data.matchId;

    socket.emit("matchSync", makeMatchSyncPayload(match));
    if (match.worldSnapshot) socket.emit("matchWorldSnapshot", match.worldSnapshot);
  });

 socket.on("matchState", rawState => {
    const p = getPlayer(socket.id);
    if (!p || !p.matchId || !rawState || typeof rawState !== "object" || Array.isArray(rawState)) return;

    const match = matches.get(p.matchId);
    const entry = match?.players.get(socket.id);
    if (!match || !entry || entry.leftMatch || entry.disconnected) return;

    const now = Date.now();
    if (now - Number(entry.lastStateAt || 0) < MATCH_STATE_MIN_MS) return;

    // Server controls which map phase is active. Clients cannot claim a phase
    // merely to bypass movement validation or use different world bounds.
    const gameState = now < Number(match.deployAt || 0) ? "QUEUE_LOBBY" : "MATCH";
    const bounds = getMatchBounds(match, gameState);

    const hadAcceptedState = Number(entry.lastStateAt || 0) > 0;
    const previousGameState = String(entry.state?.gameState || "");
    const phaseChanged = !!previousGameState && previousGameState !== gameState;

    const previousX = sanitizeMatchCoordinate(entry.x, bounds.width / 2, bounds.width);
    const previousY = sanitizeMatchCoordinate(entry.y, bounds.height / 2, bounds.height);
    const nextX = sanitizeMatchCoordinate(rawState.x, previousX, bounds.width);
    const nextY = sanitizeMatchCoordinate(rawState.y, previousY, bounds.height);

    // Prevent normal-state teleports while still allowing the queue-map to
    // island-map transition, where both maps use different coordinate spaces.
    if (hadAcceptedState && !phaseChanged) {
      const elapsedSeconds = Math.max(
        MATCH_STATE_MIN_MS,
        now - Number(entry.lastStateAt || now)
      ) / 1000;

      const allowedDistance =
        MATCH_MAX_MOVE_PER_SECOND * elapsedSeconds +
        MATCH_MOVE_GRACE_DISTANCE;

      if (Math.hypot(nextX - previousX, nextY - previousY) > allowedDistance) {
        return;
      }
    }

    const maxHp = clampFiniteNumber(
      rawState.maxHp ?? rawState.maxHealth,
      entry.maxHp ?? 100,
      1,
      1000
    );

    const shieldMax = clampFiniteNumber(
      rawState.shieldMax,
      entry.shieldMax ?? 0,
      0,
      1000
    );

    const armorMax = clampFiniteNumber(
      rawState.armorMax,
      entry.armorMax ?? 100,
      0,
      1000
    );

    const rawCustomizations =
      rawState.customizations &&
      typeof rawState.customizations === "object" &&
      !Array.isArray(rawState.customizations)
        ? rawState.customizations
        : {};

    const customizations = {};

    for (const slot of ["hair", "hat", "glasses", "face"]) {
      const id = String(rawCustomizations[slot] || "").trim().slice(0, 64);
      if (id) customizations[slot] = id;
    }

    const rawWeapon =
      rawState.meleeWeapon &&
      typeof rawState.meleeWeapon === "object" &&
      !Array.isArray(rawState.meleeWeapon)
        ? rawState.meleeWeapon
        : null;

    const meleeWeapon = rawWeapon
      ? {
          id: String(rawWeapon.id || "").slice(0, 64),
          name: String(rawWeapon.name || "").slice(0, 64),
          rarity: String(rawWeapon.rarity || "").slice(0, 32),
          damage: clampFiniteNumber(rawWeapon.damage, 0, 0, MATCH_MAX_DAMAGE_PACKET),
          objectDamage: clampFiniteNumber(rawWeapon.objectDamage, 0, 0, MATCH_MAX_DAMAGE_PACKET),
          range: clampFiniteNumber(rawWeapon.range, 0, 0, 1800),
          cooldownMs: clampFiniteNumber(rawWeapon.cooldownMs, 0, 0, 30000),
          swingDuration: clampFiniteNumber(rawWeapon.swingDuration, 0, 0, 10),
          color: String(rawWeapon.color || "").slice(0, 24),
          iconSymbol: String(rawWeapon.iconSymbol || "").slice(0, 16),
          shape: String(rawWeapon.shape || "").slice(0, 32)
        }
      : null;

    const state = {
      socketId: socket.id,
      playerId: p.playerId,
      name: p.name,
      teamId: entry.teamId,
      gameState,

      x: nextX,
      y: nextY,
      angle: clampFiniteNumber(
        rawState.angle,
        entry.angle ?? 0,
        -Math.PI * 4,
        Math.PI * 4
      ),
      radius: clampFiniteNumber(rawState.radius, 16, 8, 48),

      hp: clampFiniteNumber(
        rawState.hp ?? rawState.health,
        entry.hp ?? 100,
        0,
        maxHp
      ),
      maxHp,

      shieldHp: clampFiniteNumber(
        rawState.shieldHp,
        entry.shieldHp ?? 0,
        0,
        shieldMax
      ),
      shieldMax,

      armorHp: clampFiniteNumber(
        rawState.armorHp,
        entry.armorHp ?? 0,
        0,
        armorMax
      ),
      armorMax,

      alive: entry.alive !== false && rawState.alive !== false,
      isDowned: entry.alive !== false && !!rawState.isDowned,
      downedTimer: clampFiniteNumber(rawState.downedTimer, 0, 0, 120),

      color: String(p.color || "#38bdf8").slice(0, 24),
      titleId: String(rawState.titleId || "").slice(0, 64),
      frameId: String(rawState.frameId || "").slice(0, 64),
      customizations,

      floor: String(rawState.floor || "surface").slice(0, 64),
      scopeLevel: String(rawState.scopeLevel || "x1").slice(0, 8),
      visionRadius: clampFiniteNumber(rawState.visionRadius, 320, 120, 2500),

      selectedMelee: !!rawState.selectedMelee,
      meleeWeapon,
      updatedAt: now
    };

    // Keep match-entry values current so matchDamage range checks and
    // reconnect snapshots use approved coordinates rather than spawn defaults.
    entry.x = state.x;
    entry.y = state.y;
    entry.angle = state.angle;
    entry.hp = state.hp;
    entry.maxHp = state.maxHp;
    entry.shieldHp = state.shieldHp;
    entry.shieldMax = state.shieldMax;
    entry.armorHp = state.armorHp;
    entry.armorMax = state.armorMax;
    entry.alive = state.alive;
    entry.lastStateAt = now;
    entry.state = state;

    socket.to(match.matchId).emit("matchState", state);
  });

  socket.on("matchDamage", data => {
    const source = getPlayer(socket.id);
    if (!source || !source.matchId || !data || typeof data !== "object") return;

    const match = matches.get(source.matchId);
    if (!match) return;

    const sourceEntry = match.players.get(socket.id);
    const targetSocketId = String(data?.targetSocketId || "");
    const target = match.players.get(targetSocketId);

if (!sourceEntry || !sourceEntry.alive || !target || !target.alive) return;
if (sourceEntry.state?.isDowned || target.state?.isDowned) return;
if (targetSocketId === socket.id) return;
    if ((sourceEntry.teamId || socket.id) === (target.teamId || targetSocketId)) return;

    const now = Date.now();
    if (now - Number(sourceEntry.lastDamageEventAt || 0) < MATCH_DAMAGE_MIN_INTERVAL_MS) return;

    const sx = Number(sourceEntry.x);
    const sy = Number(sourceEntry.y);
    const tx = Number(target.x);
    const ty = Number(target.y);
    const distance = Math.hypot(tx - sx, ty - sy);

    if (!Number.isFinite(distance) || distance > 1800) return;

    const requestedDamage = clampFiniteNumber(
      data?.rawDamage ?? data?.amount,
      0,
      0,
      MATCH_MAX_DAMAGE_PACKET
    );

    if (requestedDamage <= 0) return;

    if (now - Number(sourceEntry.damageBudgetStartedAt || 0) > MATCH_DAMAGE_BUDGET_WINDOW_MS) {
      sourceEntry.damageBudgetStartedAt = now;
      sourceEntry.damageBudgetUsed = 0;
    }

    const budgetRemaining = Math.max(
      0,
      MATCH_DAMAGE_BUDGET_PER_WINDOW - Number(sourceEntry.damageBudgetUsed || 0)
    );

    const permittedDamage = Math.min(Math.round(requestedDamage), budgetRemaining);
    if (permittedDamage <= 0) return;

    sourceEntry.lastDamageEventAt = now;
    sourceEntry.damageBudgetUsed = Number(sourceEntry.damageBudgetUsed || 0) + permittedDamage;

    const resolved = resolveServerDamage(target, permittedDamage);
const damageType = String(data?.damageType || "online").slice(0, 40);

const supportsDownedState =
  (match.mode === "duo" || match.mode === "team") &&
  getServerMatchPhase(match, now) === "MATCH" &&
  !target.state?.isDowned;

// Duo/Squad players enter a server-recorded downed state instead of being
// immediately removed. This keeps revive validation and winner checks in
// sync with the existing client-side downed/revive flow.
if (target.hp <= 0 && supportsDownedState) {
  const downedMaxHp = clampFiniteNumber(
    target.maxHp ?? target.state?.maxHp,
    100,
    1,
    1000
  );

  target.hp = 1;
  target.maxHp = downedMaxHp;
  target.alive = true;

  target.state = {
    ...(target.state || {}),
    hp: 1,
    health: 1,
    maxHp: downedMaxHp,
    alive: true,
    isDowned: true,
    downedTimer: 40,
    updatedAt: now
  };
}

target.lastDamageAt = now;
    target.lastDamageSourceSocketId = socket.id;
    target.lastRawDamage = resolved.rawDamage;
    target.lastHpDamage = resolved.hpDamage;
    target.lastArmorDamage = resolved.armorDamage;
    target.lastShieldDamage = resolved.shieldDamage;
    target.state = {
      ...(target.state || {}),
      hp: target.hp,
      health: target.hp,
      maxHp: target.maxHp,
      shieldHp: target.shieldHp,
      shieldMax: target.shieldMax,
      armorHp: target.armorHp,
      armorMax: target.armorMax,
      updatedAt: now
    };

    io.to(targetSocketId).emit("matchDamageTaken", {
      ...resolved,
      amount: resolved.rawDamage,
      damageType,
      sourceSocketId: socket.id,
      sourceName: source.name,
      targetHp: target.hp,
      targetHealth: target.hp,
      targetMaxHp: target.maxHp,
      targetShieldHp: target.shieldHp,
      targetShieldMax: target.shieldMax,
      targetArmorHp: target.armorHp,
      targetArmorMax: target.armorMax
    });

    io.to(source.matchId).emit("matchDamageFx", {
      targetSocketId,
      amount: resolved.hpDamage || resolved.armorDamage || resolved.shieldDamage || resolved.rawDamage,
      ...resolved,
      targetHp: target.hp,
      targetHealth: target.hp,
      targetMaxHp: target.maxHp,
      targetShieldHp: target.shieldHp,
      targetShieldMax: target.shieldMax,
      targetArmorHp: target.armorHp,
      targetArmorMax: target.armorMax,
      x: target.x,
      y: target.y,
      damageType
    });

    if (target.hp <= 0) {
      target.alive = false;
      sourceEntry.matchKills = Number(sourceEntry.matchKills || 0) + 1;

      io.to(source.matchId).emit("matchPlayerEliminated", {
        victimSocketId: targetSocketId,
        killerSocketId: socket.id,
        victimName: target.name,
        killerName: source.name,
        damageType
      });

      checkMatchWinner(match);
    }
  });

  socket.on("matchAction", rawAction => {
    const p = getPlayer(socket.id);

    if (
      !p ||
      !p.matchId ||
      !isPlainObject(rawAction) ||
      matchActionPayloadTooLarge(rawAction)
    ) {
      return;
    }

    const match = matches.get(p.matchId);
    const sourceEntry = match?.players.get(socket.id);

    if (!match || !isActiveMatchEntry(sourceEntry)) return;

    const now = Date.now();
    const type = sanitizeMatchActionId(rawAction.type, 32);
    const rule = MATCH_ACTION_RULES[type];

    if (!rule) return;

    const phase = getServerMatchPhase(match, now);
    const bounds = getMatchBounds(match, phase);
    const sourcePoint = getMatchEntryPoint(sourceEntry);
    const sourceFloor = getMatchEntryFloor(sourceEntry);
    const sourceIsDowned = !!sourceEntry.state?.isDowned;

    const base = {
      fromSocketId: socket.id,
      fromPlayerId: p.playerId,
      fromName: p.name
    };

    // Emotes work in queue or match. Every other action is match-only.
    if (type !== "playerEmote" && phase !== "MATCH") return;

    if (type === "monsterCast") {
      if (!sourcePoint || sourceIsDowned) return;

      const cardId = sanitizeMatchActionId(rawAction.cardId, 80);
      const x = Number(rawAction.x);
      const y = Number(rawAction.y);
      const angle = clampFiniteNumber(
        rawAction.angle,
        sourceEntry.angle || 0,
        -Math.PI * 2,
        Math.PI * 2
      );

      if (!cardId || !isPointInBounds(x, y, bounds)) return;

      if (
        Math.hypot(x - sourcePoint.x, y - sourcePoint.y) >
        MATCH_ACTION_CAST_ORIGIN_MAX_DISTANCE
      ) {
        return;
      }

      if (!allowMatchAction(sourceEntry, type, now)) return;

      socket.to(match.matchId).emit("matchAction", {
        ...base,
        type,
        cardId,
        x,
        y,
        angle,
        color: sanitizeMatchActionColor(rawAction.color, "#38bdf8")
      });

      return;
    }

    if (type === "magicUse") {
      if (!sourcePoint || sourceIsDowned) return;

      const cardId = sanitizeMatchActionId(rawAction.cardId, 80);
      if (!cardId || !allowMatchAction(sourceEntry, type, now)) return;

      socket.to(match.matchId).emit("matchAction", {
        ...base,
        type,
        cardId,
        x: sourcePoint.x,
        y: sourcePoint.y,
        angle: clampFiniteNumber(
          sourceEntry.angle,
          0,
          -Math.PI * 2,
          Math.PI * 2
        ),
        color: sanitizeMatchActionColor(rawAction.color, "#38bdf8")
      });

      return;
    }

    if (type === "meleeSwing") {
      if (sourceIsDowned) return;

      const sourceType = rawAction.sourceType === "bot" ? "bot" : "player";

      let x = sourcePoint?.x;
      let y = sourcePoint?.y;
      let floor = sourceFloor;
      let sourceId = socket.id;

      // Only the current world authority can relay bot visual actions.
      if (sourceType === "bot") {
        const authority =
          reconcileWorldAuthority(match, "match_action").worldAuthoritySocketId;

        if (
          authority !== socket.id ||
          !isEligibleWorldAuthority(match, socket.id)
        ) {
          return;
        }

        const botId = sanitizeMatchActionId(rawAction.sourceId, 80);
        const rawX = Number(rawAction.x);
        const rawY = Number(rawAction.y);

        if (!botId || !isPointInBounds(rawX, rawY, bounds)) return;

        x = rawX;
        y = rawY;
        floor = sanitizeMatchActionText(rawAction.floor, 64, "surface") || "surface";
        sourceId = botId;
      } else if (!sourcePoint) {
        return;
      }

      if (!allowMatchAction(sourceEntry, type, now)) return;

      socket.to(match.matchId).emit("matchAction", {
        ...base,
        type,
        sourceType,
        sourceId,
        x,
        y,
        floor,
        angle: clampFiniteNumber(
          rawAction.angle,
          sourceEntry.angle || 0,
          -Math.PI * 2,
          Math.PI * 2
        ),
        hit: !!rawAction.hit,
        color: sanitizeMatchActionColor(rawAction.color, "#e0f2fe"),
        range: clampFiniteNumber(rawAction.range, 60, 20, 260),
        coneHalfAngle: clampFiniteNumber(
          rawAction.coneHalfAngle,
          Math.PI / 5,
          0.02,
          Math.PI
        ),
        swingDuration: clampFiniteNumber(
          rawAction.swingDuration,
          130,
          60,
          1000
        ),
        weapon: sanitizeMatchActionWeapon(rawAction.weapon)
      });

      return;
    }

    if (type === "matchPing") {
      if (!sourcePoint || sourceIsDowned) return;

      const pingType = sanitizeMatchActionId(rawAction.pingType, 24);
      const x = Number(rawAction.x);
      const y = Number(rawAction.y);

      const maxPingDistance = Math.min(
        2800,
        Math.max(
          950,
          Number(sourceEntry.state?.visionRadius || 950) +
          MATCH_ACTION_PING_EXTRA_RANGE
        )
      );

      if (!MATCH_ACTION_PING_TYPES.has(pingType)) return;
      if (!isPointInBounds(x, y, bounds)) return;

      if (Math.hypot(x - sourcePoint.x, y - sourcePoint.y) > maxPingDistance) {
        return;
      }

      if (!allowMatchAction(sourceEntry, type, now)) return;

      // Pings are teammate-only.
      emitMatchActionToTeam(
        match,
        sourceEntry.teamId || socket.id,
        {
          ...base,
          type,
          pingType,
          x,
          y,
          floor: sourceFloor,
          sourceName: p.name
        },
        socket.id
      );

      return;
    }

    if (type === "revivePlayer") {
      if (!sourcePoint || sourceIsDowned) return;

      const targetSocketId = sanitizeMatchActionText(
        rawAction.targetSocketId,
        128,
        ""
      );

      const targetEntry = match.players.get(targetSocketId);
      const targetPoint = getMatchEntryPoint(targetEntry);

      if (
        !targetSocketId ||
        targetSocketId === socket.id ||
        !isActiveMatchEntry(targetEntry)
      ) {
        return;
      }

      if (!sameMatchTeam(sourceEntry, targetEntry)) return;
      if (!targetEntry.state?.isDowned) return;
      if (!targetPoint || getMatchEntryFloor(targetEntry) !== sourceFloor) return;

      if (
        Math.hypot(
          targetPoint.x - sourcePoint.x,
          targetPoint.y - sourcePoint.y
        ) > MATCH_ACTION_REVIVE_RANGE
      ) {
        return;
      }

      if (!allowMatchAction(sourceEntry, type, now)) return;

      const revivedMaxHp = clampFiniteNumber(
        targetEntry.maxHp ?? targetEntry.state?.maxHp,
        100,
        1,
        1000
      );

      const revivedHp = Math.max(35, Math.floor(revivedMaxHp * 0.35));

      targetEntry.alive = true;
      targetEntry.hp = revivedHp;
      targetEntry.maxHp = revivedMaxHp;

      targetEntry.state = {
        ...(targetEntry.state || {}),
        x: targetPoint.x,
        y: targetPoint.y,
        hp: revivedHp,
        health: revivedHp,
        maxHp: revivedMaxHp,
        alive: true,
        isDowned: false,
        downedTimer: 0,
        updatedAt: now
      };

      emitMatchActionToTeam(
        match,
        sourceEntry.teamId || socket.id,
        {
          ...base,
          type,
          targetSocketId,
          reviverName: p.name,
          x: targetPoint.x,
          y: targetPoint.y,
          floor: sourceFloor,
          revivedHp,
          revivedMaxHp
        },
        socket.id
      );

      return;
    }

    if (type === "playerEmote") {
      if (!sourcePoint) return;

      const emoteId = sanitizeMatchActionId(rawAction.emoteId, 64);

      if (!MATCH_ACTION_EMOTE_IDS.has(emoteId)) return;
      if (!allowMatchAction(sourceEntry, type, now)) return;

      socket.to(match.matchId).emit("matchAction", {
        ...base,
        type,
        emoteId,
        x: sourcePoint.x,
        y: sourcePoint.y,
        floor: sourceFloor,
        sourceName: p.name
      });

      return;
    }

    if (type === "airdropRoute") {
      const authority =
        reconcileWorldAuthority(match, "match_action").worldAuthoritySocketId;

      if (
        authority !== socket.id ||
        !isEligibleWorldAuthority(match, socket.id)
      ) {
        return;
      }

      const routeId = sanitizeMatchActionId(rawAction.routeId, 96);
      const travelMs = clampFiniteNumber(
        rawAction.travelMs,
        18000,
        10000,
        30000
      );

      const edgeMargin = Math.max(bounds.width, bounds.height) + 3000;

      const startX = Number(rawAction.startX);
      const startY = Number(rawAction.startY);
      const endX = Number(rawAction.endX);
      const endY = Number(rawAction.endY);

      const rawTargets = Array.isArray(rawAction.targets)
        ? rawAction.targets
        : [];

      if (!routeId || rawTargets.length < 1 || rawTargets.length > 2) return;

      if (!isPointInBounds(startX, startY, bounds, edgeMargin)) return;
      if (!isPointInBounds(endX, endY, bounds, edgeMargin)) return;

      if (
        now - Number(match.lastAirdropRouteAt || 0) <
        MATCH_ACTION_AIRDROP_MIN_INTERVAL_MS
      ) {
        return;
      }

      const targets = [];

      for (let index = 0; index < rawTargets.length; index++) {
        const rawTarget = rawTargets[index];

        if (!isPlainObject(rawTarget)) return;

        const id = sanitizeMatchActionId(rawTarget.id, 96);
        const x = Number(rawTarget.x);
        const y = Number(rawTarget.y);

        if (!id || !isPointInBounds(x, y, bounds)) return;

        targets.push({
          id,
          x,
          y,
          fallMs: clampFiniteNumber(rawTarget.fallMs, 9000, 4000, 16000),
          dropT: clampFiniteNumber(rawTarget.dropT, 0.5, 0.15, 0.9)
        });
      }

      if (!allowMatchAction(sourceEntry, type, now)) return;

      match.lastAirdropRouteAt = now;

      socket.to(match.matchId).emit("matchAction", {
        ...base,
        type,
        routeId,
        startX,
        startY,
        endX,
        endY,
        travelMs,
        targets
      });
    }
  });

  socket.on("voiceJoin", data => {
    const p = getPlayer(socket.id);
    const roomId = getVoiceRoomId(p);

    if (!p || !roomId) {
      socket.emit("voiceError", { message: "Connect to the multiplayer server before enabling voice." });
      return;
    }

    const oldRoomId = p.voiceRoomId || null;
    if (oldRoomId && oldRoomId !== roomId) {
      emitVoicePeerLeft(socket.id, "room_changed");
      socket.leave(oldRoomId);
    }

    socket.join(roomId);

    p.voiceRoomId = roomId;
    p.voiceReady = true;
    p.voiceMuted = !!data?.muted;
    p.voiceMode = data?.mode === "open" ? "open" : "ptt";
    p.voiceRange = Math.max(120, Math.min(1600, Number(data?.range || 650)));

    const peers = getVoiceMatchPeerIds(socket.id)
      .map(id => getPlayer(id))
      .filter(peer => peer && peer.voiceReady)
      .map(getVoicePeerPayload);

    socket.emit("voicePeers", {
      roomId,
      matchId: p.matchId || null,
      partyId: p.partyId || null,
      peers
    });

    for (const peerId of getVoiceMatchPeerIds(socket.id)) {
      const peer = getPlayer(peerId);
      if (peer?.voiceReady) io.to(peerId).emit("voicePeerJoined", getVoicePeerPayload(p));
    }
  });

  socket.on("voiceLeave", () => {
    const p = getPlayer(socket.id);
    if (!p) return;
    if (p.voiceReady) emitVoicePeerLeft(socket.id, "left");
    p.voiceReady = false;
    p.voiceMuted = true;
    p.voiceRoomId = null;
  });

  socket.on("voiceState", data => {
    const p = getPlayer(socket.id);
    const roomId = p?.voiceRoomId || getVoiceRoomId(p);
    if (!p || !roomId) return;

    p.voiceRoomId = roomId;
    p.voiceReady = data?.ready !== false;
    p.voiceMuted = !!data?.muted;
    p.voiceMode = data?.mode === "open" ? "open" : "ptt";
    p.voiceRange = Math.max(120, Math.min(1600, Number(data?.range || p.voiceRange || 650)));

    for (const peerId of getVoiceMatchPeerIds(socket.id)) {
      io.to(peerId).emit("voicePeerState", getVoicePeerPayload(p));
    }
  });

  socket.on("voiceSignal", data => {
    const p = getPlayer(socket.id);
    const senderRoomId = p?.voiceRoomId || getVoiceRoomId(p);
    const targetSocketId = String(data?.toSocketId || "");
    const target = getPlayer(targetSocketId);
    const targetRoomId = target?.voiceRoomId || getVoiceRoomId(target);

    if (!p || !senderRoomId || !target || targetRoomId !== senderRoomId) return;

    io.to(targetSocketId).emit("voiceSignal", {
      fromSocketId: socket.id,
      fromPlayer: getVoicePeerPayload(p),
      signal: data?.signal || null
    });
  });

  socket.on("matchWorldSnapshot", snapshot => {
    const p = getPlayer(socket.id);
    if (!p || !p.matchId) return;

    const match = matches.get(p.matchId);
    if (!match) return;

    const authority = reconcileWorldAuthority(match, "snapshot_recovery").worldAuthoritySocketId;
    if (authority !== socket.id) return;
    if (!isEligibleWorldAuthority(match, socket.id)) return;

    const now = Date.now();
    if (now - (match.lastWorldSnapshotAt || 0) < WORLD_SNAPSHOT_MIN_MS) return;

    match.lastWorldSnapshotAt = now;
    match.worldSnapshot = {
      ...sanitizeWorldSnapshot(snapshot),
      matchId: match.matchId
    };

    socket.to(p.matchId).emit("matchWorldSnapshot", match.worldSnapshot);
  });

socket.on("matchLocalDeath", data => {
  const p = getPlayer(socket.id);
  if (!p || !p.matchId) return;

  const matchId = p.matchId;
  const match = matches.get(matchId);
  if (!match) return;

  const entry = match.players.get(socket.id);
  const reason = data?.reason || "unknown";
  const phase = data?.phase || entry?.state?.gameState || "";

  // Leaving during queue should cancel the queue for both Duo players
  if (reason === "left_match" && phase === "QUEUE_LOBBY") {
    cancelMatchBackToPartyLobby(match, `${p.name} left the queue.`);
    return;
  }

  // Leaving during an active island match should only remove that player
  if (reason === "left_match") {
    if (entry) {
      entry.alive = false;
      entry.hp = 0;
      entry.leftMatch = true;
      entry.leftAt = Date.now();
    }

    p.inMatch = false;
    p.matchId = null;
    socket.leave(matchId);

    socket.to(matchId).emit("matchPlayerLeft", {
      socketId: socket.id,
      playerId: p.playerId,
      name: p.name,
      reason: "left_match"
    });

    broadcastOnlineList();
    if (p.partyId) emitPartyUpdate(p.partyId);
    return;
  }

  // death/elimination
  if (entry) {
    entry.alive = false;
    entry.hp = 0;
  }

  socket.to(matchId).emit("matchPlayerEliminated", {
    victimSocketId: socket.id,
    killerSocketId: data?.killerSocketId || null,
    victimName: p.name,
    killerName: data?.killerName || "Unknown"
  });

  checkMatchWinner(match);
});

  socket.on("profileReset", data => {
    const p = getPlayer(socket.id);
    if (!p) return;

    const playerId = p.playerId;
    const keepName = String(data?.name || p.name || playerId).trim().slice(0, 24) || playerId;

    p.name = keepName;
    p.rank = "SURVIVOR";
    p.level = 1;
    p.profileXp = 0;
    p.wins = 0;
    p.kills = 0;
    p.deaths = 0;
    p.losses = 0;
    p.revives = 0;
    p.gold = 1000;
    p.gems = 0;

    let entry = leaderboardProfiles.get(playerId);
    if (!entry) {
      entry = getOrCreateLeaderboardEntry(p);
    }

    entry.name = keepName;
    entry.rank = "SURVIVOR";
    entry.level = 1;
    entry.profileXp = 0;
    entry.wins = 0;
    entry.kills = 0;
    entry.deaths = 0;
    entry.losses = 0;
    entry.revives = 0;
    entry.reportKeys = new Set();
    entry.updatedAt = Date.now();

    socket.emit("profileAssigned", publicPlayer(p));
    broadcastOnlineList();
    broadcastLeaderboards();
  });

  socket.on("claimRankedSeasonReward", (data = {}, cb) => {
    const p = getPlayer(socket.id);
    if (!p?.playerId) return cb?.({ ok: false, error: "Player profile not ready." });

    const rewardId = String(data?.rewardId || "").trim();
    const rewards = rankedFilterRewardsForPlayer(p.playerId, { includeClaimed: true });
    const reward = rewards.find(entry => entry.id === rewardId);

    if (!reward) return cb?.({ ok: false, error: "Reward not found or expired." });
    if (reward.claimed) return cb?.({ ok: false, error: "Reward already claimed." });
    if (rankedIsRewardExpired(reward)) return cb?.({ ok: false, error: "Reward expired." });

    reward.claimed = true;
    reward.paidAt = Date.now();

    p.gold = Number(p.gold || 0) + safeStatInt(reward.gold);
    p.gems = Number(p.gems || 0) + safeStatInt(reward.gems);

    rankedRewardInbox.set(p.playerId, rewards);
    rankedScheduleSave();

    const publicProfile = publicPlayer(p);
    socket.emit("profileAssigned", publicProfile);
    cb?.({ ok: true, reward, profile: publicProfile });

    broadcastOnlineList();
  });

  socket.on("leaderboardRequest", () => {
    socket.emit("leaderboards", getLeaderboardPayload());
  });

  socket.on("spectateTargetChanged", data => {
    const p = getPlayer(socket.id);
    if (!p) return;

    const targetSocketId = String(data?.targetSocketId || "");
    const target = targetSocketId ? getPlayer(targetSocketId) : null;

    p.spectatingSocketId =
      target &&
      targetSocketId !== socket.id &&
      p.matchId &&
      target.matchId === p.matchId
        ? targetSocketId
        : null;

    broadcastSpectatorCounts();
  });

  socket.on("matchResultReport", () => {
    socket.emit("matchResultRejected", {
      reason: "Client-reported results are disabled. Public stats and ranked rewards require server-authoritative match simulation."
    });
  });

  socket.on("disconnect", () => {
    const p = getPlayer(socket.id);

    if (p) {
      if (p.voiceReady) {
        emitVoicePeerLeft(socket.id, "disconnected");
        p.voiceReady = false;
      }

      if (p.playerId && idToSocket.get(p.playerId) === socket.id) idToSocket.delete(p.playerId);

      const match = p.matchId ? matches.get(p.matchId) : null;

      if (match) {
        const entry = match.players.get(socket.id);

        if (entry) {
          holdMatchPlayerForReconnect(match, entry, p);
        }
      } else if (p.partyId) {
        leaveParty(socket.id);
      }
    }

    if (p) p.spectatingSocketId = null;
    for (const other of players.values()) {
      if (other.spectatingSocketId === socket.id) other.spectatingSocketId = null;
    }

    players.delete(socket.id);
    broadcastOnlineList();
    broadcastSpectatorCounts();
  });
});

startServer().catch(err => {
  console.error("[server] startup failed:", err);
  process.exit(1);
});
