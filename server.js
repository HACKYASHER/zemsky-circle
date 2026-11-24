"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const helmet = require("helmet");
const { Server } = require("socket.io");
const Rules = require("./rules");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 50);
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 3);
const ROOM_IDLE_MS = Number(process.env.ROOM_IDLE_HOURS || 4) * 60 * 60 * 1000;
const RECONNECT_GRACE_MS = 2 * 60 * 1000;
const CREATE_WINDOW_MS = 15 * 60 * 1000;
const JOIN_WINDOW_MS = 60 * 1000;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const ROOMS_FILE = path.join(DATA_DIR, "lobbies.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(helmet({
  hsts: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      upgradeInsecureRequests: null,
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
const httpsHsts = helmet.hsts({ maxAge: 31536000, includeSubDomains: true });
app.use((req, res, next) => {
  if (req.secure) return httpsHsts(req, res, next);
  next();
});
app.get("/health", (_req, res) => res.status(200).json({ ok: true, service: "zemsky-circle" }));
app.use(express.static(PUBLIC_DIR, { index: "index.html", maxAge: 0, etag: true }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 32 * 1024,
  pingInterval: 25000,
  pingTimeout: 20000,
  serveClient: true,
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    try {
      const source = new URL(origin);
      const host = req.headers.host;
      callback(null, Boolean(host && source.host === host));
    } catch {
      callback(null, false);
    }
  }
});

const rooms = new Map();
const createAttempts = new Map();
const joinAttempts = new Map();

function now() { return Date.now(); }
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function makeToken() { return crypto.randomBytes(32).toString("base64url"); }
function makeCode() {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}
function cleanName(value) {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 22);
  return name || "Игрок";
}
function cleanCode(value) {
  const code = String(value ?? "").toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 8);
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : "";
}
function clientIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (process.env.TRUST_PROXY === "1" && typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return socket.handshake.address || "unknown";
}
function allowAttempt(store, key, limit, windowMs) {
  const time = now();
  const recent = (store.get(key) || []).filter(t => time - t < windowMs);
  if (recent.length >= limit) { store.set(key, recent); return false; }
  recent.push(time); store.set(key, recent); return true;
}
function ackWith(ack, data) { if (typeof ack === "function") ack(data); }
function roomChannel(code) { return "room:" + code; }
function roomHasLivePlayer(room) { return room.players.some(p => p.connected && !p.left); }
function byId(room, id) { return room.players.find(player => player.id === id); }
function playerForSocket(socket) {
  const member = socket.data.member;
  if (!member) return null;
  const room = rooms.get(member.code);
  const player = room && byId(room, member.playerId);
  if (!room || !player || player.socketId !== socket.id || !player.connected || player.left) return null;
  return { room, player };
}
function publicRoom(room) {
  const visiblePlayers = room.game ? room.players : room.players.filter(player => !player.left);
  const activePlayers = visiblePlayers.filter(player => !player.left);
  let current = null;
  if (room.game) {
    const actor = Rules.currentActor(room.game);
    if (actor) {
      const player = byId(room, actor.playerId);
      const disconnectedFor = player?.disconnectedAt ? now() - player.disconnectedAt : 0;
      current = {
        playerId: actor.playerId,
        name: player?.name || "Игрок",
        connected: Boolean(player?.connected),
        left: Boolean(player?.left),
        kind: actor.kind,
        roleKey: actor.roleKey,
        roleName: actor.roleName,
        canTakeover: Boolean(player && (player.left || (!player.connected && disconnectedFor >= RECONNECT_GRACE_MS)))
      };
    }
  }
  const connected = activePlayers.filter(player => player.connected);
  const ready = connected.filter(player => room.game?.readyIds?.includes(player.id)).length;
  return {
    code: room.code,
    phase: room.game ? room.game.phase : "lobby",
    hostId: room.hostId,
    players: visiblePlayers.map(player => ({
      id: player.id, name: player.name, connected: Boolean(player.connected),
      ready: Boolean(player.ready), isHost: player.id === room.hostId,
      left: Boolean(player.left)
    })),
    game: room.game ? JSON.parse(JSON.stringify(room.game)) : null,
    currentActor: current,
    connectedCount: connected.length,
    readyToContinue: ready,
    allConnectedReady: connected.length > 0 && ready === connected.length,
    maxPlayers: 4,
    minPlayers: 2,
    updatedAt: room.updatedAt
  };
}
function touch(room) {
  room.updatedAt = now();
}
function persistRooms() {
  try {
    const snapshot = Array.from(rooms.values()).map(room => ({
      code: room.code,
      phase: room.game ? room.game.phase : "lobby",
      hostId: room.hostId,
      hostIpHash: room.hostIpHash,
      players: room.players.map(player => ({
        id: player.id, name: player.name, tokenHash: player.tokenHash,
        connected: false, socketId: null, disconnectedAt: player.connected ? now() : (player.disconnectedAt || now()),
        joinedAt: player.joinedAt, ready: Boolean(player.ready), left: Boolean(player.left)
      })),
      game: room.game,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt
    }));
    const temp = ROOMS_FILE + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, ROOMS_FILE);
  } catch (error) {
    console.error("Не удалось сохранить комнаты:", error.message);
  }
}
function restoreRooms() {
  try {
    if (!fs.existsSync(ROOMS_FILE)) return;
    const snapshot = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));
    for (const saved of snapshot) {
      if (!saved || !cleanCode(saved.code) || now() - Number(saved.updatedAt || 0) > ROOM_IDLE_MS) continue;
      const players = Array.isArray(saved.players) ? saved.players.slice(0, 4).map(player => ({
        ...player, connected: false, socketId: null, disconnectedAt: now(), left: Boolean(player.left)
      })) : [];
      if (!players.some(p => !p.left)) continue;
      rooms.set(saved.code, {
        code: saved.code, phase: saved.phase || "lobby", hostId: saved.hostId,
        hostIpHash: saved.hostIpHash || "", players, game: saved.game || null,
        createdAt: saved.createdAt || now(), updatedAt: saved.updatedAt || now()
      });
    }
    if (rooms.size) console.log("Восстановлено комнат:", rooms.size);
  } catch (error) {
    console.error("Не удалось загрузить сохранённые комнаты:", error.message);
  }
}
function emitRoom(room) {
  io.to(roomChannel(room.code)).emit("room:state", publicRoom(room));
}
function emitSingle(socket, room) {
  socket.emit("room:state", publicRoom(room));
}
function attachPlayer(socket, room, player, token, ack) {
  const oldSocketId = player.socketId;
  if (oldSocketId && oldSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);
    if (oldSocket) oldSocket.disconnect(true);
  }
  player.socketId = socket.id;
  player.connected = true;
  player.disconnectedAt = null;
  player.left = false;
  player.ready = room.game ? player.ready : player.id === room.hostId ? true : player.ready;
  assignHost(room);
  socket.data.member = { code: room.code, playerId: player.id };
  socket.join(roomChannel(room.code));
  if (room.game?.phase === "intermission" && checkAllReady(room)) advanceAfterIntermission(room);
  touch(room);
  persistRooms();
  ackWith(ack, { ok: true, token, playerId: player.id, room: publicRoom(room) });
  emitRoom(room);
}
function assignHost(room) {
  if (room.hostId && byId(room, room.hostId)?.connected && !byId(room, room.hostId)?.left) return;
  const next = room.players.find(player => player.connected && !player.left);
  if (next) {
    if (room.hostId === next.id) return;
    room.hostId = next.id;
    next.ready = room.game ? next.ready : true;
    room.log?.push?.({ round: 0, title: "Ведущий сменился", text: "Права ведущего перешли к " + next.name + "." });
    return true;
  }
  return false;
}
function removeLobbyPlayer(room, player, reason) {
  const socketId = player.socketId;
  room.players = room.players.filter(item => item.id !== player.id);
  if (room.hostId === player.id) room.hostId = null;
  const target = socketId && io.sockets.sockets.get(socketId);
  if (target) {
    target.data.member = null;
    target.leave(roomChannel(room.code));
    if (reason === "kicked") target.emit("room:kicked", { message: "Ведущий удалил вас из лобби." });
  }
  assignHost(room);
  touch(room);
}
function closeRoom(room, reason) {
  io.to(roomChannel(room.code)).emit("room:closed", { message: reason || "Комната закрыта ведущим." });
  for (const player of room.players) {
    const target = player.socketId && io.sockets.sockets.get(player.socketId);
    if (target) { target.data.member = null; target.leave(roomChannel(room.code)); }
  }
  rooms.delete(room.code);
  persistRooms();
}
function roomError(socket, ack, message) {
  const payload = { ok: false, message };
  ackWith(ack, payload);
  socket.emit("app:error", payload);
}
function memberRoom(socket) {
  const member = playerForSocket(socket);
  if (!member) throw new Error("Ваша сессия в комнате закончилась. Вернитесь по приглашению.");
  return member;
}
function canControlCurrentTurn(room, player) {
  const actor = Rules.currentActor(room.game);
  if (!actor) return false;
  if (actor.playerId === player.id) return true;
  const target = byId(room, actor.playerId);
  const disconnectedLongEnough = target && !target.connected && !target.left &&
    target.disconnectedAt && now() - target.disconnectedAt >= RECONNECT_GRACE_MS;
  return player.id === room.hostId && Boolean(target && (target.left || disconnectedLongEnough));
}
function checkAllReady(room) {
  const connected = room.players.filter(player => player.connected && !player.left);
  return connected.length > 0 && connected.every(player => room.game.readyIds.includes(player.id));
}
function advanceAfterIntermission(room) {
  Rules.finishIntermission(room.game);
  room.players.forEach(player => { player.ready = false; });
  touch(room);
}
function safeEvent(socket, eventName, handler) {
  socket.on(eventName, (payload = {}, ack) => {
    try { handler(payload, ack); }
    catch (error) { roomError(socket, ack, error?.message || "Не удалось выполнить действие."); }
  });
}

restoreRooms();

io.on("connection", socket => {
  socket.data.member = null;

  safeEvent(socket, "room:create", (payload, ack) => {
    const ipHash = hash(clientIp(socket));
    if (!allowAttempt(createAttempts, ipHash, 5, CREATE_WINDOW_MS)) throw new Error("Слишком много попыток создать комнату. Подождите 15 минут.");
    if (rooms.size >= MAX_ROOMS) throw new Error("Сейчас заняты все места для лобби. Попробуйте позже.");
    const ownedCount = Array.from(rooms.values()).filter(room => room.hostIpHash === ipHash).length;
    if (ownedCount >= MAX_ROOMS_PER_IP) throw new Error("С одного подключения можно вести не больше " + MAX_ROOMS_PER_IP + " активных лобби.");
    const name = cleanName(payload.name);
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    const token = makeToken();
    const player = {
      id: crypto.randomUUID(), name, tokenHash: hash(token), socketId: null,
      connected: false, disconnectedAt: null, joinedAt: now(), ready: true, left: false
    };
    const room = {
      code, hostId: player.id, hostIpHash: ipHash, players: [player], game: null,
      createdAt: now(), updatedAt: now()
    };
    rooms.set(code, room);
    attachPlayer(socket, room, player, token, ack);
  });

  safeEvent(socket, "room:join", (payload, ack) => {
    const ipHash = hash(clientIp(socket));
    if (!allowAttempt(joinAttempts, ipHash, 14, JOIN_WINDOW_MS)) throw new Error("Слишком много попыток входа. Подождите минуту.");
    const code = cleanCode(payload.code);
    if (!code) throw new Error("Введите восьмизначный код приглашения.");
    const room = rooms.get(code);
    if (!room) throw new Error("Такое лобби не найдено. Проверьте код приглашения.");
    if (room.game) throw new Error("Партия уже началась. Войти можно только по сохранённому приглашению игрока.");
    const activePlayers = room.players.filter(player => !player.left);
    if (activePlayers.length >= 4) throw new Error("В лобби уже четыре игрока.");
    const name = cleanName(payload.name);
    const token = makeToken();
    const player = {
      id: crypto.randomUUID(), name, tokenHash: hash(token), socketId: null,
      connected: false, disconnectedAt: null, joinedAt: now(), ready: false, left: false
    };
    room.players.push(player);
    touch(room);
    attachPlayer(socket, room, player, token, ack);
  });

  safeEvent(socket, "room:reconnect", (payload, ack) => {
    const code = cleanCode(payload.code);
    const token = String(payload.token || "");
    if (!code || token.length < 30 || token.length > 100) throw new Error("Сохранённое приглашение недействительно.");
    const room = rooms.get(code);
    if (!room) throw new Error("Сохранённая комната уже закрыта или истекло время хранения.");
    const tokenHash = hash(token);
    const player = room.players.find(item => item.tokenHash && item.tokenHash === tokenHash);
    if (!player || (player.left && !room.game)) throw new Error("Приглашение этого игрока больше не действует.");
    attachPlayer(socket, room, player, token, ack);
  });

  safeEvent(socket, "room:rename", (payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (room.game) throw new Error("Во время партии имя уже нельзя менять.");
    player.name = cleanName(payload.name);
    touch(room); persistRooms(); emitRoom(room);
    ackWith(ack, { ok: true });
  });

  safeEvent(socket, "lobby:ready", (payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (room.game) throw new Error("Партия уже началась.");
    const ready = Boolean(payload.ready);
    if (player.id === room.hostId && !ready) throw new Error("Ведущий должен быть готов, чтобы начать партию.");
    player.ready = ready;
    touch(room); persistRooms(); emitRoom(room);
    ackWith(ack, { ok: true });
  });

  safeEvent(socket, "lobby:start", (_payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (player.id !== room.hostId) throw new Error("Начать партию может только ведущий.");
    if (room.game) throw new Error("В комнате уже идёт партия.");
    const players = room.players.filter(item => !item.left);
    if (players.length < 2) throw new Error("Нужно хотя бы два игрока.");
    if (players.length > 4) throw new Error("В одной партии может быть не больше четырёх игроков.");
    if (players.some(item => !item.connected || !item.ready)) throw new Error("Дождитесь, пока все подключатся и отметят готовность.");
    room.game = Rules.createGame(players);
    room.game.log.push({ round: 1, title: "Начало партии", text: "Команда собралась в Нижнем Новгороде. Запасы — 6, поддержка — 6, согласие — 6, угроза — 2." });
    touch(room); persistRooms(); emitRoom(room);
    ackWith(ack, { ok: true });
  });

  safeEvent(socket, "lobby:kick", (payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (player.id !== room.hostId) throw new Error("Удалять игроков может только ведущий.");
    if (room.game) throw new Error("Во время партии удалить игрока нельзя.");
    const target = byId(room, String(payload.playerId || ""));
    if (!target || target.id === player.id) throw new Error("Выберите другого участника.");
    removeLobbyPlayer(room, target, "kicked");
    touch(room); persistRooms(); emitRoom(room);
    ackWith(ack, { ok: true });
  });

  safeEvent(socket, "room:close", (_payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (player.id !== room.hostId) throw new Error("Закрыть комнату может только ведущий.");
    closeRoom(room, "Ведущий завершил комнату.");
    ackWith(ack, { ok: true });
  });

  safeEvent(socket, "room:leave", (_payload, ack) => {
    const { room, player } = memberRoom(socket);
    const activeGame = Boolean(room.game && room.game.phase !== "finished");
    const socketId = player.socketId;
    if (!room.game) {
      removeLobbyPlayer(room, player, "left");
      if (room.players.length === 0) {
        closeRoom(room, "В лобби больше никого не осталось.");
      } else {
        assignHost(room); touch(room); persistRooms(); emitRoom(room);
      }
    } else {
      player.left = true; player.connected = false; player.socketId = null; player.disconnectedAt = now();
      player.ready = false;
      if (room.hostId === player.id) room.hostId = null;
      assignHost(room);
      if (!roomHasLivePlayer(room)) {
        closeRoom(room, "Все участники покинули комнату.");
      } else {
        touch(room); persistRooms(); emitRoom(room);
      }
    }
    if (socketId) {
      const leavingSocket = io.sockets.sockets.get(socketId);
      if (leavingSocket) {
        leavingSocket.data.member = null;
        leavingSocket.leave(roomChannel(room.code));
      }
    }
    ackWith(ack, { ok: true, activeGame });
  });

  safeEvent(socket, "game:event-choice", (payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (!room.game || room.game.phase !== "event") throw new Error("Сейчас событие недоступно для выбора.");
    if (!canControlCurrentTurn(room, player)) throw new Error("Сейчас ждём решения другого игрока.");
    const index = Number(payload.index);
    if (!Number.isInteger(index) || index < 0 || index > 1) throw new Error("Выберите один из двух вариантов.");
    Rules.chooseEvent(room.game, index, player.name);
    touch(room); persistRooms(); emitRoom(room);
    ackWith(ack, { ok: true });
  });

  safeEvent(socket, "game:action", (payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (!room.game || room.game.phase !== "actions") throw new Error("Сейчас нельзя выполнять игровое действие.");
    if (!canControlCurrentTurn(room, player)) throw new Error("Сейчас ждём действия другого игрока.");
    const roleKey = String(payload.roleKey || "");
    const actionId = String(payload.actionId || "");
    Rules.performAction(room.game, roleKey, actionId, player.name);
    touch(room); persistRooms(); emitRoom(room);
    ackWith(ack, { ok: true });
  });

  safeEvent(socket, "game:intermission-ready", (payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (!room.game || room.game.phase !== "intermission") throw new Error("Сейчас нет межраундовой паузы.");
    if (payload.ready === false) room.game.readyIds = room.game.readyIds.filter(id => id !== player.id);
    else if (!room.game.readyIds.includes(player.id)) room.game.readyIds.push(player.id);
    if (checkAllReady(room)) advanceAfterIntermission(room);
    touch(room); persistRooms(); emitRoom(room);
    ackWith(ack, { ok: true });
  });

  safeEvent(socket, "game:intermission-force", (_payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (player.id !== room.hostId) throw new Error("Продолжить без остальных может только ведущий.");
    if (!room.game || room.game.phase !== "intermission") throw new Error("Сейчас нет межраундовой паузы.");
    advanceAfterIntermission(room);
    touch(room); persistRooms(); emitRoom(room);
    ackWith(ack, { ok: true });
  });

  safeEvent(socket, "game:rematch", (_payload, ack) => {
    const { room, player } = memberRoom(socket);
    if (player.id !== room.hostId) throw new Error("Начать повторную партию может только ведущий.");
    if (!room.game || room.game.phase !== "finished") throw new Error("Сначала завершите текущую партию.");
    room.game = null;
    room.players.forEach(item => { if (!item.left) item.ready = item.id === room.hostId; });
    touch(room); persistRooms(); emitRoom(room);
    ackWith(ack, { ok: true });
  });

  socket.on("disconnect", () => {
    const member = socket.data.member;
    if (!member) return;
    const room = rooms.get(member.code);
    const player = room && byId(room, member.playerId);
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = now();
    if (!room.game) player.ready = false;
    touch(room); persistRooms(); emitRoom(room);
  });
});

setInterval(() => {
  const time = now();
  let anyChanged = false;
  for (const room of Array.from(rooms.values())) {
    let roomChanged = false;
    if (time - room.updatedAt > ROOM_IDLE_MS) {
      closeRoom(room, "Комната закрыта после долгого бездействия.");
      anyChanged = true;
      continue;
    }
    if (!room.game) {
      const expired = room.players.filter(player =>
        !player.connected && player.disconnectedAt && time - player.disconnectedAt >= RECONNECT_GRACE_MS
      );
      for (const player of expired) {
        const wasHost = room.hostId === player.id;
        removeLobbyPlayer(room, player, "expired");
        if (wasHost) assignHost(room);
        roomChanged = true;
      }
      if (room.players.length === 0) {
        closeRoom(room, "В лобби больше никого не осталось.");
        anyChanged = true;
        continue;
      }
    } else {
      if (assignHost(room)) { touch(room); roomChanged = true; }
      const actor = room.game.phase === "event" || room.game.phase === "actions" ? Rules.currentActor(room.game) : null;
      const actorPlayer = actor && byId(room, actor.playerId);
      if (actorPlayer && !actorPlayer.connected && actorPlayer.disconnectedAt &&
          time - actorPlayer.disconnectedAt >= RECONNECT_GRACE_MS) roomChanged = true;
    }
    if (roomChanged) { touch(room); emitRoom(room); anyChanged = true; }
  }
  for (const [key, values] of createAttempts) if (!values.length || time - values[values.length - 1] > CREATE_WINDOW_MS) createAttempts.delete(key);
  for (const [key, values] of joinAttempts) if (!values.length || time - values[values.length - 1] > JOIN_WINDOW_MS) joinAttempts.delete(key);
  if (anyChanged) persistRooms();
}, 15000).unref();

const saveTimer = setInterval(persistRooms, 60000);
saveTimer.unref();

httpServer.listen(PORT, HOST, () => {
  console.log("Земский круг запущен на " + HOST + ":" + PORT + ".");
});

function shutdown() {
  persistRooms();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
