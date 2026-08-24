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
  "https://i-am-wizard.itch.io",

  // Game Jolt can serve HTML5 games from .com or tokenized .net hosts.
  // The ?token= value is only a page query parameter; CORS uses the Origin.
  "https://gamejolt.com",
  "https://www.gamejolt.com",
  "https://gamejolt.net",
  "https://www.gamejolt.net",

  // Optional extra verified origins set in Render.
  ...splitAllowedOrigins(process.env.GAME_ALLOWED_ORIGINS),

  // Allows your direct Render URL only when Render provides it.
  normalizeBrowserOrigin(process.env.RENDER_EXTERNAL_URL)
].filter(Boolean));

function isGameJoltHost(host) {
  const normalized = String(host || "").toLowerCase();

  return [
    "gamejolt.com",
    "gamejolt.net"
  ].some(domain =>
    normalized === domain ||
    normalized.endsWith(`.${domain}`)
  );
}

function isAllowedBrowserOrigin(rawOrigin) {
  const origin = normalizeBrowserOrigin(rawOrigin);
  if (!origin) return false;

  if (GAME_ALLOWED_ORIGINS.has(origin)) {
    return true;
  }

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    // Local browser testing is allowed over HTTP; production browser origins still require HTTPS.
    if (url.protocol !== "https:") {
      return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    }

    // Allows only genuine Game Jolt HTTPS subdomains:
    // gamejolt.com, gamejolt.net, and their real subdomains.
    // It does not allow lookalikes such as gamejolt.net.evil-site.com.
    return isGameJoltHost(host);
  } catch (err) {
    return false;
  }
}

const GAME_CORS_OPTIONS = Object.freeze({
  origin(origin, callback) {
    callback(null, !origin || isAllowedBrowserOrigin(origin));
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
    <lastmod>2026-06-20</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/play</loc>
    <lastmod>2026-06-20</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/play.html</loc>
    <lastmod>2026-06-20</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/how-to-play/</loc>
    <lastmod>2026-06-20</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/cards-and-creatures/</loc>
    <lastmod>2026-06-20</lastmod>
  </url>
  <url>
    <loc>https://duelio.lol/updates/</loc>
    <lastmod>2026-06-20</lastmod>
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
    const origin = String(req.headers.origin || "");
    const host = String(req.headers.host || "").split(":")[0].toLowerCase();
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

    if (!origin || localHosts.has(host)) {
      callback(null, true);
      return;
    }

    callback(null, isAllowedBrowserOrigin(origin));
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
const tcgDuels = new Map();
const tcgDuelInvites = new Map();
const tcgLobbies = new Map();
const tcgNpcProfiles = new Map();
const leaderboardProfiles = new Map();

// Ranked Duo waits here until a second real two-player party is ready.
const rankedDuoPartyQueue = [];
const rankedDuoQueueTimers = new Map();

const PLAYER_SESSION_SECRET = String(
  process.env.PLAYER_SESSION_SECRET ||
  (process.env.NODE_ENV === "production" ? "" : "duel-survivor-local-dev-session-secret")
).trim();

// Use this only when you intentionally rotate PLAYER_SESSION_SECRET.
// Put the old secret in Render here temporarily so old accounts still load.
const PLAYER_SESSION_PREVIOUS_SECRETS = String(
  process.env.PLAYER_SESSION_PREVIOUS_SECRETS || ""
)
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

const PLAYER_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 180;
const PLAYER_ID_BYTES = 18;

// Player transform/state packets are intentionally capped at 15 Hz.
// Socket.IO is reliable, so a full snapshot on match join plus compact deltas
// gives smoother traffic without continuously rebroadcasting full state blobs.
const MATCH_STATE_UPDATE_HZ = 15;
const MATCH_STATE_MIN_MS = Math.round(1000 / MATCH_STATE_UPDATE_HZ);
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
  "fall_leaves",
  "fall_tornado",
  "fall_pie",
  "fall_coffee",
  "share_ufo_alien",
  "ranked_rift_medal_2",
  "ranked_sovereign_medal_1"
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

// Production must not start with an empty temporary database if Upstash
// is unavailable, misconfigured, or pointed at the wrong key.
const RANKED_UPSTASH_FAIL_CLOSED =
  String(process.env.RANKED_UPSTASH_FAIL_CLOSED || "true").toLowerCase() !== "false";

const RANKED_UPSTASH_BACKUP_KEY = String(
  process.env.RANKED_UPSTASH_BACKUP_KEY ||
  `${RANKED_UPSTASH_KEY}:previous`
).trim();

const RANKED_STATE_STORAGE_LABEL = RANKED_UPSTASH_ENABLED ? "upstash-redis" : RANKED_FILE_STORAGE_LABEL;
const RANKED_STATE_DURABLE = RANKED_UPSTASH_ENABLED ? true : RANKED_FILE_STORAGE_DURABLE;

const RANKED_ADMIN_KEY = process.env.RANKED_ADMIN_KEY || "";
const rankedSeasonArchives = new Map();
const rankedRewardInbox = new Map();
let rankedStateSaveTimer = null;
let rankedWriteQueue = Promise.resolve();
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

// Ranked uses fewer NPCs so real-player eliminations decide more matches.
const RANKED_BOT_MIN = 24;
const RANKED_BOT_COMMON_MAX = 56;
const RANKED_BOT_HIGH_MIN = 57;
const RANKED_BOT_HIGH_MAX = 65;
const RANKED_BOT_MAX = 73;
const RANKED_BOT_RARE_MAX_CHANCE = 0.08;

const RANKED_PVP_ELIMINATION_POINTS = 20;
const RANKED_MATCH_WIN_POINTS = 40;
const RANKED_MATCH_LOSS_POINTS = -8;
const RANKED_LAST_DAMAGE_CREDIT_MS = 15000;

const ONLINE_QUEUE_MS = 15000;
const WORLD_SNAPSHOT_MIN_MS = 180;
const MATCH_RECONNECT_GRACE_MS = 45000;
const ACCOUNT_SCHEMA_VERSION = 3;
const ACCOUNT_LEGACY_MIGRATION_ENABLED =
  String(process.env.ACCOUNT_LEGACY_MIGRATION_ENABLED || "true").toLowerCase() !== "false";

const ACCOUNT_LEGACY_GOLD_CAP = 250000;
const ACCOUNT_LEGACY_GEMS_CAP = 5000;
const ACCOUNT_MAX_CARD_COPIES = 99;
const ACCOUNT_LEGACY_MAX_CARD_COPIES = 12;
const ACCOUNT_MAX_TICKETS_PER_PACK = 99;
const ACCOUNT_MAX_EVENT_TICKETS = 999;

// Quest and Battle Pass receipts are stored permanently in Upstash.
// The same reward ID can never add currency twice.
const ACCOUNT_MAX_REWARD_RECEIPTS = 2048;
const ACCOUNT_CLIENT_REWARD_MAX_GOLD = 10000;
const ACCOUNT_CLIENT_REWARD_MAX_GEMS = 250;
const ACCOUNT_CLIENT_REWARD_MAX_XP = 25000;
const ACCOUNT_CLIENT_REWARD_MAX_TICKETS_PER_PACK = 8;
const ACCOUNT_CLIENT_REWARD_MAX_EVENT_TICKETS = 8;
const ACCOUNT_BATTLE_PASS_MAGIC_COST = 750;

const ACCOUNT_LOADOUT_WEIGHT_BASE = 50;
const ACCOUNT_LOADOUT_WEIGHT_MAX = 105;
const ACCOUNT_LOADOUT_WEIGHT_STEP = 5;
const ACCOUNT_LOADOUT_WEIGHT_UPGRADE_BASE_GEMS = 50;
const ACCOUNT_LOADOUT_WEIGHT_UPGRADE_STEP_GEMS = 50;

const ACCOUNT_STARTER_CARD_IDS = Object.freeze([
  "ember_pup",
  "iron_ram",
  "frost_serpent",
  "spark_wasp",
  "thorn_boar",
  "healing_veil",
  "cleanse_rune",
  "revenge_thorn",
  "static_trap"
]);

const ACCOUNT_SHARE_REWARD = Object.freeze({
  gold: 5000,
  gems: 500,
  cardIds: ["starvisitor_ufo"],
  emoteIds: ["share_ufo_alien"]
});

const ACCOUNT_DAILY_TIME_ZONE = "America/Vancouver";
const ACCOUNT_FALL_LEAVES_EMOTE_ID = "fall_leaves";

const ACCOUNT_DAILY_REWARD_TRACK = Object.freeze([
  { day: 1, title: "Fresh Duelist Bonus", gold: 600, gems: 0 },
  { day: 2, title: "Starter Rift Ticket", gold: 350, gems: 0, boosterTickets: { starter_rift: 1 } },
  { day: 3, title: "Gem Spark Cache", gold: 900, gems: 5 },
  { day: 4, title: "Bonus Card Drop", gold: 700, gems: 0, dailyCard: { minRarityRank: 1, maxRarityRank: 3 } },
  { day: 5, title: "Event Ticket Cache", gold: 1200, gems: 8, eventTickets: 1 },
  { day: 6, title: "Element Burst Ticket", gold: 900, gems: 12, boosterTickets: { element_burst: 1 } },
  { day: 7, title: "Weekly Rift Jackpot", gold: 2200, gems: 30, boosterTickets: { mythic_rift: 1 }, dailyCard: { minRarityRank: 2, maxRarityRank: 5 } }
]);

const ACCOUNT_DAILY_RARITY_RANK = Object.freeze({
  Common: 0,
  Uncommon: 1,
  Rare: 2,
  Epic: 3,
  Legendary: 4,
  Mythic: 5,
  "Hollow Rare": 6,
  "Super Ultra Rare": 7,
  "God Tier": 8
});

const ACCOUNT_PACK_CATALOG = Object.freeze({
  starter_rift: {
    costType: "gold",
    cost: 500,
    odds: { Common: 65, Uncommon: 25, Rare: 10 },
    categoryBias: "",
    minStage: 1
  },
  element_burst: {
    costType: "gold",
    cost: 1200,
    odds: { Common: 40, Uncommon: 35, Rare: 20, Epic: 5 },
    categoryBias: "",
    minStage: 1
  },
  mythic_rift: {
    costType: "gems",
    cost: 80,
    odds: {
      Uncommon: 30,
      Rare: 35,
      Epic: 25,
      Legendary: 8,
      Mythic: 2,
      "Hollow Rare": 0.6,
      "Super Ultra Rare": 0.15
    },
    categoryBias: "",
    minStage: 1
  },
  evolution_surge: {
    costType: "gold",
    cost: 1800,
    odds: { Common: 35, Uncommon: 35, Rare: 22, Epic: 7, Legendary: 1 },
    categoryBias: "evolution",
    minStage: 2
  },
  trap_magic: {
    costType: "gold",
    cost: 900,
    odds: { Common: 45, Uncommon: 35, Rare: 17, Epic: 3 },
    categoryBias: "utility",
    minStage: 1
  }
});

const ACCOUNT_TITLE_STORE = Object.freeze({
  crate_cracker: { gold: 900 },
  storm_runner: { gold: 1400 },
  beach_raider: { gold: 1500 },
  airdrop_hunter: { gold: 2400 },
  shark_bait: { gold: 2600 },
  gold_drifter: { gold: 3000 },
  trap_artist: { gems: 75 },
  card_slinger: { gems: 90 },
  rift_walker: { gems: 110 },
  final_circle: { gems: 150 },
  pack_ripper: { gems: 175 },
  prism_hunter: { gems: 190 }
});

const ACCOUNT_FRAME_STORE = Object.freeze({
  shop_neon_frame: { gold: 6500 },
  shop_prism_frame: { gems: 150 },
  shop_infernal_frame: { gems: 220 }
});

const ACCOUNT_CUSTOMIZATION_STORE = Object.freeze({
  hair_amber_bob: { slot: "hair", gold: 1400 },
  hat_beach_bandana: { slot: "hat", gold: 1200 },
  glasses_round: { slot: "glasses", gold: 900 },
  face_bandage: { slot: "face", gold: 750 },
  face_moustache: { slot: "face", gems: 45 }
});

const ACCOUNT_TITLE_IDS = new Set([
  "rookie_survivor",
  ...Object.keys(ACCOUNT_TITLE_STORE),
  "bp_survivalist",
  "bp_mageborne",
  "bp_riftbound",
  "bp_stormforged",
  "bp_mana_crowned",
  "ranked_bronze",
  "ranked_silver",
  "ranked_gold",
  "ranked_platinum",
  "ranked_diamond",
  "ranked_master",
  "ranked_top_50",
  "season_champion",
  "quest_relentless"
]);

const ACCOUNT_FRAME_IDS = new Set([
  "default_frame",
  ...Object.keys(ACCOUNT_FRAME_STORE),
  "ranked_bronze_frame",
  "ranked_silver_frame",
  "ranked_gold_frame",
  "ranked_platinum_frame",
  "ranked_diamond_frame",
  "ranked_master_frame",
  "ranked_top50_frame",
  "ranked_champion_frame"
]);

const ACCOUNT_CUSTOMIZATION_BY_ID = Object.freeze({
  hair_amber_bob: "hair",
  hair_cyan_spikes: "hair",
  hat_wizard_cap: "hat",
  hat_beach_bandana: "hat",
  glasses_round: "glasses",
  glasses_star: "glasses",
  face_blush: "face",
  face_bandage: "face",
  face_moustache: "face"
});

const ACCOUNT_EMOTE_IDS = new Set([
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
  "fall_leaves",
  "fall_tornado",
  "fall_pie",
  "fall_coffee",
  "share_ufo_alien",
  "ranked_rift_medal_2",
  "ranked_sovereign_medal_1"
]);

const ACCOUNT_SEASONAL_EVENTS = Object.freeze({
  season_01_foundation: {
    enabled: false,
    startsAt: "2026-06-01T00:00:00-07:00",
    endsAt: "2026-07-20T23:59:59-07:00",
    rewards: {
      foundation_cache: { gold: 900, gems: 20, eventTickets: 1 }
    },
    shopItems: {
      foundation_event_ticket: {
        costType: "gold",
        cost: 750,
        limit: 6,
        reward: { eventTickets: 1 }
      },
      foundation_cash_cache: {
        costType: "gems",
        cost: 25,
        limit: 3,
        reward: { gold: 1400 }
      }
    }
  }
});

const ACCOUNT_ACTION_RULES = Object.freeze({
  migrateLegacy: { cooldownMs: 0, windowMs: 60000, maxInWindow: 1 },
  claimDailyReward: { cooldownMs: 500, windowMs: 60000, maxInWindow: 3 },
  claimFallLeavesEmote: { cooldownMs: 750, windowMs: 60000, maxInWindow: 2 },
  claimProgressReward: { cooldownMs: 200, windowMs: 60000, maxInWindow: 80 },
  buyBattlePassPremium: { cooldownMs: 300, windowMs: 60000, maxInWindow: 3 },
  buyPack: { cooldownMs: 350, windowMs: 10000, maxInWindow: 12 },
  buyTitle: { cooldownMs: 250, windowMs: 10000, maxInWindow: 12 },
  buyFrame: { cooldownMs: 250, windowMs: 10000, maxInWindow: 12 },
  buyCustomization: { cooldownMs: 250, windowMs: 10000, maxInWindow: 12 },
  equipTitle: { cooldownMs: 150, windowMs: 10000, maxInWindow: 20 },
  equipFrame: { cooldownMs: 150, windowMs: 10000, maxInWindow: 20 },
  equipCustomization: { cooldownMs: 150, windowMs: 10000, maxInWindow: 30 },
  unequipCustomization: { cooldownMs: 150, windowMs: 10000, maxInWindow: 30 },
  claimSeasonalReward: { cooldownMs: 250, windowMs: 10000, maxInWindow: 12 },
  buySeasonalItem: { cooldownMs: 250, windowMs: 10000, maxInWindow: 12 },
  claimShareBonus: { cooldownMs: 250, windowMs: 60000, maxInWindow: 2 },
  upgradeLoadoutWeight: { cooldownMs: 250, windowMs: 10000, maxInWindow: 12 }
});

function accountReadStaticArrayBody(source, constantName) {
  const marker = `const ${constantName} =`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing ${constantName} in public/play.html.`);

  const openIndex = source.indexOf("[", markerIndex);
  if (openIndex < 0) throw new Error(`Missing array start for ${constantName}.`);

  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = openIndex; index < source.length; index++) {
    const character = source[index];

    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }

    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }

  throw new Error(`Unclosed ${constantName} array.`);
}

function accountSplitTopLevelObjects(arrayBody) {
  const objects = [];
  let depth = 0;
  let startIndex = -1;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < arrayBody.length; index++) {
    const character = arrayBody[index];

    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }

    if (character === "{") {
      if (depth === 0) startIndex = index;
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        objects.push(arrayBody.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return objects;
}

function accountReadStringProperty(objectText, propertyName, fallback = "") {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = objectText.match(new RegExp(`\\b${escaped}\\s*:\\s*["']([^"']*)["']`));
  return match ? match[1] : fallback;
}

function accountReadNumberProperty(objectText, propertyName, fallback = 0) {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = objectText.match(new RegExp(`\\b${escaped}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value : fallback;
}

function accountReadBooleanProperty(objectText, propertyName) {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*:\\s*true\\b`).test(objectText);
}

function loadAccountCardCatalog() {
  try {
    const source = fs.readFileSync(path.join(publicDir, "play.html"), "utf8");
    const entries = accountSplitTopLevelObjects(
      accountReadStaticArrayBody(source, "CARD_POOL")
    );

    const catalog = new Map();

    for (const text of entries) {
      const id = accountReadStringProperty(text, "id");
      const rarity = accountReadStringProperty(text, "rarity");
      const category = accountReadStringProperty(text, "category");

      if (!id || !rarity || !category) continue;

      catalog.set(id, {
        id,
        rarity,
        category,
        name: accountReadStringProperty(text, "name"),
        description: accountReadStringProperty(text, "description"),
        triggerType: accountReadStringProperty(text, "triggerType"),
        effectType: accountReadStringProperty(text, "effectType"),
        duration: accountReadNumberProperty(text, "duration", 0),
        damage: accountReadNumberProperty(text, "damage", 0),
        reflectRatio: accountReadNumberProperty(text, "reflectRatio", 0),
        hpThreshold: accountReadNumberProperty(text, "hpThreshold", 0),
        family: accountReadStringProperty(text, "family"),
        evolutionStage: Math.max(1, accountReadNumberProperty(text, "evolutionStage", 1)),
        battlePassExclusive: accountReadBooleanProperty(text, "battlePassExclusive"),
        boosterExcluded: accountReadBooleanProperty(text, "boosterExcluded"),
        rewardRestricted: accountReadBooleanProperty(text, "rewardRestricted"),
        packExclusive: accountReadBooleanProperty(text, "packExclusive"),
        lootExcluded: accountReadBooleanProperty(text, "lootExcluded")
      });
    }

    if (!catalog.size) throw new Error("No card definitions were parsed.");
    console.log(`[account] loaded ${catalog.size} server-authoritative card definitions.`);
    return catalog;
  } catch (err) {
    console.error(`[account] card catalog unavailable; server pack opening is disabled: ${err.message}`);
    return new Map();
  }
}

const ACCOUNT_CARD_CATALOG = loadAccountCardCatalog();

function accountPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function accountSafeId(value, maxLength = 96) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > maxLength) return "";
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? id : "";
}

function accountSafeMap(rawValue, allowed, maxValue = 1) {
  const result = {};
  if (!accountPlainObject(rawValue)) return result;

  for (const [rawId, rawCount] of Object.entries(rawValue)) {
    const id = accountSafeId(rawId);
    if (!id || !allowed.has(id)) continue;

    const amount = safeStatInt(rawCount, 0, maxValue);
    if (amount > 0) result[id] = amount;
  }

  return result;
}

function accountSafeOwnedMap(rawValue, options = {}) {
  const result = {};
  const maxCopies = options.legacy
    ? ACCOUNT_LEGACY_MAX_CARD_COPIES
    : ACCOUNT_MAX_CARD_COPIES;

  if (!accountPlainObject(rawValue)) return result;

  for (const [rawId, rawCount] of Object.entries(rawValue)) {
    const id = accountSafeId(rawId);
    if (!id || !ACCOUNT_CARD_CATALOG.has(id)) continue;

    const amount = safeStatInt(rawCount, 0, maxCopies);
    if (amount > 0) result[id] = amount;
  }

  return result;
}

function accountSafeCustomizationMap(rawValue) {
  const result = {};
  if (!accountPlainObject(rawValue)) return result;

  for (const [rawSlot, rawId] of Object.entries(rawValue)) {
    const slot = accountSafeId(rawSlot, 24);
    const id = accountSafeId(rawId);
    if (!slot || !id || ACCOUNT_CUSTOMIZATION_BY_ID[id] !== slot) continue;
    result[slot] = id;
  }

  return result;
}

function accountDefaultInventory() {
  const ownedCards = {};
  for (const cardId of ACCOUNT_STARTER_CARD_IDS) {
    if (ACCOUNT_CARD_CATALOG.has(cardId)) ownedCards[cardId] = 1;
  }

  return {
    version: ACCOUNT_SCHEMA_VERSION,
    migratedAt: 0,
    daily: {
      lastClaimDayKey: "",
      trackIndex: 0,
      totalClaims: 0,
      claimHistory: []
    },

    progressRewardReceipts: {},

    battlePass: {
      premiumSeasons: {}
    },

    ownedCards,
    boosterTickets: {},
    eventTickets: 0,
    ownedTitles: { rookie_survivor: true },
    equippedTitleId: "rookie_survivor",
    ownedFrames: { default_frame: true },
    equippedFrameId: "default_frame",
    ownedCustomizations: {},
    equippedCustomizations: {},
    ownedEmotes: {},
    loadoutWeightBonus: 0,
    seasonal: {
      claimedRewards: {},
      shopPurchases: {}
    },
    shareRewardClaimed: false,
    shareRewardClaimedAt: 0,
    shareRewardSource: "",
    shareRewardCardIds: [],
    shareRewardEmoteIds: []
  };
}

function accountNormalizeInventory(rawValue, options = {}) {
  const source = accountPlainObject(rawValue) ? rawValue : {};
  const inventory = accountDefaultInventory();
  const legacy = !!options.legacy;

 inventory.migratedAt = Math.max(0, Number(source.migratedAt || 0));

  const dailySource = accountPlainObject(source.daily)
    ? source.daily
    : {};

  const dailyKey = String(dailySource.lastClaimDayKey || "");

  inventory.daily.lastClaimDayKey = /^\d{4}-\d{2}-\d{2}$/.test(dailyKey)
    ? dailyKey
    : "";

  inventory.daily.trackIndex = safeStatInt(
    dailySource.trackIndex,
    0,
    Math.max(0, ACCOUNT_DAILY_REWARD_TRACK.length - 1)
  );

  inventory.daily.totalClaims = safeStatInt(
    dailySource.totalClaims,
    0,
    999999999
  );

  inventory.daily.claimHistory = Array.isArray(dailySource.claimHistory)
    ? dailySource.claimHistory
      .slice(-14)
      .map(row => ({
        dayKey: /^\d{4}-\d{2}-\d{2}$/.test(String(row?.dayKey || ""))
          ? String(row.dayKey)
          : "",
        trackDay: safeStatInt(
          row?.trackDay,
          0,
          ACCOUNT_DAILY_REWARD_TRACK.length
        ),
        title: String(row?.title || "").slice(0, 80),
        summary: Array.isArray(row?.summary)
          ? row.summary.map(value => String(value).slice(0, 96)).slice(0, 8)
          : []
      }))
      .filter(row => row.dayKey && row.trackDay > 0)
    : [];

  const receiptSource = accountPlainObject(source.progressRewardReceipts)
    ? source.progressRewardReceipts
    : {};

  const receiptRows = Object.entries(receiptSource)
    .map(([rawId, rawClaimedAt]) => ({
      id: accountSafeProgressReceiptId(rawId),
      claimedAt: Math.max(0, Number(rawClaimedAt || 0))
    }))
    .filter(row => row.id && Number.isFinite(row.claimedAt) && row.claimedAt > 0)
    .sort((a, b) => a.claimedAt - b.claimedAt)
    .slice(-ACCOUNT_MAX_REWARD_RECEIPTS);

  for (const row of receiptRows) {
    inventory.progressRewardReceipts[row.id] = row.claimedAt;
  }

  const battlePassSource = accountPlainObject(source.battlePass)
    ? source.battlePass
    : {};

  const premiumSeasonSource = accountPlainObject(
    battlePassSource.premiumSeasons
  )
    ? battlePassSource.premiumSeasons
    : {};

  for (const [rawSeasonId, rawUnlockedAt] of Object.entries(premiumSeasonSource)) {
    const seasonId = accountSafeId(rawSeasonId, 64);
    const unlockedAt = Math.max(0, Number(rawUnlockedAt || 0));

    if (
      seasonId &&
      /^battlepass_[A-Za-z0-9_-]{1,48}$/.test(seasonId) &&
      Number.isFinite(unlockedAt) &&
      unlockedAt > 0
    ) {
      inventory.battlePass.premiumSeasons[seasonId] = unlockedAt;
    }
  }

  inventory.ownedCards = {
    ...inventory.ownedCards,
    ...accountSafeOwnedMap(source.ownedCards || source.owned, { legacy })
  };

  inventory.boosterTickets = accountSafeMap(
    source.boosterTickets,
    new Set(Object.keys(ACCOUNT_PACK_CATALOG)),
    ACCOUNT_MAX_TICKETS_PER_PACK
  );

  inventory.eventTickets = safeStatInt(
    source.eventTickets,
    0,
    ACCOUNT_MAX_EVENT_TICKETS
  );

  inventory.ownedTitles = accountSafeMap(
    source.ownedTitles,
    ACCOUNT_TITLE_IDS,
    1
  );
  inventory.ownedTitles.rookie_survivor = 1;

  const requestedTitle = accountSafeId(source.equippedTitleId, 64);
  inventory.equippedTitleId =
    requestedTitle && inventory.ownedTitles[requestedTitle]
      ? requestedTitle
      : "rookie_survivor";

  inventory.ownedFrames = accountSafeMap(
    source.ownedFrames,
    ACCOUNT_FRAME_IDS,
    1
  );
  inventory.ownedFrames.default_frame = 1;

  const requestedFrame = accountSafeId(source.equippedFrameId, 64);
  inventory.equippedFrameId =
    requestedFrame && inventory.ownedFrames[requestedFrame]
      ? requestedFrame
      : "default_frame";

  inventory.ownedCustomizations = accountSafeMap(
    source.ownedCustomizations,
    new Set(Object.keys(ACCOUNT_CUSTOMIZATION_BY_ID)),
    1
  );

  const requestedCustomizations = accountSafeCustomizationMap(
    source.equippedCustomizations
  );

  for (const [slot, id] of Object.entries(requestedCustomizations)) {
    if (inventory.ownedCustomizations[id]) {
      inventory.equippedCustomizations[slot] = id;
    }
  }

  inventory.ownedEmotes = accountSafeMap(
    source.ownedEmotes || source.unlockedEmotes,
    ACCOUNT_EMOTE_IDS,
    1
  );

  const sharedEmotes = Array.isArray(source.shareRewardEmoteIds)
    ? source.shareRewardEmoteIds
    : [];

  for (const rawId of sharedEmotes) {
    const id = accountSafeId(rawId);
    if (id && ACCOUNT_EMOTE_IDS.has(id)) inventory.ownedEmotes[id] = 1;
  }

  const eventRewardEmotes = Array.isArray(source.eventRewardEmoteIds)
    ? source.eventRewardEmoteIds
    : [];

  for (const rawId of eventRewardEmotes) {
    const id = accountSafeId(rawId);
    if (id && ACCOUNT_EMOTE_IDS.has(id)) inventory.ownedEmotes[id] = 1;
  }

  inventory.loadoutWeightBonus = Math.min(
    ACCOUNT_LOADOUT_WEIGHT_MAX - ACCOUNT_LOADOUT_WEIGHT_BASE,
    Math.max(
      0,
      Math.floor(
        safeStatInt(source.loadoutWeightBonus, 0, 1000) /
        ACCOUNT_LOADOUT_WEIGHT_STEP
      ) * ACCOUNT_LOADOUT_WEIGHT_STEP
    )
  );

  const seasonal = accountPlainObject(source.seasonal)
    ? source.seasonal
    : accountPlainObject(source.seasonalEventState)
      ? source.seasonalEventState
      : {};

  for (const [eventId, event] of Object.entries(ACCOUNT_SEASONAL_EVENTS)) {
    const claimedSource = accountPlainObject(seasonal.claimedRewards?.[eventId])
      ? seasonal.claimedRewards[eventId]
      : {};

    const purchaseSource = accountPlainObject(seasonal.shopPurchases?.[eventId])
      ? seasonal.shopPurchases[eventId]
      : {};

    const claimed = {};
    const purchases = {};

    for (const rewardId of Object.keys(event.rewards)) {
      if (claimedSource[rewardId]) claimed[rewardId] = true;
    }

    for (const [itemId, item] of Object.entries(event.shopItems)) {
      const count = safeStatInt(purchaseSource[itemId], 0, item.limit || 99);
      if (count > 0) purchases[itemId] = count;
    }

    if (Object.keys(claimed).length) inventory.seasonal.claimedRewards[eventId] = claimed;
    if (Object.keys(purchases).length) inventory.seasonal.shopPurchases[eventId] = purchases;
  }

  inventory.shareRewardClaimed = !!source.shareRewardClaimed;
  inventory.shareRewardClaimedAt = Math.max(0, Number(source.shareRewardClaimedAt || 0));
  inventory.shareRewardSource = String(source.shareRewardSource || "").slice(0, 32);

  const shareCardIds = Array.isArray(source.shareRewardCardIds)
    ? source.shareRewardCardIds
    : [];

  const shareEmoteIds = Array.isArray(source.shareRewardEmoteIds)
    ? source.shareRewardEmoteIds
    : [];

  inventory.shareRewardCardIds = shareCardIds
    .map(id => accountSafeId(id))
    .filter(id => id && ACCOUNT_CARD_CATALOG.has(id))
    .slice(0, 16);

  inventory.shareRewardEmoteIds = shareEmoteIds
    .map(id => accountSafeId(id))
    .filter(id => id && ACCOUNT_EMOTE_IDS.has(id))
    .slice(0, 16);

  if (inventory.shareRewardClaimed) {
    for (const cardId of ACCOUNT_SHARE_REWARD.cardIds) {
      if (ACCOUNT_CARD_CATALOG.has(cardId)) {
        inventory.ownedCards[cardId] = Math.max(1, inventory.ownedCards[cardId] || 0);
        if (!inventory.shareRewardCardIds.includes(cardId)) {
          inventory.shareRewardCardIds.push(cardId);
        }
      }
    }

    for (const emoteId of ACCOUNT_SHARE_REWARD.emoteIds) {
      inventory.ownedEmotes[emoteId] = 1;
      if (!inventory.shareRewardEmoteIds.includes(emoteId)) {
        inventory.shareRewardEmoteIds.push(emoteId);
      }
    }
  }

  return inventory;
}

function accountEnsureInventory(entry) {
  if (!entry) return accountDefaultInventory();

  // Keep the same object reference alive. Account actions can hold this
  // reference while reward helpers normalize inventory again.
  const existingAccount = accountPlainObject(entry.account)
    ? entry.account
    : null;

  const normalizedAccount = accountNormalizeInventory(
    existingAccount || {}
  );

  if (!existingAccount) {
    entry.account = normalizedAccount;
    return entry.account;
  }

  for (const key of Object.keys(existingAccount)) {
    if (!Object.prototype.hasOwnProperty.call(normalizedAccount, key)) {
      delete existingAccount[key];
    }
  }

  Object.assign(existingAccount, normalizedAccount);

  entry.account = existingAccount;
  return existingAccount;
}

function accountSnapshot(entry) {
  const account = accountEnsureInventory(entry);

  return {
    version: ACCOUNT_SCHEMA_VERSION,
    migrationRequired: ACCOUNT_LEGACY_MIGRATION_ENABLED && !account.migratedAt,
    migratedAt: account.migratedAt || 0,
    daily: JSON.parse(JSON.stringify(account.daily)),
    battlePass: {
      premiumSeasons: JSON.parse(
        JSON.stringify(account.battlePass?.premiumSeasons || {})
      )
    },
    gold: safeStatInt(entry.gold, 1000, 999999999),
    gems: safeStatInt(entry.gems, 0, 999999999),
    owned: { ...account.ownedCards },
    boosterTickets: { ...account.boosterTickets },
    eventTickets: account.eventTickets,
    ownedTitles: { ...account.ownedTitles },
    equippedTitleId: account.equippedTitleId,
    ownedFrames: { ...account.ownedFrames },
    equippedFrameId: account.equippedFrameId,
    ownedCustomizations: { ...account.ownedCustomizations },
    equippedCustomizations: { ...account.equippedCustomizations },
    ownedEmotes: { ...account.ownedEmotes },
    loadoutWeightBonus: account.loadoutWeightBonus,
    seasonal: {
      claimedRewards: JSON.parse(JSON.stringify(account.seasonal.claimedRewards)),
      shopPurchases: JSON.parse(JSON.stringify(account.seasonal.shopPurchases))
    },
    shareRewardClaimed: account.shareRewardClaimed,
    shareRewardClaimedAt: account.shareRewardClaimedAt,
    shareRewardSource: account.shareRewardSource,
    shareRewardCardIds: [...account.shareRewardCardIds],
    shareRewardEmoteIds: [...account.shareRewardEmoteIds]
  };
}

function accountSyncPlayerCurrency(entry, player) {
  if (!entry || !player) return;
  player.gold = safeStatInt(entry.gold, 1000, 999999999);
  player.gems = safeStatInt(entry.gems, 0, 999999999);
}

function accountCreateRollbackSnapshot(entry) {
  return JSON.parse(JSON.stringify(serializeLeaderboardEntry(entry)));
}

function accountRestoreRollbackSnapshot(entry, snapshot) {
  if (!entry || !snapshot || typeof snapshot !== "object") return;

  for (const key of Object.keys(entry)) {
    delete entry[key];
  }

  Object.assign(entry, {
    ...snapshot,
    reportKeys: new Set(
      Array.isArray(snapshot.reportKeys) ? snapshot.reportKeys : []
    )
  });

  accountEnsureInventory(entry);
}

function accountAllowAction(entry, actionType, now = Date.now()) {
  const rule = ACCOUNT_ACTION_RULES[actionType];
  if (!entry || !rule) return false;

  if (!accountPlainObject(entry.accountActionRate)) {
    entry.accountActionRate = Object.create(null);
  }

  const bucket = entry.accountActionRate[actionType] || {
    lastAt: 0,
    windowStartedAt: now,
    count: 0
  };

  if (now - Number(bucket.lastAt || 0) < rule.cooldownMs) return false;

  if (now - Number(bucket.windowStartedAt || 0) >= rule.windowMs) {
    bucket.windowStartedAt = now;
    bucket.count = 0;
  }

  if (Number(bucket.count || 0) >= rule.maxInWindow) return false;

  bucket.lastAt = now;
  bucket.count = Number(bucket.count || 0) + 1;
  entry.accountActionRate[actionType] = bucket;
  return true;
}

function accountSpend(entry, cost = {}) {
  const gold = safeStatInt(cost.gold, 0, 999999999);
  const gems = safeStatInt(cost.gems, 0, 999999999);

  if (Number(entry.gold || 0) < gold || Number(entry.gems || 0) < gems) {
    return false;
  }

  entry.gold = Number(entry.gold || 0) - gold;
  entry.gems = Number(entry.gems || 0) - gems;
  return true;
}

function accountAddCard(entry, cardId, amount = 1) {
  const account = accountEnsureInventory(entry);
  const id = accountSafeId(cardId);
  if (!id || !ACCOUNT_CARD_CATALOG.has(id)) return false;

  account.ownedCards[id] = Math.min(
    ACCOUNT_MAX_CARD_COPIES,
    Number(account.ownedCards[id] || 0) + safeStatInt(amount, 0, ACCOUNT_MAX_CARD_COPIES)
  );

  return true;
}

function accountAwardProfileXp(entry, amount = 0) {
  if (!entry) {
    return {
      xp: 0,
      oldLevel: 1,
      newLevel: 1,
      levelsGained: 0
    };
  }

  const xp = safeStatInt(amount, 0, 999999999);
  entry.level = Math.max(1, Math.min(PROFILE_MAX_LEVEL, safeStatInt(entry.level, 1, PROFILE_MAX_LEVEL)));
  entry.profileXp = entry.level >= PROFILE_MAX_LEVEL
    ? 0
    : safeStatInt(entry.profileXp, 0, 999999999);

  const oldLevel = entry.level;

  if (!xp || entry.level >= PROFILE_MAX_LEVEL) {
    return {
      xp: 0,
      oldLevel,
      newLevel: entry.level,
      levelsGained: 0
    };
  }

  entry.profileXp += xp;

  while (entry.level < PROFILE_MAX_LEVEL) {
    const requiredXp = profileXpForNextLevel(entry.level);

    if (!requiredXp || entry.profileXp < requiredXp) break;

    entry.profileXp -= requiredXp;
    entry.level++;
  }

  if (entry.level >= PROFILE_MAX_LEVEL) entry.profileXp = 0;

  return {
    xp,
    oldLevel,
    newLevel: entry.level,
    levelsGained: entry.level - oldLevel
  };
}

function accountGrantReward(entry, reward = {}) {
  const account = accountEnsureInventory(entry);
  const gold = safeStatInt(reward.gold ?? reward.cash, 0, 999999999);
  const gems = safeStatInt(reward.gems, 0, 999999999);

  entry.gold = safeStatInt(Number(entry.gold || 0) + gold, 0, 999999999);
  entry.gems = safeStatInt(Number(entry.gems || 0) + gems, 0, 999999999);

  const profileXp = accountAwardProfileXp(entry, reward.profileXp ?? reward.xp);

  if (reward.eventTickets) {
    account.eventTickets = Math.min(
      ACCOUNT_MAX_EVENT_TICKETS,
      Number(account.eventTickets || 0) + safeStatInt(reward.eventTickets, 0, ACCOUNT_MAX_EVENT_TICKETS)
    );
  }

  if (accountPlainObject(reward.boosterTickets)) {
    for (const [rawPackId, rawAmount] of Object.entries(reward.boosterTickets)) {
      const packId = accountSafeId(rawPackId);

      if (!packId || !ACCOUNT_PACK_CATALOG[packId]) continue;

      const amount = safeStatInt(rawAmount, 0, ACCOUNT_MAX_TICKETS_PER_PACK);

      if (amount <= 0) continue;

      account.boosterTickets[packId] = Math.min(
        ACCOUNT_MAX_TICKETS_PER_PACK,
        Number(account.boosterTickets[packId] || 0) + amount
      );
    }
  }

  const cardIds = [
    ...(Array.isArray(reward.cardIds) ? reward.cardIds : []),
    reward.cardId
  ];

  for (const rawCardId of cardIds) {
    const cardId = accountSafeId(rawCardId);
    if (cardId) accountAddCard(entry, cardId, 1);
  }

  if (reward.titleId && ACCOUNT_TITLE_IDS.has(reward.titleId)) {
    account.ownedTitles[reward.titleId] = 1;
  }

  if (reward.frameId && ACCOUNT_FRAME_IDS.has(reward.frameId)) {
    account.ownedFrames[reward.frameId] = 1;
  }

  if (reward.customizationId && ACCOUNT_CUSTOMIZATION_BY_ID[reward.customizationId]) {
    account.ownedCustomizations[reward.customizationId] = 1;
  }

  const emoteIds = [
    ...(Array.isArray(reward.emoteIds) ? reward.emoteIds : []),
    reward.emoteId
  ];

  for (const rawEmoteId of emoteIds) {
    const emoteId = accountSafeId(rawEmoteId);

    if (emoteId && ACCOUNT_EMOTE_IDS.has(emoteId)) {
      account.ownedEmotes[emoteId] = 1;
    }
  }

  entry.updatedAt = Date.now();
  return profileXp;
}

function accountGetActiveSeasonalEvent(now = Date.now()) {
  for (const [eventId, event] of Object.entries(ACCOUNT_SEASONAL_EVENTS)) {
    const startAt = Date.parse(event.startsAt);
    const endAt = Date.parse(event.endsAt);

    if (
      event.enabled !== false &&
      Number.isFinite(startAt) &&
      Number.isFinite(endAt) &&
      now >= startAt &&
      now <= endAt
    ) {
      return { id: eventId, ...event };
    }
  }

  return null;
}

function accountServerRandomFloat() {
  return crypto.randomBytes(6).readUIntBE(0, 6) / 0x1000000000000;
}

function accountPickRarity(odds = {}) {
  const entries = Object.entries(odds)
    .map(([rarity, chance]) => ({ rarity, chance: Number(chance) || 0 }))
    .filter(entry => entry.chance > 0);

  const total = entries.reduce((sum, entry) => sum + entry.chance, 0);
  if (total <= 0) return "";

  let roll = accountServerRandomFloat() * total;
  for (const entry of entries) {
    roll -= entry.chance;
    if (roll <= 0) return entry.rarity;
  }

  return entries[entries.length - 1]?.rarity || "";
}

function accountCardCanAppearInPack(card, pack) {
  if (!card || !pack?.odds?.[card.rarity]) return false;
  if (
    card.battlePassExclusive ||
    card.boosterExcluded ||
    ACCOUNT_SHARE_REWARD.cardIds.includes(card.id)
  ) {
    return false;
  }

  if (pack.categoryBias === "utility" && card.category !== "magic" && card.category !== "trap") {
    return false;
  }

  if (pack.categoryBias === "evolution" && card.category !== "monster") {
    return false;
  }

  return card.category !== "monster" ||
    Number(card.evolutionStage || 1) >= Number(pack.minStage || 1);
}

function accountRollPackCard(pack) {
  const allCards = [...ACCOUNT_CARD_CATALOG.values()];
  if (!allCards.length) return null;

  const rarity = accountPickRarity(pack.odds);
  let candidates = allCards.filter(card =>
    card.rarity === rarity &&
    accountCardCanAppearInPack(card, pack)
  );

  if (!candidates.length) {
    candidates = allCards.filter(card => accountCardCanAppearInPack(card, pack));
  }

  if (!candidates.length) return null;
  return candidates[crypto.randomInt(candidates.length)];
}

function accountVancouverDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ACCOUNT_DAILY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const get = type => parts.find(part => part.type === type)?.value || "";

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function accountIsFallLeavesEmoteRewardWindow(date = new Date()) {
  const dayKey = accountVancouverDayKey(date);
  const month = Number(dayKey.slice(5, 7));
  const day = Number(dayKey.slice(8, 10));

  return (
    (month === 9 && day >= 22) ||
    month === 10 ||
    month === 11
  );
}

function accountRollDailyCard(rule = {}) {
  const minRank = safeStatInt(rule.minRarityRank, 0, 8);

  const maxRank = Math.max(
    minRank,
    safeStatInt(rule.maxRarityRank, minRank, 8)
  );

  const candidates = [...ACCOUNT_CARD_CATALOG.values()].filter(card => {
    const rank = ACCOUNT_DAILY_RARITY_RANK[card?.rarity] ?? -1;

    return (
      rank >= minRank &&
      rank <= maxRank &&
      !card.battlePassExclusive &&
      !card.boosterExcluded &&
      !card.rewardRestricted &&
      !card.packExclusive &&
      !card.lootExcluded &&
      !ACCOUNT_SHARE_REWARD.cardIds.includes(card.id)
    );
  });

  return candidates.length
    ? candidates[crypto.randomInt(candidates.length)]
    : null;
}

function accountClaimDailyReward(entry) {
  const account = accountEnsureInventory(entry);
  const todayKey = accountVancouverDayKey();

  if (account.daily.lastClaimDayKey === todayKey) {
    return {
      ok: false,
      error: "Daily reward already claimed. Try again after the next Vancouver day begins."
    };
  }

  const trackIndex = safeStatInt(
    account.daily.trackIndex,
    0,
    Math.max(0, ACCOUNT_DAILY_REWARD_TRACK.length - 1)
  );

  const definition =
    ACCOUNT_DAILY_REWARD_TRACK[trackIndex] ||
    ACCOUNT_DAILY_REWARD_TRACK[0];

  const reward = {
    gold: definition.gold,
    gems: definition.gems,
    eventTickets: definition.eventTickets,
    boosterTickets: definition.boosterTickets
  };

  if (definition.dailyCard) {
    const card = accountRollDailyCard(definition.dailyCard);

    if (!card) {
      return {
        ok: false,
        error: "Daily reward card pool is unavailable. No reward was consumed."
      };
    }

    reward.cardId = card.id;
  }

  const summary = [];

  if (reward.gold) {
    summary.push(`+${Number(reward.gold).toLocaleString()} Cash Points`);
  }

  if (reward.gems) {
    summary.push(`+${Number(reward.gems).toLocaleString()} Gems`);
  }

  for (const [packId, amount] of Object.entries(reward.boosterTickets || {})) {
    summary.push(`+${amount} ${packId.replace(/_/g, " ")} Ticket`);
  }

  if (reward.eventTickets) summary.push(`+${reward.eventTickets} Event Ticket`);
  if (reward.cardId) summary.push(`+${reward.cardId.replace(/_/g, " ")}`);

  // Mark the reward as claimed before any helper can normalize account data.
  // This marker is included in the same Upstash save as the reward itself.
  account.daily.lastClaimDayKey = todayKey;
  account.daily.trackIndex =
    (trackIndex + 1) % ACCOUNT_DAILY_REWARD_TRACK.length;

  account.daily.totalClaims += 1;

  account.daily.claimHistory.push({
    dayKey: todayKey,
    trackDay: definition.day,
    title: definition.title,
    summary
  });

  account.daily.claimHistory = account.daily.claimHistory.slice(-14);

  entry.updatedAt = Date.now();

  accountGrantReward(entry, reward);

  return {
    ok: true,
    trackDay: definition.day,
    title: definition.title,
    summary
  };
}

function accountBuildVerifiedMatchReward(match, matchEntry, won) {
  const kills = safeStatInt(matchEntry?.matchKills, 0, MATCH_TOTAL_SLOTS);

  return {
    gold: 75 + (won ? 350 : 0) + kills * 60,
    gems: won ? 6 : (kills >= 5 ? 1 : 0),
    profileXp: 120 + (won ? 500 : 0) + kills * 90
  };
}

function accountSafeProgressReceiptId(value) {
  const id = typeof value === "string" ? value.trim() : "";

  if (!id || id.length > 180) return "";

  return /^(?:quest|battlepass)_[A-Za-z0-9_-]{1,160}$/.test(id)
    ? id
    : "";
}

function accountPruneProgressReceipts(account) {
  if (!accountPlainObject(account?.progressRewardReceipts)) {
    account.progressRewardReceipts = {};
    return;
  }

  const rows = Object.entries(account.progressRewardReceipts)
    .map(([rawId, rawClaimedAt]) => ({
      id: accountSafeProgressReceiptId(rawId),
      claimedAt: Math.max(0, Number(rawClaimedAt || 0))
    }))
    .filter(row => row.id && Number.isFinite(row.claimedAt) && row.claimedAt > 0)
    .sort((a, b) => a.claimedAt - b.claimedAt)
    .slice(-ACCOUNT_MAX_REWARD_RECEIPTS);

  account.progressRewardReceipts = Object.fromEntries(
    rows.map(row => [row.id, row.claimedAt])
  );
}

function accountSanitizeProgressReward(rawReward) {
  const source = accountPlainObject(rawReward) ? rawReward : {};

  const reward = {
    gold: safeStatInt(
      source.gold ?? source.cash,
      0,
      ACCOUNT_CLIENT_REWARD_MAX_GOLD
    ),
    gems: safeStatInt(
      source.gems,
      0,
      ACCOUNT_CLIENT_REWARD_MAX_GEMS
    ),
    profileXp: safeStatInt(
      source.profileXp ?? source.xp,
      0,
      ACCOUNT_CLIENT_REWARD_MAX_XP
    ),
    eventTickets: safeStatInt(
      source.eventTickets,
      0,
      ACCOUNT_CLIENT_REWARD_MAX_EVENT_TICKETS
    )
  };

  const rawTickets = accountPlainObject(source.boosterTickets)
    ? source.boosterTickets
    : accountPlainObject(source.tickets)
      ? source.tickets
      : {};

  reward.boosterTickets = accountSafeMap(
    rawTickets,
    new Set(Object.keys(ACCOUNT_PACK_CATALOG)),
    ACCOUNT_CLIENT_REWARD_MAX_TICKETS_PER_PACK
  );

  const cardId = accountSafeId(source.cardId);
  const emoteId = accountSafeId(source.emoteId);
  const titleId = accountSafeId(source.titleId, 64);
  const frameId = accountSafeId(source.frameId, 64);
  const customizationId = accountSafeId(source.customizationId, 64);

  if (cardId && ACCOUNT_CARD_CATALOG.has(cardId)) reward.cardId = cardId;
  if (emoteId && ACCOUNT_EMOTE_IDS.has(emoteId)) reward.emoteId = emoteId;
  if (titleId && ACCOUNT_TITLE_IDS.has(titleId)) reward.titleId = titleId;
  if (frameId && ACCOUNT_FRAME_IDS.has(frameId)) reward.frameId = frameId;

  if (
    customizationId &&
    ACCOUNT_CUSTOMIZATION_BY_ID[customizationId]
  ) {
    reward.customizationId = customizationId;
  }

  const hasTickets = Object.values(reward.boosterTickets).some(
    amount => amount > 0
  );

  const hasReward =
    reward.gold > 0 ||
    reward.gems > 0 ||
    reward.profileXp > 0 ||
    reward.eventTickets > 0 ||
    hasTickets ||
    !!reward.cardId ||
    !!reward.emoteId ||
    !!reward.titleId ||
    !!reward.frameId ||
    !!reward.customizationId;

  return hasReward ? reward : null;
}

function accountClaimProgressReward(entry, data = {}) {
  const account = accountEnsureInventory(entry);
  const receiptId = accountSafeProgressReceiptId(data.receiptId);

  if (!receiptId) {
    return { ok: false, error: "Invalid progress reward receipt." };
  }

  if (account.progressRewardReceipts[receiptId]) {
    return {
      ok: false,
      duplicate: true,
      error: "This reward was already claimed."
    };
  }

  const reward = accountSanitizeProgressReward(data.reward);

  if (!reward) {
    return { ok: false, error: "Progress reward has no valid items." };
  }

  account.progressRewardReceipts[receiptId] = Date.now();
  accountPruneProgressReceipts(account);

  accountGrantReward(entry, reward);
  entry.updatedAt = Date.now();

  return {
    ok: true,
    receiptId,
    reward
  };
}

function accountBuyBattlePassPremium(entry, data = {}) {
  const account = accountEnsureInventory(entry);
  const seasonId = accountSafeId(data.seasonId, 64);

  if (
    !seasonId ||
    !/^battlepass_[A-Za-z0-9_-]{1,48}$/.test(seasonId)
  ) {
    return { ok: false, error: "Invalid Battle Pass season." };
  }

  if (account.battlePass.premiumSeasons[seasonId]) {
    return {
      ok: false,
      error: "Magic Pass is already unlocked for this season."
    };
  }

  if (!accountSpend(entry, { gems: ACCOUNT_BATTLE_PASS_MAGIC_COST })) {
    return {
      ok: false,
      error: `Need ${ACCOUNT_BATTLE_PASS_MAGIC_COST.toLocaleString()} Gems to unlock Magic Pass.`
    };
  }

  account.battlePass.premiumSeasons[seasonId] = Date.now();
  entry.updatedAt = Date.now();

  return {
    ok: true,
    seasonId,
    cost: ACCOUNT_BATTLE_PASS_MAGIC_COST
  };
}

function accountClaimFallLeavesEmote(entry) {
  const account = accountEnsureInventory(entry);

  if (!accountIsFallLeavesEmoteRewardWindow()) {
    return { ok: false, error: "Fall Leaves is only available during the Fall Event." };
  }

  const alreadyOwned = !!account.ownedEmotes[ACCOUNT_FALL_LEAVES_EMOTE_ID];
  account.ownedEmotes[ACCOUNT_FALL_LEAVES_EMOTE_ID] = 1;
  entry.updatedAt = Date.now();

  return {
    ok: true,
    emoteId: ACCOUNT_FALL_LEAVES_EMOTE_ID,
    alreadyOwned,
    summary: alreadyOwned ? ["Fall Leaves Emote already owned"] : ["Fall Leaves Emote"]
  };
}

function accountLegacyMigration(entry, rawLegacy) {
  if (!ACCOUNT_LEGACY_MIGRATION_ENABLED) {
    return { ok: false, error: "Legacy browser-save migration is closed." };
  }

  const account = accountEnsureInventory(entry);
  if (account.migratedAt) {
    return { ok: false, error: "This account has already completed its one-time migration." };
  }

  const legacy = accountPlainObject(rawLegacy) ? rawLegacy : {};
  const collection = accountPlainObject(legacy.collection) ? legacy.collection : legacy;

  entry.account = accountNormalizeInventory({
    ...collection,
    seasonal: legacy.seasonal || legacy.seasonalEventState || collection.seasonal,
    migratedAt: Date.now()
  }, { legacy: true });

  // This is a one-time compatibility bridge for existing browser saves.
  // Currency is capped because a browser save cannot prove historical validity.
  entry.gold = Math.max(
    safeStatInt(entry.gold, 1000, 999999999),
    safeStatInt(collection.gold, 1000, ACCOUNT_LEGACY_GOLD_CAP)
  );

  entry.gems = Math.max(
    safeStatInt(entry.gems, 0, 999999999),
    safeStatInt(collection.gems, 0, ACCOUNT_LEGACY_GEMS_CAP)
  );

  return { ok: true };
}

function accountHandleAction(entry, actionType, data = {}) {
  const account = accountEnsureInventory(entry);

  if (actionType === "migrateLegacy") {
    return accountLegacyMigration(entry, data.legacy);
  }

  if (actionType === "claimDailyReward") {
    return accountClaimDailyReward(entry);
  }

  if (actionType === "claimFallLeavesEmote") {
    return accountClaimFallLeavesEmote(entry);
  }

  if (actionType === "claimProgressReward") {
    return accountClaimProgressReward(entry, data);
  }

  if (actionType === "buyBattlePassPremium") {
    return accountBuyBattlePassPremium(entry, data);
  }

if (actionType === "buyPack") {
  const packId = accountSafeId(data.packId);
  const pack = ACCOUNT_PACK_CATALOG[packId];

  if (!pack) return { ok: false, error: "Unknown booster pack." };
  if (!ACCOUNT_CARD_CATALOG.size) {
    return {
      ok: false,
      error: "Server card catalog is unavailable. Pack opening is temporarily disabled."
    };
  }

  // Roll first so a bad future pack configuration cannot consume
  // currency or a ticket without awarding cards.
  const cards = [];

  for (let index = 0; index < 3; index++) {
    const card = accountRollPackCard(pack);

    if (!card) {
      return {
        ok: false,
        error: "No eligible cards are configured for this pack."
      };
    }

    cards.push(card.id);
  }

  const tickets = Number(account.boosterTickets[packId] || 0);
  const usedTicket = tickets > 0;

  if (usedTicket) {
    account.boosterTickets[packId] = tickets - 1;
  } else if (!accountSpend(entry, { [pack.costType]: pack.cost })) {
    return {
      ok: false,
      error: `Not enough ${pack.costType.toUpperCase()}.`
    };
  }

  for (const cardId of cards) {
    accountAddCard(entry, cardId, 1);
  }

  return { ok: true, packId, usedTicket, cards };
}

  if (actionType === "buyTitle") {
    const titleId = accountSafeId(data.titleId);
    const cost = ACCOUNT_TITLE_STORE[titleId];
    if (!cost) return { ok: false, error: "That title is not sold by the server shop." };

    if (!account.ownedTitles[titleId] && !accountSpend(entry, cost)) {
      return { ok: false, error: "Not enough currency for that title." };
    }

    account.ownedTitles[titleId] = 1;
    account.equippedTitleId = titleId;
    return { ok: true, titleId };
  }

  if (actionType === "buyFrame") {
    const frameId = accountSafeId(data.frameId);
    const cost = ACCOUNT_FRAME_STORE[frameId];
    if (!cost) return { ok: false, error: "That frame is not sold by the server shop." };

    if (!account.ownedFrames[frameId] && !accountSpend(entry, cost)) {
      return { ok: false, error: "Not enough currency for that frame." };
    }

    account.ownedFrames[frameId] = 1;
    account.equippedFrameId = frameId;
    return { ok: true, frameId };
  }

  if (actionType === "buyCustomization") {
    const customizationId = accountSafeId(data.customizationId);
    const cost = ACCOUNT_CUSTOMIZATION_STORE[customizationId];
    if (!cost) return { ok: false, error: "That customization is not sold by the server shop." };

    if (!account.ownedCustomizations[customizationId] && !accountSpend(entry, cost)) {
      return { ok: false, error: "Not enough currency for that customization." };
    }

    account.ownedCustomizations[customizationId] = 1;
    account.equippedCustomizations[cost.slot] = customizationId;
    return { ok: true, customizationId };
  }

  if (actionType === "equipTitle") {
    const titleId = accountSafeId(data.titleId);
    if (!titleId || !account.ownedTitles[titleId]) {
      return { ok: false, error: "That title is locked." };
    }

    account.equippedTitleId = titleId;
    return { ok: true, titleId };
  }

  if (actionType === "equipFrame") {
    const frameId = accountSafeId(data.frameId);
    if (!frameId || !account.ownedFrames[frameId]) {
      return { ok: false, error: "That frame is locked." };
    }

    account.equippedFrameId = frameId;
    return { ok: true, frameId };
  }

  if (actionType === "equipCustomization") {
    const customizationId = accountSafeId(data.customizationId);
    const slot = ACCOUNT_CUSTOMIZATION_BY_ID[customizationId];

    if (!slot || !account.ownedCustomizations[customizationId]) {
      return { ok: false, error: "That customization is locked." };
    }

    account.equippedCustomizations[slot] = customizationId;
    return { ok: true, customizationId };
  }

  if (actionType === "unequipCustomization") {
    const slot = accountSafeId(data.slot, 24);
    if (!["hair", "hat", "glasses", "face"].includes(slot)) {
      return { ok: false, error: "Unknown customization slot." };
    }

    delete account.equippedCustomizations[slot];
    return { ok: true, slot };
  }

  if (actionType === "upgradeLoadoutWeight") {
    const current = ACCOUNT_LOADOUT_WEIGHT_BASE + Number(account.loadoutWeightBonus || 0);
    if (current >= ACCOUNT_LOADOUT_WEIGHT_MAX) {
      return { ok: false, error: "Loadout weight is already at maximum." };
    }

    const purchased = Math.floor(Number(account.loadoutWeightBonus || 0) / ACCOUNT_LOADOUT_WEIGHT_STEP);
    const cost = ACCOUNT_LOADOUT_WEIGHT_UPGRADE_BASE_GEMS +
      purchased * ACCOUNT_LOADOUT_WEIGHT_UPGRADE_STEP_GEMS;

    if (!accountSpend(entry, { gems: cost })) {
      return { ok: false, error: `Need ${cost.toLocaleString()} Gems for this upgrade.` };
    }

    account.loadoutWeightBonus = Math.min(
      ACCOUNT_LOADOUT_WEIGHT_MAX - ACCOUNT_LOADOUT_WEIGHT_BASE,
      Number(account.loadoutWeightBonus || 0) + ACCOUNT_LOADOUT_WEIGHT_STEP
    );

    return { ok: true, cost, loadoutWeightBonus: account.loadoutWeightBonus };
  }

  if (actionType === "claimSeasonalReward") {
    const active = accountGetActiveSeasonalEvent();
    const eventId = accountSafeId(data.eventId);
    const rewardId = accountSafeId(data.rewardId);

    if (!active || active.id !== eventId) {
      return { ok: false, error: "That seasonal event is not active." };
    }

    const reward = active.rewards[rewardId];
    if (!reward) return { ok: false, error: "Seasonal reward not found." };

    account.seasonal.claimedRewards[eventId] =
      account.seasonal.claimedRewards[eventId] || {};

    if (account.seasonal.claimedRewards[eventId][rewardId]) {
      return { ok: false, error: "Seasonal reward already claimed." };
    }

    account.seasonal.claimedRewards[eventId][rewardId] = true;
    accountGrantReward(entry, reward);
    return { ok: true, eventId, rewardId };
  }

  if (actionType === "buySeasonalItem") {
    const active = accountGetActiveSeasonalEvent();
    const eventId = accountSafeId(data.eventId);
    const itemId = accountSafeId(data.itemId);

    if (!active || active.id !== eventId) {
      return { ok: false, error: "That seasonal event is not active." };
    }

    const item = active.shopItems[itemId];
    if (!item) return { ok: false, error: "Seasonal shop item not found." };

    account.seasonal.shopPurchases[eventId] =
      account.seasonal.shopPurchases[eventId] || {};

    const count = Number(account.seasonal.shopPurchases[eventId][itemId] || 0);
    if (item.limit && count >= item.limit) {
      return { ok: false, error: "Seasonal item purchase limit reached." };
    }

    if (!accountSpend(entry, { [item.costType]: item.cost })) {
      return { ok: false, error: `Not enough ${String(item.costType || "currency").toUpperCase()}.` };
    }

    account.seasonal.shopPurchases[eventId][itemId] = count + 1;
    accountGrantReward(entry, item.reward);
    return { ok: true, eventId, itemId };
  }

  if (actionType === "claimShareBonus") {
    if (account.shareRewardClaimed) {
      return { ok: false, error: "This account already claimed its one-time community share bonus." };
    }

    // Browsers cannot verify that an external social post was published.
    // This prevents repeat/localStorage claims, but remains an honor-system claim.
    account.shareRewardClaimed = true;
    account.shareRewardClaimedAt = Date.now();
    account.shareRewardSource = String(data.source || "share").slice(0, 32);

    for (const cardId of ACCOUNT_SHARE_REWARD.cardIds) {
      accountAddCard(entry, cardId, 1);
      if (!account.shareRewardCardIds.includes(cardId)) {
        account.shareRewardCardIds.push(cardId);
      }
    }

    for (const emoteId of ACCOUNT_SHARE_REWARD.emoteIds) {
      account.ownedEmotes[emoteId] = 1;
      if (!account.shareRewardEmoteIds.includes(emoteId)) {
        account.shareRewardEmoteIds.push(emoteId);
      }
    }

    entry.gold = safeStatInt(
      Number(entry.gold || 0) + ACCOUNT_SHARE_REWARD.gold,
      0,
      999999999
    );

    entry.gems = safeStatInt(
      Number(entry.gems || 0) + ACCOUNT_SHARE_REWARD.gems,
      0,
      999999999
    );

    return { ok: true, honorSystem: true };
  }

  return { ok: false, error: "Unknown account action." };
}

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

function signPlayerSession(encodedPayload, secret = PLAYER_SESSION_SECRET) {
  return crypto
    .createHmac("sha256", secret)
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

  const provided = Buffer.from(signature);

  const validSignature = [
    PLAYER_SESSION_SECRET,
    ...PLAYER_SESSION_PREVIOUS_SECRETS
  ].some(secret => {
    const expected = Buffer.from(signPlayerSession(encodedPayload, secret));

    return (
      expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided)
    );
  });

  if (!validSignature) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );

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
  const entry = p?.playerId ? leaderboardProfiles.get(p.playerId) : null;

  return {
    ...publicPlayer(p),
    sessionToken: p?.sessionToken || "",
    ranked: entry?.ranked || null,
    rankedPoints: Math.max(0, Number(entry?.rankedPoints || 1000)),
    account: entry ? accountSnapshot(entry) : null
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

const MATCH_STATE_NETWORK_FIELDS = Object.freeze([
  "name",
  "teamId",
  "gameState",
  "x",
  "y",
  "angle",
  "radius",
  "hp",
  "maxHp",
  "shieldHp",
  "shieldMax",
  "armorHp",
  "armorMax",
  "alive",
  "isDowned",
  "downedTimer",
  "color",
  "titleId",
  "frameId",
  "customizations",
  "floor",
  "scopeLevel",
  "visionRadius",
  "selectedMelee",
  "meleeWeapon"
]);

function matchStateValuesEqual(left, right) {
  if (left === right) return true;

  if (typeof left === "number" && typeof right === "number") {
    return Math.abs(left - right) < 0.001;
  }

  // These replicated state objects are flat DTOs:
  // customizations and meleeWeapon.
  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) return false;

    for (const key of leftKeys) {
      if (left[key] !== right[key]) return false;
    }

    return true;
  }

  return false;
}

function makeMatchStateDeltaPayload(match, entry, state, now = Date.now()) {
  if (!match || !entry || !state) return null;

  const previous = entry.lastBroadcastState || null;
  const full = !previous || previous.gameState !== state.gameState;
  const delta = {};

  for (const field of MATCH_STATE_NETWORK_FIELDS) {
    if (full || !matchStateValuesEqual(state[field], previous[field])) {
      delta[field] = state[field];
    }
  }

  if (!Object.keys(delta).length) return null;

  entry.stateSequence = Number(entry.stateSequence || 0) + 1;
  entry.lastBroadcastState = {
    ...state,
    customizations: { ...(state.customizations || {}) },
    meleeWeapon: state.meleeWeapon ? { ...state.meleeWeapon } : null
  };

  return {
    v: 2,
    matchId: match.matchId,
    socketId: state.socketId,
    playerId: state.playerId,
    seq: entry.stateSequence,
    full,
    serverNow: now,
    state: delta
  };
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

  return match?.ranked
    ? Math.min(RANKED_BOT_MIN, maxBotsForSlots)
    : Math.min(MATCH_BOT_MIN, maxBotsForSlots);
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

function sanitizeWorldCustomizations(raw) {
  if (!isPlainObject(raw)) return {};

  const clean = {};

  for (const [slot, id] of Object.entries(raw).slice(0, 8)) {
    const safeSlot = String(slot || "").slice(0, 32);
    const safeId = String(id || "").slice(0, 64);

    if (safeSlot && safeId) {
      clean[safeSlot] = safeId;
    }
  }

  return clean;
}

function sanitizeWorldBotFull(bot) {
  return {
    id: String(bot?.id || ""),
    name: String(bot?.name || "Bot").slice(0, 32),
    color: String(bot?.color || "#ef4444").slice(0, 24),
    customizations: sanitizeWorldCustomizations(bot?.customizations),
    teamId: bot?.teamId
      ? String(bot.teamId).slice(0, 48)
      : null,
    x: Number(bot?.x || 0),
    y: Number(bot?.y || 0),
    angle: Number(bot?.angle || 0),
    lookAngle: Number(bot?.lookAngle || bot?.angle || 0),
    hp: Number(bot?.hp ?? 100),
    maxHp: Number(bot?.maxHp ?? 100),
    alive: bot?.alive !== false,
    isEliminated: !!bot?.isEliminated,
    isDowned: !!bot?.isDowned,
    floor: String(bot?.floor || "surface").slice(0, 48)
  };
}

function sanitizeWorldBotUpdate(bot) {
  return {
    id: String(bot?.id || ""),
    x: Number(bot?.x || 0),
    y: Number(bot?.y || 0),
    angle: Number(bot?.angle || 0),
    lookAngle: Number(bot?.lookAngle || bot?.angle || 0),
    hp: Number(bot?.hp ?? 100),
    maxHp: Number(bot?.maxHp ?? 100),
    alive: bot?.alive !== false,
    isEliminated: !!bot?.isEliminated,
    isDowned: !!bot?.isDowned,
    floor: String(bot?.floor || "surface").slice(0, 48)
  };
}

function sanitizeWorldItem(item) {
  return {
    id: String(item?.id || ""),
    x: Number(item?.x || 0),
    y: Number(item?.y || 0),
    floor: String(item?.floor || "surface").slice(0, 48),
    type: String(item?.type || "loot").slice(0, 32),
    name: String(item?.name || "Loot").slice(0, 64),
    cardId: item?.cardId
      ? String(item.cardId).slice(0, 64)
      : null,
    cardName: item?.cardName
      ? String(item.cardName).slice(0, 64)
      : null,
    rarity: item?.rarity
      ? String(item.rarity).slice(0, 32)
      : null,
    visualColor: item?.visualColor
      ? String(item.visualColor).slice(0, 24)
      : null,
    iconSymbol: item?.iconSymbol
      ? String(item.iconSymbol).slice(0, 8)
      : null,
    radius: Number(item?.radius || 12),
    healAmount: Number(item?.healAmount || 0),
    shieldAmount: Number(item?.shieldAmount || 0),
    armorAmount: Number(item?.armorAmount || 0),
    amount: Number(item?.amount || 0),
    meleeId: item?.meleeId
      ? String(item.meleeId).slice(0, 64)
      : null,
    damage: Number(item?.damage || 0),
    objectDamage: Number(item?.objectDamage || 0),
    cooldownMs: Number(item?.cooldownMs || 0)
  };
}

function sanitizeWorldCrateFull(crate) {
  return {
    id: String(crate?.id || ""),
    x: Number(crate?.x || 0),
    y: Number(crate?.y || 0),
    width: Number(crate?.width || 44),
    height: Number(crate?.height || 44),
    floor: String(crate?.floor || "surface").slice(0, 48),
    rarity: crate?.rarity
      ? String(crate.rarity).slice(0, 32)
      : null,
    crateType: crate?.crateType
      ? String(crate.crateType).slice(0, 32)
      : null,
    hp: Number(crate?.hp || 0),
    maxHp: Number(crate?.maxHp || crate?.hp || 0),
    alive: crate?.alive !== false,
    destroyed: !!crate?.destroyed
  };
}

function sanitizeWorldCrateUpdate(crate) {
  return {
    id: String(crate?.id || ""),
    hp: Number(crate?.hp || 0),
    alive: crate?.alive !== false,
    destroyed: !!crate?.destroyed
  };
}

function sanitizeWorldIdList(raw, limit) {
  if (!Array.isArray(raw)) return [];

  return raw
    .slice(0, limit)
    .map(id => String(id || "").slice(0, 96))
    .filter(Boolean);
}

function sanitizeWorldStorm(storm) {
  if (!isPlainObject(storm)) return null;

  return {
    centerX: Number(storm.centerX || 0),
    centerY: Number(storm.centerY || 0),
    currentRadius: Number(storm.currentRadius || 0),
    targetRadius: Number(storm.targetRadius || 0),
    timer: Number(storm.timer || 0),
    damagePhase: Number(storm.damagePhase || 0)
  };
}

function sanitizeWorldSnapshot(snapshot) {
  const legacyFullSnapshot =
    snapshot?.full !== false &&
    Array.isArray(snapshot?.bots) &&
    !Array.isArray(snapshot?.botUpdates);

  const full = snapshot?.full === true || legacyFullSnapshot;

  return {
    full,
    seq: Number(snapshot?.seq || 0),
    state: String(snapshot?.state || "MATCH").slice(0, 32),
    serverNow: Date.now(),

    bots: full
      ? (
        Array.isArray(snapshot?.bots)
          ? snapshot.bots
              .slice(0, MATCH_TOTAL_SLOTS)
              .map(sanitizeWorldBotFull)
          : []
      )
      : [],

    botUpserts: Array.isArray(snapshot?.botUpserts)
      ? snapshot.botUpserts
          .slice(0, MATCH_TOTAL_SLOTS)
          .map(sanitizeWorldBotFull)
      : [],

    botUpdates: Array.isArray(snapshot?.botUpdates)
      ? snapshot.botUpdates
          .slice(0, MATCH_TOTAL_SLOTS)
          .map(sanitizeWorldBotUpdate)
      : [],

    botRemoves: sanitizeWorldIdList(
      snapshot?.botRemoves,
      MATCH_TOTAL_SLOTS
    ),

    items: full
      ? (
        Array.isArray(snapshot?.items)
          ? snapshot.items
              .slice(0, 160)
              .map(sanitizeWorldItem)
          : []
      )
      : [],

    itemUpserts: Array.isArray(snapshot?.itemUpserts)
      ? snapshot.itemUpserts
          .slice(0, 160)
          .map(sanitizeWorldItem)
      : [],

    itemRemoves: sanitizeWorldIdList(snapshot?.itemRemoves, 160),

    crates: full
      ? (
        Array.isArray(snapshot?.crates)
          ? snapshot.crates
              .slice(0, 220)
              .map(sanitizeWorldCrateFull)
          : []
      )
      : [],

    crateUpserts: Array.isArray(snapshot?.crateUpserts)
      ? snapshot.crateUpserts
          .slice(0, 220)
          .map(sanitizeWorldCrateFull)
      : [],

    crateUpdates: Array.isArray(snapshot?.crateUpdates)
      ? snapshot.crateUpdates
          .slice(0, 220)
          .map(sanitizeWorldCrateUpdate)
      : [],

    crateRemoves: sanitizeWorldIdList(snapshot?.crateRemoves, 220),
    storm: sanitizeWorldStorm(snapshot?.storm)
  };
}

function mergeWorldSnapshot(previous, incoming, matchId) {
  if (incoming.full) {
    return {
      ...incoming,
      full: true,
      matchId
    };
  }

  const base = previous?.full
    ? previous
    : {
        full: true,
        seq: 0,
        state: incoming.state || "MATCH",
        serverNow: Date.now(),
        bots: [],
        items: [],
        crates: [],
        storm: null
      };

  const botsById = new Map(
    (base.bots || []).map(bot => [String(bot.id), bot])
  );

  const itemsById = new Map(
    (base.items || []).map(item => [String(item.id), item])
  );

  const cratesById = new Map(
    (base.crates || []).map(crate => [String(crate.id), crate])
  );

  for (const bot of incoming.botUpserts || []) {
    if (bot.id) {
      botsById.set(String(bot.id), bot);
    }
  }

  for (const update of incoming.botUpdates || []) {
    const id = String(update.id || "");
    const current = botsById.get(id);

    if (current) {
      botsById.set(id, { ...current, ...update });
    }
  }

  for (const id of incoming.botRemoves || []) {
    botsById.delete(String(id));
  }

  for (const item of incoming.itemUpserts || []) {
    if (item.id) {
      itemsById.set(String(item.id), item);
    }
  }

  for (const id of incoming.itemRemoves || []) {
    itemsById.delete(String(id));
  }

  for (const crate of incoming.crateUpserts || []) {
    if (crate.id) {
      cratesById.set(String(crate.id), crate);
    }
  }

  for (const update of incoming.crateUpdates || []) {
    const id = String(update.id || "");
    const current = cratesById.get(id);

    if (current) {
      cratesById.set(id, { ...current, ...update });
    }
  }

  for (const id of incoming.crateRemoves || []) {
    cratesById.delete(String(id));
  }

  return {
    full: true,
    seq: incoming.seq,
    state: incoming.state || base.state || "MATCH",
    serverNow: incoming.serverNow || Date.now(),
    bots: [...botsById.values()],
    items: [...itemsById.values()],
    crates: [...cratesById.values()],
    storm: incoming.storm || base.storm || null,
    matchId
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
    inTcgDuel: !!p.tcgDuelId,
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

const TCG_DUEL_MIN_DECK_SIZE = 15;
const TCG_DUEL_MAX_DECK_SIZE = 40;
const TCG_DUEL_MAX_DUPLICATES = 3;
const TCG_DUEL_LIFE_POINTS = 4000;
const TCG_DUEL_INVITE_TTL_MS = 20000;
const TCG_TURN_CHOICE_MS = 8000;
const TCG_RPS_AUTO_PICK_MS = 10000;
const TCG_RPS_REVEAL_MS = 2400;
const TCG_RPS_CHOICES = new Set(["rock", "paper", "scissors"]);
const TCG_REWARD_PACKS = { win: "mythic_rift", loss: "starter_rift" };
const TCG_NPC_SOCKET_PREFIX = "tcg_npc_";
const TCG_NPC_NAMES = ["RiftRunner77", "SunnyAce", "CardSharkKai", "NovaGambit", "BeachsideAce", "TabletopRonin"];
const TCG_NPC_EXCLUDED_CARD_PATTERN = /slotty|casino|scratch/i;
const TCG_RARITY_RANK = {
  Common: 1,
  Uncommon: 2,
  Rare: 3,
  Epic: 4,
  Legendary: 5,
  Mythic: 6,
  "Super Ultra Rare": 7,
  "God Tier": 8
};
const TCG_DUEL_BOARD_LANES = 5;
const TCG_DUEL_BOARD_ROWS = 6;
const TCG_DUEL_BOARD_CELLS = TCG_DUEL_BOARD_LANES * TCG_DUEL_BOARD_ROWS;

function makeTcgDuelId() {
  return "tcg_" + Math.random().toString(36).slice(2, 11);
}

function tcgGetServerCard(cardId) {
  return ACCOUNT_CARD_CATALOG.get(accountSafeId(cardId)) || null;
}

function tcgCardCategory(cardId) {
  return tcgGetServerCard(cardId)?.category || "monster";
}

function tcgCardRank(cardId) {
  return TCG_RARITY_RANK[tcgGetServerCard(cardId)?.rarity || "Common"] || 1;
}

function tcgCardStats(cardId) {
  const card = tcgGetServerCard(cardId);
  const rank = tcgCardRank(cardId);

  if ((card?.category || "monster") !== "monster") {
    return { attack: 0, health: 0, rank };
  }

  const tributeBoost = tcgCreatureSacrificeCost(cardId) * 180;

  return {
    attack: Math.round(520 + rank * 260 + tributeBoost),
    health: Math.round(780 + rank * 310 + tributeBoost * 1.35),
    rank
  };
}

function tcgCreatureSacrificeCost(cardId) {
  const rank = tcgCardRank(cardId);
  if (rank >= 7) return 2;
  if (rank >= 5) return 1;
  return 0;
}

function tcgNormalizeBoardLane(value) {
  const lane = Math.floor(Number(value));
  return Number.isFinite(lane) ? Math.max(0, Math.min(TCG_DUEL_BOARD_LANES - 1, lane)) : 0;
}

function tcgNormalizeBoardRow(value) {
  const row = Math.floor(Number(value));
  return Number.isFinite(row) ? Math.max(0, Math.min(TCG_DUEL_BOARD_ROWS - 1, row)) : 0;
}

function tcgCreatureBoardProfile(cardId) {
  const card = tcgGetServerCard(cardId);
  const rank = tcgCardRank(cardId);
  const text = `${card?.id || ""} ${card?.name || ""} ${card?.description || ""}`.toLowerCase();

  let moveRange = rank >= 7 ? 2 : 1;
  let movePattern = "orthogonal";
  let attackRange = rank >= 7 ? 2 : 1;
  let attackStyle = "melee";

  // Common/Uncommon/Rare creatures scout only their nearby 3x3.
  // Mythic/SUR/God-tier and clear scout/ranged archetypes get wider light.
  let sightRange = rank <= 3 ? 1 : rank <= 5 ? 2 : rank === 6 ? 3 : 4;

  if (text.includes("phoenix") || text.includes("dragon")) {
    moveRange = Math.max(moveRange, 2);
    movePattern = "diagonal";
    attackRange = Math.max(attackRange, 3);
    attackStyle = "ranged";
    sightRange = Math.max(sightRange, rank >= 7 ? 4 : 3);
  }

  if (text.includes("coyote") || text.includes("koi")) {
    moveRange = Math.max(moveRange, 2);
    movePattern = "omni";
    attackRange = Math.max(attackRange, 3);
    attackStyle = "ranged";
    sightRange = Math.max(sightRange, rank >= 6 ? 3 : 2);
  }

  if (text.includes("turtle") || text.includes("tideglass")) {
    moveRange = 1;
    movePattern = "vertical";
    attackRange = Math.max(attackRange, 2);
    attackStyle = "ranged";
    sightRange = Math.max(sightRange, 2);
  }

  if (text.includes("crab") || text.includes("titan")) {
    moveRange = Math.max(moveRange, 2);
    movePattern = "orthogonal";
    attackRange = 1;
    attackStyle = "melee";
    if (text.includes("titan")) sightRange = Math.max(sightRange, rank >= 6 ? 3 : 2);
  }

  if (text.includes("lantern") || text.includes("flare") || text.includes("solar") || text.includes("star")) {
    sightRange = Math.max(sightRange, rank >= 7 ? 5 : 4);
  }

  return {
    moveRange,
    movePattern,
    attackRange,
    attackStyle,
    sightRange: Math.max(1, Math.min(5, sightRange))
  };
}

function tcgBoardCellIndex(lane, row) {
  return tcgNormalizeBoardRow(row) * TCG_DUEL_BOARD_LANES + tcgNormalizeBoardLane(lane);
}

function tcgBoardCellLane(cellIndex) {
  return tcgNormalizeBoardLane(Math.floor(Number(cellIndex || 0)) % TCG_DUEL_BOARD_LANES);
}

function tcgBoardCellRow(cellIndex) {
  return tcgNormalizeBoardRow(Math.floor(Number(cellIndex || 0)) / TCG_DUEL_BOARD_LANES);
}

function tcgNormalizeCreatureBoardState(state) {
  if (!state) return Array(TCG_DUEL_BOARD_CELLS).fill(null);

  const source = Array.isArray(state.creatureSlots) ? state.creatureSlots : [];
  const next = Array(TCG_DUEL_BOARD_CELLS).fill(null);

  source.forEach((slot, index) => {
    if (!slot) return;

    const lane = tcgNormalizeBoardLane(slot.lane ?? tcgBoardCellLane(index));
    const row = tcgNormalizeBoardRow(slot.row ?? tcgBoardCellRow(index));
    let cellIndex = tcgBoardCellIndex(lane, row);

    if (next[cellIndex]) {
      cellIndex = next.findIndex(entry => !entry);
      if (cellIndex < 0) return;
    }

    slot.lane = tcgBoardCellLane(cellIndex);
    slot.row = tcgBoardCellRow(cellIndex);
    tcgRefreshCreatureBoardProfile(slot);
    next[cellIndex] = slot;
  });

  state.creatureSlots = next;
  return next;
}

function tcgNormalizeFieldTrapState(state) {
  if (!state) return Array(TCG_DUEL_BOARD_CELLS).fill(null);

  const source = Array.isArray(state.fieldTrapSlots) ? state.fieldTrapSlots : [];
  state.fieldTrapSlots = Array.from(
    { length: TCG_DUEL_BOARD_CELLS },
    (_, index) => source[index] || null
  );

  return state.fieldTrapSlots;
}

function tcgMirrorBoardCellIndex(cellIndex) {
  const lane = tcgBoardCellLane(cellIndex);
  const row = tcgBoardCellRow(cellIndex);
  return tcgBoardCellIndex(lane, TCG_DUEL_BOARD_ROWS - 1 - row);
}

function tcgTrapPlacementCellSet(state) {
  const visible = new Set();
  const creatures = tcgNormalizeCreatureBoardState(state);

  creatures.forEach((creature, sourceCell) => {
    if (!creature) return;

    tcgRefreshCreatureBoardProfile(creature);

    const sourceLane = tcgBoardCellLane(sourceCell);
    const sourceRow = tcgBoardCellRow(sourceCell);
    const range = Math.max(1, Math.min(5, Number(creature.sightRange || 1)));

    for (let row = 0; row < TCG_DUEL_BOARD_ROWS; row++) {
      for (let lane = 0; lane < TCG_DUEL_BOARD_LANES; lane++) {
        if (Math.max(Math.abs(lane - sourceLane), Math.abs(row - sourceRow)) <= range) {
          visible.add(tcgBoardCellIndex(lane, row));
        }
      }
    }
  });

  return visible;
}

function tcgFieldTrapProfile(cardId) {
  const card = tcgGetServerCard(cardId);
  const rank = tcgCardRank(cardId);
  const triggerType = String(card?.triggerType || "");
  const effectType = String(card?.effectType || "");
  const text = `${cardId} ${card?.name || ""} ${effectType} ${card?.description || ""}`.toLowerCase();

  let kind = "snare";

  if (/preventlethal|nexthitreduction|decoyclone|angel|shell.ward/.test(text)) {
    kind = "guard";
  } else if (/reflect|damagecloseattacker|revenge|rebuke|mirror.bite/.test(text)) {
    kind = "reflect";
  } else if (/umbrella|knockback|push/.test(text)) {
    kind = "push";
  } else if (/riptide|last.laugh/.test(text)) {
    kind = "projectile";
  } else if (/mine|explosion|detonat|destroy/.test(text)) {
    kind = "blast";
  } else if (/blind|curse|poison|revealattacker|blood.mark/.test(text)) {
    kind = "weaken";
  }

  const attackTrigger = /OnHit|LowHP|Lethal/i.test(triggerType);
  const exactCell = /tripwire|mine|pit/.test(text);
  const damage = Math.max(
    120,
    Math.round((Number(card?.damage || 0) * 14) + 150 + rank * 95)
  );

  return {
    kind,
    triggerEvent: attackTrigger ? "attack" : "move",
    triggerRadius: exactCell ? 0 : 1,
    damage,
    rootTurns: rank >= 4 ? 2 : 1,
    pushDistance: rank >= 4 ? 2 : 1,
    instantKill: rank >= 7 && kind === "blast",
    pattern: tcgSpellPattern(cardId, "trap"),
    range: Math.min(5, 2 + Math.ceil(rank / 2)),
    reflectRatio: Math.max(0.3, Number(card?.reflectRatio || 0.42)),
    ownerHpThreshold: /LowHP/i.test(triggerType)
      ? Math.max(0.1, Number(card?.hpThreshold || 0.35))
      : 0
  };
}

function tcgTrapDistance(trapOwnerCell, victimCell) {
  const mirroredTrapCell = tcgMirrorBoardCellIndex(trapOwnerCell);

  return Math.max(
    Math.abs(tcgBoardCellLane(mirroredTrapCell) - tcgBoardCellLane(victimCell)),
    Math.abs(tcgBoardCellRow(mirroredTrapCell) - tcgBoardCellRow(victimCell))
  );
}

function tcgPushCreatureTowardHome(state, fromCell, distance) {
  const creature = state.creatureSlots[fromCell];
  if (!creature) return fromCell;

  const lane = tcgBoardCellLane(fromCell);
  let destination = fromCell;
  let row = tcgBoardCellRow(fromCell);

  for (let step = 0; step < distance; step++) {
    const nextRow = row - 1;
    if (nextRow < 0) break;

    const nextCell = tcgBoardCellIndex(lane, nextRow);
    if (state.creatureSlots[nextCell]) break;

    destination = nextCell;
    row = nextRow;
  }

  if (destination !== fromCell) {
    state.creatureSlots[fromCell] = null;
    state.creatureSlots[destination] = creature;
    creature.lane = tcgBoardCellLane(destination);
    creature.row = tcgBoardCellRow(destination);
  }

  return destination;
}

function tcgBuildTrapProjectilePaths(profile, sourceCell) {
  const sourceLane = tcgBoardCellLane(sourceCell);
  const sourceRow = tcgBoardCellRow(sourceCell);

  return [-1, 1].map((rowDirection, projectileIndex) => {
    const path = [];

    for (let step = 0; step <= profile.range; step++) {
      const row = sourceRow + rowDirection * step;
      if (row < 0 || row >= TCG_DUEL_BOARD_ROWS) break;

      let lane = sourceLane;

      if (profile.pattern === "diagonal") {
        lane += rowDirection * step;
      } else if (profile.pattern === "zigzag" || profile.pattern === "bounce") {
        lane += step % 2 === 0 ? 0 : rowDirection;
      }

      if (lane < 0 || lane >= TCG_DUEL_BOARD_LANES) continue;

      path.push({
        kind: "creature",
        lane,
        row,
        cellIndex: tcgBoardCellIndex(lane, row),
        step,
        projectileIndex
      });
    }

    return path;
  }).filter(path => path.length);
}

function tcgResolveFieldTraps(duel, victimSocketId, victimCellIndex, eventType, incomingDamage = 0) {
  const victimState = duel.players[victimSocketId];
  const trapOwnerSocketId = getTcgOpponentSocketId(duel, victimSocketId);
  const trapOwnerState = duel.players[trapOwnerSocketId];

  if (!victimState || !trapOwnerState) {
    return { triggered: false, destroyed: false, displaced: false, cancelAction: false };
  }

  tcgNormalizeCreatureBoardState(victimState);
  tcgNormalizeCreatureBoardState(trapOwnerState);

  const traps = tcgNormalizeFieldTrapState(trapOwnerState);
  let currentCell = victimCellIndex;
  let triggered = false;
  let destroyed = false;
  let displaced = false;
  let cancelAction = false;

  for (let trapCell = 0; trapCell < traps.length; trapCell++) {
    const trap = traps[trapCell];
    const victim = victimState.creatureSlots[currentCell];

    if (!trap || !victim) continue;

    const profile = tcgFieldTrapProfile(trap.cardId);
    if (profile.triggerEvent !== eventType) continue;
    if (trap.setTurn >= duel.turnNumber) continue;
    if (tcgTrapDistance(trapCell, currentCell) > profile.triggerRadius) continue;

    if (
      profile.ownerHpThreshold > 0 &&
      trapOwnerState.lifePoints / TCG_DUEL_LIFE_POINTS > profile.ownerHpThreshold
    ) {
      continue;
    }

    traps[trapCell] = null;
    trapOwnerState.discard.push(trap.cardId);
    triggered = true;

    const victimReference = victim;
    const sourceOnVictimBoard = tcgMirrorBoardCellIndex(trapCell);
    let paths = [[{
      kind: "creature",
      lane: tcgBoardCellLane(currentCell),
      row: tcgBoardCellRow(currentCell),
      cellIndex: currentCell,
      step: 0,
      projectileIndex: 0
    }]];
    const hits = [];

    if (profile.kind === "guard") {
      cancelAction = true;
    } else if (profile.kind === "reflect") {
      const damage = Math.max(profile.damage, Math.round(incomingDamage * profile.reflectRatio));
      const beforeHealth = Math.max(0, Number(victim.health || 0));
      const killed = tcgDamageCreature(victimState, currentCell, damage);

      hits.push({
        kind: "creature",
        lane: tcgBoardCellLane(currentCell),
        row: tcgBoardCellRow(currentCell),
        cellIndex: currentCell,
        step: 0,
        projectileIndex: 0,
        damage,
        beforeHealth,
        destroyed: killed
      });
    } else if (profile.kind === "projectile") {
      paths = tcgBuildTrapProjectilePaths(profile, sourceOnVictimBoard);
      const hitCells = new Set();

      paths.forEach(path => {
        path.forEach(step => {
          const target = victimState.creatureSlots[step.cellIndex];
          if (!target || hitCells.has(step.cellIndex)) return;

          const beforeHealth = Math.max(0, Number(target.health || 0));
          const killed = tcgDamageCreature(victimState, step.cellIndex, profile.damage);
          hitCells.add(step.cellIndex);

          hits.push({
            ...step,
            damage: profile.damage,
            beforeHealth,
            destroyed: killed
          });
        });
      });
    } else {
      const damage = profile.instantKill ? 999999 : profile.damage;
      const beforeHealth = Math.max(0, Number(victim.health || 0));
      const killed = tcgDamageCreature(victimState, currentCell, damage);

      hits.push({
        kind: "creature",
        lane: tcgBoardCellLane(currentCell),
        row: tcgBoardCellRow(currentCell),
        cellIndex: currentCell,
        step: 0,
        projectileIndex: 0,
        damage,
        beforeHealth,
        destroyed: killed
      });

      if (!killed) {
        if (profile.kind === "snare") {
          victim.rootedUntilTurn = Math.max(
            Number(victim.rootedUntilTurn || 0),
            duel.turnNumber + profile.rootTurns * 2
          );
        } else if (profile.kind === "weaken") {
          victim.attack = Math.max(100, Math.round(Number(victim.attack || 0) * 0.72));
          victim.rootedUntilTurn = Math.max(Number(victim.rootedUntilTurn || 0), duel.turnNumber + 1);
        } else if (profile.kind === "push") {
          const pushedCell = tcgPushCreatureTowardHome(victimState, currentCell, profile.pushDistance);
          displaced = displaced || pushedCell !== currentCell;
          currentCell = pushedCell;
          cancelAction = cancelAction || displaced;
        }
      }
    }

    const survivingCell = victimState.creatureSlots.indexOf(victimReference);
    if (survivingCell < 0) {
      destroyed = true;
    } else {
      currentCell = survivingCell;
    }

    const card = tcgGetServerCard(trap.cardId);
    const trapName = card?.name || trap.cardId.replace(/_/g, " ");

    tcgPushLog(duel, `${trapOwnerState.name}'s ${trapName} was triggered!`, {
      actionType: "trigger_field_trap",
      actorSocketId: trapOwnerSocketId,
      victimSocketId,
      effect: {
        eventType: "trap_trigger",
        ownerSocketId: trapOwnerSocketId,
        targetSocketId: victimSocketId,
        targetSide: "enemy",
        friendlyFire: false,
        legalTargets: "enemy_only",
        cardId: trap.cardId,
        category: "trap",
        kind: profile.kind,
        pattern: profile.pattern,
        damage: profile.damage,
        sourceCell: trapCell,
        sourceLane: tcgBoardCellLane(trapCell),
        paths,
        hits,
        revealDurationMs: 4600
      }
    });
  }

  return {
    triggered,
    destroyed,
    displaced,
    cancelAction,
    currentCellIndex: currentCell
  };
}

function tcgResolveCreatureCellIndex(state, rawIndex) {
  const slots = tcgNormalizeCreatureBoardState(state);
  const index = Math.floor(Number(rawIndex));

  if (index >= 0 && index < slots.length && slots[index]) return index;

  if (index >= 0 && index < TCG_DUEL_BOARD_LANES) {
    let best = -1;
    let bestRow = -1;

    slots.forEach((slot, cellIndex) => {
      if (!slot) return;
      const lane = tcgNormalizeBoardLane(slot.lane ?? tcgBoardCellLane(cellIndex));
      const row = tcgNormalizeBoardRow(slot.row ?? tcgBoardCellRow(cellIndex));

      if (lane === index && row > bestRow) {
        best = cellIndex;
        bestRow = row;
      }
    });

    return best;
  }

  return -1;
}

function tcgCreatureAtCell(state, lane, row) {
  const slots = tcgNormalizeCreatureBoardState(state);
  return slots[tcgBoardCellIndex(lane, row)] || null;
}

function tcgMovementDistance(profile, laneDelta, rowDelta) {
  const absLane = Math.abs(laneDelta);
  const absRow = Math.abs(rowDelta);
  return profile.movePattern === "diagonal" || profile.movePattern === "omni"
    ? Math.max(absLane, absRow)
    : absLane + absRow;
}

function tcgMovementPatternAllows(profile, laneDelta, rowDelta) {
  const absLane = Math.abs(laneDelta);
  const absRow = Math.abs(rowDelta);

  if (!absLane && !absRow) return false;
  if (profile.movePattern === "vertical") return laneDelta === 0;
  if (profile.movePattern === "horizontal") return rowDelta === 0;
  if (profile.movePattern === "diagonal") return absLane === absRow;
  if (profile.movePattern === "omni") return true;
  return laneDelta === 0 || rowDelta === 0;
}

function tcgRefreshCreatureBoardProfile(slot) {
  if (!slot) return null;
  const profile = tcgCreatureBoardProfile(slot.cardId);
  slot.lane = tcgNormalizeBoardLane(slot.lane ?? 0);
  slot.row = tcgNormalizeBoardRow(slot.row ?? 0);
  slot.moveRange = profile.moveRange;
  slot.movePattern = profile.movePattern;
  slot.attackRange = profile.attackRange;
  slot.attackStyle = profile.attackStyle;
  slot.sightRange = profile.sightRange;
  return slot;
}

function tcgAttackCellLane(slot, cellIndex) {
  return tcgNormalizeBoardLane(slot?.lane ?? (cellIndex >= TCG_DUEL_BOARD_LANES ? tcgBoardCellLane(cellIndex) : cellIndex));
}

function tcgAttackCellRow(slot, cellIndex) {
  return tcgNormalizeBoardRow(slot?.row ?? (cellIndex >= TCG_DUEL_BOARD_LANES ? tcgBoardCellRow(cellIndex) : 0));
}

function tcgCreatureBoardMetrics(attacker, attackerCellIndex, defender, defenderCellIndex) {
  const attackerRow = tcgAttackCellRow(attacker, attackerCellIndex);
  const defenderRow = tcgAttackCellRow(defender, defenderCellIndex);
  const attackerLane = tcgAttackCellLane(attacker, attackerCellIndex);
  const defenderLane = tcgAttackCellLane(defender, defenderCellIndex);
  const rowDistance = Math.abs((TCG_DUEL_BOARD_ROWS - 1) - attackerRow - defenderRow);
  const laneDistance = Math.abs(defenderLane - attackerLane);

  return {
    attackerRow,
    defenderRow,
    attackerLane,
    defenderLane,
    rowDistance,
    laneDistance,
    distance: Math.max(rowDistance, laneDistance)
  };
}

function tcgCanCreatureAttackTarget(attacker, attackerCellIndex, defender, defenderCellIndex) {
  if (!attacker || !defender) return false;
  const profile = tcgCreatureBoardProfile(attacker.cardId);
  const metrics = tcgCreatureBoardMetrics(attacker, attackerCellIndex, defender, defenderCellIndex);

  if (profile.attackStyle === "melee") {
    return metrics.rowDistance <= 1 && metrics.laneDistance <= 1;
  }

  return metrics.rowDistance <= profile.attackRange && metrics.laneDistance <= profile.attackRange;
}

function tcgDirectLaneBlocked(opponentState, directLane) {
  const slots = tcgNormalizeCreatureBoardState(opponentState);
  return !!slots[tcgBoardCellIndex(directLane, 0)];
}

function tcgCanCreatureAttackDirect(attacker, attackerCellIndex = -1, opponentState = null, directLane = null) {
  if (!attacker) return false;

  const profile = tcgCreatureBoardProfile(attacker.cardId);
  const attackerLane = tcgAttackCellLane(attacker, attackerCellIndex);
  const attackerRow = tcgAttackCellRow(attacker, attackerCellIndex);
  const lane = directLane === null || directLane === undefined
    ? attackerLane
    : tcgNormalizeBoardLane(directLane);
  const laneDistance = Math.abs(lane - attackerLane);

  if (attackerRow < TCG_DUEL_BOARD_ROWS - 1) return false;
  if (opponentState && tcgDirectLaneBlocked(opponentState, lane)) return false;

  if (profile.attackStyle === "melee") {
    return laneDistance <= 1;
  }

  return laneDistance <= profile.attackRange;
}

function tcgFindDirectPushbackCell(state, attackerCellIndex) {
  const slots = tcgNormalizeCreatureBoardState(state);
  const attackerLane = tcgBoardCellLane(attackerCellIndex);
  const attackerRow = tcgBoardCellRow(attackerCellIndex);

  if (attackerRow <= 0) return -1;

  const fallbackRows = [attackerRow - 1];
  const laneOrder = [attackerLane, attackerLane - 1, attackerLane + 1];

  for (const row of fallbackRows) {
    for (const lane of laneOrder) {
      if (lane < 0 || lane >= TCG_DUEL_BOARD_LANES) continue;
      const cellIndex = tcgBoardCellIndex(lane, row);
      if (!slots[cellIndex]) return cellIndex;
    }
  }

  return -1;
}

function tcgPushDirectAttackerBack(state, attackerCellIndex) {
  const slots = tcgNormalizeCreatureBoardState(state);
  const slot = slots[attackerCellIndex];
  if (!slot) return false;

  const targetCell = tcgFindDirectPushbackCell(state, attackerCellIndex);
  if (targetCell < 0 || targetCell === attackerCellIndex) return false;

  slots[attackerCellIndex] = null;
  slots[targetCell] = slot;
  slot.lane = tcgBoardCellLane(targetCell);
  slot.row = tcgBoardCellRow(targetCell);
  return true;
}

function tcgAttackDirectionFromSlots(attackerCellIndex, targetCellIndex) {
  const attackerLane = attackerCellIndex >= TCG_DUEL_BOARD_LANES ? tcgBoardCellLane(attackerCellIndex) : tcgNormalizeBoardLane(attackerCellIndex);
  const targetLane = targetCellIndex >= TCG_DUEL_BOARD_LANES && targetCellIndex < TCG_DUEL_BOARD_CELLS
    ? tcgBoardCellLane(targetCellIndex)
    : tcgNormalizeBoardLane(targetCellIndex);
  const delta = targetLane - attackerLane;
  if (delta < 0) return "forward_left";
  if (delta > 0) return "forward_right";
  return "forward";
}

function tcgCreatureAttackShape(attacker) {
  const profile = tcgCreatureBoardProfile(attacker?.cardId);
  if (profile.attackStyle !== "ranged") return "melee";

  const card = tcgGetServerCard(attacker?.cardId);
  const text = `${card?.id || ""} ${card?.name || ""} ${card?.description || ""}`.toLowerCase();

  if (text.includes("coyote") || text.includes("koi") || text.includes("star")) return "radius";
  if (text.includes("phoenix") || text.includes("dragon")) return "diagonal";
  return "line";
}

function tcgCanCreatureAttackTarget(attacker, attackerCellIndex, defender, defenderCellIndex) {
  if (!attacker || !defender) return false;

  const profile = tcgCreatureBoardProfile(attacker.cardId);
  const metrics = tcgCreatureBoardMetrics(attacker, attackerCellIndex, defender, defenderCellIndex);
  const range = Math.max(1, Number(profile.attackRange || 1));
  const shape = tcgCreatureAttackShape(attacker);

  if (shape === "melee") return metrics.rowDistance <= 1 && metrics.laneDistance <= 1;
  if (shape === "radius") return metrics.distance <= range;
  if (shape === "diagonal") {
    return metrics.rowDistance <= range && (metrics.laneDistance === 0 || metrics.laneDistance === metrics.rowDistance);
  }

  return metrics.rowDistance <= range && metrics.laneDistance === 0;
}

function tcgResolveEffectKind(cardId, category = "") {
  const card = tcgGetServerCard(cardId);
  const text = `${card?.id || ""} ${card?.name || ""} ${card?.description || ""}`.toLowerCase();

  if (text.includes("heal") || text.includes("shield") || text.includes("feast") || text.includes("bonfire")) return "heal";
  if (text.includes("draw") || text.includes("mirror") || text.includes("luck") || text.includes("echo")) return "draw";
  if (text.includes("tide") || text.includes("riptide") || text.includes("wave") || text.includes("ocean")) return "aoe";
  if (text.includes("stun") || text.includes("snare") || text.includes("jellyfish") || text.includes("umbrella") || text.includes("sand") || text.includes("slow")) return "disable";
  if (text.includes("destroy") || text.includes("reaper") || text.includes("mine") || text.includes("mirage")) return "destroy";
  if (text.includes("flare") || text.includes("solar") || text.includes("fire") || text.includes("heat") || text.includes("burn")) return "burn";
  return category === "trap" ? "disable" : "burn";
}

function tcgSpellEffectTemplate(cardId, category = "") {
  const card = tcgGetServerCard(cardId);
  const rank = tcgCardRank(cardId);
  const text = `${card?.id || ""} ${card?.name || ""} ${card?.description || ""}`.toLowerCase();
  const effectKind = tcgResolveEffectKind(cardId, category);

  const template = {
    effectKind,
    pattern: "straight",
    range: TCG_DUEL_BOARD_ROWS + 1,
    damage: category === "trap" ? 620 + rank * 160 : 480 + rank * 135,
    piercing: false,
    stopsOnHit: true,
    projectileCount: 1,
    canHitLp: category === "magic",
    lpScale: 0.42,
    requiresTarget: false,
    debuff: null
  };

  if (effectKind === "heal" || effectKind === "draw") return { ...template, pattern: "utility", damage: 0, canHitLp: false };
  if (effectKind === "aoe") return { ...template, pattern: text.includes("riptide") ? "bounce" : "wave", range: 5, damage: 260 + rank * 90, piercing: true, stopsOnHit: false, projectileCount: text.includes("riptide") ? 2 : 5, lpScale: 0.28 };
  if (effectKind === "destroy") return { ...template, pattern: text.includes("mine") || text.includes("mirage") ? "zigzag" : "straight", damage: rank >= 5 ? 99999 : 720 + rank * 180, requiresTarget: true, canHitLp: false };
  if (effectKind === "disable") return { ...template, pattern: text.includes("jellyfish") || text.includes("umbrella") ? "zigzag" : "cross", damage: 320 + rank * 95, piercing: true, stopsOnHit: false, projectileCount: 3, canHitLp: false, debuff: "weaken" };
  if (effectKind === "burn") return { ...template, pattern: text.includes("solar") || text.includes("flare") ? "diagonal" : "straight", projectileCount: text.includes("solar") || text.includes("flare") ? 2 : 1 };

  return template;
}

function tcgSpellPattern(cardId, category = "") {
  return tcgSpellEffectTemplate(cardId, category).pattern;
}

function tcgSpellAnchorFromTarget(targetSlotIndex, opponentState, casterLane) {
  const raw = Math.floor(Number(targetSlotIndex));

  if (raw >= 0 && raw < TCG_DUEL_BOARD_CELLS) {
    return { cellIndex: raw, lane: tcgBoardCellLane(raw), row: tcgBoardCellRow(raw) };
  }

  const resolved = tcgResolveCreatureCellIndex(opponentState, raw);
  if (resolved >= 0) {
    return { cellIndex: resolved, lane: tcgBoardCellLane(resolved), row: tcgBoardCellRow(resolved) };
  }

  return { cellIndex: -1, lane: tcgNormalizeBoardLane(raw >= 0 ? raw : casterLane), row: TCG_DUEL_BOARD_ROWS - 1 };
}

function tcgSpellProjectileStarts(template, anchorLane) {
  if (template.pattern === "wave") return Array.from({ length: TCG_DUEL_BOARD_LANES }, (_, lane) => ({ lane, dir: 0 }));
  if (template.pattern === "cross") return [-1, 0, 1].map(offset => ({ lane: anchorLane + offset, dir: 0 }));
  if (template.pattern === "diagonal") return [{ lane: anchorLane, dir: -1 }, { lane: anchorLane, dir: 1 }];
  if (template.pattern === "zigzag") return [{ lane: anchorLane, dir: -1 }, { lane: anchorLane, dir: 1 }];
  if (template.pattern === "bounce") return [{ lane: anchorLane, dir: anchorLane <= 2 ? 1 : -1 }, { lane: anchorLane, dir: anchorLane <= 2 ? -1 : 1 }];
  return [{ lane: anchorLane, dir: 0 }];
}

function tcgBuildSpellProjectilePaths(template, anchorLane) {
  const paths = [];

  tcgSpellProjectileStarts(template, anchorLane).forEach((start, projectileIndex) => {
    const path = [];
    let lane = tcgNormalizeBoardLane(start.lane);
    let dir = start.dir || 0;

    for (let step = 0; step < Math.max(1, Number(template.range || 1)); step++) {
      if (template.pattern === "diagonal") {
        lane = anchorLane + dir * (step + 1);
      } else if (template.pattern === "zigzag") {
        lane = anchorLane + (step % 2 === 0 ? 0 : dir);
      } else if (template.pattern === "bounce" && step > 0) {
        lane += dir;
        if (lane < 0 || lane >= TCG_DUEL_BOARD_LANES) {
          dir *= -1;
          lane += dir * 2;
        }
      } else if (template.pattern !== "bounce") {
        lane = start.lane;
      }

      if (lane < 0 || lane >= TCG_DUEL_BOARD_LANES) continue;

      if (step < TCG_DUEL_BOARD_ROWS) {
        const row = TCG_DUEL_BOARD_ROWS - 1 - step;
        path.push({ kind: "creature", lane, row, cellIndex: tcgBoardCellIndex(lane, row), step, projectileIndex });
      } else if (template.canHitLp) {
        path.push({ kind: "base", lane, row: -1, cellIndex: -1, step, projectileIndex });
      }
    }

    if (path.length) paths.push(path);
  });

  return paths;
}

function tcgPatternTargetSlots(pattern, anchorSlotIndex, opponentState) {
  const anchor = tcgSpellAnchorFromTarget(anchorSlotIndex, opponentState, anchorSlotIndex);
  const template = {
    pattern,
    range: TCG_DUEL_BOARD_ROWS + 1,
    canHitLp: false,
    projectileCount: pattern === "wave" ? 5 : pattern === "cross" ? 3 : pattern === "diagonal" || pattern === "zigzag" || pattern === "bounce" ? 2 : 1
  };

  return [...new Set(tcgBuildSpellProjectilePaths(template, anchor.lane)
    .flat()
    .filter(step => step.kind === "creature" && opponentState.creatureSlots[step.cellIndex])
    .map(step => step.cellIndex))];
}

function tcgEffectNeedsTarget(effectKind, opponentState) {
  if (!opponentState?.creatureSlots?.some(Boolean)) return false;
  return effectKind === "destroy";
}

function cleanTcgDeckPayload(deckPayload) {
  const rawIds = Array.isArray(deckPayload?.deckIds) ? deckPayload.deckIds : [];
  const counts = {};
  const deckIds = [];

  for (const rawId of rawIds) {
    const cardId = String(rawId || "").trim();
    if (!cardId) continue;

    counts[cardId] = counts[cardId] || 0;
    if (counts[cardId] >= TCG_DUEL_MAX_DUPLICATES) continue;
    if (deckIds.length >= TCG_DUEL_MAX_DECK_SIZE) break;

    counts[cardId]++;
    deckIds.push(cardId);
  }

  if (deckIds.length < TCG_DUEL_MIN_DECK_SIZE) {
    return {
      ok: false,
      error: `Card Duel requires at least ${TCG_DUEL_MIN_DECK_SIZE} valid cards.`
    };
  }

  return { ok: true, deckIds };
}

function shuffleTcgDeck(deckIds) {
  const deck = [...deckIds];

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function drawTcgCards(playerState, count) {
  let drawn = 0;

  for (let i = 0; i < count; i++) {
    if (!playerState.deck.length) {
      return { drawn, deckedOut: true };
    }

    playerState.hand.push(playerState.deck.shift());
    drawn++;
  }

  return { drawn, deckedOut: false };
}

function makeTcgPlayerState(p, deckIds) {
  const state = {
    socketId: p.socketId,
    playerId: p.playerId,
    name: p.name,
    lifePoints: TCG_DUEL_LIFE_POINTS,
    deck: shuffleTcgDeck(deckIds),
    hand: [],
    discard: [],
    creatureSlots: Array(TCG_DUEL_BOARD_CELLS).fill(null),
    spellTrapSlots: Array(5).fill(null),
    fieldTrapSlots: Array(TCG_DUEL_BOARD_CELLS).fill(null),
    normalSummonUsed: false,
    spellMoveUsed: false,
    directBlockedThisTurn: false
  };

  drawTcgCards(state, 5);
  return state;
}

function getTcgOpponentSocketId(duel, socketId) {
  return Object.keys(duel.players).find(id => id !== socketId) || null;
}

function tcgEmptyPublicVision() {
  return {
    visibleEnemyCreatureCells: [],
    visibleOpponentBoardKeys: [],
    trapPlacementCells: []
  };
}

function tcgPublicBoardKey(kind, lane, rowOrCell = 0) {
  if (kind === "creature") return `creature:opponent:${Math.floor(Number(rowOrCell || 0))}`;
  return `${kind}:opponent:${tcgNormalizeBoardLane(lane)}`;
}

function tcgViewerSharedCreatureRow(row) {
  return TCG_DUEL_BOARD_ROWS - tcgNormalizeBoardRow(row);
}

function tcgOpponentSharedCreatureRow(row) {
  return 1 + tcgNormalizeBoardRow(row);
}

function tcgBuildPublicVision(viewerState, opponentState) {
  if (!viewerState || !opponentState) return tcgEmptyPublicVision();

  const viewerSlots = tcgNormalizeCreatureBoardState(viewerState);
  const opponentSlots = tcgNormalizeCreatureBoardState(opponentState);
  const visibleEnemyCreatureCells = new Set();
  const visibleOpponentBoardKeys = new Set();

  viewerSlots.forEach((source, sourceCellIndex) => {
    if (!source) return;

    tcgRefreshCreatureBoardProfile(source);

    const sourceLane = tcgBoardCellLane(sourceCellIndex);
    const sourceRow = tcgBoardCellRow(sourceCellIndex);
    const sourceSharedRow = tcgViewerSharedCreatureRow(sourceRow);
    const sightRange = Math.max(1, Math.min(5, Math.round(Number(source.sightRange || tcgCreatureBoardProfile(source.cardId).sightRange || 1))));

    for (let lane = 0; lane < TCG_DUEL_BOARD_LANES; lane++) {
      for (let row = 0; row < TCG_DUEL_BOARD_ROWS; row++) {
        const targetCell = tcgBoardCellIndex(lane, row);
        const targetSharedRow = tcgOpponentSharedCreatureRow(row);
        const distance = Math.max(Math.abs(lane - sourceLane), Math.abs(targetSharedRow - sourceSharedRow));

        if (distance <= sightRange) {
          visibleOpponentBoardKeys.add(tcgPublicBoardKey("creature", lane, targetCell));
          if (opponentSlots[targetCell]) visibleEnemyCreatureCells.add(targetCell);
        }
      }

      const spellDistance = Math.max(Math.abs(lane - sourceLane), Math.abs(0 - sourceSharedRow));

      if (spellDistance <= sightRange) {
        visibleOpponentBoardKeys.add(tcgPublicBoardKey("spell", lane));
        visibleOpponentBoardKeys.add(tcgPublicBoardKey("base", lane));
      }
    }
  });

  return {
    visibleEnemyCreatureCells: [...visibleEnemyCreatureCells],
    visibleOpponentBoardKeys: [...visibleOpponentBoardKeys],
    trapPlacementCells: [...tcgTrapPlacementCellSet(viewerState)]
  };
}

function publicTcgPlayerState(playerState, revealHand = false, options = {}) {
  const revealPrivate = !!revealHand;
  const hideUnseenCreatures = !!options.hideUnseenCreatures && !revealPrivate;
  const hideBackrow = !!options.hideBackrow && !revealPrivate;
  const visibleCreatureCells = new Set(options.visibleCreatureCells || []);

  tcgNormalizeCreatureBoardState(playerState);

  return {
    socketId: playerState.socketId,
    playerId: playerState.playerId,
    name: playerState.name,
    lifePoints: playerState.lifePoints,
    deckCount: playerState.deck.length,
    handCount: playerState.hand.length,
    hand: revealPrivate ? [...playerState.hand] : [],
    discardCount: playerState.discard.length,
    graveyardCount: playerState.discard.length,
    creatureSlots: playerState.creatureSlots.map((slot, index) => {
      if (!slot) return null;
      if (hideUnseenCreatures && !visibleCreatureCells.has(index)) return null;

      tcgRefreshCreatureBoardProfile(slot);

      if (slot.faceDown && !revealPrivate) {
        return {
          faceDown: true,
          position: slot.position || "defense",
          setTurn: slot.summonedTurn || 0,
          lane: tcgNormalizeBoardLane(slot.lane ?? tcgBoardCellLane(index)),
          row: tcgNormalizeBoardRow(slot.row ?? tcgBoardCellRow(index)),
          moveRange: slot.moveRange || 1,
          movePattern: slot.movePattern || "orthogonal",
          attackRange: slot.attackRange || 1,
          attackStyle: slot.attackStyle || "melee",
          sightRange: slot.sightRange || 2
        };
      }

      return { ...slot };
    }),
    spellTrapSlots: playerState.spellTrapSlots.map(slot => {
      if (!slot) return null;
      if (hideBackrow) return null;
      if (!revealPrivate) {
        return {
          faceDown: true,
          category: "set",
          setTurn: slot.setTurn || 0
        };
      }
      return { ...slot };
    }),
    fieldTrapSlots: tcgNormalizeFieldTrapState(playerState).map(slot => {
      if (!slot || !revealPrivate) return null;
      return { ...slot };
    })
  };
}

function publicTcgRpsScore(duel, viewerSocketId) {
  const playerSocketIds = Object.keys(duel?.players || {});
  const selfSocketId = duel?.players?.[viewerSocketId] ? viewerSocketId : playerSocketIds[0];
  const opponentSocketId = duel?.players?.[viewerSocketId]
    ? getTcgOpponentSocketId(duel, viewerSocketId)
    : playerSocketIds[1];
  const wins = duel?.rps?.wins || {};

  return {
    round: Math.max(1, Number(duel?.rps?.round || 1)),
    targetWins: 2,
    selfWins: Math.max(0, Number(wins[selfSocketId] || 0)),
    opponentWins: Math.max(0, Number(wins[opponentSocketId] || 0))
  };
}

function publicTcgRpsReveal(duel, viewerSocketId) {
  const reveal = duel?.rpsReveal;
  if (!reveal) return null;

  const playerSocketIds = Object.keys(duel.players || {});
  const viewerIsDuelist = !!duel.players?.[viewerSocketId];
  const selfSocketId = viewerIsDuelist ? viewerSocketId : playerSocketIds[0];
  const opponentSocketId = viewerIsDuelist ? getTcgOpponentSocketId(duel, viewerSocketId) : playerSocketIds[1];
  const picks = reveal.picks || {};
  const winnerSocketId = reveal.winnerSocketId || null;

  return {
    id: reveal.id || "",
    round: Math.max(1, Number(reveal.round || duel.rps?.round || 1)),
    result: !winnerSocketId ? "tie" : winnerSocketId === selfSocketId ? "win" : "loss",
    selfPick: picks[selfSocketId] || "",
    opponentPick: picks[opponentSocketId] || "",
    selfName: duel.players?.[selfSocketId]?.name || "You",
    opponentName: duel.players?.[opponentSocketId]?.name || "Rival",
    winnerName: winnerSocketId ? duel.players?.[winnerSocketId]?.name || "Rival" : "",
    message: reveal.message || duel.rpsStatus || "",
    revealUntil: Math.max(0, Number(reveal.revealUntil || 0)),
    selfWins: Math.max(0, Number(reveal.wins?.[selfSocketId] || 0)),
    opponentWins: Math.max(0, Number(reveal.wins?.[opponentSocketId] || 0)),
    targetWins: 2
  };
}

function publicTcgScrubActionEntry(entry, overrideMessage = "") {
  const safe = {
    at: Number(entry?.at || Date.now()),
    message: String(overrideMessage || entry?.message || "")
  };

  if (entry?.meta?.effect || entry?.meta?.combat) {
    safe.meta = {};
    if (entry.meta.effect) safe.meta.effect = entry.meta.effect;
    if (entry.meta.combat) safe.meta.combat = entry.meta.combat;
  }

  return safe;
}

function publicTcgActionLog(duel, viewerSocketId) {
  const rawEntries = Array.isArray(duel?.actionLog) ? duel.actionLog : [];
  const viewerState = duel?.players?.[viewerSocketId] || null;
  const opponentSocketId = viewerState ? getTcgOpponentSocketId(duel, viewerSocketId) : null;
  const opponentState = opponentSocketId ? duel.players[opponentSocketId] : null;
  const opponentName = opponentState?.name || "Opponent";
  const vision = viewerState && opponentState ? tcgBuildPublicVision(viewerState, opponentState) : tcgEmptyPublicVision();
  const visibleBoardKeys = new Set(vision.visibleOpponentBoardKeys || []);

  const viewerHasCreatureCellVision = cellIndex => {
    const cell = Math.floor(Number(cellIndex));
    if (cell < 0 || cell >= TCG_DUEL_BOARD_CELLS) return false;
    return visibleBoardKeys.has(tcgPublicBoardKey("creature", tcgBoardCellLane(cell), cell));
  };

  const sanitized = [];

  for (const entry of rawEntries) {
    const meta = entry?.meta || {};
    const actorSocketId = meta.actorSocketId || meta.ownerSocketId || "";
    const isOpponentAction = !!opponentSocketId && actorSocketId === opponentSocketId;

    if (!isOpponentAction) {
      sanitized.push(publicTcgScrubActionEntry(entry));
      continue;
    }

    if (meta.actionType === "set_spell_trap") {
      sanitized.push(publicTcgScrubActionEntry(entry, `${opponentName} set a card.`));
      continue;
    }

    if (meta.actionType === "summon_creature") {
      const visible = viewerHasCreatureCellVision(meta.cellIndex);
      const message = visible && !meta.faceDown
        ? `${opponentName} summoned a creature.`
        : `${opponentName} placed a card.`;
      sanitized.push(publicTcgScrubActionEntry(entry, message));
      continue;
    }

    if (meta.actionType === "move_creature") {
      const fromVisible = viewerHasCreatureCellVision(meta.fromCellIndex);
      const toVisible = viewerHasCreatureCellVision(meta.toCellIndex);
      if (!fromVisible && !toVisible) continue;

      const message = fromVisible && toVisible
        ? `${opponentName} moved a visible creature.`
        : toVisible
          ? `${opponentName} moved a creature into view.`
          : `${opponentName} moved a visible creature into the darkness.`;

      sanitized.push(publicTcgScrubActionEntry(entry, message));
      continue;
    }

    if (meta.actionType === "phase" && meta.phase === "end") {
      sanitized.push(publicTcgScrubActionEntry(entry, `${opponentName} ended their turn.`));
      continue;
    }

    if (meta.actionType === "end_turn") {
      sanitized.push(publicTcgScrubActionEntry(entry, `${opponentName} ended their turn.`));
      continue;
    }

    sanitized.push(publicTcgScrubActionEntry(entry));
  }

  return sanitized.slice(0, 8);
}

function publicTcgDuelState(duel, viewerSocketId) {
  const playerSocketIds = Object.keys(duel.players);
  const isDuelist = !!duel.players[viewerSocketId];

  if (!isDuelist) {
    const left = duel.players[playerSocketIds[0]];
    const right = duel.players[playerSocketIds[1]];

    return {
      duelId: duel.duelId,
      lobbyCode: duel.lobbyCode || "",
      spectator: true,
      status: duel.status,
      phase: duel.phase,
      turnNumber: duel.turnNumber,
      activeSocketId: duel.activeSocketId,
      chooserSocketId: duel.chooserSocketId,
      choiceDeadlineAt: duel.choiceDeadlineAt || 0,
      rpsStatus: duel.rpsStatus || "",
      rpsReveal: publicTcgRpsReveal(duel, viewerSocketId),
      rpsScore: publicTcgRpsScore(duel, viewerSocketId),
      rpsPicked: false,
      winnerSocketId: duel.winnerSocketId || null,
      loserSocketId: duel.loserSocketId || null,
      endReason: duel.endReason || "",
      rewards: duel.rewards || null,
      rewardForSelf: null,
      actionLog: publicTcgActionLog(duel, viewerSocketId),
      vision: tcgEmptyPublicVision(),
      self: left ? publicTcgPlayerState(left, false, { hideBackrow: true, hideUnseenCreatures: true, visibleCreatureCells: [] }) : null,
      opponent: right ? publicTcgPlayerState(right, false, { hideBackrow: true, hideUnseenCreatures: true, visibleCreatureCells: [] }) : null
    };
  }

  const opponentSocketId = getTcgOpponentSocketId(duel, viewerSocketId);
  const self = duel.players[viewerSocketId];
  const opponent = opponentSocketId ? duel.players[opponentSocketId] : null;
  const vision = tcgBuildPublicVision(self, opponent);

  return {
    duelId: duel.duelId,
    lobbyCode: duel.lobbyCode || "",
    spectator: false,
    status: duel.status,
    phase: duel.phase,
    turnNumber: duel.turnNumber,
    activeSocketId: duel.activeSocketId,
    chooserSocketId: duel.chooserSocketId,
    choiceDeadlineAt: duel.choiceDeadlineAt || 0,
    rpsStatus: duel.rpsStatus || "",
    rpsReveal: publicTcgRpsReveal(duel, viewerSocketId),
    rpsScore: publicTcgRpsScore(duel, viewerSocketId),
    rpsPicked: !!duel.rps?.picks?.[viewerSocketId],
    winnerSocketId: duel.winnerSocketId || null,
    loserSocketId: duel.loserSocketId || null,
    endReason: duel.endReason || "",
    rewards: duel.rewards || null,
    rewardForSelf: duel.rewardResults?.[viewerSocketId] || null,
          actionLog: publicTcgActionLog(duel, viewerSocketId),
    vision,
    self: self ? publicTcgPlayerState(self, true) : null,
    opponent: opponent ? publicTcgPlayerState(opponent, false, {
      hideBackrow: true,
      hideUnseenCreatures: true,
      visibleCreatureCells: vision.visibleEnemyCreatureCells
    }) : null
  };
}

function emitTcgDuelUpdate(duel) {
  for (const socketId of Object.keys(duel.players)) {
    if (!tcgIsNpcSocketId(socketId)) {
      io.to(socketId).emit("tcgDuelUpdate", publicTcgDuelState(duel, socketId));
    }
  }

  const spectatorIds = Array.isArray(duel.spectators) ? duel.spectators : [];
  for (const socketId of spectatorIds) {
    if (!duel.players[socketId] && !tcgIsNpcSocketId(socketId)) {
      io.to(socketId).emit("tcgDuelUpdate", publicTcgDuelState(duel, socketId));
    }
  }

  tcgMaybeScheduleNpcAction(duel);
}

const TCG_LOBBY_VISIBILITIES = new Set(["open", "closed", "invite_only"]);
const TCG_LOBBY_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeTcgLobbyVisibility(value) {
  const clean = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  return TCG_LOBBY_VISIBILITIES.has(clean) ? clean : "closed";
}

function makeTcgLobbyCode() {
  for (let attempt = 0; attempt < 32; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += TCG_LOBBY_CODE_CHARS[Math.floor(Math.random() * TCG_LOBBY_CODE_CHARS.length)];
    }
    if (!tcgLobbies.has(code)) return code;
  }

  return "D" + Date.now().toString(36).slice(-5).toUpperCase();
}

function publicTcgLobby(lobby, viewerSocketId) {
  const slotIds = lobby.duelSlots || [null, null];
  const slotSet = new Set(slotIds.filter(Boolean));
  const members = (lobby.members || [])
    .map(id => tcgGetLobbyProfile(lobby, id))
    .filter(Boolean)
    .map(publicPlayer);

  const playerBySocketId = new Map(members.map(player => [player.socketId, player]));

  return {
    code: lobby.code,
    visibility: lobby.visibility || "closed",
    leaderSocketId: lobby.leaderSocketId,
    isLeader: lobby.leaderSocketId === viewerSocketId,
    activeDuelId: lobby.activeDuelId || null,
    memberCount: members.length,
    canStart: !!slotIds[0] && !!slotIds[1] && !lobby.activeDuelId,
    duelSlots: slotIds.map(socketId => socketId ? playerBySocketId.get(socketId) || null : null),
    pool: members.filter(player => !slotSet.has(player.socketId))
  };
}

function emitTcgLobbyUpdate(lobby) {
  if (!lobby) return;

  for (const socketId of lobby.members || []) {
    if (!tcgIsNpcSocketId(socketId)) {
      io.to(socketId).emit("tcgLobbyUpdate", publicTcgLobby(lobby, socketId));
    }
  }
}

function leaveTcgLobby(socketId, reason = "left") {
  const p = getPlayer(socketId);
  const lobby = p?.tcgLobbyCode ? tcgLobbies.get(p.tcgLobbyCode) : null;
  if (!lobby) {
    if (p) p.tcgLobbyCode = null;
    return;
  }

  lobby.members = (lobby.members || []).filter(id => id !== socketId);
  lobby.duelSlots = (lobby.duelSlots || [null, null]).map(id => id === socketId ? null : id);
  lobby.spectators = (lobby.spectators || []).filter(id => id !== socketId);
  delete lobby.deckIdsBySocketId[socketId];

  if (p) p.tcgLobbyCode = null;

  const humanMembers = lobby.members.filter(id => !tcgIsNpcSocketId(id));

  if (!humanMembers.length) {
    for (const npcSocketId of Object.keys(lobby.npcProfilesBySocketId || {})) {
      tcgNpcProfiles.delete(npcSocketId);
    }

    tcgLobbies.delete(lobby.code);
    return;
  }

  if (lobby.leaderSocketId === socketId || tcgIsNpcSocketId(lobby.leaderSocketId)) {
    lobby.leaderSocketId = humanMembers[0];
  }

  io.to(socketId).emit("tcgLobbyClosed", { reason });
  emitTcgLobbyUpdate(lobby);
}

function getOpenTcgLobbyResults() {
  return [...tcgLobbies.values()]
    .filter(lobby => lobby.visibility === "open" && !lobby.activeDuelId)
    .slice(0, 16)
    .map(lobby => {
      const host = getPlayer(lobby.leaderSocketId);
      return {
        code: lobby.code,
        hostName: host?.name || "Host",
        memberCount: (lobby.members || []).length
      };
    });
}

function createTcgDuelFromLobby(lobby) {
  const slotIds = lobby?.duelSlots || [];
  const firstSocketId = slotIds[0];
  const secondSocketId = slotIds[1];

  if (!firstSocketId || !secondSocketId) {
    return { ok: false, error: "Two duelists are required." };
  }

  const first = tcgGetLobbyProfile(lobby, firstSocketId);
  const second = tcgGetLobbyProfile(lobby, secondSocketId);
  const realFirst = getPlayer(firstSocketId);
  const realSecond = getPlayer(secondSocketId);

  if (!first || !second) return { ok: false, error: "A duelist is no longer connected." };
  if ((realFirst && (realFirst.inMatch || realFirst.tcgDuelId)) || (realSecond && (realSecond.inMatch || realSecond.tcgDuelId))) {
    return { ok: false, error: "A duelist is already busy." };
  }

  const firstDeck = cleanTcgDeckPayload({ deckIds: lobby.deckIdsBySocketId[firstSocketId] || [] });
  const secondDeck = cleanTcgDeckPayload({ deckIds: lobby.deckIdsBySocketId[secondSocketId] || [] });

  if (!firstDeck.ok) return { ok: false, error: `${first.name}: ${firstDeck.error}` };
  if (!secondDeck.ok) return { ok: false, error: `${second.name}: ${secondDeck.error}` };

  const duelId = makeTcgDuelId();
  const duel = {
    duelId,
    lobbyCode: lobby.code,
    npcSocketIds: [firstSocketId, secondSocketId].filter(tcgIsNpcSocketId),
    spectators: (lobby.members || []).filter(id => id !== firstSocketId && id !== secondSocketId),
    status: "rps",
    phase: "rps",
    turnNumber: 0,
    activeSocketId: null,
    chooserSocketId: null,
    choiceDeadlineAt: Date.now() + TCG_RPS_AUTO_PICK_MS,
    rpsStatus: "Choose rock, paper, or scissors.",
    rpsReveal: null,
    rpsHistory: [],
    rps: {
      round: 1,
      wins: {
        [firstSocketId]: 0,
        [secondSocketId]: 0
      },
      picks: {},
      revealing: false
    },
    players: {
      [firstSocketId]: makeTcgPlayerState(first, firstDeck.deckIds),
      [secondSocketId]: makeTcgPlayerState(second, secondDeck.deckIds)
    }
  };

  tcgDuels.set(duelId, duel);
  if (realFirst) realFirst.tcgDuelId = duelId;
  if (realSecond) realSecond.tcgDuelId = duelId;
  lobby.activeDuelId = duelId;
  lobby.spectators = duel.spectators;

  tcgScheduleRpsAuto(duel);
  emitTcgLobbyUpdate(lobby);
  emitTcgDuelUpdate(duel);
  broadcastOnlineList();

  return { ok: true, duelId };
}

function tcgIsNpcSocketId(socketId) {
  return String(socketId || "").startsWith(TCG_NPC_SOCKET_PREFIX);
}

function tcgGetLobbyProfile(lobby, socketId) {
  return getPlayer(socketId) || lobby?.npcProfilesBySocketId?.[socketId] || tcgNpcProfiles.get(socketId) || null;
}

function makeTcgNpcSocketId() {
  return `${TCG_NPC_SOCKET_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeTcgNpcProfile(socketId) {
  const name = TCG_NPC_NAMES[Math.floor(Math.random() * TCG_NPC_NAMES.length)] || "RiftRival";

  return {
    socketId,
    playerId: socketId,
    name,
    rank: "DUELIST",
    level: 10 + Math.floor(Math.random() * 45),
    profileXp: 0,
    wins: 0,
    kills: 0,
    deaths: 0,
    losses: 0,
    revives: 0,
    gold: 0,
    gems: 0,
    color: ["#ef4444", "#f97316", "#a855f7", "#22d3ee", "#22c55e"][Math.floor(Math.random() * 5)],
    icon: name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "DS",
    isNpc: true
  };
}

function tcgNpcEligibleCards() {
  return [...ACCOUNT_CARD_CATALOG.values()].filter(card => {
    if (!card?.id || !["monster", "magic", "trap"].includes(card.category)) return false;
    if (TCG_NPC_EXCLUDED_CARD_PATTERN.test(`${card.id} ${card.name || ""}`)) return false;
    return true;
  });
}

function tcgNpcPickWeightedCard(cards, counts) {
  const candidates = cards.filter(card => (counts[card.id] || 0) < TCG_DUEL_MAX_DUPLICATES);
  if (!candidates.length) return null;

  let total = 0;
  const weighted = candidates.map(card => {
    const rank = tcgCardRank(card.id);
    const rarityWeight = Math.pow(0.62, Math.max(0, rank - 1));
    const categoryWeight = card.category === "monster" ? 1.08 : card.category === "trap" ? 0.86 : 0.96;
    const weight = Math.max(0.05, rarityWeight * categoryWeight);
    total += weight;
    return { card, weight };
  });

  let roll = Math.random() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) return entry.card;
  }

  return weighted[weighted.length - 1]?.card || null;
}

function makeTcgNpcDeck() {
  const cards = tcgNpcEligibleCards();
  const byCategory = {
    monster: cards.filter(card => card.category === "monster"),
    magic: cards.filter(card => card.category === "magic"),
    trap: cards.filter(card => card.category === "trap")
  };

  const counts = {};
  const deckIds = [];
  const targetSize = 26 + Math.floor(Math.random() * 11);

  const addFromCategory = category => {
    const card = tcgNpcPickWeightedCard(byCategory[category] || cards, counts);
    if (!card) return false;
    counts[card.id] = (counts[card.id] || 0) + 1;
    deckIds.push(card.id);
    return true;
  };

  for (let i = 0; i < 12 && deckIds.length < targetSize; i++) addFromCategory("monster");
  for (let i = 0; i < 7 && deckIds.length < targetSize; i++) addFromCategory("magic");
  for (let i = 0; i < 6 && deckIds.length < targetSize; i++) addFromCategory("trap");

  while (deckIds.length < Math.max(TCG_DUEL_MIN_DECK_SIZE, targetSize) && deckIds.length < TCG_DUEL_MAX_DECK_SIZE) {
    const roll = Math.random();
    addFromCategory(roll < 0.52 ? "monster" : roll < 0.78 ? "magic" : "trap");
  }

  return shuffleTcgDeck(deckIds).slice(0, TCG_DUEL_MAX_DECK_SIZE);
}

function tcgNpcVisibleEnemyCellSet(duel, socketId) {
  const state = duel?.players?.[socketId];
  const opponent = duel?.players?.[getTcgOpponentSocketId(duel, socketId)];
  if (!state || !opponent) return new Set();

  tcgNormalizeCreatureBoardState(state);
  tcgNormalizeCreatureBoardState(opponent);

  const vision = tcgBuildPublicVision(state, opponent);
  return new Set((vision.visibleEnemyCreatureCells || []).filter(index =>
    index >= 0 &&
    index < TCG_DUEL_BOARD_CELLS &&
    opponent.creatureSlots[index]
  ));
}

function tcgNpcVisibleEnemyTargets(duel, socketId) {
  const opponent = duel?.players?.[getTcgOpponentSocketId(duel, socketId)];
  const visibleCells = tcgNpcVisibleEnemyCellSet(duel, socketId);
  if (!opponent) return [];

  return [...visibleCells].map(index => {
    const slot = opponent.creatureSlots[index];
    const hidden = !!slot?.faceDown;
    const lane = tcgBoardCellLane(index);
    const row = tcgBoardCellRow(index);
    const attack = hidden ? 700 : Math.max(0, Number(slot.attack || 0));
    const health = hidden ? 900 : Math.max(0, Number(slot.health || slot.maxHealth || 0));

    return {
      slot,
      index,
      lane,
      row,
      hidden,
      attack,
      health,
      score: attack + health * 0.45 + row * 180,
      threatScore: attack + row * 420 + (row >= TCG_DUEL_BOARD_ROWS - 1 ? 700 : 0)
    };
  }).sort((a, b) => b.threatScore - a.threatScore);
}

function tcgNpcPickTargetCreatureSlot(state, mode = "strongest", allowedCells = null) {
  const allowed = allowedCells ? new Set(allowedCells) : null;
  let bestIndex = -1;
  let bestScore = mode === "weakest" ? Infinity : -Infinity;

  tcgNormalizeCreatureBoardState(state).forEach((slot, index) => {
    if (!slot || (allowed && !allowed.has(index))) return;

    const hidden = !!slot.faceDown;
    const score = hidden ? 1100 : (slot.attack || 0) + (slot.health || slot.maxHealth || 0) * 0.45;

    if (mode === "weakest") {
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    } else if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function tcgNpcPreferredLanesFromTargets(targets = []) {
  const lanes = [];
  targets.forEach(target => {
    lanes.push(target.lane, target.lane - 1, target.lane + 1);
  });
  lanes.push(2, 1, 3, 0, 4);
  return [...new Set(lanes)].filter(lane => lane >= 0 && lane < TCG_DUEL_BOARD_LANES);
}

function tcgNpcChooseSummon(duel, socketId) {
  const state = duel.players[socketId];
  const visibleTargets = tcgNpcVisibleEnemyTargets(duel, socketId);
  const preferredOpenLanes = tcgNpcPreferredLanesFromTargets(visibleTargets);
  let best = null;

  tcgNormalizeCreatureBoardState(state);

  state.hand.forEach((cardId, handIndex) => {
    if (tcgCardCategory(cardId) !== "monster") return;

    const cost = tcgCreatureSacrificeCost(cardId);
    const availableSacrifices = state.creatureSlots
      .map((slot, index) => slot ? { slot, index, score: (slot.attack || 0) + (slot.health || 0) * 0.35 + tcgBoardCellRow(index) * 120 } : null)
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);

    const openSlots = preferredOpenLanes.filter(index => !state.creatureSlots[index]);
    const sacrificeSlots = availableSacrifices.slice(0, cost).map(entry => entry.index);
    const backrowSacrificeSlots = sacrificeSlots.filter(index => index >= 0 && index < TCG_DUEL_BOARD_LANES);

    if (cost > availableSacrifices.length) return;
    if (!openSlots.length && (!cost || !backrowSacrificeSlots.length)) return;

    const stats = tcgCardStats(cardId);
    const boardProfile = tcgCreatureBoardProfile(cardId);
    const sacrificePenalty = availableSacrifices.slice(0, cost).reduce((sum, entry) => sum + entry.score, 0);
    const slotCandidates = openSlots.length ? openSlots : backrowSacrificeSlots;

    slotCandidates.forEach(slotIndex => {
      const centerBonus = 180 - Math.abs(slotIndex - 2) * 38;
      const visibleLaneBonus = visibleTargets.some(target => Math.abs(target.lane - slotIndex) <= 1) ? 180 : 0;
      const scoutingBonus = (boardProfile.sightRange || 2) * 110;
      const rangeBonus = (boardProfile.attackRange || 1) * 95 + (boardProfile.moveRange || 1) * 65;
      const lowLpGuardBonus = state.lifePoints < 1900 ? stats.health * 0.22 : 0;
      const score = stats.attack + stats.health * 0.58 + centerBonus + visibleLaneBonus + scoutingBonus + rangeBonus + lowLpGuardBonus - sacrificePenalty * 0.55;

      if (!best || score > best.score) {
        best = {
          handIndex,
          slotIndex,
          score,
          sacrificeSlots
        };
      }
    });
  });

  return best;
}

function tcgNpcScoreSpellPlan(duel, socketId, slotIndex, cardId, category, visibleTargets) {
  const state = duel.players[socketId];
  const opponent = duel.players[getTcgOpponentSocketId(duel, socketId)];
  const template = tcgSpellEffectTemplate(cardId, category);
  const visibleCells = new Set(visibleTargets.map(target => target.index));
  const rank = tcgCardRank(cardId);

  if (template.effectKind === "heal") {
    return state.lifePoints < 3300
      ? { slotIndex, targetSlotIndex: -1, score: (TCG_DUEL_LIFE_POINTS - state.lifePoints) * 0.45 + rank * 130 }
      : null;
  }

  if (template.effectKind === "draw") {
    return { slotIndex, targetSlotIndex: -1, score: 260 + rank * 120 };
  }

  const targetOptions = template.requiresTarget
    ? visibleTargets.map(target => target.index)
    : tcgNpcPreferredLanesFromTargets(visibleTargets);

  let best = null;

  targetOptions.forEach(targetSlotIndex => {
    const anchor = tcgSpellAnchorFromTarget(targetSlotIndex, opponent, slotIndex);
    const paths = tcgBuildSpellProjectilePaths(template, anchor.lane);
    const hitCells = new Set();
    let score = rank * 90 + template.damage * 0.08;
    let visibleHitCount = 0;
    let lpPressure = 0;

    paths.forEach(path => {
      let pathHit = false;

      for (const step of path) {
        if (step.kind === "creature") {
          if (!visibleCells.has(step.cellIndex) || hitCells.has(step.cellIndex)) continue;

          const target = opponent.creatureSlots[step.cellIndex];
          if (!target) continue;

          const health = target.faceDown ? 900 : Math.max(1, Number(target.health || target.maxHealth || 1));
          const attack = target.faceDown ? 700 : Math.max(0, Number(target.attack || 0));
          const destroys = template.damage >= health;

          score += 520 + attack * 0.42 + health * 0.18 + (destroys ? 920 : 0) + tcgBoardCellRow(step.cellIndex) * 180;
          visibleHitCount++;
          hitCells.add(step.cellIndex);
          pathHit = true;

          if (template.stopsOnHit) break;
        } else if (step.kind === "base" && template.canHitLp && !pathHit) {
          lpPressure += Math.round(template.damage * template.lpScale);
          score += Math.round(template.damage * template.lpScale * 0.45);
          pathHit = true;
        }
      }
    });

    if (!visibleHitCount && !lpPressure) {
      score += visibleTargets.length ? -260 : 90 - Math.abs(anchor.lane - 2) * 18;
    }

    if (!best || score > best.score) {
      best = { slotIndex, targetSlotIndex, score, visibleHitCount, lpPressure };
    }
  });

  if (!best || best.score < 120) return null;
  return best;
}

function tcgNpcTryActivateMagic(duel, socketId) {
  const state = duel.players[socketId];
  let best = null;
  const visibleTargets = tcgNpcVisibleEnemyTargets(duel, socketId);

  for (let slotIndex = 0; slotIndex < state.spellTrapSlots.length; slotIndex++) {
    const slot = state.spellTrapSlots[slotIndex];
    if (!slot || slot.category !== "magic") continue;

    const plan = tcgNpcScoreSpellPlan(
      duel,
      socketId,
      slotIndex,
      slot.cardId,
      "magic",
      visibleTargets
    );

    if (plan && (!best || plan.score > best.score)) best = plan;
  }

  if (!best) return { ok: false };
  return tcgActivateSpellTrap(duel, socketId, best.slotIndex, best.targetSlotIndex);
}

function tcgNpcTrySetBackrow(duel, socketId) {
  const state = duel.players[socketId];
  const opponent = duel.players[getTcgOpponentSocketId(duel, socketId)];
  const visibleTargets = tcgNpcVisibleEnemyTargets(duel, socketId);
  const preferredLanes = tcgNpcPreferredLanesFromTargets(visibleTargets);
  const openMagicSlots = state.spellTrapSlots
    .map((slot, index) => !slot ? index : -1)
    .filter(index => index >= 0);

  const fieldTraps = tcgNormalizeFieldTrapState(state);
  const legalTrapCells = [...tcgTrapPlacementCellSet(state)].filter(cellIndex =>
    !fieldTraps[cellIndex] &&
    !state.creatureSlots[cellIndex] &&
    !opponent.creatureSlots[tcgMirrorBoardCellIndex(cellIndex)]
  );

  const existingTrapCount = fieldTraps.filter(Boolean).length;
  const trapCardsInHand = state.hand.filter(cardId => tcgCardCategory(cardId) === "trap").length;
  let best = null;

  state.hand.forEach((cardId, handIndex) => {
    const category = tcgCardCategory(cardId);
    const rank = tcgCardRank(cardId);

    if (category === "magic" && openMagicSlots.length) {
      const lane = preferredLanes.find(candidate => openMagicSlots.includes(candidate)) ?? openMagicSlots[0];
      const template = tcgSpellEffectTemplate(cardId, "magic");
      const score =
        280 +
        rank * 105 +
        (template.effectKind === "heal" ? Math.max(0, TCG_DUEL_LIFE_POINTS - state.lifePoints) * 0.2 : 0) +
        (template.effectKind === "aoe" ? visibleTargets.length * 220 : 0);

      if (!best || score > best.score) {
        best = { handIndex, slotIndex: lane, score };
      }

      return;
    }

    if (category !== "trap" || !legalTrapCells.length || existingTrapCount >= 4) return;

    const shouldReserveLastTrap =
      trapCardsInHand <= 1 &&
      existingTrapCount >= 1 &&
      state.lifePoints > 1800 &&
      !visibleTargets.length;

    if (shouldReserveLastTrap) return;

    const profile = tcgFieldTrapProfile(cardId);

    legalTrapCells.forEach(cellIndex => {
      const lane = tcgBoardCellLane(cellIndex);
      const row = tcgBoardCellRow(cellIndex);
      let score = 300 + rank * 120;

      visibleTargets.forEach(target => {
        const targetOnNpcBoard = tcgMirrorBoardCellIndex(target.index);
        const distance = Math.max(
          Math.abs(lane - tcgBoardCellLane(targetOnNpcBoard)),
          Math.abs(row - tcgBoardCellRow(targetOnNpcBoard))
        );

        score += Math.max(0, 900 - distance * 210);
        if (profile.kind === "snare" || profile.kind === "push") score += target.threatScore * 0.14;
        if (profile.kind === "blast" && target.health <= profile.damage) score += 1000;
      });

      if (state.lifePoints < 1900) score += (TCG_DUEL_BOARD_ROWS - row) * 90;
      if (row <= 1) score += state.lifePoints < 2200 ? 450 : 100;
      score -= existingTrapCount * 170;

      if (!best || score > best.score) {
        best = { handIndex, slotIndex: cellIndex, score };
      }
    });
  });

  if (!best) return { ok: false };
  return tcgSetSpellTrap(duel, socketId, best.handIndex, best.slotIndex);
}

function tcgNpcFindAttackPlan(duel, socketId) {
  const state = duel.players[socketId];
  const opponent = duel.players[getTcgOpponentSocketId(duel, socketId)];
  const visibleTargets = tcgNpcVisibleEnemyTargets(duel, socketId);
  let best = null;

  tcgNormalizeCreatureBoardState(state);
  tcgNormalizeCreatureBoardState(opponent);

  state.creatureSlots.forEach((attacker, attackerIndex) => {
    if (!attacker || attacker.hasAttacked) return;

    tcgRefreshCreatureBoardProfile(attacker);
    attacker.lane = tcgBoardCellLane(attackerIndex);
    attacker.row = tcgBoardCellRow(attackerIndex);

    visibleTargets.forEach(target => {
      const defender = target.slot;
      const targetIndex = target.index;

      if (!tcgCanCreatureAttackTarget(attacker, attackerIndex, defender, targetIndex)) return;

      const metrics = tcgCreatureBoardMetrics(attacker, attackerIndex, defender, targetIndex);
      const targetHealth = target.hidden ? 900 : Math.max(1, Number(defender.health || defender.maxHealth || 1));
      const canKill = (attacker.attack || 0) >= targetHealth;
      const score =
        (canKill ? 2400 : 0) +
        target.attack +
        target.health * 0.38 +
        target.row * 260 -
        metrics.distance * 95;

      if (!best || score > best.score) {
        best = {
          type: "creature",
          attackerIndex,
          targetIndex,
          attackDirection: tcgAttackDirectionFromSlots(attackerIndex, targetIndex),
          score
        };
      }
    });

    const attackerLane = tcgBoardCellLane(attackerIndex);
    const directLaneCandidates = [...new Set([attackerLane, attackerLane - 1, attackerLane + 1])]
      .filter(lane => lane >= 0 && lane < TCG_DUEL_BOARD_LANES);

    directLaneCandidates.forEach(directLane => {
      if (!tcgCanCreatureAttackDirect(attacker, attackerIndex, opponent, directLane)) return;

      const score =
        (attacker.attack || 0) +
        tcgBoardCellRow(attackerIndex) * 520 -
        Math.abs(directLane - attackerLane) * 100 +
        (opponent.lifePoints <= (attacker.attack || 0) ? 2200 : 0);

      if (!best || score > best.score) {
        best = {
          type: "direct",
          attackerIndex,
          targetIndex: -1,
          directLaneIndex: directLane,
          attackDirection: tcgAttackDirectionFromSlots(attackerIndex, directLane),
          score
        };
      }
    });
  });

  return best;
}

function tcgNpcMoveCandidates(slot, fromCellIndex) {
  const moves = [];
  const profile = tcgCreatureBoardProfile(slot.cardId);
  const originLane = tcgBoardCellLane(fromCellIndex);
  const originRow = tcgBoardCellRow(fromCellIndex);
  const range = Math.max(1, Math.floor(Number(slot.moveRange || profile.moveRange || 1)));

  for (let laneDelta = -range; laneDelta <= range; laneDelta++) {
    for (let rowDelta = -range; rowDelta <= range; rowDelta++) {
      if (!tcgMovementPatternAllows(profile, laneDelta, rowDelta)) continue;

      const distance = tcgMovementDistance(profile, laneDelta, rowDelta);
      if (distance < 1 || distance > range) continue;

      const targetLane = originLane + laneDelta;
      const targetRow = originRow + rowDelta;

      if (targetLane < 0 || targetLane >= TCG_DUEL_BOARD_LANES) continue;
      if (targetRow < 0 || targetRow >= TCG_DUEL_BOARD_ROWS) continue;

      moves.push({
        lane: targetLane,
        row: targetRow,
        cellIndex: tcgBoardCellIndex(targetLane, targetRow),
        distance
      });
    }
  }

  return moves;
}

function tcgNpcTryMoveCreature(duel, socketId) {
  const state = duel.players[socketId];
  const opponent = duel.players[getTcgOpponentSocketId(duel, socketId)];
  const slots = tcgNormalizeCreatureBoardState(state);
  const visibleTargets = tcgNpcVisibleEnemyTargets(duel, socketId);
  const threatenedLanes = visibleTargets
    .filter(target => target.row >= TCG_DUEL_BOARD_ROWS - 1)
    .map(target => target.lane);

  let bestMove = null;

  slots.forEach((slot, fromCellIndex) => {
    if (!slot || slot.moveUsed || slot.summonedTurn >= duel.turnNumber) return;

    tcgRefreshCreatureBoardProfile(slot);
    const currentLane = tcgBoardCellLane(fromCellIndex);
    const currentRow = tcgBoardCellRow(fromCellIndex);
    slot.lane = currentLane;
    slot.row = currentRow;

    tcgNpcMoveCandidates(slot, fromCellIndex).forEach(move => {
      if (slots[move.cellIndex]) return;

      const fake = { ...slot, lane: move.lane, row: move.row };
      let score =
        move.row * 320 -
        Math.abs(move.lane - 2) * 32 -
        move.distance * 22 +
        (move.row > currentRow ? 280 : -80);

      if (state.lifePoints < 2100 && move.row === TCG_DUEL_BOARD_ROWS - 1) score += 260;
      if (threatenedLanes.some(lane => Math.abs(lane - move.lane) <= 1) && move.row === TCG_DUEL_BOARD_ROWS - 1) score += 850;

      if (!visibleTargets.length) {
        score += 260 + move.row * 260 + (slot.sightRange || 2) * 95;
      }

      visibleTargets.forEach(target => {
        if (tcgCanCreatureAttackTarget(fake, move.cellIndex, target.slot, target.index)) {
          const canKill = (slot.attack || 0) >= Math.max(1, target.health || 1);
          score += 1600 + (canKill ? 1000 : 0) + target.attack * 0.48 + target.row * 180;
        } else {
          const metrics = tcgCreatureBoardMetrics(fake, move.cellIndex, target.slot, target.index);
          score -= metrics.distance * 80;
        }
      });

      if (tcgCanCreatureAttackDirect(fake, move.cellIndex, opponent, move.lane)) {
        score += 1700 + (slot.attack || 0) * 0.22 + (opponent.lifePoints <= (slot.attack || 0) ? 1600 : 0);
      }

      if (!bestMove || score > bestMove.score) {
        bestMove = {
          fromCell: fromCellIndex,
          toCell: move.cellIndex,
          row: move.row,
          score
        };
      }
    });
  });

  if (!bestMove || bestMove.score < 140) return false;

  const result = tcgMoveCreature(duel, socketId, bestMove.fromCell, bestMove.toCell, bestMove.row);
  return !!result.ok;
}

function tcgNpcEndTurnReliably(duel, socketId) {
  if (!duel || duel.status !== "active" || duel.activeSocketId !== socketId) return;

  if (duel.phase !== "end") {
    const phaseResult = tcgSetPhase(duel, socketId, "end");
    if (!phaseResult.ok && duel.status === "active" && duel.activeSocketId === socketId) {
      duel.phase = "end";
      tcgPushLog(duel, `${duel.players[socketId]?.name || "Opponent"} prepared to end their turn.`);
      emitTcgDuelUpdate(duel);
    }
    return;
  }

  const endResult = tcgEndTurn(duel, socketId);
  if (!endResult.ok) emitTcgDuelUpdate(duel);
}

function tcgNpcRunMainPhase(duel, socketId) {
  const state = duel.players[socketId];
  const opponent = duel.players[getTcgOpponentSocketId(duel, socketId)];

  if (!state || !opponent) {
    tcgNpcEndTurnReliably(duel, socketId);
    return;
  }

  if (duel.status !== "active" || duel.activeSocketId !== socketId || duel.phase !== "main") return;

  const hasCreature = tcgNormalizeCreatureBoardState(state).some(Boolean);

  if (!hasCreature && !state.normalSummonUsed) {
    const summon = tcgNpcChooseSummon(duel, socketId);
    if (summon) {
      const result = tcgSummonCreature(duel, socketId, summon.handIndex, summon.slotIndex, summon.sacrificeSlots);
      if (result.ok || duel.status === "finished") return;
    }
  }

  const magicResult = tcgNpcTryActivateMagic(duel, socketId);
  if (magicResult.ok || duel.status === "finished") return;

  if (!state.normalSummonUsed) {
    const summon = tcgNpcChooseSummon(duel, socketId);
    if (summon) {
      const result = tcgSummonCreature(duel, socketId, summon.handIndex, summon.slotIndex, summon.sacrificeSlots);
      if (result.ok || duel.status === "finished") return;
    }
  }

  if (tcgNpcTryMoveCreature(duel, socketId) || duel.status === "finished") return;

  const setResult = tcgNpcTrySetBackrow(duel, socketId);
  if (setResult.ok || duel.status === "finished") return;

  const canAttack =
    duel.status === "active" &&
    duel.turnNumber !== 1 &&
    duel.firstTurnSocketId !== socketId &&
    !!tcgNpcFindAttackPlan(duel, socketId);

  if (canAttack) {
    const result = tcgSetPhase(duel, socketId, "attack");
    if (!result.ok) tcgNpcEndTurnReliably(duel, socketId);
    return;
  }

  tcgPushLog(duel, `${state.name} scouted the field and passed.`);
  tcgNpcEndTurnReliably(duel, socketId);
}

function tcgNpcRunBattlePhase(duel, socketId) {
  if (duel.status !== "active" || duel.activeSocketId !== socketId) return;

  const plan = tcgNpcFindAttackPlan(duel, socketId);

  if (plan) {
    const result = tcgAttackWithCreature(
      duel,
      socketId,
      plan.attackerIndex,
      plan.targetIndex,
      plan.attackDirection || "forward",
      plan.directLaneIndex ?? plan.attackerIndex
    );

    if (result.ok || duel.status === "finished") return;

    tcgPushLog(duel, `${duel.players[socketId].name} found no legal attack path through the fog.`);
  } else {
    tcgPushLog(duel, `${duel.players[socketId].name} held position and ended battle.`);
  }

  tcgNpcEndTurnReliably(duel, socketId);
}

function tcgRunNpcAction(duel, socketId) {
  if (!duel || duel.status === "finished" || !tcgIsNpcSocketId(socketId)) return;

  if (duel.status === "rps") {
    if (duel.rps?.revealing) return;

    if (!duel.rps.picks[socketId]) {
      duel.rps.picks[socketId] = tcgRandomRpsChoice();
      tcgSetRpsWaitingStatus(duel);
      const resolved = resolveTcgRpsRound(duel);
      if (!resolved && duel.status === "rps") emitTcgDuelUpdate(duel);
    }
    return;
  }

  if (duel.status === "turn_choice" && duel.chooserSocketId === socketId) {
    const opponentSocketId = getTcgOpponentSocketId(duel, socketId);
    const firstSocketId = Math.random() < 0.48 ? socketId : opponentSocketId;
    startTcgDuelTurns(duel, firstSocketId);
    return;
  }

  if (duel.status !== "active" || duel.activeSocketId !== socketId) return;

  if (duel.phase === "draw") {
    tcgDrawForTurn(duel, socketId);
  } else if (duel.phase === "standby") {
    tcgAdvanceStandbyToMain(duel, socketId);
  } else if (duel.phase === "main") {
    tcgNpcRunMainPhase(duel, socketId);
  } else if (duel.phase === "attack" || duel.phase === "battle") {
    tcgNpcRunBattlePhase(duel, socketId);
  } else if (duel.phase === "end") {
    tcgEndTurn(duel, socketId);
  }
}

function tcgGetNpcActionSocketId(duel) {
  if (!duel || duel.status === "finished" || !duel.players) return null;

  if (duel.status === "rps") {
    return Object.keys(duel.players).find(socketId =>
      tcgIsNpcSocketId(socketId) && !duel.rps?.picks?.[socketId]
    ) || null;
  }

  if (duel.status === "turn_choice" && tcgIsNpcSocketId(duel.chooserSocketId)) {
    return duel.chooserSocketId;
  }

  if (duel.status === "active" && tcgIsNpcSocketId(duel.activeSocketId)) {
    return duel.activeSocketId;
  }

  return null;
}

function tcgNpcDelay(minMs, maxMs) {
  return Math.round(minMs + Math.random() * Math.max(0, maxMs - minMs));
}

function tcgNpcActionDelay(duel, npcSocketId) {
  if (!duel || !npcSocketId) return tcgNpcDelay(1200, 2200);

  if (duel.status === "rps") return tcgNpcDelay(900, 1800);
  if (duel.status === "turn_choice") return tcgNpcDelay(1200, 2600);

  if (duel.status !== "active") return tcgNpcDelay(1200, 2200);

  const turnKey = `${npcSocketId}:${duel.turnNumber || 0}`;

  if (duel.phase === "draw") return tcgNpcDelay(3000, 6000);
  if (duel.phase === "standby") return tcgNpcDelay(1200, 2400);

  if (duel.phase === "main") {
    if (duel.npcMainThinkTurnKey !== turnKey) {
      duel.npcMainThinkTurnKey = turnKey;
      return tcgNpcDelay(4000, 10000);
    }

    return tcgNpcDelay(2200, 3600);
  }

  if (duel.phase === "attack" || duel.phase === "battle") {
    if (duel.npcBattleThinkTurnKey !== turnKey) {
      duel.npcBattleThinkTurnKey = turnKey;
      return tcgNpcDelay(2200, 5200);
    }

    return tcgNpcDelay(1500, 2800);
  }

  if (duel.phase === "end") return tcgNpcDelay(2000, 4000);

  return tcgNpcDelay(1400, 2600);
}

function tcgMaybeScheduleNpcAction(duel, force = false) {
  if (!duel || duel.status === "finished") return;

  const npcSocketId = tcgGetNpcActionSocketId(duel);

  if (!npcSocketId) {
    if (duel.npcActionTimer) clearTimeout(duel.npcActionTimer);
    duel.npcActionTimer = null;
    duel.npcActionPending = false;
    duel.npcActionPendingAt = 0;
    duel.npcActionSocketId = null;
    return;
  }

  const now = Date.now();
  const samePendingNpc = duel.npcActionPending && duel.npcActionSocketId === npcSocketId;
  if (!force && samePendingNpc && now - Number(duel.npcActionPendingAt || 0) < 2500) return;

  if (duel.npcActionTimer) clearTimeout(duel.npcActionTimer);

  duel.npcActionPending = true;
  duel.npcActionPendingAt = now;
  duel.npcActionSocketId = npcSocketId;

  const delay = tcgNpcActionDelay(duel, npcSocketId);

  duel.npcActionTimer = setTimeout(() => {
    const liveDuel = tcgDuels.get(duel.duelId);
    if (!liveDuel || liveDuel.status === "finished") return;

    liveDuel.npcActionTimer = null;
    liveDuel.npcActionPending = false;
    liveDuel.npcActionPendingAt = 0;

    const liveNpcSocketId = tcgGetNpcActionSocketId(liveDuel);
    if (!liveNpcSocketId) {
      liveDuel.npcActionSocketId = null;
      return;
    }

    try {
      tcgRunNpcAction(liveDuel, liveNpcSocketId);
    } catch (error) {
      console.error("[tcg] NPC action failed:", error);

      if (liveDuel.status === "turn_choice" && liveDuel.chooserSocketId === liveNpcSocketId) {
        const opponentSocketId = getTcgOpponentSocketId(liveDuel, liveNpcSocketId);
        startTcgDuelTurns(liveDuel, opponentSocketId || liveNpcSocketId);
      } else if (liveDuel.status === "active" && liveDuel.activeSocketId === liveNpcSocketId) {
        liveDuel.phase = "end";
        try {
          tcgEndTurn(liveDuel, liveNpcSocketId);
        } catch (endError) {
          console.error("[tcg] NPC emergency end turn failed:", endError);
          emitTcgDuelUpdate(liveDuel);
        }
      }
    }

    setTimeout(() => {
      const refreshed = tcgDuels.get(duel.duelId);
      if (!refreshed || refreshed.status === "finished") return;
      if (tcgGetNpcActionSocketId(refreshed)) tcgMaybeScheduleNpcAction(refreshed, true);
    }, 180);
  }, delay);
}

function tcgRollRewardPack(entry, packId) {
  const pack = ACCOUNT_PACK_CATALOG[packId];
  const cards = [];

  if (!pack || !ACCOUNT_CARD_CATALOG.size) return cards;

  for (let index = 0; index < 3; index++) {
    const card = accountRollPackCard(pack);
    if (!card) continue;
    accountAddCard(entry, card.id, 1);
    cards.push(card.id);
  }

  return cards;
}

function tcgGrantDuelReward(socketId, reward) {
  const p = getPlayer(socketId);

  if (!p?.playerId) {
    return { ...reward, packCards: [], account: null, profile: null };
  }

  const entry = getOrCreateLeaderboardEntry({
    playerId: p.playerId,
    name: p.name,
    color: p.color,
    icon: p.icon
  });

  accountGrantReward(entry, {
    gold: reward.gold,
    gems: reward.gems
  });

  const packCards = tcgRollRewardPack(entry, reward.packId);

  accountSyncPlayerCurrency(entry, p);

  const account = accountSnapshot(entry);
  const profile = privatePlayerProfile(p);

  io.to(socketId).emit("accountSync", account);
  io.to(socketId).emit("profileAssigned", profile);

  return {
    ...reward,
    packCards,
    account,
    profile
  };
}

function endTcgDuel(duel, winnerSocketId, reason = "complete") {
  if (!duel || duel.status === "finished") return;

  const loserSocketId = getTcgOpponentSocketId(duel, winnerSocketId);
  const isConcession = reason === "forfeit" || reason === "disconnect";

  duel.status = "finished";
  duel.winnerSocketId = winnerSocketId;
  duel.loserSocketId = loserSocketId;
  duel.endReason = reason;
  duel.rewards = isConcession
    ? {
        [winnerSocketId]: { result: "win", gold: 750, gems: 15, packTier: "standard", packId: TCG_REWARD_PACKS.loss },
        [loserSocketId]: { result: "loss", gold: 0, gems: 0, packTier: "none", packId: null }
      }
    : {
        [winnerSocketId]: { result: "win", gold: 1500, gems: 25, packTier: "premium", packId: TCG_REWARD_PACKS.win },
        [loserSocketId]: { result: "loss", gold: 750, gems: 15, packTier: "standard", packId: TCG_REWARD_PACKS.loss }
      };
  duel.rewardResults = {};

  for (const [socketId, reward] of Object.entries(duel.rewards)) {
    duel.rewardResults[socketId] = tcgGrantDuelReward(socketId, reward);
  }

  void rankedCommitStateNow();

  for (const socketId of Object.keys(duel.players)) {
    const p = getPlayer(socketId);
    if (p && p.tcgDuelId === duel.duelId) p.tcgDuelId = null;
    io.to(socketId).emit("tcgDuelEnded", publicTcgDuelState(duel, socketId));
  }

  const spectatorIds = Array.isArray(duel.spectators) ? duel.spectators : [];
  for (const socketId of spectatorIds) {
    if (!duel.players[socketId]) {
      io.to(socketId).emit("tcgDuelEnded", publicTcgDuelState(duel, socketId));
    }
  }

  const lobby = duel.lobbyCode ? tcgLobbies.get(duel.lobbyCode) : null;
  if (lobby && lobby.activeDuelId === duel.duelId) {
    lobby.activeDuelId = null;
    emitTcgLobbyUpdate(lobby);
  }

  broadcastOnlineList();

  setTimeout(() => {
    tcgDuels.delete(duel.duelId);
  }, 60000);
}

function forfeitTcgDuel(duel, loserSocketId, reason = "forfeit") {
  const winnerSocketId = getTcgOpponentSocketId(duel, loserSocketId);
  if (!winnerSocketId) return;
  endTcgDuel(duel, winnerSocketId, reason);
}

function tcgPushLog(duel, message, meta = null) {
  duel.actionLog = Array.isArray(duel.actionLog) ? duel.actionLog : [];
  const entry = {
    at: Date.now(),
    message: String(message || "")
  };
  if (meta && typeof meta === "object") entry.meta = meta;
  duel.actionLog.unshift(entry);
  duel.actionLog = duel.actionLog.slice(0, 8);
}

function tcgCheckLifeAndDeckLoss(duel) {
  for (const [socketId, state] of Object.entries(duel.players)) {
    if (state.lifePoints <= 0) {
      forfeitTcgDuel(duel, socketId, "life_points_zero");
      return true;
    }
  }

  return false;
}

function tcgStartTurn(duel, socketId) {
  const state = duel.players[socketId];

  duel.status = "active";
  duel.phase = "draw";
  duel.activeSocketId = socketId;
  duel.drawPendingSocketId = socketId;
  duel.standbyDeadlineAt = 0;
  duel.turnNumber += 1;

  state.normalSummonUsed = false;
  state.spellMoveUsed = false;
  state.directBlockedThisTurn = false;
  tcgNormalizeCreatureBoardState(state).forEach((slot, index) => {
    if (slot) {
      slot.hasAttacked = false;
      slot.attacksThisTurn = 0;
      slot.moveUsed = false;
      slot.lane = tcgBoardCellLane(index);
      slot.row = tcgBoardCellRow(index);
      tcgRefreshCreatureBoardProfile(slot);
    }
  });

  tcgPushLog(duel, `${state.name} starts turn ${duel.turnNumber}. Draw Phase.`);
  emitTcgDuelUpdate(duel);
  return true;
}

function tcgHasStandbyResponse(duel, activeSocketId) {
  return Object.entries(duel.players).some(([socketId, state]) =>
    state.spellTrapSlots.some(slot =>
      slot &&
      slot.category === "trap" &&
      slot.setTurn < duel.turnNumber &&
      socketId !== activeSocketId
    )
  );
}

function tcgAdvanceStandbyToMain(duel, socketId) {
  if (!duel || duel.status !== "active" || duel.activeSocketId !== socketId) return;
  if (duel.phase !== "standby") return;
  duel.phase = "main";
  duel.standbyDeadlineAt = 0;
  tcgPushLog(duel, `${duel.players[socketId].name} enters Main Phase.`);
  emitTcgDuelUpdate(duel);
}

function tcgDrawForTurn(duel, socketId) {
  const turn = tcgRequireActiveTurn(duel, socketId);
  if (!turn.ok) return turn;
  if (duel.phase !== "draw" || duel.drawPendingSocketId !== socketId) return { ok: false, error: "Draw Phase is not pending." };

  const state = duel.players[socketId];
  const opponentSocketId = getTcgOpponentSocketId(duel, socketId);
  const drawnCardId = state.deck[0] || null;
  const draw = drawTcgCards(state, 1);

  if (draw.deckedOut) {
    endTcgDuel(duel, opponentSocketId, "deck_out");
    return { ok: true };
  }

  duel.drawPendingSocketId = null;
  duel.standbyDeadlineAt = 0;
  duel.phase = "main";
  tcgPushLog(duel, `${state.name} draws a card and enters Main Phase.`);
  emitTcgDuelUpdate(duel);
  return { ok: true, cardId: drawnCardId, phase: duel.phase };
}

function startTcgDuelTurns(duel, firstSocketId) {
  duel.status = "active";
  duel.phase = "main";
  duel.turnNumber = 0;
  duel.firstTurnSocketId = firstSocketId;
  tcgStartTurn(duel, firstSocketId);
}

function tcgRequireActiveTurn(duel, socketId) {
  if (!duel || duel.status !== "active") return { ok: false, error: "Duel is not active." };
  if (duel.activeSocketId !== socketId) return { ok: false, error: "It is not your turn." };
  return { ok: true };
}

function tcgRemoveHandCard(playerState, handIndex) {
  const index = Math.max(0, Math.floor(Number(handIndex)));
  if (index < 0 || index >= playerState.hand.length) return null;
  return playerState.hand.splice(index, 1)[0] || null;
}

function tcgSummonCreature(duel, socketId, handIndex, slotIndex = -1, sacrificeSlots = [], options = {}) {
  const turn = tcgRequireActiveTurn(duel, socketId);
  if (!turn.ok) return turn;
  if (duel.phase !== "main") return { ok: false, error: "Summon during Main Phase." };

  const state = duel.players[socketId];
  if (state.normalSummonUsed) return { ok: false, error: "You already summoned this turn." };

  const cardId = state.hand[Math.max(0, Math.floor(Number(handIndex)))];
  if (!cardId || tcgCardCategory(cardId) !== "monster") return { ok: false, error: "That is not a creature card." };

  const summonOptions = options && typeof options === "object" ? options : {};
  const faceDown = !!summonOptions.faceDown;
  const position = faceDown || summonOptions.position === "defense" ? "defense" : "attack";
  tcgNormalizeCreatureBoardState(state);

  const tributeCost = tcgCreatureSacrificeCost(cardId);
  const cleanSacrifices = [...new Set((Array.isArray(sacrificeSlots) ? sacrificeSlots : []).map(index => Math.floor(Number(index))))].filter(index =>
    index >= 0 &&
    index < TCG_DUEL_BOARD_CELLS &&
    state.creatureSlots[index]
  );

  if (cleanSacrifices.length < tributeCost) {
    return { ok: false, error: `${cardId.replace(/_/g, " ")} requires ${tributeCost} sacrifice${tributeCost === 1 ? "" : "s"}.` };
  }

  let targetSlot = Math.floor(Number(slotIndex));
  const targetWillBeCleared = cleanSacrifices.includes(targetSlot);
  const openBackRowSlot = Array.from({ length: TCG_DUEL_BOARD_LANES }, (_, index) => index)
    .find(index => !state.creatureSlots[index] || cleanSacrifices.includes(index));

  if (targetSlot < 0 || targetSlot >= TCG_DUEL_BOARD_LANES || (state.creatureSlots[targetSlot] && !targetWillBeCleared)) {
    targetSlot = openBackRowSlot ?? -1;
  }

  if (targetSlot < 0) return { ok: false, error: "No open creature slot." };

  cleanSacrifices.slice(0, tributeCost).forEach(index => {
    if (state.creatureSlots[index]) {
      state.discard.push(state.creatureSlots[index].cardId);
      state.creatureSlots[index] = null;
    }
  });

  tcgRemoveHandCard(state, handIndex);

  const stats = tcgCardStats(cardId);
  const boardProfile = tcgCreatureBoardProfile(cardId);
  state.creatureSlots[targetSlot] = {
    cardId,
    attack: stats.attack,
    maxHealth: stats.health,
    health: stats.health,
    hasAttacked: true,
    attacksThisTurn: 0,
    moveUsed: true,
    summonedTurn: duel.turnNumber,
    tributeCost,
    position,
    faceDown,
    lane: targetSlot,
    row: 0,
    moveRange: boardProfile.moveRange,
    movePattern: boardProfile.movePattern,
    attackRange: boardProfile.attackRange,
    attackStyle: boardProfile.attackStyle,
    sightRange: boardProfile.sightRange
  };
  state.normalSummonUsed = true;

  tcgPushLog(duel, faceDown
    ? `${state.name} set a creature face-down in defense position.`
    : `${state.name} summoned a creature${tributeCost ? ` by sacrificing ${tributeCost}` : ""}.`,
    {
      actionType: "summon_creature",
      actorSocketId: socketId,
      cellIndex: targetSlot,
      cardId,
      faceDown,
      tributeCost
    }
  );
  emitTcgDuelUpdate(duel);
  return { ok: true };
}

function tcgSetSpellTrap(duel, socketId, handIndex, slotIndex = -1) {
  const turn = tcgRequireActiveTurn(duel, socketId);
  if (!turn.ok) return turn;
  if (duel.phase !== "main") return { ok: false, error: "Place cards during Main Phase." };

  const state = duel.players[socketId];
  const opponent = duel.players[getTcgOpponentSocketId(duel, socketId)];
  const cleanHandIndex = Math.max(0, Math.floor(Number(handIndex)));
  const cardId = state.hand[cleanHandIndex];
  const category = tcgCardCategory(cardId);

  if (!cardId || (category !== "magic" && category !== "trap")) {
    return { ok: false, error: "That card cannot be placed here." };
  }

  if (category === "magic") {
    let targetSlot = Math.floor(Number(slotIndex));

    if (targetSlot < 0 || targetSlot >= TCG_DUEL_BOARD_LANES || state.spellTrapSlots[targetSlot]) {
      targetSlot = state.spellTrapSlots.findIndex(slot => !slot);
    }

    if (targetSlot < 0) return { ok: false, error: "No open Magic slot." };

    tcgRemoveHandCard(state, cleanHandIndex);

    state.spellTrapSlots[targetSlot] = {
      cardId,
      category: "magic",
      setTurn: duel.turnNumber,
      ownerSocketId: socketId,
      faceDown: true,
      lane: targetSlot,
      pattern: tcgSpellPattern(cardId, "magic")
    };

    tcgPushLog(duel, `${state.name} set a card.`, {
      actionType: "set_spell_trap",
      actorSocketId: socketId,
      slotIndex: targetSlot,
      category: "magic"
    });

    emitTcgDuelUpdate(duel);
    return { ok: true };
  }

  tcgNormalizeCreatureBoardState(state);
  tcgNormalizeCreatureBoardState(opponent);

  const traps = tcgNormalizeFieldTrapState(state);
  const targetCell = Math.floor(Number(slotIndex));
  const visibleCells = tcgTrapPlacementCellSet(state);

  if (targetCell < 0 || targetCell >= TCG_DUEL_BOARD_CELLS) {
    return { ok: false, error: "Choose a highlighted field cell." };
  }

  if (!visibleCells.has(targetCell)) {
    return { ok: false, error: "Your creatures cannot currently see that field cell." };
  }

  if (traps[targetCell]) {
    return { ok: false, error: "You already have a Trap on that field cell." };
  }

  if (
    state.creatureSlots[targetCell] ||
    opponent.creatureSlots[tcgMirrorBoardCellIndex(targetCell)]
  ) {
    return { ok: false, error: "Traps cannot be placed under a creature." };
  }

  tcgRemoveHandCard(state, cleanHandIndex);

  traps[targetCell] = {
    cardId,
    category: "trap",
    setTurn: duel.turnNumber,
    ownerSocketId: socketId,
    faceDown: true,
    cellIndex: targetCell
  };

  tcgPushLog(duel, `${state.name} set a card on the field.`, {
    actionType: "set_spell_trap",
    actorSocketId: socketId,
    cellIndex: targetCell,
    category: "trap"
  });

  emitTcgDuelUpdate(duel);
  return { ok: true };
}

function tcgDamageCreature(ownerState, slotIndex, damage) {
  const slot = ownerState.creatureSlots[slotIndex];
  if (!slot) return false;

  slot.health -= Math.max(0, Math.round(Number(damage || 0)));

  if (slot.health <= 0) {
    ownerState.discard.push(slot.cardId);
    ownerState.creatureSlots[slotIndex] = null;
    return true;
  }

  return false;
}

function tcgFindFirstCreatureSlot(state) {
  return state.creatureSlots.findIndex(slot => !!slot);
}

function tcgMoveCreature(duel, socketId, fromSlotIndex, toSlotIndex, toRow) {
  const turn = tcgRequireActiveTurn(duel, socketId);
  if (!turn.ok) return turn;
  if (duel.phase !== "main") return { ok: false, error: "Move creatures during Main Phase." };

  const state = duel.players[socketId];
  const slots = tcgNormalizeCreatureBoardState(state);
  const fromCell = tcgResolveCreatureCellIndex(state, fromSlotIndex);
  const rawTarget = Math.floor(Number(toSlotIndex));
  const targetCell = rawTarget >= TCG_DUEL_BOARD_LANES && rawTarget < TCG_DUEL_BOARD_CELLS
    ? rawTarget
    : tcgBoardCellIndex(rawTarget, toRow);

  const slot = slots[fromCell];

  if (!slot) return { ok: false, error: "No creature in that board cell." };
  if (slot.moveUsed) return { ok: false, error: "That creature already moved this turn." };
  if (Number(slot.rootedUntilTurn || 0) >= duel.turnNumber) {
    return { ok: false, error: "That creature is trapped and cannot move yet." };
  }
  if (slot.summonedTurn >= duel.turnNumber) return { ok: false, error: "Newly summoned creatures move next turn." };
  if (targetCell < 0 || targetCell >= TCG_DUEL_BOARD_CELLS) return { ok: false, error: "That board cell is outside the field." };
  if (targetCell !== fromCell && slots[targetCell]) return { ok: false, error: "That board cell is occupied." };

  tcgRefreshCreatureBoardProfile(slot);

  const fromLane = tcgBoardCellLane(fromCell);
  const fromRow = tcgBoardCellRow(fromCell);
  const targetLane = tcgBoardCellLane(targetCell);
  const targetRow = tcgBoardCellRow(targetCell);
  const laneDelta = targetLane - fromLane;
  const rowDelta = targetRow - fromRow;
  const profile = tcgCreatureBoardProfile(slot.cardId);
  const movementDistance = tcgMovementDistance(profile, laneDelta, rowDelta);

  if (movementDistance < 1) return { ok: false, error: "Choose a new position." };
  if (!tcgMovementPatternAllows(profile, laneDelta, rowDelta)) return { ok: false, error: "That creature cannot move in that pattern." };
  if (movementDistance > (slot.moveRange || profile.moveRange || 1)) return { ok: false, error: "That creature cannot move that far." };

  const alignedPath = laneDelta === 0 || rowDelta === 0 || Math.abs(laneDelta) === Math.abs(rowDelta);
  if (alignedPath && movementDistance > 1) {
    const laneStep = Math.sign(laneDelta);
    const rowStep = Math.sign(rowDelta);
    let checkLane = fromLane + laneStep;
    let checkRow = fromRow + rowStep;

    while (checkLane !== targetLane || checkRow !== targetRow) {
      if (slots[tcgBoardCellIndex(checkLane, checkRow)]) {
        return { ok: false, error: "That movement path is blocked." };
      }

      checkLane += laneStep;
      checkRow += rowStep;
    }
  }

  const traversalCells = [];

  if (alignedPath) {
    const laneStep = Math.sign(laneDelta);
    const rowStep = Math.sign(rowDelta);
    let traversalLane = fromLane + laneStep;
    let traversalRow = fromRow + rowStep;

    while (traversalLane !== targetLane || traversalRow !== targetRow) {
      traversalCells.push(tcgBoardCellIndex(traversalLane, traversalRow));
      traversalLane += laneStep;
      traversalRow += rowStep;
    }

    traversalCells.push(targetCell);
  } else {
    traversalCells.push(targetCell);
  }

  slot.moveUsed = true;
  slot.moveRange = profile.moveRange;
  slot.movePattern = profile.movePattern;
  slot.attackRange = profile.attackRange;
  slot.attackStyle = profile.attackStyle;

  let currentCell = fromCell;
  let trapTriggered = false;
  let creatureDestroyed = false;

  for (const traversalCell of traversalCells) {
    if (!state.creatureSlots[currentCell]) {
      creatureDestroyed = true;
      break;
    }

    slots[currentCell] = null;
    slots[traversalCell] = slot;
    currentCell = traversalCell;
    slot.lane = tcgBoardCellLane(currentCell);
    slot.row = tcgBoardCellRow(currentCell);

    const trapResult = tcgResolveFieldTraps(
      duel,
      socketId,
      currentCell,
      "move"
    );

    trapTriggered = trapTriggered || trapResult.triggered;
    creatureDestroyed = creatureDestroyed || trapResult.destroyed;

    if (trapResult.destroyed) break;

    currentCell = Number.isFinite(Number(trapResult.currentCellIndex))
      ? Number(trapResult.currentCellIndex)
      : currentCell;

    const wasStopped =
      trapResult.displaced ||
      Number(slot.rootedUntilTurn || 0) >= duel.turnNumber;

    if (wasStopped) break;
  }

  tcgPushLog(duel, `${state.name} moved a creature.`, {
    actionType: "move_creature",
    actorSocketId: socketId,
    fromCellIndex: fromCell,
    toCellIndex: currentCell
  });

  emitTcgDuelUpdate(duel);
  return {
    ok: true,
    trapTriggered,
    creatureDestroyed,
    finalCellIndex: currentCell
  };
}

function tcgMoveSpellTrap(duel, socketId, fromSlotIndex, toSlotIndex) {
  const turn = tcgRequireActiveTurn(duel, socketId);
  if (!turn.ok) return turn;
  if (duel.phase !== "main") return { ok: false, error: "Reorder magic/trap cards during Main Phase." };

  const state = duel.players[socketId];
  if (state.spellMoveUsed) return { ok: false, error: "You already moved a magic/trap card this turn." };

  const fromLane = tcgNormalizeBoardLane(fromSlotIndex);
  const targetLane = tcgNormalizeBoardLane(toSlotIndex);
  const slot = state.spellTrapSlots[fromLane];

  if (!slot) return { ok: false, error: "No magic/trap card in that lane." };
  if (fromLane === targetLane) return { ok: false, error: "Choose a different magic/trap lane." };

  const swap = state.spellTrapSlots[targetLane];
  state.spellTrapSlots[targetLane] = slot;
  state.spellTrapSlots[fromLane] = swap || null;

  state.spellTrapSlots.forEach((entry, index) => {
    if (entry) entry.lane = index;
  });

  state.spellMoveUsed = true;
  tcgPushLog(duel, `${state.name} rearranged their back row.`);
  emitTcgDuelUpdate(duel);
  return { ok: true };
}

function tcgHasTideglassGuard(state) {
  return state.creatureSlots.some(slot => {
    const card = slot ? tcgGetServerCard(slot.cardId) : null;
    return card && /tideglass|turtle/i.test(`${card.id} ${card.name}`);
  });
}

function tcgActivateSpellTrap(duel, socketId, slotIndex, targetSlotIndex = -1) {
  const state = duel.players[socketId];
  const opponentSocketId = getTcgOpponentSocketId(duel, socketId);
  const opponent = duel.players[opponentSocketId];
  const index = Math.max(0, Math.floor(Number(slotIndex)));
  const slot = state?.spellTrapSlots?.[index];

  if (!state || !opponent) return { ok: false, error: "Card Duel opponent not found." };
  if (!slot) return { ok: false, error: "No card in that slot." };

  const card = tcgGetServerCard(slot.cardId);
  const category = slot.category || card?.category || "magic";
  const template = tcgSpellEffectTemplate(slot.cardId, category);

  if (category === "magic") {
    const turn = tcgRequireActiveTurn(duel, socketId);
    if (!turn.ok) return turn;
    if (duel.phase !== "main") return { ok: false, error: "Magic activates during your Main Phase." };
  }

  if (category === "trap" && slot.setTurn >= duel.turnNumber) {
    return { ok: false, error: "Trap cards cannot activate on the same turn they were set." };
  }

  const enemySlots = tcgNormalizeCreatureBoardState(opponent);
  const targetCell = tcgResolveCreatureCellIndex(opponent, targetSlotIndex);

  if (template.requiresTarget && targetCell < 0) {
    return { ok: false, error: "Choose a target creature for this effect." };
  }

  state.spellTrapSlots[index] = null;
  state.discard.push(slot.cardId);

  const baseEffectEvent = {
    eventType: "spell_projectile",
    ownerSocketId: socketId,
    targetSocketId: opponentSocketId,
    targetSide: "enemy",
    friendlyFire: false,
    legalTargets: "enemy_only",
    cardId: slot.cardId,
    category,
    kind: template.effectKind,
    pattern: template.pattern,
    damage: template.damage,
    range: template.range,
    piercing: template.piercing,
    stopsOnHit: template.stopsOnHit,
    projectileCount: template.projectileCount,
    sourceLane: index,
    paths: [],
    hits: []
  };

  if (template.effectKind === "heal") {
    const heal = 420 + tcgCardRank(slot.cardId) * 130;
    state.lifePoints = Math.min(TCG_DUEL_LIFE_POINTS, state.lifePoints + heal);
    tcgPushLog(duel, `${state.name} restored ${heal} LP.`, { effect: { ...baseEffectEvent, eventType: "utility", amount: heal } });
  } else if (template.effectKind === "draw") {
    const draw = drawTcgCards(state, 1);
    if (draw.deckedOut) {
      endTcgDuel(duel, opponentSocketId, "deck_out");
      return { ok: true };
    }
    tcgPushLog(duel, `${state.name} drew a card.`, { effect: { ...baseEffectEvent, eventType: "utility", amount: 1 } });
  } else {
    const anchor = tcgSpellAnchorFromTarget(targetSlotIndex, opponent, index);
    const paths = tcgBuildSpellProjectilePaths(template, anchor.lane);
    const hitCells = new Set();
    const hits = [];
    let lpHits = 0;
    const maxLpHits = template.pattern === "wave" ? 2 : template.projectileCount > 1 ? 2 : 1;

    paths.forEach(path => {
      let pathHit = false;

      for (const step of path) {
        if (step.kind === "creature") {
          const target = enemySlots[step.cellIndex];
          if (!target || hitCells.has(step.cellIndex)) continue;

          if (target.faceDown) target.faceDown = false;
          if (template.debuff === "weaken") {
            target.hasAttacked = true;
            target.attack = Math.max(100, Math.round((target.attack || 0) * 0.82));
          }

          const beforeHealth = Math.max(0, Math.round(target.health || target.maxHealth || 0));
          const destroyed = tcgDamageCreature(opponent, step.cellIndex, template.damage);
          hitCells.add(step.cellIndex);
          pathHit = true;

          hits.push({
            kind: "creature",
            cellIndex: step.cellIndex,
            lane: step.lane,
            row: step.row,
            step: step.step,
            projectileIndex: step.projectileIndex,
            damage: template.damage,
            beforeHealth,
            destroyed
          });

          if (template.stopsOnHit) break;
        } else if (step.kind === "base" && template.canHitLp && !pathHit && lpHits < maxLpHits) {
          const lpDamage = Math.max(1, Math.round(template.damage * template.lpScale));
          opponent.lifePoints -= lpDamage;
          lpHits++;
          pathHit = true;
          hits.push({
            kind: "lp",
            lane: step.lane,
            step: step.step,
            projectileIndex: step.projectileIndex,
            damage: lpDamage
          });
        }
      }
    });

    const creatureHits = hits.filter(hit => hit.kind === "creature").length;
    const lpDamage = hits.filter(hit => hit.kind === "lp").reduce((sum, hit) => sum + hit.damage, 0);
    const hitText = creatureHits
      ? `${creatureHits} enemy creature${creatureHits === 1 ? "" : "s"}`
      : lpDamage
        ? `${lpDamage} LP`
        : "nothing";

    tcgPushLog(
      duel,
      `${state.name} fired a ${template.pattern} ${category} effect for ${template.damage} damage and hit ${hitText}.`,
      {
        effect: {
          ...baseEffectEvent,
          anchorLane: anchor.lane,
          anchorCell: anchor.cellIndex,
          paths,
          hits
        }
      }
    );
  }

  if (!tcgCheckLifeAndDeckLoss(duel)) emitTcgDuelUpdate(duel);
  return { ok: true };
}

function tcgAttackWithCreature(duel, socketId, attackerSlotIndex, targetSlotIndex = -1, attackDirection = "forward", directLaneIndex = 2) {
  const turn = tcgRequireActiveTurn(duel, socketId);
  if (!turn.ok) return turn;
  if (duel.phase !== "attack" && duel.phase !== "battle") return { ok: false, error: "Switch to Battle Phase first." };
  if (duel.turnNumber === 1 && duel.firstTurnSocketId === socketId) return { ok: false, error: "First player cannot attack on turn one." };

  const state = duel.players[socketId];
  const opponentSocketId = getTcgOpponentSocketId(duel, socketId);
  const opponent = duel.players[opponentSocketId];

  tcgNormalizeCreatureBoardState(state);
  tcgNormalizeCreatureBoardState(opponent);

  const attackerIndex = tcgResolveCreatureCellIndex(state, attackerSlotIndex);
  const attacker = state.creatureSlots[attackerIndex];

  if (!attacker) return { ok: false, error: "No attacker in that board cell." };
  if (attacker.hasAttacked) return { ok: false, error: "That creature already attacked." };

  tcgRefreshCreatureBoardProfile(attacker);
  attacker.lane = tcgBoardCellLane(attackerIndex);
  attacker.row = tcgBoardCellRow(attackerIndex);

  const trapResult = tcgResolveFieldTraps(
    duel,
    socketId,
    attackerIndex,
    "attack",
    Number(attacker.attack || 0)
  );

  if (trapResult.destroyed || trapResult.displaced || trapResult.cancelAction) {
    const survivingAttacker = state.creatureSlots[trapResult.currentCellIndex];
    if (survivingAttacker) survivingAttacker.hasAttacked = true;

    emitTcgDuelUpdate(duel);
    return {
      ok: true,
      trapTriggered: trapResult.triggered,
      attackCancelled: true
    };
  }

  const targetIndex = tcgResolveCreatureCellIndex(opponent, targetSlotIndex);
  const defender = targetIndex >= 0 ? opponent.creatureSlots[targetIndex] : null;

  if (defender) {
    tcgRefreshCreatureBoardProfile(defender);
    defender.lane = tcgBoardCellLane(targetIndex);
    defender.row = tcgBoardCellRow(targetIndex);

    if (!tcgCanCreatureAttackTarget(attacker, attackerIndex, defender, targetIndex)) {
      return { ok: false, error: "Target is outside this creature's attack range or line." };
    }

    const profile = tcgCreatureBoardProfile(attacker.cardId);
    const shape = tcgCreatureAttackShape(attacker);
    const metrics = tcgCreatureBoardMetrics(attacker, attackerIndex, defender, targetIndex);
    const direction = attackDirection || tcgAttackDirectionFromSlots(attackerIndex, targetIndex);

    if (defender.faceDown) {
      defender.faceDown = false;
      tcgPushLog(duel, `${opponent.name}'s face-down creature was flipped: ${defender.cardId.replace(/_/g, " ")}.`);
    }

    const defenderIsDefense = defender.position === "defense";
    const defenderHealthBefore = Math.max(0, Math.round(defender.health || defender.maxHealth || 0));
    const defenderAttack = Math.max(0, Math.round(defender.attack || 0));
    const attackerDamage = Math.max(0, Math.round(attacker.attack || 0));
    const destroyedDefender = tcgDamageCreature(opponent, targetIndex, defenderIsDefense && attackerDamage > defenderHealthBefore ? 999999 : attackerDamage);
    let lpSpill = 0;

    if (destroyedDefender) {
      const overkill = Math.max(0, attackerDamage - defenderHealthBefore);
      if (!defenderIsDefense) lpSpill = Math.round(overkill * (shape === "melee" ? 0.55 : 0.35));
      if (lpSpill > 0) opponent.lifePoints -= lpSpill;
    } else if (shape === "melee" || metrics.rowDistance <= 1) {
      tcgDamageCreature(state, attackerIndex, defenderAttack);
    }

    if (defenderIsDefense && !destroyedDefender && attackerDamage < defenderHealthBefore && shape === "melee") {
      const recoil = defenderHealthBefore - attackerDamage;
      state.lifePoints -= recoil;
      tcgPushLog(duel, `${state.name} attacked ${direction.replace(/_/g, " ")} into stronger defense and took ${recoil} LP damage.`);
    } else {
      tcgPushLog(
        duel,
        `${state.name} made a ${shape} ${direction.replace(/_/g, " ")} attack for ${attackerDamage}${destroyedDefender ? " and destroyed the creature" : ""}${lpSpill ? `, spilling ${lpSpill} LP damage` : ""}.`,
        {
          combat: {
            attackerCell: attackerIndex,
            targetCell: targetIndex,
            shape,
            attackRange: profile.attackRange,
            rowDistance: metrics.rowDistance,
            laneDistance: metrics.laneDistance,
            damage: attackerDamage,
            destroyed: destroyedDefender,
            lpSpill
          }
        }
      );
    }

    if (state.creatureSlots[attackerIndex]) state.creatureSlots[attackerIndex].hasAttacked = true;
  } else {
    const requestedLane = Math.floor(Number(directLaneIndex));
    const directLane = requestedLane >= 0 ? tcgNormalizeBoardLane(requestedLane) : tcgBoardCellLane(attackerIndex);

    if (!tcgCanCreatureAttackDirect(attacker, attackerIndex, opponent, directLane)) {
      return { ok: false, error: "Move to the enemy base zone and clear that lane before attacking LP." };
    }

    let pushedBack = false;

    if (tcgHasTideglassGuard(opponent) && !opponent.directBlockedThisTurn) {
      opponent.directBlockedThisTurn = true;
      attacker.hasAttacked = true;
      pushedBack = tcgPushDirectAttackerBack(state, attackerIndex);
      tcgPushLog(duel, `${opponent.name}'s Tideglass guard blocked the direct attack${pushedBack ? " and forced the attacker back" : ""}.`);
    } else {
      const directDamage = Math.max(0, Math.round(attacker.attack || 0));
      opponent.lifePoints -= directDamage;
      attacker.hasAttacked = true;
      pushedBack = tcgPushDirectAttackerBack(state, attackerIndex);
      tcgPushLog(
        duel,
        `${state.name} attacked lane ${directLane + 1} LP directly for ${directDamage}${pushedBack ? " and fell back one space" : ""}.`,
        { combat: { attackerCell: attackerIndex, directLane, damage: directDamage, direct: true, pushedBack } }
      );
    }
  }

  if (!tcgCheckLifeAndDeckLoss(duel)) emitTcgDuelUpdate(duel);
  return { ok: true };
}

function tcgSetPhase(duel, socketId, phase) {
  const turn = tcgRequireActiveTurn(duel, socketId);
  if (!turn.ok) return turn;

  const cleanPhase =
    phase === "standby" ? "standby" :
    phase === "main" ? "main" :
    phase === "attack" || phase === "battle" ? "attack" :
    phase === "end" ? "end" :
    "";

  if (!cleanPhase) return { ok: false, error: "Invalid phase." };
  if (duel.phase === "draw") return { ok: false, error: "Draw first." };
  if (duel.phase === "standby" && cleanPhase !== "main" && cleanPhase !== "end") return { ok: false, error: "Standby can only advance to Main or End." };
  if (duel.phase === "main" && !["main", "attack", "end"].includes(cleanPhase)) return { ok: false, error: "Main can advance to Attack or End." };
  if (duel.phase === "attack" && cleanPhase !== "end") return { ok: false, error: "Attack Phase can only advance to End." };

  duel.phase = cleanPhase;
  if (cleanPhase !== "end") {
    tcgPushLog(duel, `${duel.players[socketId].name} entered ${cleanPhase.toUpperCase()} Phase.`, {
      actionType: "phase",
      actorSocketId: socketId,
      phase: cleanPhase
    });
  }
  emitTcgDuelUpdate(duel);
  return { ok: true };
}

function tcgEndTurn(duel, socketId) {
  const turn = tcgRequireActiveTurn(duel, socketId);
  if (!turn.ok) return turn;
  if (duel.phase !== "end") return { ok: false, error: "Move to End Phase first." };

  const nextSocketId = getTcgOpponentSocketId(duel, socketId);
  tcgPushLog(duel, `${duel.players[socketId].name} ended their turn.`, {
    actionType: "end_turn",
    actorSocketId: socketId
  });
  tcgStartTurn(duel, nextSocketId);
  return { ok: true };
}

function tcgRandomRpsChoice() {
  const choices = ["rock", "paper", "scissors"];
  return choices[Math.floor(Math.random() * choices.length)] || "rock";
}

function tcgRpsChoiceBeats(choice, otherChoice) {
  return (
    (choice === "rock" && otherChoice === "scissors") ||
    (choice === "paper" && otherChoice === "rock") ||
    (choice === "scissors" && otherChoice === "paper")
  );
}

function tcgSetRpsWaitingStatus(duel) {
  const pickedCount = Object.keys(duel.rps?.picks || {}).length;
  const playerCount = Object.keys(duel.players || {}).length;
  duel.rpsStatus = pickedCount >= playerCount
    ? "Revealing RPS choices..."
    : "Choice locked. Waiting for rival.";
}

function tcgScheduleRpsAuto(duel) {
  if (!duel || duel.status !== "rps" || duel.rps?.revealing) return;

  if (duel.rpsAutoTimer) clearTimeout(duel.rpsAutoTimer);

  duel.phase = "rps";
  duel.choiceDeadlineAt = Date.now() + TCG_RPS_AUTO_PICK_MS;

  duel.rpsAutoTimer = setTimeout(() => {
    const liveDuel = tcgDuels.get(duel.duelId);
    if (!liveDuel || liveDuel.status !== "rps" || liveDuel.rps?.revealing) return;

    let changed = false;

    for (const socketId of Object.keys(liveDuel.players || {})) {
      if (!liveDuel.rps?.picks?.[socketId]) {
        liveDuel.rps.picks[socketId] = tcgRandomRpsChoice();
        changed = true;
      }
    }

    if (!changed) return;

    tcgSetRpsWaitingStatus(liveDuel);
    resolveTcgRpsRound(liveDuel);
    tcgMaybeScheduleNpcAction(liveDuel, true);
  }, TCG_RPS_AUTO_PICK_MS);
}

function scheduleTcgTurnChoiceAuto(duel) {
  const duelId = duel.duelId;

  setTimeout(() => {
    const liveDuel = tcgDuels.get(duelId);
    if (!liveDuel || liveDuel.status !== "turn_choice") return;

    const chooserSocketId = liveDuel.chooserSocketId;
    const opponentSocketId = getTcgOpponentSocketId(liveDuel, chooserSocketId);
    const firstSocketId = Math.random() < 0.5 ? chooserSocketId : opponentSocketId;
    startTcgDuelTurns(liveDuel, firstSocketId);
    tcgMaybeScheduleNpcAction(liveDuel, true);
  }, TCG_TURN_CHOICE_MS);
}

function tcgFinishRpsReveal(duelId, revealId) {
  const duel = tcgDuels.get(duelId);
  if (!duel || duel.status !== "rps" || duel.rpsReveal?.id !== revealId) return;

  const reveal = duel.rpsReveal;
  const winnerSocketId = reveal.winnerSocketId || null;

  duel.rps.picks = {};
  duel.rps.revealing = false;
  duel.rpsReveal = null;

  if (winnerSocketId && (duel.rps.wins[winnerSocketId] || 0) >= 2) {
    duel.status = "turn_choice";
    duel.phase = "turn_choice";
    duel.chooserSocketId = winnerSocketId;
    duel.choiceDeadlineAt = Date.now() + TCG_TURN_CHOICE_MS;
    duel.rpsStatus = `${duel.players[winnerSocketId].name} won RPS. Choose turn order.`;
    scheduleTcgTurnChoiceAuto(duel);
  } else {
    if (winnerSocketId) duel.rps.round++;
    duel.phase = "rps";
    duel.rpsStatus = winnerSocketId
      ? `Round ${duel.rps.round}. Choose rock, paper, or scissors.`
      : "Tie. Pick again.";
    tcgScheduleRpsAuto(duel);
  }

  emitTcgDuelUpdate(duel);
  tcgMaybeScheduleNpcAction(duel, true);
}

function resolveTcgRpsRound(duel) {
  if (!duel || duel.status !== "rps" || duel.rps?.revealing) return false;

  const socketIds = Object.keys(duel.players);
  const [a, b] = socketIds;
  const pickA = duel.rps.picks[a];
  const pickB = duel.rps.picks[b];

  if (!pickA || !pickB) return false;

  if (duel.rpsAutoTimer) {
    clearTimeout(duel.rpsAutoTimer);
    duel.rpsAutoTimer = null;
  }

  const tie = pickA === pickB;
  const winnerSocketId = tie ? null : tcgRpsChoiceBeats(pickA, pickB) ? a : b;

  if (winnerSocketId) {
    duel.rps.wins[winnerSocketId] = (duel.rps.wins[winnerSocketId] || 0) + 1;
  }

  const revealId = `rps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const message = tie
    ? `Tie: both picked ${pickA}. Rematch.`
    : `${duel.players[winnerSocketId].name} wins the RPS round.`;

  duel.phase = "rps_reveal";
  duel.rps.revealing = true;
  duel.rpsStatus = message;
  duel.rpsReveal = {
    id: revealId,
    round: duel.rps.round,
    picks: {
      [a]: pickA,
      [b]: pickB
    },
    winnerSocketId,
    message,
    wins: { ...(duel.rps.wins || {}) },
    revealUntil: Date.now() + TCG_RPS_REVEAL_MS
  };

  duel.rpsHistory = Array.isArray(duel.rpsHistory) ? duel.rpsHistory : [];
  duel.rpsHistory.unshift(duel.rpsReveal);
  duel.rpsHistory = duel.rpsHistory.slice(0, 5);

  emitTcgDuelUpdate(duel);

  setTimeout(() => {
    tcgFinishRpsReveal(duel.duelId, revealId);
  }, TCG_RPS_REVEAL_MS);

  return true;
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

function recordRankedPlayerElimination(match, sourceEntry, targetEntry) {
  if (!match?.ranked || !sourceEntry || !targetEntry) return;
  if (sourceEntry.socketId === targetEntry.socketId) return;
  if ((sourceEntry.teamId || sourceEntry.socketId) === (targetEntry.teamId || targetEntry.socketId)) return;
  if (targetEntry.rankedEliminationCredited) return;

  targetEntry.rankedEliminationCredited = true;
  sourceEntry.rankedPvpKills = Number(sourceEntry.rankedPvpKills || 0) + 1;
  targetEntry.rankedPvpDeaths = Number(targetEntry.rankedPvpDeaths || 0) + 1;
}

function applyServerRankedMatchResult(entry, mode, won) {
  const cleanMode = mode === "duo" ? "duo" : "solo";
  const season = getRankedSeasonInfo();

  if (!entry.ranked || typeof entry.ranked !== "object") {
    entry.ranked = {
      solo: defaultServerRankedBucket(),
      duo: defaultServerRankedBucket()
    };
  }

  const existing = entry.ranked[cleanMode] || defaultServerRankedBucket();

  if (existing.seasonId && existing.seasonId !== season.id) {
    entry.ranked[cleanMode] = {
      ...defaultServerRankedBucket(),
      seasonId: season.id,
      seasonName: season.label
    };
  }

  const bucket = entry.ranked[cleanMode];
  const before = Math.max(0, Math.round(Number(bucket.rating || 1000)));
  const pvpKills = Math.max(0, Math.round(Number(entry.rankedPvpKills || 0)));
  const pvpDeaths = Math.max(0, Math.round(Number(entry.rankedPvpDeaths || 0)));
  const delta = (won ? RANKED_MATCH_WIN_POINTS : RANKED_MATCH_LOSS_POINTS) +
    pvpKills * RANKED_PVP_ELIMINATION_POINTS;
  const after = Math.max(0, before + delta);

  bucket.seasonId = season.id;
  bucket.seasonName = season.label;
  bucket.rating = after;
  bucket.seasonalRating = after;
  bucket.wins = Number(bucket.wins || 0) + (won ? 1 : 0);
  bucket.losses = Number(bucket.losses || 0) + (won ? 0 : 1);
  bucket.kills = Number(bucket.kills || 0) + pvpKills;
  bucket.deaths = Number(bucket.deaths || 0) + pvpDeaths;
  bucket.matches = Number(bucket.matches || 0) + 1;
  bucket.bestPlacement = won
    ? Math.min(Number(bucket.bestPlacement || 999), 1)
    : (bucket.bestPlacement || null);
  bucket.updatedAt = Date.now();

  entry.rankedPoints = Math.max(
    Number(entry.ranked.solo?.rating || 1000),
    Number(entry.ranked.duo?.rating || 1000)
  );
  entry.rank = entry.rankedPoints >= 2600 ? "MYTHIC" :
    entry.rankedPoints >= 2200 ? "DIAMOND" :
    entry.rankedPoints >= 1800 ? "PLATINUM" :
    entry.rankedPoints >= 1450 ? "GOLD" :
    entry.rankedPoints >= 1150 ? "SILVER" :
    "BRONZE";

  return {
    active: true,
    mode: cleanMode,
    before,
    after,
    delta: after - before,
    pvpKills,
    pvpDeaths,
    npcRankPoints: 0,
    won: !!won
  };
}

function publicRankedLeaderboardEntry(entry, mode, index = 0) {
  const bucket = entry.ranked?.[mode] || defaultServerRankedBucket();

  return {
    position: index + 1,
    playerId: entry.playerId,
    name: sanitizePlayerName(entry.name, "Survivor"),
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

const PLAYER_NAME_MIN_LENGTH = 3;
const PLAYER_NAME_MAX_LENGTH = 24;
const PLAYER_NAME_ALLOWED_RE = /^[A-Za-z0-9 _-]+$/;

function normalizePlayerName(value = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function validatePlayerName(value = "") {
  const name = normalizePlayerName(value);

  if (name.length < PLAYER_NAME_MIN_LENGTH) {
    return { ok: false, name: "", error: "Name must be at least 3 characters." };
  }

  if (name.length > PLAYER_NAME_MAX_LENGTH) {
    return { ok: false, name: "", error: "Name must be 24 characters or fewer." };
  }

  if (!PLAYER_NAME_ALLOWED_RE.test(name) || !/[A-Za-z0-9]/.test(name)) {
    return {
      ok: false,
      name: "",
      error: "Use letters, numbers, spaces, underscores, or hyphens only."
    };
  }

  return { ok: true, name, error: "" };
}

function sanitizePlayerName(value = "", fallback = "Survivor") {
  const checked = validatePlayerName(value);
  if (checked.ok) return checked.name;

  const backup = normalizePlayerName(fallback);

  return (
    backup.length >= PLAYER_NAME_MIN_LENGTH &&
    backup.length <= PLAYER_NAME_MAX_LENGTH &&
    PLAYER_NAME_ALLOWED_RE.test(backup) &&
    /[A-Za-z0-9]/.test(backup)
  ) ? backup : "Survivor";
}

function safeStatInt(value, fallback = 0, max = 999999) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.round(n)));
}

function normalizeLeaderboardName(name = "") {
  return normalizePlayerName(name).toLowerCase();
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
  const { accountActionRate, ...persistedEntry } = entry;

  return {
    ...persistedEntry,
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
  accountEnsureInventory(entry);

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

  return {
    ok: true,
    existingProfiles,
    existingState: existing
  };
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
    backupKey: RANKED_UPSTASH_ENABLED ? RANKED_UPSTASH_BACKUP_KEY : "",
    file: RANKED_STATE_FILE,
    upstashSaved: false,
    upstashBackupSaved: false,
    fileBackupSaved: false,
    error: ""
  };

  if (RANKED_UPSTASH_ENABLED) {
    try {
      const guard = await rankedValidateNonDestructiveUpstashSave(payload);

      if (!guard.ok) {
        throw new Error(guard.error);
      }

      // Preserve the exact prior Upstash value before replacing it.
      if (guard.existingState) {
        await rankedUpstashCommand(
          "SET",
          RANKED_UPSTASH_BACKUP_KEY,
          JSON.stringify(guard.existingState)
        );

        result.upstashBackupSaved = true;
      }

      await rankedUpstashCommand(
        "SET",
        RANKED_UPSTASH_KEY,
        JSON.stringify(payload)
      );

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

function rankedCommitStateNow() {
  const commit = rankedWriteQueue
    .catch(() => null)
    .then(() => rankedSaveStateNow());

  rankedWriteQueue = commit.catch(() => null);
  return commit;
}

function rankedScheduleSave() {
  if (rankedStateSaveTimer) clearTimeout(rankedStateSaveTimer);

  rankedStateSaveTimer = setTimeout(() => {
    rankedStateSaveTimer = null;

    rankedCommitStateNow()
      .then(result => {
        if (!result?.ok) {
          console.error(
            "[ranked] scheduled save failed:",
            result?.error || "Unknown storage error."
          );
        }
      })
      .catch(err => {
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
  if (RANKED_STORAGE_DRIVER === "upstash" && !RANKED_UPSTASH_ENABLED) {
    throw new Error(
      "RANKED_STORAGE_DRIVER=upstash but the Upstash URL, token, or state key is missing."
    );
  }

  let loaded = null;
  let upstashFailure = null;

  if (RANKED_UPSTASH_ENABLED) {
    try {
      const raw = await rankedUpstashCommand("GET", RANKED_UPSTASH_KEY);

      if (!raw) {
        upstashFailure = new Error(
          `Upstash key ${RANKED_UPSTASH_KEY} is empty. Refusing to create a new production state over an unknown account database.`
        );
      } else {
        loaded = {
          file: `upstash:${RANKED_UPSTASH_KEY}`,
          data: rankedParseStatePayload(
            raw,
            `upstash:${RANKED_UPSTASH_KEY}`
          )
        };
      }
    } catch (err) {
      upstashFailure = err;
    }

    if (upstashFailure && RANKED_UPSTASH_FAIL_CLOSED) {
      throw new Error(
        `Upstash account-state load failed: ${upstashFailure.message}`
      );
    }

    if (upstashFailure) {
      console.warn(
        "[ranked] Upstash load failed; fail-closed is disabled, trying local backup:",
        upstashFailure.message
      );
    }
  }

  if (!loaded) {
    for (const file of rankedLoadCandidateFiles()) {
      try {
        loaded = {
          file,
          data: rankedParseStatePayload(
            fs.readFileSync(file, "utf8"),
            file
          )
        };

        break;
      } catch (err) {
        console.warn(
          `[ranked] could not load state candidate ${file}:`,
          err.message
        );
      }
    }
  }

  if (!loaded) {
    if (RANKED_UPSTASH_FAIL_CLOSED) {
      throw new Error(
        "No verified account-state snapshot was loaded. Server startup is blocked to protect player data."
      );
    }

    console.warn(
      `[ranked] no saved state found. New state will be created in ${RANKED_STATE_STORAGE_LABEL}.`
    );

    return false;
  }

  rankedApplyLoadedState(loaded.data, loaded.file);

  if (
    RANKED_UPSTASH_ENABLED &&
    !String(loaded.file).startsWith("upstash:")
  ) {
    const result = await rankedCommitStateNow();

    if (!result?.ok) {
      throw new Error(
        `Recovered state could not be committed to Upstash: ${result?.error || "Unknown error"}`
      );
    }
  }

  if (!RANKED_UPSTASH_ENABLED && loaded.file !== RANKED_STATE_FILE) {
    rankedScheduleSave();
  }

  return true;
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
  const modeLabel = String(mode || "ranked").toUpperCase();
  const premiumPackTickets = {
    element_burst: 1,
    evolution_surge: 1,
    mythic_rift: 1
  };

  if (position === 1) {
    return {
      gold: 50000,
      gems: 2500,
      profileXp: 10000,
      boosterTickets: premiumPackTickets,
      emoteId: "ranked_sovereign_medal_1",
      cardId: "asterion_rift_crown_wyrm",
      title: `${modeLabel} SEASON CHAMPION`
    };
  }

  if (position === 2) {
    return {
      gold: 35000,
      gems: 1600,
      profileXp: 7500,
      boosterTickets: premiumPackTickets,
      emoteId: "ranked_rift_medal_2",
      title: `${modeLabel} SEASON RUNNER-UP`
    };
  }

  if (position === 3) {
    return {
      gold: 27000,
      gems: 1100,
      profileXp: 6500,
      boosterTickets: premiumPackTickets,
      title: `${modeLabel} TOP 3`
    };
  }

  if (position <= 5) {
    return {
      gold: 20000,
      gems: 750,
      profileXp: 5000,
      title: `${modeLabel} TOP 5`
    };
  }

  if (position <= 10) {
    return {
      gold: 14000,
      gems: 400,
      profileXp: 3800,
      title: `${modeLabel} TOP 10`
    };
  }

  if (position <= 20) {
    return {
      gold: 9000,
      gems: 200,
      profileXp: 2800,
      title: `${modeLabel} TOP 20`
    };
  }

  if (position <= 30) {
    return {
      gold: 6000,
      gems: 100,
      profileXp: 2000,
      title: `${modeLabel} TOP 30`
    };
  }

  if (position <= 40) {
    return {
      gold: 3000,
      gems: 40,
      profileXp: 1400,
      title: `${modeLabel} TOP 40`
    };
  }

  return {
    gold: 0,
    gems: 0,
    profileXp: 750,
    title: `${modeLabel} TOP 50 XP REWARD`
  };
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
  const requestedName = sanitizePlayerName(profile.name, "Survivor");

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
      account: accountDefaultInventory(),
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

  entry.name = sanitizePlayerName(requestedName, entry.name || "Survivor");
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
  accountEnsureInventory(entry);
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
    name: sanitizePlayerName(entry.name, "Survivor"),
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
      name: sanitizePlayerName(p.name, "Survivor"),
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
  removeRankedDuoPartyFromQueue(partyId);
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

function removeRankedDuoPartyFromQueue(partyId, reason = "") {
  const index = rankedDuoPartyQueue.findIndex(entry => entry.partyId === partyId);
  if (index >= 0) rankedDuoPartyQueue.splice(index, 1);

  const timer = rankedDuoQueueTimers.get(partyId);
  if (timer) clearTimeout(timer);
  rankedDuoQueueTimers.delete(partyId);

  const party = parties.get(partyId);
  if (party && party.status === "ranked_queue") {
    party.status = "lobby";
    party.rankedIntent = false;
    party.modeIntent = "duo";

    for (const socketId of party.members) {
      party.ready[socketId] = false;
      if (reason) {
        io.to(socketId).emit("rankedQueueStatus", {
          mode: "duo",
          queued: false,
          reason
        });
      }
    }

    emitPartyUpdate(partyId);
  }
}

function cancelRankedMatchBeforeDeploy(match, reason) {
  if (!match || !match.ranked || match.resultsFinalized) return;

  for (const entry of match.players.values()) {
    const p = getPlayer(entry.socketId);
    if (p) {
      p.inMatch = false;
      p.matchId = null;
    }

    const socket = io.sockets.sockets.get(entry.socketId);
    if (socket) socket.leave(match.matchId);

    io.to(entry.socketId).emit("rankedQueueStatus", {
      mode: match.rankedMode || match.mode || "solo",
      queued: false,
      reason
    });

    io.to(entry.socketId).emit("matchQueueCancelled", {
      matchId: match.matchId,
      reason
    });
  }

  matches.delete(match.matchId);
  broadcastOnlineList();
}

function armRankedMinimumHumanGuard(match) {
  if (!match?.ranked || match.rankedMinimumHumanGuard) return;

  match.rankedMinimumHumanGuard = setTimeout(() => {
    if (!matches.has(match.matchId) || match.resultsFinalized) return;

    if (getMatchHumanCount(match) < 2) {
      cancelRankedMatchBeforeDeploy(
        match,
        "Ranked needs at least two real players. No rating changed."
      );
    }
  }, Math.max(1000, Number(match.deployAt || Date.now()) - Date.now() - 150));

  match.rankedMinimumHumanGuard.unref?.();
}

function createRankedDuoMatch(firstParty, secondParty) {
  const matchId = makeMatchId();
  const seed = makeSeed();
  const now = Date.now();
  const partyGroups = [firstParty, secondParty];
  const match = {
    matchId,
    seed,
    mode: "duo",
    partyId: firstParty.partyId,
    partyIds: partyGroups.map(party => party.partyId),
    teamSize: 2,
    totalSlots: MATCH_TOTAL_SLOTS,
    queueStartAt: now,
    deployAt: now + ONLINE_QUEUE_MS,
    worldAuthoritySocketId: firstParty.leaderId || firstParty.members[0] || null,
    worldSnapshot: null,
    lastWorldSnapshotAt: 0,
    ranked: true,
    rankedMode: "duo",
    players: new Map()
  };

  for (const party of partyGroups) {
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
        partyId: party.partyId,
        alive: true,
        hp: 100,
        x: 0,
        y: 0,
        angle: 0,
        rankedPvpKills: 0,
        rankedPvpDeaths: 0
      });

      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.join(matchId);
    }
  }

  const humanCount = getMatchHumanCount(match);
  const botTarget = rollRankedMatchBotTarget(humanCount);
  match.botTarget = botTarget;
  match.populationTarget = Math.min(MATCH_TOTAL_SLOTS, humanCount + botTarget);

  matches.set(matchId, match);

  for (const party of partyGroups) {
    party.matchId = matchId;
    party.seed = seed;
    party.status = "matching";
    party.modeIntent = "duo";
    party.rankedIntent = true;
    party.teamSize = 2;

    const teammates = party.members
      .map(socketId => getPlayer(socketId))
      .filter(Boolean)
      .map(publicPlayer);

    for (const socketId of party.members) {
      io.to(socketId).emit("partyMatchStart", {
        matchId,
        seed,
        partyId: party.partyId,
        teamId: party.partyId,
        mode: "duo",
        teamSize: 2,
        botFillSlots: 0,
        totalSlots: MATCH_TOTAL_SLOTS,
        botCount: botTarget,
        populationTarget: match.populationTarget,
        queueMs: ONLINE_QUEUE_MS,
        serverNow: now,
        deployAt: match.deployAt,
        worldAuthoritySocketId: match.worldAuthoritySocketId,
        ranked: true,
        teammates
      });
    }

    emitPartyUpdate(party.partyId);
  }

  if (!cleanupEmptyMatch(match, "reconnect_timeout")) {
    broadcastMatchSync(match);
    checkMatchWinner(match);
  }

  broadcastOnlineList();
}

function enqueueRankedDuoParty(party) {
  if (!party || party.members.length !== 2) return false;
  if (rankedDuoPartyQueue.some(entry => entry.partyId === party.partyId)) return true;

  party.status = "ranked_queue";
  party.modeIntent = "duo";
  party.rankedIntent = true;
  party.teamSize = 2;

  rankedDuoPartyQueue.push({
    partyId: party.partyId,
    queuedAt: Date.now()
  });

  for (const socketId of party.members) {
    io.to(socketId).emit("rankedQueueStatus", {
      mode: "duo",
      queued: true,
      queuedParties: rankedDuoPartyQueue.length,
      reason: "Searching for another ready Duo party."
    });
  }

  emitPartyUpdate(party.partyId);

  const timeout = setTimeout(() => {
    if (!rankedDuoPartyQueue.some(entry => entry.partyId === party.partyId)) return;

    removeRankedDuoPartyFromQueue(
      party.partyId,
      "Ranked Duo queue timed out. No rating changed."
    );
  }, 120000);

  timeout.unref?.();
  rankedDuoQueueTimers.set(party.partyId, timeout);

  while (rankedDuoPartyQueue.length >= 2) {
    const first = rankedDuoPartyQueue.shift();
    const second = rankedDuoPartyQueue.shift();
    const firstParty = parties.get(first?.partyId);
    const secondParty = parties.get(second?.partyId);

    const firstTimer = rankedDuoQueueTimers.get(first?.partyId);
    const secondTimer = rankedDuoQueueTimers.get(second?.partyId);
    if (firstTimer) clearTimeout(firstTimer);
    if (secondTimer) clearTimeout(secondTimer);
    rankedDuoQueueTimers.delete(first?.partyId);
    rankedDuoQueueTimers.delete(second?.partyId);

    if (
      !firstParty ||
      !secondParty ||
      firstParty.members.length !== 2 ||
      secondParty.members.length !== 2 ||
      firstParty.status !== "ranked_queue" ||
      secondParty.status !== "ranked_queue"
    ) {
      continue;
    }

    createRankedDuoMatch(firstParty, secondParty);
    break;
  }

  return true;
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
    rankedMode: party.rankedIntent ? cleanMode : null,
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
      partyId: party.partyId,
      alive: true,
      hp: 100,
      x: 0,
      y: 0,
      angle: 0,
      rankedPvpKills: 0,
      rankedPvpDeaths: 0
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
  const botTarget = match.ranked
    ? rollRankedMatchBotTarget(humanCount)
    : rollMatchBotTarget(humanCount);
  match.botTarget = botTarget;
  match.populationTarget = Math.min(MATCH_TOTAL_SLOTS, humanCount + botTarget);

  const botFillSlots = Math.max(0, teamSize - teammates.length);

  for (const socketId of party.members) {
    io.to(socketId).emit("partyMatchStart", {
      matchId,
      seed,
      partyId: party.partyId,
      teamId: party.partyId,
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
  if (mode === "solo") return "solo";
  return mode === "team" ? "team" : "duo";
}

function publicMatchTeammates(match) {
  return [...match.players.values()]
    .map(entry => getPlayer(entry.socketId))
    .filter(Boolean)
    .map(publicPlayer);
}

function findJoinablePublicMatch(mode = "duo", ranked = false) {
  const cleanMode = cleanQuickMatchMode(mode);
  const teamSize = TEAM_SIZE_BY_MODE[cleanMode] || 1;
  const now = Date.now();

  return [...matches.values()]
    .filter(match => {
      if (!match || !match.publicQueue) return false;
      if (match.mode !== cleanMode) return false;
      if (!!match.ranked !== !!ranked) return false;

      // Keep a small safety window so nobody joins right as deployment fires.
      if (now >= (match.deployAt || 0) - 2500) return false;

      if (getMatchHumanCount(match) >= teamSize && !ranked) return false;
      if (ranked && getMatchHumanCount(match) >= MATCH_HUMAN_RESERVED_SLOTS) return false;

      return true;
    })
    .sort((a, b) => {
      const humanDiff = getMatchHumanCount(b) - getMatchHumanCount(a);
      if (humanDiff !== 0) return humanDiff;

      // Prefer the lobby that is closer to deploying, as long as it is still joinable.
      return (a.deployAt || 0) - (b.deployAt || 0);
    })[0] || null;
}

function createPublicQuickMatch(mode = "duo", ranked = false) {
  const cleanMode = cleanQuickMatchMode(mode);
  const teamSize = TEAM_SIZE_BY_MODE[cleanMode] || 1;
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
    ranked: !!ranked,
    rankedMode: ranked ? cleanMode : null,
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

function joinPublicQuickMatch(socket, mode = "duo", options = {}) {
  const p = getPlayer(socket.id);
  if (!p) return { ok: false, error: "Not registered." };
  if (p.inMatch) return { ok: false, error: "You are already in a match." };

  const ranked = !!options.ranked;
  const cleanMode = cleanQuickMatchMode(mode);

  // Ranked Solo is the only no-party ranked queue. Ranked Duo uses two
  // ready parties so both sides are real two-player teams.
  if (ranked && cleanMode !== "solo") {
    return { ok: false, error: "Ranked Duo requires a ready party of two players." };
  }

  // Parties should continue using the normal party-ready matchmaking path.
  if (p.partyId) return { ok: false, error: "Leave your party or use party ready check." };

  const teamSize = TEAM_SIZE_BY_MODE[cleanMode] || 1;

  let match = findJoinablePublicMatch(cleanMode, ranked);
  const joinedExisting = !!match;

  if (!match) {
    match = createPublicQuickMatch(cleanMode, ranked);
  }

  if (!match.worldAuthoritySocketId || !io.sockets.sockets.has(match.worldAuthoritySocketId)) {
    match.worldAuthoritySocketId = socket.id;
  }

  p.inMatch = true;
  p.matchId = match.matchId;

  match.players.set(socket.id, {
    socketId: socket.id,
    playerId: p.playerId,
    name: p.name,
    teamId: ranked ? socket.id : "player_team",
    alive: true,
    hp: 100,
    x: 0,
    y: 0,
    angle: 0,
    rankedPvpKills: 0,
    rankedPvpDeaths: 0
  });

  socket.join(match.matchId);

  const humanCount = getMatchHumanCount(match);
  const botTarget = ranked
    ? rollRankedMatchBotTarget(humanCount)
    : getMatchBotTarget(match, humanCount);

  match.botTarget = botTarget;
  match.populationTarget = Math.min(MATCH_TOTAL_SLOTS, humanCount + botTarget);

  const teammates = ranked
    ? [publicPlayer(p)]
    : publicMatchTeammates(match);

  socket.emit("partyMatchStart", {
    matchId: match.matchId,
    seed: match.seed,
    partyId: null,
    teamId: ranked ? socket.id : "player_team",
    mode: cleanMode,
    teamSize,
    botFillSlots: ranked ? 0 : Math.max(0, teamSize - teammates.length),
    totalSlots: MATCH_TOTAL_SLOTS,
    botCount: botTarget,
    populationTarget: match.populationTarget,
    queueMs: Math.max(0, match.deployAt - Date.now()),
    serverNow: Date.now(),
    deployAt: match.deployAt,
    worldAuthoritySocketId: match.worldAuthoritySocketId,
    ranked,
    teammates,
    joinedExisting
  });

  if (ranked) {
    armRankedMinimumHumanGuard(match);
  } else {
    emitPublicMatchTeamUpdate(match);
  }

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

    const verifiedKills = safeStatInt(
      entry.matchKills,
      0,
      MATCH_TOTAL_SLOTS
    );

    profileEntry.kills += verifiedKills;
    profileEntry.wins += won ? 1 : 0;
    profileEntry.losses += won ? 0 : 1;
    profileEntry.deaths += won ? 0 : 1;

    const accountReward = accountBuildVerifiedMatchReward(
      match,
      entry,
      won
    );

    accountGrantReward(profileEntry, accountReward);
    entry.accountReward = accountReward;
    profileEntry.updatedAt = Date.now();

    if (match.ranked && getMatchHumanCount(match) >= 2) {
      entry.rankedResult = applyServerRankedMatchResult(
        profileEntry,
        match.rankedMode || match.mode,
        won
      );
    }

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

      accountSyncPlayerCurrency(profileEntry, liveProfile);

      io.to(entry.socketId).emit("matchAccountReward", {
        reward: accountReward,
        account: accountSnapshot(profileEntry)
      });

      io.to(entry.socketId).emit(
        "profileAssigned",
        privatePlayerProfile(liveProfile)
      );
    }
  }

  rankedCommitStateNow()
    .then(result => {
      if (!result?.ok) {
        console.error(
          "[ranked] match result save failed:",
          result?.error || "Unknown storage error."
        );
      }
    })
    .catch(err => {
      console.error("[ranked] match result save failed:", err);
    });

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
      winners,
      ranked: entry.rankedResult || null
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

function cleanupEmptyMatch(match, reason = "empty") {
  if (!match || !matches.has(match.matchId)) return false;

  // Keep a match alive while a disconnected player can still reconnect.
  // Dead players may spectate, so only explicit/expired leavers allow cleanup.
  const hasRetainedHuman = [...match.players.values()].some(entry =>
    entry &&
    !entry.leftMatch &&
    !entry.reconnectExpired
  );

  if (hasRetainedHuman) return false;

  for (const entry of match.players.values()) {
    if (entry?.reconnectTimer) clearTimeout(entry.reconnectTimer);
  }

  if (match.rankedMinimumHumanGuard) {
    clearTimeout(match.rankedMinimumHumanGuard);
    match.rankedMinimumHumanGuard = null;
  }

  match.worldSnapshot = null;
  match.players.clear();
  matches.delete(match.matchId);

  console.log(`[match] cleaned empty match ${match.matchId} (${reason})`);
  return true;
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

    const suppliedSessionToken = String(data?.sessionToken || "").trim();
    const session = verifyPlayerSessionToken(suppliedSessionToken);

    // Never replace a broken existing account session with a new default profile.
    if (suppliedSessionToken && !session) {
      socket.emit("profileSessionInvalid", {
        message: "Saved profile session could not be verified. No new account was created."
      });

      return;
    }

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
      name: sanitizePlayerName(data?.name, "Survivor"),
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

  const checkedName = validatePlayerName(data?.name);
  if (!checkedName.ok) {
    return cb?.({ ok: false, error: checkedName.error });
  }

  const nextName = checkedName.name;
  const nextNameKey = normalizeLeaderboardName(nextName);

  const duplicate = [...players.values()].some(other =>
    other.socketId !== socket.id &&
    normalizeLeaderboardName(other.name) === nextNameKey
  );

  if (duplicate) {
    return cb?.({ ok: false, error: "That name is already online." });
  }

  const profileEntry = getOrCreateLeaderboardEntry({
    playerId: p.playerId,
    name: nextName,
    color: p.color,
    icon: p.icon
  });

  profileEntry.name = nextName;
  profileEntry.updatedAt = Date.now();
  p.name = nextName;

  const match = p.matchId ? matches.get(p.matchId) : null;
  const matchEntry = match?.players.get(socket.id);
  if (matchEntry) matchEntry.name = nextName;

  rankedScheduleSave();
  cb?.({ ok: true, player: publicPlayer(p) });

  if (p.partyId) emitPartyUpdate(p.partyId);
  if (match) broadcastMatchSync(match, "player_renamed");
  broadcastOnlineList();
  broadcastLeaderboards();
});

socket.on("accountAction", async (data = {}, cb) => {
  const p = getPlayer(socket.id);

  if (!p?.playerId) {
    return cb?.({ ok: false, error: "Player profile not ready." });
  }

  if (p.matchId || p.inMatch) {
    return cb?.({
      ok: false,
      error: "Account changes are unavailable during a match."
    });
  }

  const entry = getOrCreateLeaderboardEntry({
    playerId: p.playerId,
    name: p.name,
    color: p.color,
    icon: p.icon
  });

  const actionType = accountSafeId(data?.type, 48);

  if (!ACCOUNT_ACTION_RULES[actionType]) {
    return cb?.({ ok: false, error: "Unknown account action." });
  }

  if (!accountAllowAction(entry, actionType)) {
    return cb?.({
      ok: false,
      error: "Please wait a moment before trying that again."
    });
  }

  const rollback = accountCreateRollbackSnapshot(entry);
  const result = accountHandleAction(entry, actionType, data);

  if (!result.ok) {
    return cb?.(result);
  }

  entry.updatedAt = Date.now();

  const saveResult = await rankedCommitStateNow();

  if (!saveResult?.ok) {
    accountRestoreRollbackSnapshot(entry, rollback);
    accountSyncPlayerCurrency(entry, p);

    return cb?.({
      ok: false,
      error: "Account storage is unavailable. Nothing was charged or claimed."
    });
  }

  accountSyncPlayerCurrency(entry, p);

  const account = accountSnapshot(entry);
  const profile = privatePlayerProfile(p);

  socket.emit("accountSync", account);
  socket.emit("profileAssigned", profile);

  cb?.({
    ...result,
    profile,
    account
  });

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
    const result = joinPublicQuickMatch(socket, mode, {
      ranked: !!data?.ranked
    });

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

  socket.on("tcgDuelInvite", data => {
    const from = getPlayer(socket.id);
    const targetSocket = getSocketByPlayerId(data?.targetId);
    const target = targetSocket ? getPlayer(targetSocket.id) : null;

    if (!from) return;
    if (!targetSocket || !target) return socket.emit("tcgDuelInviteFailed", "Friend is offline.");
    if (from.inMatch || target.inMatch) return socket.emit("tcgDuelInviteFailed", "Card Duels can only start from the main menu.");
    if (from.tcgDuelId || target.tcgDuelId) return socket.emit("tcgDuelInviteFailed", "A player is already in a Card Duel.");

    const deck = cleanTcgDeckPayload(data?.deckPayload);

    if (!deck.ok) {
      return socket.emit("tcgDuelInviteFailed", deck.error);
    }

    const inviteId = "tcg_invite_" + Math.random().toString(36).slice(2, 10);

    tcgDuelInvites.set(inviteId, {
      inviteId,
      fromSocketId: socket.id,
      targetSocketId: targetSocket.id,
      fromDeckIds: deck.deckIds,
      createdAt: Date.now()
    });

    targetSocket.emit("tcgDuelInviteIncoming", {
      inviteId,
      fromSocketId: socket.id,
      fromPlayer: publicPlayer(from),
      deckCount: deck.deckIds.length
    });

    socket.emit("tcgDuelInviteSent", { targetId: data?.targetId });
  });

  socket.on("tcgDuelInviteResponse", data => {
    const invite = tcgDuelInvites.get(data?.inviteId);
    const me = getPlayer(socket.id);

    if (!invite || !me || invite.targetSocketId !== socket.id) return;

    const inviterSocket = io.sockets.sockets.get(invite.fromSocketId);
    const inviter = getPlayer(invite.fromSocketId);

    tcgDuelInvites.delete(invite.inviteId);

    if (!inviterSocket || !inviter) {
      return socket.emit("tcgDuelInviteFailed", "Challenger is no longer online.");
    }

    if (!data?.accepted) {
      inviterSocket.emit("tcgDuelInviteDeclined", { player: publicPlayer(me) });
      return;
    }

    if (Date.now() - invite.createdAt > TCG_DUEL_INVITE_TTL_MS) {
      return socket.emit("tcgDuelInviteFailed", "Card Duel invite expired.");
    }

    if (me.inMatch || inviter.inMatch || me.tcgDuelId || inviter.tcgDuelId) {
      return socket.emit("tcgDuelInviteFailed", "A player is already busy.");
    }

    const targetDeck = cleanTcgDeckPayload(data?.deckPayload);

    if (!targetDeck.ok) {
      return socket.emit("tcgDuelInviteFailed", targetDeck.error);
    }

    const duelId = makeTcgDuelId();

    const duel = {
      duelId,
      status: "rps",
      phase: "rps",
      turnNumber: 0,
      activeSocketId: null,
      chooserSocketId: null,
      choiceDeadlineAt: Date.now() + TCG_RPS_AUTO_PICK_MS,
      rpsStatus: "Choose rock, paper, or scissors.",
      rpsReveal: null,
      rpsHistory: [],
      rps: {
        round: 1,
        wins: {
          [invite.fromSocketId]: 0,
          [socket.id]: 0
        },
        picks: {},
        revealing: false
      },
      players: {
        [invite.fromSocketId]: makeTcgPlayerState(inviter, invite.fromDeckIds),
        [socket.id]: makeTcgPlayerState(me, targetDeck.deckIds)
      }
    };

    tcgDuels.set(duelId, duel);
    inviter.tcgDuelId = duelId;
    me.tcgDuelId = duelId;

    tcgScheduleRpsAuto(duel);
    emitTcgDuelUpdate(duel);
    broadcastOnlineList();
  });

  socket.on("tcgLobbyCreate", (data, cb) => {
    const p = getPlayer(socket.id);
    if (!p) return cb?.({ ok: false, error: "Player profile not found." });
    if (p.inMatch || p.tcgDuelId) return cb?.({ ok: false, error: "Leave the current match or duel first." });

    const deck = cleanTcgDeckPayload(data?.deckPayload);
    if (!deck.ok) return cb?.({ ok: false, error: deck.error });

    if (p.tcgLobbyCode) leaveTcgLobby(socket.id, "Moved to a new lobby.");

    const code = makeTcgLobbyCode();
    const lobby = {
      code,
      leaderSocketId: socket.id,
      visibility: "closed",
      members: [socket.id],
      duelSlots: [socket.id, null],
      spectators: [],
      activeDuelId: null,
      createdAt: Date.now(),
      deckIdsBySocketId: {
        [socket.id]: deck.deckIds
      }
    };

    tcgLobbies.set(code, lobby);
    p.tcgLobbyCode = code;
    cb?.({ ok: true, lobby: publicTcgLobby(lobby, socket.id) });
    emitTcgLobbyUpdate(lobby);
  });

  socket.on("tcgLobbyJoin", (data, cb) => {
    const p = getPlayer(socket.id);
    const code = String(data?.code || "").trim().toUpperCase();
    const lobby = code ? tcgLobbies.get(code) : null;

    if (!p) return cb?.({ ok: false, error: "Player profile not found." });
    if (!lobby) return cb?.({ ok: false, error: "Lobby code not found." });
    if (p.inMatch || p.tcgDuelId) return cb?.({ ok: false, error: "Leave the current match or duel first." });
    if (lobby.visibility === "closed") return cb?.({ ok: false, error: "This lobby is closed." });
    if (lobby.activeDuelId) return cb?.({ ok: false, error: "This lobby already has a duel in progress." });

    const deck = cleanTcgDeckPayload(data?.deckPayload);
    if (!deck.ok) return cb?.({ ok: false, error: deck.error });

    if (p.tcgLobbyCode && p.tcgLobbyCode !== code) leaveTcgLobby(socket.id, "Moved to another lobby.");

    if (!lobby.members.includes(socket.id)) lobby.members.push(socket.id);
    lobby.deckIdsBySocketId[socket.id] = deck.deckIds;

    if (!lobby.duelSlots[0]) lobby.duelSlots[0] = socket.id;
    else if (!lobby.duelSlots[1]) lobby.duelSlots[1] = socket.id;
    else if (!lobby.spectators.includes(socket.id)) lobby.spectators.push(socket.id);

    p.tcgLobbyCode = code;
    cb?.({ ok: true, lobby: publicTcgLobby(lobby, socket.id) });
    emitTcgLobbyUpdate(lobby);
  });

  socket.on("tcgLobbySearch", (data, cb) => {
    cb?.({ ok: true, lobbies: getOpenTcgLobbyResults() });
  });

  socket.on("tcgLobbyNpcFallback", (data, cb) => {
    const p = getPlayer(socket.id);
    if (!p) return cb?.({ ok: false, error: "Player profile not found." });
    if (p.inMatch || p.tcgDuelId) return cb?.({ ok: false, error: "Leave the current match or duel first." });

    const deck = cleanTcgDeckPayload(data?.deckPayload);
    if (!deck.ok) return cb?.({ ok: false, error: deck.error });

    if (getOpenTcgLobbyResults().length) {
      return cb?.({ ok: false, error: "An open player lobby appeared. Search again." });
    }

    if (p.tcgLobbyCode) leaveTcgLobby(socket.id, "Moved to duel lobby.");

    const code = makeTcgLobbyCode();
    const npcSocketId = makeTcgNpcSocketId();
    const npcProfile = makeTcgNpcProfile(npcSocketId);
    const npcDeck = makeTcgNpcDeck();

    tcgNpcProfiles.set(npcSocketId, npcProfile);

    const lobby = {
      code,
      leaderSocketId: socket.id,
      visibility: "closed",
      members: [socket.id, npcSocketId],
      duelSlots: [socket.id, npcSocketId],
      spectators: [],
      activeDuelId: null,
      createdAt: Date.now(),
      npcProfilesBySocketId: {
        [npcSocketId]: npcProfile
      },
      deckIdsBySocketId: {
        [socket.id]: deck.deckIds,
        [npcSocketId]: npcDeck
      }
    };

    tcgLobbies.set(code, lobby);
    p.tcgLobbyCode = code;

    cb?.({ ok: true, lobby: publicTcgLobby(lobby, socket.id) });
    emitTcgLobbyUpdate(lobby);

    setTimeout(() => {
      const liveLobby = tcgLobbies.get(code);
    if (!liveLobby || liveLobby.activeDuelId) return;

    const result = createTcgDuelFromLobby(liveLobby);
    if (result?.ok) {
      const liveDuel = tcgDuels.get(result.duelId);
      tcgMaybeScheduleNpcAction(liveDuel, true);
    }
    }, 1000 + Math.random() * 1400);
  });

  socket.on("tcgLobbySetVisibility", data => {
    const p = getPlayer(socket.id);
    const lobby = p?.tcgLobbyCode ? tcgLobbies.get(p.tcgLobbyCode) : null;
    if (!lobby || lobby.leaderSocketId !== socket.id) return;

    lobby.visibility = normalizeTcgLobbyVisibility(data?.visibility);
    emitTcgLobbyUpdate(lobby);
  });

  socket.on("tcgLobbyAssignSlot", data => {
    const p = getPlayer(socket.id);
    const lobby = p?.tcgLobbyCode ? tcgLobbies.get(p.tcgLobbyCode) : null;
    if (!lobby || lobby.leaderSocketId !== socket.id || lobby.activeDuelId) return;

    const targetSocketId = String(data?.socketId || "");
    const targetSlot = Math.max(0, Math.min(1, Math.floor(Number(data?.slotIndex || 0))));
    if (!targetSocketId || !lobby.members.includes(targetSocketId)) return;

    const previousSlot = lobby.duelSlots.indexOf(targetSocketId);
    const displacedSocketId = lobby.duelSlots[targetSlot] || null;

    if (previousSlot >= 0) lobby.duelSlots[previousSlot] = null;
    lobby.spectators = (lobby.spectators || []).filter(id => id !== targetSocketId);

    lobby.duelSlots[targetSlot] = targetSocketId;

    if (displacedSocketId && displacedSocketId !== targetSocketId && !lobby.spectators.includes(displacedSocketId)) {
      lobby.spectators.push(displacedSocketId);
    }

    emitTcgLobbyUpdate(lobby);
  });

  socket.on("tcgLobbyStartDuel", (data, cb) => {
    const p = getPlayer(socket.id);
    const lobby = p?.tcgLobbyCode ? tcgLobbies.get(p.tcgLobbyCode) : null;
    if (!lobby || lobby.leaderSocketId !== socket.id) return cb?.({ ok: false, error: "Only the lobby leader can start the duel." });
    if (lobby.activeDuelId) return cb?.({ ok: false, error: "A duel is already active." });

    const result = createTcgDuelFromLobby(lobby);
    cb?.(result);
  });

  socket.on("tcgLobbyLeave", () => {
    leaveTcgLobby(socket.id, "Left Card Duel lobby.");
  });

  socket.on("tcgDuelRpsPick", data => {
    const p = getPlayer(socket.id);
    const duel = p?.tcgDuelId ? tcgDuels.get(p.tcgDuelId) : null;
    const choice = String(data?.choice || "").toLowerCase();

    if (!duel || duel.duelId !== data?.duelId || duel.status !== "rps" || duel.rps?.revealing) return;
    if (!TCG_RPS_CHOICES.has(choice)) return;
    if (duel.rps?.picks?.[socket.id]) return;

    duel.rps.picks[socket.id] = choice;
    tcgSetRpsWaitingStatus(duel);

    const resolved = resolveTcgRpsRound(duel);
    if (!resolved) emitTcgDuelUpdate(duel);

    tcgMaybeScheduleNpcAction(duel, true);
  });

  socket.on("tcgDuelTurnChoice", data => {
    const p = getPlayer(socket.id);
    const duel = p?.tcgDuelId ? tcgDuels.get(p.tcgDuelId) : null;

    if (!duel || duel.duelId !== data?.duelId || duel.status !== "turn_choice") return;
    if (duel.chooserSocketId !== socket.id) return;

    const opponentSocketId = getTcgOpponentSocketId(duel, socket.id);
    const choice = data?.choice === "second" ? "second" : "first";
    const firstSocketId = choice === "first" ? socket.id : opponentSocketId;

    startTcgDuelTurns(duel, firstSocketId);
    tcgMaybeScheduleNpcAction(duel, true);
  });

  socket.on("tcgDuelAction", (data, cb) => {
    const p = getPlayer(socket.id);
    const duel = p?.tcgDuelId ? tcgDuels.get(p.tcgDuelId) : null;

    if (!duel || duel.duelId !== data?.duelId) {
      return cb?.({ ok: false, error: "Card Duel not found." });
    }

    let result = { ok: false, error: "Unknown Card Duel action." };

    if (data?.action === "draw_phase") {
      result = tcgDrawForTurn(duel, socket.id);
    } else if (data?.action === "summon") {
      result = tcgSummonCreature(duel, socket.id, data.handIndex, data.slotIndex, data.sacrificeSlots, {
        position: data.position,
        faceDown: !!data.faceDown
      });
    } else if (data?.action === "set_spell_trap") {
      result = tcgSetSpellTrap(duel, socket.id, data.handIndex, data.slotIndex);
    } else if (data?.action === "activate_spell_trap") {
      result = tcgActivateSpellTrap(duel, socket.id, data.slotIndex, data.targetSlotIndex);
    } else if (data?.action === "move_creature") {
      result = tcgMoveCreature(duel, socket.id, data.fromSlotIndex, data.toSlotIndex, data.toRow);
    } else if (data?.action === "move_spell_trap") {
      result = tcgMoveSpellTrap(duel, socket.id, data.fromSlotIndex, data.toSlotIndex);
    } else if (data?.action === "attack") {
      result = tcgAttackWithCreature(duel, socket.id, data.attackerSlotIndex, data.targetSlotIndex, data.attackDirection, data.directLaneIndex);
    } else if (data?.action === "phase") {
      result = tcgSetPhase(duel, socket.id, data.phase);
    } else if (data?.action === "end_turn") {
      result = tcgEndTurn(duel, socket.id);
    } else if (data?.action === "forfeit") {
      forfeitTcgDuel(duel, socket.id, "forfeit");
      result = { ok: true };
    }

    cb?.(result);

    if (result?.ok) {
      tcgMaybeScheduleNpcAction(duel, true);
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
      return socket.emit("partyError", "Invite at least one teammate first, or queue alone and let matchmaking fill the squad.");
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
      if (party.rankedIntent && party.modeIntent === "duo") {
        enqueueRankedDuoParty(party);
      } else {
        createMatchFromParty(party, party.modeIntent || "duo");
      }
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
    p.partyId = entry.partyId || match.partyId || null;

    socket.join(match.matchId);

    const party = p.partyId ? parties.get(p.partyId) : null;

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
    const entry = match?.players.get(socket.id);

    if (!match || !entry || entry.leftMatch || entry.disconnected) return;

    socket.join(data.matchId);
    p.inMatch = true;
    p.matchId = data.matchId;
    entry.lastBroadcastState = null;

    socket.emit("matchSync", makeMatchSyncPayload(match));
    if (match.worldSnapshot) socket.emit("matchWorldSnapshot", match.worldSnapshot);
  });

 socket.on("matchState", incomingState => {
    const rawState = (
      isPlainObject(incomingState) &&
      isPlainObject(incomingState.state)
    )
      ? incomingState.state
      : incomingState;

    const p = getPlayer(socket.id);
    if (!p || !p.matchId || !isPlainObject(rawState)) return;

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



    const rawWeaponCandidate = Object.prototype.hasOwnProperty.call(rawState, "meleeWeapon")
      ? rawState.meleeWeapon
      : entry.state?.meleeWeapon;

    const rawWeapon =
      rawWeaponCandidate &&
      typeof rawWeaponCandidate === "object" &&
      !Array.isArray(rawWeaponCandidate)
        ? rawWeaponCandidate
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
          swingDuration: clampFiniteNumber(rawWeapon.swingDuration, 130, 60, 1000),
          color: String(rawWeapon.color || "").slice(0, 24),
          iconSymbol: String(rawWeapon.iconSymbol || "").slice(0, 16),
          shape: String(rawWeapon.shape || "").slice(0, 32)
        }
      : null;

    // Account changes are blocked while p.inMatch is true, so this cosmetic
    // snapshot can safely stay cached for this match entry.
    let networkCosmetics = entry.networkCosmetics;

    if (!networkCosmetics) {
      const profileEntry = leaderboardProfiles.get(p.playerId) || getOrCreateLeaderboardEntry({
        playerId: p.playerId,
        name: p.name,
        color: p.color,
        icon: p.icon
      });

      const authoritativeAccount = accountEnsureInventory(profileEntry);

      networkCosmetics = entry.networkCosmetics = Object.freeze({
        titleId: authoritativeAccount.equippedTitleId,
        frameId: authoritativeAccount.equippedFrameId,
        customizations: Object.freeze({
          ...authoritativeAccount.equippedCustomizations
        })
      });
    }

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
      radius: clampFiniteNumber(rawState.radius, entry.state?.radius ?? 16, 8, 48),

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

      alive: entry.alive !== false && (rawState.alive ?? entry.state?.alive ?? true) !== false,
      isDowned: entry.alive !== false && !!(rawState.isDowned ?? entry.state?.isDowned),
      downedTimer: clampFiniteNumber(rawState.downedTimer, entry.state?.downedTimer ?? 0, 0, 120),

      color: String(p.color || "#38bdf8").slice(0, 24),
      titleId: networkCosmetics.titleId,
      frameId: networkCosmetics.frameId,
      customizations: networkCosmetics.customizations,

      floor: String(rawState.floor ?? entry.state?.floor ?? "surface").slice(0, 64),
      scopeLevel: String(rawState.scopeLevel ?? entry.state?.scopeLevel ?? "x1").slice(0, 8),
      visionRadius: clampFiniteNumber(rawState.visionRadius, entry.state?.visionRadius ?? 320, 120, 2500),

      selectedMelee: !!(rawState.selectedMelee ?? entry.state?.selectedMelee),
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

    const deltaPayload = makeMatchStateDeltaPayload(match, entry, state, now);
    if (deltaPayload) {
      socket.to(match.matchId).emit("matchState", deltaPayload);
    }
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
      recordRankedPlayerElimination(match, sourceEntry, target);

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
      const targetX = Number(rawAction.targetX);
      const targetY = Number(rawAction.targetY);
      const hasTarget = Number.isFinite(targetX) && Number.isFinite(targetY) && isPointInBounds(targetX, targetY, bounds);
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
        color: sanitizeMatchActionColor(rawAction.color, "#38bdf8"),
        ...(hasTarget ? { targetX, targetY } : {})
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

    const authority = reconcileWorldAuthority(
      match,
      "snapshot_recovery"
    ).worldAuthoritySocketId;

    if (authority !== socket.id) return;
    if (!isEligibleWorldAuthority(match, socket.id)) return;

    const now = Date.now();

    if (
      now - (match.lastWorldSnapshotAt || 0) <
      WORLD_SNAPSHOT_MIN_MS
    ) {
      return;
    }

    const incoming = sanitizeWorldSnapshot(snapshot);

    // Deltas require a previously accepted full baseline.
    if (!incoming.full && !match.worldSnapshot?.full) {
      return;
    }

    match.lastWorldSnapshotAt = now;

    match.worldSnapshot = mergeWorldSnapshot(
      match.worldSnapshot,
      incoming,
      match.matchId
    );

    // Existing players receive only the compact delta.
    // Reconnecting/joining players receive match.worldSnapshot,
    // which remains a complete merged baseline.
    socket.to(p.matchId).emit("matchWorldSnapshot", {
      ...incoming,
      matchId: match.matchId
    });
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

    cleanupEmptyMatch(match, "left_match");

    broadcastOnlineList();
    if (p.partyId) emitPartyUpdate(p.partyId);
    return;
  }

  // death/elimination
  if (entry) {
    entry.alive = false;
    entry.hp = 0;
  }

  const now = Date.now();
  const killerSocketId =
    entry &&
    now - Number(entry.lastDamageAt || 0) <= RANKED_LAST_DAMAGE_CREDIT_MS &&
    typeof entry.lastDamageSourceSocketId === "string" &&
    match.players.has(entry.lastDamageSourceSocketId)
      ? entry.lastDamageSourceSocketId
      : null;

  const killerEntry = killerSocketId ? match.players.get(killerSocketId) : null;
  const killerProfile = killerSocketId ? getPlayer(killerSocketId) : null;

  if (entry && killerEntry) {
    recordRankedPlayerElimination(match, killerEntry, entry);
  }

  socket.to(matchId).emit("matchPlayerEliminated", {
    victimSocketId: socket.id,
    killerSocketId,
    victimName: p.name,
    killerName: killerProfile?.name || "Unknown"
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
    entry.gold = 1000;
    entry.gems = 0;
    entry.account = accountDefaultInventory();
    entry.account.migratedAt = Date.now();
    entry.reportKeys = new Set();
    entry.updatedAt = Date.now();
    accountSyncPlayerCurrency(entry, p);
    rankedScheduleSave();

    socket.emit("profileAssigned", privatePlayerProfile(p));
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

    const entry = getOrCreateLeaderboardEntry({
      playerId: p.playerId,
      name: p.name,
      color: p.color,
      icon: p.icon
    });

    const profileXp = accountGrantReward(entry, reward);

    reward.claimed = true;
    reward.paidAt = Date.now();

    accountSyncPlayerCurrency(entry, p);
    p.level = entry.level;
    p.profileXp = entry.profileXp;

    rankedRewardInbox.set(p.playerId, rewards);
    rankedScheduleSave();

    const privateProfile = privatePlayerProfile(p);
    socket.emit("profileAssigned", privateProfile);
    cb?.({
      ok: true,
      reward: {
        ...reward,
        profileXp: profileXp.xp
      },
      profile: privateProfile,
      account: accountSnapshot(entry)
    });

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
      if (p.partyId) {
        removeRankedDuoPartyFromQueue(p.partyId, "A ranked party member disconnected.");
      }

      if (p.voiceReady) {
        emitVoicePeerLeft(socket.id, "disconnected");
        p.voiceReady = false;
      }

      if (p.playerId && idToSocket.get(p.playerId) === socket.id) idToSocket.delete(p.playerId);

      const tcgDuel = p.tcgDuelId ? tcgDuels.get(p.tcgDuelId) : null;

      if (tcgDuel) {
        forfeitTcgDuel(tcgDuel, socket.id, "disconnect");
      }

      if (p.tcgLobbyCode) {
        leaveTcgLobby(socket.id, "Disconnected from Card Duel lobby.");
      }

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
