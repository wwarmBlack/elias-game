// Элиас Online — сервер на Express + Socket.IO.
// Всё игровое состояние держится в памяти процесса (Map по коду комнаты).
// Это означает: PM2 должен запускать ровно один процесс (fork-режим, без cluster),
// иначе разные клиенты попадут в разные процессы и не увидят друг друга.
//
// Игроки и хост определяются не по socket.id (он меняется при каждом
// переподключении/перезагрузке страницы), а по стабильному playerToken,
// который генерируется на клиенте и хранится в localStorage. Это позволяет
// хосту оставаться хостом, а игрокам — оставаться в своих командах, после
// перезагрузки страницы.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const WORDS = require("./words");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TEAM_COLORS = ["#e63946", "#1d8a99", "#f4a300", "#6a4c93", "#2a9d8f", "#e07a5f"];
const WORD_CATEGORIES = ["easy", "medium", "hard", "netmonet"];
const EMPTY_ROOM_TTL_MS = 15 * 60 * 1000; // комната без игроков удаляется через 15 минут
const HOST_GRACE_MS = 2 * 60 * 1000; // если хост не возвращается 2 минуты — роль хоста передаётся другому

app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------------------------------
// Игровое состояние
// --------------------------------------------------------------------------

/** rooms: code -> room object */
const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без похожих символов
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createRoom(hostToken, hostName, password, category) {
  const code = generateRoomCode();
  const room = {
    code,
    hostToken,
    hostGraceTimer: null,
    password: password ? password : null,
    createdAt: Date.now(),
    emptySince: null, // момент, когда в комнате не осталось подключённых игроков
    status: "lobby", // lobby | playing | turn_summary | finished
    settings: {
      turnSeconds: 60,
      winMode: "score", // "score" | "rounds"
      targetScore: 30,
      maxRounds: 6,
      wordCategory: WORD_CATEGORIES.includes(category) ? category : "easy",
    },
    players: new Map(), // playerToken -> { token, name, teamId, connected, socketId }
    teams: [
      { id: "t1", name: "Команда 1", color: TEAM_COLORS[0], score: 0, memberOrder: [], explainerPointer: 0 },
      { id: "t2", name: "Команда 2", color: TEAM_COLORS[1], score: 0, memberOrder: [], explainerPointer: 0 },
    ],
    turnOrder: [], // массив id команд в порядке ходов (заполняется при старте)
    currentTeamIndex: 0,
    roundsPlayed: 0,
    wordPool: [],
    usedWords: [],
    turn: null, // { teamId, explainerId, word, wordsThisTurn: [{word, result}], remaining, timer }
    lastSummary: null,
  };
  room.players.set(hostToken, { token: hostToken, name: hostName, teamId: null, connected: true, socketId: null });
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get((code || "").toUpperCase());
}

function refillWordPoolIfNeeded(room) {
  if (room.wordPool.length === 0) {
    const categoryWords = WORDS[room.settings.wordCategory] || WORDS.easy;
    // Перемешиваем уже использованные слова обратно в пул, если запас закончился
    const source = room.usedWords.length > 0 ? room.usedWords : categoryWords;
    room.wordPool = shuffle(source);
    room.usedWords = [];
  }
}

function drawWord(room) {
  refillWordPoolIfNeeded(room);
  const word = room.wordPool.pop();
  room.usedWords.push(word);
  return word;
}

function connectedMembers(room, teamId) {
  const team = room.teams.find((t) => t.id === teamId);
  if (!team) return [];
  return team.memberOrder.filter((token) => {
    const p = room.players.get(token);
    return p && p.connected;
  });
}

function pickNextExplainer(room, team) {
  const members = connectedMembers(room, team.id);
  if (members.length === 0) return null;
  const idx = team.explainerPointer % members.length;
  team.explainerPointer = (team.explainerPointer + 1) % Math.max(members.length, 1);
  return members[idx];
}

function activeTeams(room) {
  return room.teams.filter((t) => connectedMembers(room, t.id).length > 0);
}

function checkGameEnd(room) {
  if (room.settings.winMode === "score") {
    return room.teams.some((t) => t.score >= room.settings.targetScore);
  }
  return room.roundsPlayed >= room.settings.maxRounds;
}

function endTurn(room, reason) {
  if (!room.turn) return;
  clearInterval(room.turn.timer);
  const team = room.teams.find((t) => t.id === room.turn.teamId);
  room.lastSummary = {
    teamId: team.id,
    teamName: team.name,
    words: room.turn.wordsThisTurn,
    correctCount: room.turn.wordsThisTurn.filter((w) => w.result === "correct").length,
    reason: reason || "time", // time | disconnect
  };
  room.turn = null;

  const teams = activeTeams(room);
  if (teams.length === 0) {
    room.status = "lobby";
    broadcastState(room);
    return;
  }

  // Считаем круг завершённым, когда возвращаемся к первой команде из turnOrder
  const finishedTeamId = room.lastSummary.teamId;
  const orderIdx = room.turnOrder.indexOf(finishedTeamId);
  if (orderIdx === room.turnOrder.length - 1) {
    room.roundsPlayed += 1;
  }

  if (checkGameEnd(room)) {
    room.status = "finished";
    broadcastState(room);
    return;
  }

  // Следующая команда по очереди (пропускаем команды без подключённых игроков)
  let nextIdx = room.currentTeamIndex;
  for (let i = 0; i < room.turnOrder.length; i++) {
    nextIdx = (nextIdx + 1) % room.turnOrder.length;
    const teamId = room.turnOrder[nextIdx];
    if (connectedMembers(room, teamId).length > 0) {
      room.currentTeamIndex = nextIdx;
      break;
    }
  }
  room.status = "turn_summary";
  broadcastState(room);
}

function startTurn(room) {
  const teamId = room.turnOrder[room.currentTeamIndex];
  const team = room.teams.find((t) => t.id === teamId);
  const explainerId = pickNextExplainer(room, team);
  if (!explainerId) {
    // в команде никого нет — пропускаем её ход
    endTurnSkipTeam(room);
    return;
  }
  room.status = "playing";
  room.turn = {
    teamId,
    explainerId,
    word: drawWord(room),
    wordsThisTurn: [],
    remaining: room.settings.turnSeconds,
    timer: null,
  };
  room.turn.timer = setInterval(() => {
    room.turn.remaining -= 1;
    if (room.turn.remaining <= 0) {
      endTurn(room, "time");
    } else {
      broadcastState(room);
    }
  }, 1000);
  broadcastState(room);
}

function endTurnSkipTeam(room) {
  // вызывается, если у текущей команды не осталось игроков онлайн
  let nextIdx = room.currentTeamIndex;
  for (let i = 0; i < room.turnOrder.length; i++) {
    nextIdx = (nextIdx + 1) % room.turnOrder.length;
    if (connectedMembers(room, room.turnOrder[nextIdx]).length > 0) {
      room.currentTeamIndex = nextIdx;
      startTurn(room);
      return;
    }
  }
  room.status = "lobby";
  broadcastState(room);
}

// --------------------------------------------------------------------------
// Передача роли хоста, если исходный хост долго не возвращается
// --------------------------------------------------------------------------

function clearHostGrace(room) {
  if (room.hostGraceTimer) {
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
  }
}

function scheduleHostGrace(room, token) {
  clearHostGrace(room);
  room.hostGraceTimer = setTimeout(() => {
    room.hostGraceTimer = null;
    if (room.hostToken !== token) return; // хост уже сменился
    const player = room.players.get(token);
    if (player && player.connected) return; // хост вернулся
    const next = [...room.players.values()].find((p) => p.connected);
    if (next) {
      room.hostToken = next.token;
      broadcastState(room);
    }
  }, HOST_GRACE_MS);
}

// --------------------------------------------------------------------------
// Автоудаление комнат, в которых никого нет уже 15 минут
// --------------------------------------------------------------------------

function sweepEmptyRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = [...room.players.values()].some((p) => p.connected);
    if (anyConnected) {
      room.emptySince = null;
      continue;
    }
    if (room.emptySince == null) {
      room.emptySince = now;
      continue;
    }
    if (now - room.emptySince >= EMPTY_ROOM_TTL_MS) {
      if (room.turn) clearInterval(room.turn.timer);
      clearHostGrace(room);
      rooms.delete(code);
    }
  }
}
setInterval(sweepEmptyRooms, 60 * 1000);

// --------------------------------------------------------------------------
// Сборка персонального "вида" комнаты для конкретного игрока (слово скрыто
// от всех, кроме текущего объясняющего)
// --------------------------------------------------------------------------

function buildView(room, token) {
  const me = room.players.get(token);
  const isExplainer = !!room.turn && room.turn.explainerId === token;
  const isHost = room.hostToken === token;

  return {
    code: room.code,
    status: room.status,
    isHost,
    hasPassword: !!room.password,
    me: me ? { id: token, name: me.name, teamId: me.teamId } : null,
    settings: room.settings,
    teams: room.teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      score: t.score,
      members: t.memberOrder
        .map((tok) => room.players.get(tok))
        .filter(Boolean)
        .map((p) => ({ id: p.token, name: p.name, connected: p.connected })),
    })),
    unassigned: [...room.players.values()]
      .filter((p) => !p.teamId)
      .map((p) => ({ id: p.token, name: p.name, connected: p.connected })),
    roundsPlayed: room.roundsPlayed,
    turn: room.turn
      ? {
          teamId: room.turn.teamId,
          explainerId: room.turn.explainerId,
          remaining: room.turn.remaining,
          word: isExplainer ? room.turn.word : null,
          guessedCount: room.turn.wordsThisTurn.filter((w) => w.result === "correct").length,
        }
      : null,
    lastSummary: room.status === "turn_summary" ? room.lastSummary : null,
    winner:
      room.status === "finished"
        ? room.teams.slice().sort((a, b) => b.score - a.score)[0]
        : null,
  };
}

function broadcastState(room) {
  for (const player of room.players.values()) {
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit("state", buildView(room, player.token));
    }
  }
}

function publicRoomsList() {
  return [...rooms.values()]
    .map((room) => {
      const connectedCount = [...room.players.values()].filter((p) => p.connected).length;
      const hostPlayer = room.players.get(room.hostToken);
      return {
        code: room.code,
        hostName: hostPlayer ? hostPlayer.name : "—",
        playerCount: connectedCount,
        totalPlayers: room.players.size,
        status: room.status,
        category: room.settings.wordCategory,
        hasPassword: !!room.password,
        createdAt: room.createdAt,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

// --------------------------------------------------------------------------
// Socket.IO обработчики
// --------------------------------------------------------------------------

io.on("connection", (socket) => {
  socket.on("create_room", ({ name, password, category, playerToken }) => {
    if (!playerToken) {
      socket.emit("error_message", "Ошибка идентификации. Обновите страницу и попробуйте снова.");
      return;
    }
    const hostName = (name || "Хост").trim().slice(0, 24) || "Хост";
    const pass = (password || "").trim().slice(0, 32);
    const room = createRoom(playerToken, hostName, pass, category);
    room.players.get(playerToken).socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerToken = playerToken;
    broadcastState(room);
  });

  socket.on("join_room", ({ code, name, password, playerToken, silent }) => {
    if (!playerToken) {
      socket.emit("error_message", "Ошибка идентификации. Обновите страницу и попробуйте снова.");
      return;
    }
    const room = getRoom(code);
    if (!room) {
      if (silent) socket.emit("rejoin_failed");
      else socket.emit("error_message", "Комната не найдена. Проверьте код или ссылку.");
      return;
    }

    let player = room.players.get(playerToken);

    if (player) {
      // переподключение уже известного участника (в т.ч. хоста) — пароль не нужен
      player.connected = true;
      player.socketId = socket.id;
      if (name && !silent) {
        player.name = name.trim().slice(0, 24) || player.name;
      }
      room.emptySince = null;
      if (room.hostToken === playerToken) clearHostGrace(room);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerToken = playerToken;
      broadcastState(room);
      return;
    }

    // новый участник
    if (room.password && room.password !== (password || "")) {
      if (silent) socket.emit("rejoin_failed");
      else socket.emit("error_message", "Неверный пароль комнаты.");
      return;
    }
    if (room.status !== "lobby") {
      if (silent) socket.emit("rejoin_failed");
      else socket.emit("error_message", "Игра уже идёт. Дождитесь её завершения, чтобы присоединиться.");
      return;
    }
    const playerName = (name || "Игрок").trim().slice(0, 24) || "Игрок";
    room.players.set(playerToken, {
      token: playerToken,
      name: playerName,
      teamId: null,
      connected: true,
      socketId: socket.id,
    });
    room.emptySince = null;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerToken = playerToken;
    broadcastState(room);
  });

  socket.on("list_rooms", (ack) => {
    if (typeof ack !== "function") return;
    ack(publicRoomsList());
  });

  socket.on("leave_room", () => {
    const room = getRoom(socket.data.roomCode);
    const token = socket.data.playerToken;
    if (!room || !token) return;
    const player = room.players.get(token);
    if (player) {
      room.teams.forEach((t) => {
        t.memberOrder = t.memberOrder.filter((id) => id !== token);
      });
      if (room.turn && room.turn.explainerId === token) {
        endTurn(room, "disconnect");
      }
      room.players.delete(token);
      if (room.hostToken === token) {
        clearHostGrace(room);
        const next = [...room.players.values()].find((p) => p.connected);
        room.hostToken = next ? next.token : null;
      }
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerToken = null;
    const anyConnected = [...room.players.values()].some((p) => p.connected);
    room.emptySince = anyConnected ? null : Date.now();
    broadcastState(room);
  });

  socket.on("choose_team", ({ teamId }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const token = socket.data.playerToken;
    const player = room.players.get(token);
    if (!player) return;
    const team = room.teams.find((t) => t.id === teamId);
    if (!team) return;

    // убрать из прежней команды
    room.teams.forEach((t) => {
      t.memberOrder = t.memberOrder.filter((id) => id !== token);
    });
    team.memberOrder.push(token);
    player.teamId = teamId;
    broadcastState(room);
  });

  socket.on("add_team", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostToken !== socket.data.playerToken || room.status !== "lobby") return;
    if (room.teams.length >= TEAM_COLORS.length) return;
    const n = room.teams.length + 1;
    room.teams.push({
      id: "t" + Date.now(),
      name: "Команда " + n,
      color: TEAM_COLORS[room.teams.length % TEAM_COLORS.length],
      score: 0,
      memberOrder: [],
      explainerPointer: 0,
    });
    broadcastState(room);
  });

  socket.on("remove_team", ({ teamId }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostToken !== socket.data.playerToken || room.status !== "lobby") return;
    if (room.teams.length <= 2) return;
    const team = room.teams.find((t) => t.id === teamId);
    if (!team) return;
    team.memberOrder.forEach((token) => {
      const p = room.players.get(token);
      if (p) p.teamId = null;
    });
    room.teams = room.teams.filter((t) => t.id !== teamId);
    broadcastState(room);
  });

  socket.on("rename_team", ({ teamId, name }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostToken !== socket.data.playerToken) return;
    const team = room.teams.find((t) => t.id === teamId);
    if (!team || !name) return;
    team.name = name.trim().slice(0, 20) || team.name;
    broadcastState(room);
  });

  socket.on("update_settings", (patch) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostToken !== socket.data.playerToken || room.status !== "lobby") return;
    const s = room.settings;
    if (Number.isFinite(patch.turnSeconds)) s.turnSeconds = Math.min(180, Math.max(15, Math.round(patch.turnSeconds)));
    if (patch.winMode === "score" || patch.winMode === "rounds") s.winMode = patch.winMode;
    if (Number.isFinite(patch.targetScore)) s.targetScore = Math.min(200, Math.max(5, Math.round(patch.targetScore)));
    if (Number.isFinite(patch.maxRounds)) s.maxRounds = Math.min(30, Math.max(1, Math.round(patch.maxRounds)));
    if (WORD_CATEGORIES.includes(patch.wordCategory)) s.wordCategory = patch.wordCategory;
    if (typeof patch.password === "string") {
      room.password = patch.password.trim().slice(0, 32) || null;
    }
    broadcastState(room);
  });

  socket.on("start_game", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostToken !== socket.data.playerToken) return;
    if (room.status !== "lobby" && room.status !== "finished") return;
    const teamsWithPlayers = room.teams.filter((t) => t.memberOrder.length > 0);
    if (teamsWithPlayers.length < 2) {
      socket.emit("error_message", "Нужно минимум 2 команды с игроками.");
      return;
    }
    room.teams.forEach((t) => {
      t.score = 0;
      t.explainerPointer = 0;
    });
    room.roundsPlayed = 0;
    room.usedWords = [];
    room.wordPool = shuffle(WORDS[room.settings.wordCategory] || WORDS.easy);
    room.turnOrder = shuffle(teamsWithPlayers.map((t) => t.id));
    room.currentTeamIndex = 0;
    room.lastSummary = null;
    startTurn(room);
  });

  socket.on("word_result", ({ result }) => {
    const room = getRoom(socket.data.roomCode);
    const token = socket.data.playerToken;
    if (!room || !room.turn || room.turn.explainerId !== token) return;
    if (result !== "correct" && result !== "skip") return;
    const team = room.teams.find((t) => t.id === room.turn.teamId);
    room.turn.wordsThisTurn.push({ word: room.turn.word, result });
    if (result === "correct") team.score += 1;
    if (checkGameEnd(room) && result === "correct") {
      endTurn(room, "time");
      return;
    }
    room.turn.word = drawWord(room);
    broadcastState(room);
  });

  socket.on("continue_after_summary", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostToken !== socket.data.playerToken) return;
    if (room.status !== "turn_summary") return;
    startTurn(room);
  });

  socket.on("end_game_now", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostToken !== socket.data.playerToken) return;
    if (room.turn) {
      clearInterval(room.turn.timer);
      room.turn = null;
    }
    room.status = "finished";
    broadcastState(room);
  });

  socket.on("back_to_lobby", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostToken !== socket.data.playerToken) return;
    room.status = "lobby";
    room.teams.forEach((t) => (t.score = 0));
    broadcastState(room);
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const token = socket.data.playerToken;
    const player = room.players.get(token);
    if (!player) return;
    // игнорируем "устаревшее" отключение, если игрок уже переподключился с новым socket.id
    if (player.socketId !== socket.id) return;

    player.connected = false;
    player.socketId = null;

    // если отключился текущий объясняющий — даём ему немного времени на
    // переподключение (например, при перезагрузке страницы), прежде чем
    // завершать ход
    if (room.turn && room.turn.explainerId === token) {
      setTimeout(() => {
        const p = room.players.get(token);
        if (room.turn && room.turn.explainerId === token && (!p || !p.connected)) {
          endTurn(room, "disconnect");
        }
      }, 10 * 1000);
    }

    // если отключился хост — даём ему время на переподключение, прежде чем
    // передать роль хоста другому подключённому игроку
    if (room.hostToken === token) {
      scheduleHostGrace(room, token);
    }

    const anyConnected = [...room.players.values()].some((p) => p.connected);
    room.emptySince = anyConnected ? null : Date.now();

    broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Элиас Online запущен на порту ${PORT}`);
});
