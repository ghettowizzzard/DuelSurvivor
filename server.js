const express = require("express");
const cors = require("cors");
const path = require("path");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();

app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 10000;

const players = new Map();
const idToSocket = new Map();
const parties = new Map();
const matches = new Map();
const leaderboardProfiles = new Map();

const PARTY_MAX_SIZE = 4;
const MATCH_TOTAL_SLOTS = 100;
const MATCH_BOT_MIN = 40;
const MATCH_BOT_MAX = 99;
const ONLINE_QUEUE_MS = 15000;
const WORLD_SNAPSHOT_MIN_MS = 160;
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

function getMatchHumanCount(match) {
  if (!match) return 0;
  return [...match.players.values()].filter(p => p && !p.leftMatch && !p.disconnected).length;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rollMatchBotTarget(humanCount = 1) {
  const safeHumanCount = Math.max(1, Number(humanCount) || 1);
  const maxBotsForSlots = Math.max(0, MATCH_TOTAL_SLOTS - safeHumanCount);
  if (maxBotsForSlots <= 0) return 0;

  const minBots = Math.min(MATCH_BOT_MIN, maxBotsForSlots);
  const activeOnline = Math.max(safeHumanCount, players.size || safeHumanCount);
  const popularityRatio = clampNumber((activeOnline - safeHumanCount) / Math.max(1, MATCH_TOTAL_SLOTS - safeHumanCount), 0, 1);
  const lowPopulationTarget = MATCH_BOT_MIN + Math.round((MATCH_BOT_MAX - MATCH_BOT_MIN) * (1 - popularityRatio));
  const jitter = Math.floor(Math.random() * 17) - 8;

  let target = clampNumber(lowPopulationTarget + jitter, minBots, maxBotsForSlots);

  if (Math.random() < (popularityRatio < 0.18 ? 0.22 : 0.08)) {
    target = maxBotsForSlots;
  } else if (Math.random() < 0.12) {
    target = clampNumber(target - Math.floor(Math.random() * 18), minBots, maxBotsForSlots);
  }

  return Math.round(target);
}

function getMatchBotTarget(match, humanCount = getMatchHumanCount(match)) {
  const maxBotsForSlots = Math.max(0, MATCH_TOTAL_SLOTS - Math.max(0, humanCount));
  const configured = Number(match?.botTarget);

  if (Number.isFinite(configured)) {
    return Math.max(0, Math.min(maxBotsForSlots, Math.round(configured)));
  }

  return Math.min(MATCH_BOT_MIN, maxBotsForSlots);
}

function chooseWorldAuthority(match) {
  if (!match) return null;

  const current = match.worldAuthoritySocketId;
  if (current && match.players.has(current) && io.sockets.sockets.has(current)) return current;

  const next = [...match.players.keys()].find(socketId => io.sockets.sockets.has(socketId)) || null;
  match.worldAuthoritySocketId = next;
  return next;
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

function broadcastMatchSync(match) {
  if (!match) return;
  io.to(match.matchId).emit("matchSync", makeMatchSyncPayload(match));
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
      amount: Number(item.amount || 0)
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
    voiceRange: Number(p.voiceRange || 650)
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

function safeStatInt(value, fallback = 0, max = 999999) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.round(n)));
}

function getOrCreateLeaderboardEntry(profile = {}) {
  const playerId = String(profile.playerId || "").trim() || makeSurvivorId();

  let entry = leaderboardProfiles.get(playerId);

  if (!entry) {
    entry = {
      playerId,
      name: String(profile.name || playerId).trim().slice(0, 24),
      rank: String(profile.rank || "SURVIVOR").trim().slice(0, 32),
      level: Math.min(PROFILE_MAX_LEVEL, safeStatInt(profile.level, 1, PROFILE_MAX_LEVEL)),
      profileXp: safeStatInt(profile.profileXp ?? profile.xp, 0, 999999999),
      wins: 0,
      kills: 0,
      deaths: 0,
      losses: 0,
      revives: 0,
      color: profile.color || "#38bdf8",
      icon: profile.icon || "DS",
      reportKeys: new Set(),
      firstSeenAt: Date.now(),
      updatedAt: Date.now()
    };

    leaderboardProfiles.set(playerId, entry);
  }

  if (!(entry.reportKeys instanceof Set)) entry.reportKeys = new Set();

  entry.name = String(profile.name || entry.name || playerId).trim().slice(0, 24);
  entry.rank = String(profile.rank || entry.rank || "SURVIVOR").trim().slice(0, 32);
  entry.level = Math.min(PROFILE_MAX_LEVEL, Math.max(safeStatInt(entry.level, 1, PROFILE_MAX_LEVEL), safeStatInt(profile.level, 1, PROFILE_MAX_LEVEL)));
  entry.profileXp = Math.max(safeStatInt(entry.profileXp, 0, 999999999), safeStatInt(profile.profileXp ?? profile.xp, 0, 999999999));
  if (entry.level >= PROFILE_MAX_LEVEL) entry.profileXp = 0;
  entry.color = profile.color || entry.color || "#38bdf8";
  entry.icon = profile.icon || entry.icon || "DS";

  entry.wins = Math.max(safeStatInt(entry.wins), safeStatInt(profile.wins));
  entry.kills = Math.max(safeStatInt(entry.kills), safeStatInt(profile.kills));
  entry.deaths = Math.max(safeStatInt(entry.deaths), safeStatInt(profile.deaths));
  entry.losses = Math.max(safeStatInt(entry.losses), safeStatInt(profile.losses));
  entry.revives = Math.max(safeStatInt(entry.revives), safeStatInt(profile.revives));
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
  entry.updatedAt = Date.now();

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

function checkMatchWinner(match) {
  if (!match) return;

  const alive = [...match.players.values()].filter(p => p.alive);
  if (alive.length <= 0) return;

  const aliveTeams = [...new Set(alive.map(p => p.teamId || p.socketId))];

  if (aliveTeams.length === 1) {
    const winners = alive.filter(p => (p.teamId || p.socketId) === aliveTeams[0]);

    for (const entry of match.players.values()) {
      const won = winners.some(w => w.socketId === entry.socketId);

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
}

io.on("connection", socket => {
  console.log("[socket] connected:", socket.id);

  socket.on("register", data => {
    console.log("[socket] register:", socket.id, data?.playerId, data?.name);
    let playerId = String(data?.playerId || "").trim();

    if (!playerId || idToSocket.has(playerId)) {
      playerId = makeSurvivorId();
    }

    idToSocket.set(playerId, socket.id);

    const p = {
      socketId: socket.id,
      playerId,
      name: String(data?.name || playerId).trim().slice(0, 24),
      rank: data?.rank || "SURVIVOR",
      level: Math.max(1, Math.min(PROFILE_MAX_LEVEL, Number(data?.level || 1))),
      profileXp: Number(data?.profileXp || data?.xp || 0),
      wins: Number(data?.wins || 0),
      kills: Number(data?.kills || 0),
      deaths: Number(data?.deaths || 0),
      losses: Number(data?.losses || 0),
      revives: Number(data?.revives || 0),
      gold: Number(data?.gold || 0),
      gems: Number(data?.gems || 0),
      color: data?.color || "#38bdf8",
      icon: data?.icon || "DS",
      partyId: null,
      inMatch: false,
      matchId: null
    };

    players.set(socket.id, p);

    const leaderboardEntry = getOrCreateLeaderboardEntry(p);
    p.level = leaderboardEntry.level;
    p.profileXp = leaderboardEntry.profileXp || 0;
    p.wins = leaderboardEntry.wins;
    p.kills = leaderboardEntry.kills;
    p.deaths = leaderboardEntry.deaths;
    p.losses = leaderboardEntry.losses;
    p.revives = leaderboardEntry.revives;

    socket.emit("profileAssigned", publicPlayer(p));
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

  function startPartyReadyCheck(mode = "duo") {
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
    party.teamSize = TEAM_SIZE_BY_MODE[cleanMode] || 2;

    for (const id of party.members) {
      party.ready[id] = false;
    }

    emitPartyUpdate(party.partyId);
  }

  socket.on("partyStartModeReady", data => {
    startPartyReadyCheck(data?.mode || "duo");
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

  socket.on("matchState", state => {
    const p = getPlayer(socket.id);
    if (!p || !p.matchId) return;

    const match = matches.get(p.matchId);
    if (!match) return;

    let entry = match.players.get(socket.id);

    if (!entry) {
      entry = {
        socketId: socket.id,
        playerId: p.playerId,
        name: p.name,
        teamId: p.partyId || state?.teamId || socket.id,
        alive: true,
        hp: 100,
        x: 0,
        y: 0,
        angle: 0
      };

      match.players.set(socket.id, entry);
      socket.join(p.matchId);
    }

    entry.x = Number(state?.x || 0);
    entry.y = Number(state?.y || 0);
    entry.angle = Number(state?.angle || 0);
    entry.hp = Number(state?.hp ?? entry.hp);
    entry.maxHp = Number(state?.maxHp ?? entry.maxHp ?? 100);
    entry.shieldHp = Math.max(0, Math.round(Number(state?.shieldHp ?? entry.shieldHp ?? 0)));
    entry.shieldMax = Math.max(0, Math.round(Number(state?.shieldMax ?? entry.shieldMax ?? 0)));
    entry.armorHp = Math.max(0, Math.round(Number(state?.armorHp ?? entry.armorHp ?? 0)));
    entry.armorMax = Math.max(1, Math.round(Number(state?.armorMax ?? entry.armorMax ?? 100)));
    entry.alive = state?.alive !== false;
    entry.state = {
      ...(entry.state || {}),
      ...state,
      hp: entry.hp,
      health: entry.hp,
      maxHp: entry.maxHp,
      shieldHp: entry.shieldHp,
      shieldMax: entry.shieldMax,
      armorHp: entry.armorHp,
      armorMax: entry.armorMax,
      gameState: state?.gameState || entry.state?.gameState || "MATCH",
      floor: state?.floor || entry.state?.floor || "surface",
      updatedAt: Date.now()
    };

    socket.to(p.matchId).emit("matchState", {
      ...state,
      socketId: socket.id,
      playerId: p.playerId,
      name: p.name,
      color: p.color,
      level: p.level,
      rank: p.rank,
      teamId: entry.teamId,
      matchMode: match.mode,
      teamSize: match.teamSize || 2
    });
  });

    socket.on("matchAction", action => {
    const p = getPlayer(socket.id);
    if (!p || !p.matchId) return;

    socket.to(p.matchId).emit("matchAction", {
      ...action,
      fromSocketId: socket.id,
      fromPlayerId: p.playerId,
      fromName: p.name
    });
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

    const authority = chooseWorldAuthority(match);
    if (authority && authority !== socket.id) return;

    const now = Date.now();
    if (now - (match.lastWorldSnapshotAt || 0) < WORLD_SNAPSHOT_MIN_MS) return;

    match.worldAuthoritySocketId = socket.id;
    match.lastWorldSnapshotAt = now;
    match.worldSnapshot = sanitizeWorldSnapshot(snapshot);

    socket.to(p.matchId).emit("matchWorldSnapshot", match.worldSnapshot);
  });

  socket.on("matchDamage", data => {
    const source = getPlayer(socket.id);
    if (!source || !source.matchId) return;

    const match = matches.get(source.matchId);
    if (!match) return;

    const sourceEntry = match.players.get(socket.id);
    const targetSocketId = String(data?.targetSocketId || "");
    const target = match.players.get(targetSocketId);

    if (!sourceEntry || !sourceEntry.alive || !target || !target.alive) return;
    if (targetSocketId === socket.id) return;
    if ((sourceEntry.teamId || socket.id) === (target.teamId || targetSocketId)) return;

    const rawAmount = Number(data?.rawDamage ?? data?.amount ?? 0);
    const rawHpDamage = Number(data?.hpDamage ?? rawAmount);
    const rawArmorDamage = Number(data?.armorDamage ?? 0);
    const rawShieldDamage = Number(data?.shieldDamage ?? 0);

    if (![rawAmount, rawHpDamage, rawArmorDamage, rawShieldDamage].some(Number.isFinite)) return;

    const sx = Number(sourceEntry.x);
    const sy = Number(sourceEntry.y);
    const tx = Number(target.x);
    const ty = Number(target.y);

    if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(tx) && Number.isFinite(ty)) {
      const dist = Math.hypot(tx - sx, ty - sy);
      if (dist > 1800) return;
    }

    const amount = Math.max(0, Math.min(120, Math.round(Number.isFinite(rawAmount) ? rawAmount : 0)));
    const hpDamage = Math.max(0, Math.min(120, Math.round(Number.isFinite(rawHpDamage) ? rawHpDamage : amount)));
    const armorDamage = Math.max(0, Math.min(120, Math.round(Number.isFinite(rawArmorDamage) ? rawArmorDamage : 0)));
    const shieldDamage = Math.max(0, Math.min(120, Math.round(Number.isFinite(rawShieldDamage) ? rawShieldDamage : 0)));
    const damageType = String(data?.damageType || "online").slice(0, 40);

    if (amount <= 0 && hpDamage <= 0 && armorDamage <= 0 && shieldDamage <= 0) return;

    const reportedTargetHp = Number(data?.targetHp ?? data?.targetHealth);
    const reportedTargetMaxHp = Number(data?.targetMaxHp ?? data?.targetMaxHealth);
    const reportedTargetShieldHp = Number(data?.targetShieldHp);
    const reportedTargetShieldMax = Number(data?.targetShieldMax);
    const reportedTargetArmorHp = Number(data?.targetArmorHp);
    const reportedTargetArmorMax = Number(data?.targetArmorMax);

    target.hp = Math.max(0, Number.isFinite(reportedTargetHp) ? Math.round(reportedTargetHp) : target.hp - hpDamage);
    target.maxHp = Math.max(1, Math.round(Number.isFinite(reportedTargetMaxHp) ? reportedTargetMaxHp : target.maxHp ?? target.state?.maxHp ?? 100));
    target.shieldHp = Math.max(0, Math.round(Number.isFinite(reportedTargetShieldHp) ? reportedTargetShieldHp : target.shieldHp ?? target.state?.shieldHp ?? 0));
    target.shieldMax = Math.max(0, Math.round(Number.isFinite(reportedTargetShieldMax) ? reportedTargetShieldMax : target.shieldMax ?? target.state?.shieldMax ?? 0));
    target.armorHp = Math.max(0, Math.round(Number.isFinite(reportedTargetArmorHp) ? reportedTargetArmorHp : target.armorHp ?? target.state?.armorHp ?? 0));
    target.armorMax = Math.max(1, Math.round(Number.isFinite(reportedTargetArmorMax) ? reportedTargetArmorMax : target.armorMax ?? target.state?.armorMax ?? 100));
    target.lastDamageAt = Date.now();
    target.lastDamageSourceSocketId = socket.id;
    target.lastRawDamage = amount;
    target.lastHpDamage = hpDamage;
    target.lastArmorDamage = armorDamage;
    target.lastShieldDamage = shieldDamage;
    target.state = {
      ...(target.state || {}),
      hp: target.hp,
      health: target.hp,
      maxHp: target.maxHp,
      shieldHp: target.shieldHp,
      shieldMax: target.shieldMax,
      armorHp: target.armorHp,
      armorMax: target.armorMax
    };

    io.to(targetSocketId).emit("matchDamageTaken", {
      amount,
      rawDamage: amount,
      hpDamage,
      armorDamage,
      shieldDamage,
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
      amount: hpDamage > 0 ? hpDamage : armorDamage > 0 ? armorDamage : shieldDamage > 0 ? shieldDamage : amount,
      rawDamage: amount,
      hpDamage,
      armorDamage,
      shieldDamage,
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

  socket.on("matchResultReport", data => {
    const result = applyLeaderboardMatchReport(socket.id, data);
    if (!result.ok) return;

    socket.emit("profileAssigned", publicPlayer(getPlayer(socket.id)));
    broadcastOnlineList();
    broadcastLeaderboards();
  });

  socket.on("disconnect", () => {
    const p = getPlayer(socket.id);

       if (p) {
      if (p.voiceReady) {
        emitVoicePeerLeft(socket.id, "disconnected");
        p.voiceReady = false;
      }

      if (p.playerId) idToSocket.delete(p.playerId);

      if (p.partyId) leaveParty(socket.id);

      if (p.matchId) {
        const matchId = p.matchId;
        const match = matches.get(matchId);

        if (match) {
          const entry = match.players.get(socket.id);
          const phase = entry?.state?.gameState || "";

          if (phase === "QUEUE_LOBBY") {
            cancelMatchBackToPartyLobby(match, `${p.name} disconnected during queue.`);
          } else {
            if (entry) {
              entry.alive = false;
              entry.hp = 0;
              entry.disconnected = true;
              entry.disconnectedAt = Date.now();
            }

            socket.to(matchId).emit("matchPlayerLeft", {
              socketId: socket.id,
              playerId: p.playerId,
              name: p.name,
              reason: "disconnected"
            });
          }
        }
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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Duel Survivor multiplayer server running on ${PORT}`);
});
