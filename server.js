const express = require("express");
const cors = require("cors");
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
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

const PARTY_MAX_SIZE = 4;
const MATCH_TOTAL_SLOTS = 60;
const ONLINE_QUEUE_MS = 15000;
const WORLD_SNAPSHOT_MIN_MS = 160;

const TEAM_SIZE_BY_MODE = {
  duo: 2,
  team: 4
};

function getMatchHumanCount(match) {
  if (!match) return 0;
  return [...match.players.values()].filter(p => p && !p.leftMatch && !p.disconnected).length;
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
  const worldAuthoritySocketId = chooseWorldAuthority(match);

  return {
    matchId: match.matchId,
    seed: match.seed,
    mode: match.mode,
    teamSize: match.teamSize || 2,
    totalSlots: MATCH_TOTAL_SLOTS,
    humanCount,
    botCount: Math.max(0, MATCH_TOTAL_SLOTS - humanCount),
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
    bots: Array.isArray(snapshot?.bots) ? snapshot.bots.slice(0, 80).map(bot => ({
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
    level: p.level || 1,
    wins: p.wins || 0,
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

function getVoiceRoomId(p) {
  if (!p) return null;
  if (p.matchId && matches.has(p.matchId)) return `match:${p.matchId}`;
  if (p.partyId && parties.has(p.partyId)) return `party:${p.partyId}`;
  return null;
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
      botCount: Math.max(0, MATCH_TOTAL_SLOTS - teammates.length),
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
        if (won) profile.wins = (profile.wins || 0) + 1;
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
      level: Number(data?.level || 1),
      wins: Number(data?.wins || 0),
      gold: Number(data?.gold || 0),
      gems: Number(data?.gems || 0),
      color: data?.color || "#38bdf8",
      icon: data?.icon || "DS",
      partyId: null,
      inMatch: false,
      matchId: null
    };

    players.set(socket.id, p);
    socket.emit("profileAssigned", publicPlayer(p));
    broadcastOnlineList();
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
    entry.alive = state?.alive !== false;
    entry.state = {
      ...(entry.state || {}),
      ...state,
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
      socket.emit("voiceError", { message: "Join a party lobby or online match before enabling voice." });
      return;
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

    if (!Number.isFinite(rawAmount) || rawAmount <= 0) return;

    const sx = Number(sourceEntry.x);
    const sy = Number(sourceEntry.y);
    const tx = Number(target.x);
    const ty = Number(target.y);

    if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(tx) && Number.isFinite(ty)) {
      const dist = Math.hypot(tx - sx, ty - sy);
      if (dist > 1800) return;
    }

    const amount = Math.max(0, Math.min(120, Math.round(rawAmount)));
    const hpDamage = Math.max(0, Math.min(120, Math.round(Number.isFinite(rawHpDamage) ? rawHpDamage : amount)));
    const armorDamage = Math.max(0, Math.min(120, Math.round(Number.isFinite(rawArmorDamage) ? rawArmorDamage : 0)));
    const shieldDamage = Math.max(0, Math.min(120, Math.round(Number.isFinite(rawShieldDamage) ? rawShieldDamage : 0)));
    const damageType = String(data?.damageType || "online").slice(0, 40);

    if (amount <= 0 && hpDamage <= 0 && armorDamage <= 0 && shieldDamage <= 0) return;

    target.hp = Math.max(0, target.hp - hpDamage);
    target.lastDamageAt = Date.now();
    target.lastDamageSourceSocketId = socket.id;
    target.lastRawDamage = amount;
    target.lastHpDamage = hpDamage;
    target.lastArmorDamage = armorDamage;
    target.lastShieldDamage = shieldDamage;

    io.to(targetSocketId).emit("matchDamageTaken", {
      amount,
      rawDamage: amount,
      hpDamage,
      armorDamage,
      shieldDamage,
      damageType,
      sourceSocketId: socket.id,
      sourceName: source.name
    });

    io.to(source.matchId).emit("matchDamageFx", {
      targetSocketId,
      amount: hpDamage > 0 ? hpDamage : amount,
      rawDamage: amount,
      hpDamage,
      armorDamage,
      shieldDamage,
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

    players.delete(socket.id);
    broadcastOnlineList();
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Duel Survivor multiplayer server running on ${PORT}`);
});
