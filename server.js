const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

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

app.get("/", (req, res) => {
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
    inMatch: !!p.inMatch
  };
}

function broadcastOnlineList() {
  io.emit("onlinePlayers", [...players.values()].map(publicPlayer));
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

function createParty(leaderId, guestId) {
  const leader = getPlayer(leaderId);
  const guest = getPlayer(guestId);
  if (!leader || !guest) return null;

  leaveParty(leaderId);
  leaveParty(guestId);

  const partyId = makePartyId();

  const party = {
    partyId,
    leaderId,
    members: [leaderId, guestId],
    ready: {
      [leaderId]: false,
      [guestId]: false
    },
    status: "lobby",
    matchId: null,
    seed: null
  };

  parties.set(partyId, party);
  leader.partyId = partyId;
  guest.partyId = partyId;

  emitPartyUpdate(partyId);
  broadcastOnlineList();

  return party;
}

function createDuoMatchFromParty(party) {
  const matchId = makeMatchId();
  const seed = makeSeed();

  const match = {
    matchId,
    seed,
    mode: "duo",
    partyId: party.partyId,
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

  for (const socketId of party.members) {
    io.to(socketId).emit("partyMatchStart", {
      matchId,
      seed,
      partyId: party.partyId,
      teammates: party.members
        .map(id => getPlayer(id))
        .filter(Boolean)
        .map(publicPlayer)
    });
  }

  emitPartyUpdate(party.partyId);
  broadcastOnlineList();
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
    if (target.partyId) return socket.emit("partyInviteFailed", "That player is already in a Duo lobby.");

    targetSocket.emit("partyInviteIncoming", {
      fromSocketId: socket.id,
      fromPlayer: publicPlayer(from)
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

  socket.on("partyStartDuoReady", () => {
    const p = getPlayer(socket.id);
    if (!p || !p.partyId) return;

    const party = parties.get(p.partyId);
    if (!party) return;
    if (party.leaderId !== socket.id) return socket.emit("partyError", "Only the lobby leader can start Duo.");

    party.status = "readying";
    for (const id of party.members) party.ready[id] = false;

    emitPartyUpdate(party.partyId);
  });

  socket.on("partyReady", ready => {
    const p = getPlayer(socket.id);
    if (!p || !p.partyId) return;

    const party = parties.get(p.partyId);
    if (!party) return;

    party.ready[socket.id] = !!ready;
    emitPartyUpdate(party.partyId);

    const allReady = party.members.length >= 2 && party.members.every(id => party.ready[id]);

    if (party.status === "readying" && allReady) {
      createDuoMatchFromParty(party);
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
        teamId: p.partyId || socket.id,
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

    socket.to(p.matchId).emit("matchState", {
      ...state,
      socketId: socket.id,
      playerId: p.playerId,
      name: p.name,
      color: p.color,
      level: p.level,
      rank: p.rank,
      teamId: entry.teamId
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

  socket.on("matchDamage", data => {
    const source = getPlayer(socket.id);
    if (!source || !source.matchId) return;

    const match = matches.get(source.matchId);
    if (!match) return;

    const targetSocketId = data?.targetSocketId;
    const target = match.players.get(targetSocketId);

    if (!target || !target.alive) return;

    const amount = Math.max(0, Math.min(300, Number(data?.amount || 0)));
    target.hp = Math.max(0, target.hp - amount);

    io.to(targetSocketId).emit("matchDamageTaken", {
      amount,
      damageType: data?.damageType || "online",
      sourceSocketId: socket.id,
      sourceName: source.name
    });

    io.to(source.matchId).emit("matchDamageFx", {
      targetSocketId,
      amount,
      x: target.x,
      y: target.y,
      damageType: data?.damageType || "online"
    });

    if (target.hp <= 0) {
      target.alive = false;

      io.to(source.matchId).emit("matchPlayerEliminated", {
        victimSocketId: targetSocketId,
        killerSocketId: socket.id,
        victimName: target.name,
        killerName: source.name
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

  // Leaving during queue should cancel the queue for both Duo players,
  // not declare the remaining player as winner.
  if (reason === "left_match" && phase === "QUEUE_LOBBY") {
    cancelMatchBackToPartyLobby(match, `${p.name} left the queue.`);
    return;
  }

  // Leaving during an active island match should only remove that player.
  // It should not force the partner out and should not trigger a fake win.
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

  // Real death/elimination.
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

            // Do NOT call checkMatchWinner here.
            // A disconnect/leave is not a legitimate match victory.
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
