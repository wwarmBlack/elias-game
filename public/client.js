const socket = io();

let myState = null; // последний полученный "state" от сервера
let myName = "";
let roomsRefreshTimer = null;

// ---------- утилиты ----------
const $ = (id) => document.getElementById(id);
function show(screenId) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screenId).classList.add("active");
}
function setText(id, text) { $(id).textContent = text; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- стабильный идентификатор игрока (чтобы переживать перезагрузку) ----------
function genToken() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
let playerToken = localStorage.getItem("eliasPlayerToken");
if (!playerToken) {
  playerToken = genToken();
  localStorage.setItem("eliasPlayerToken", playerToken);
}
let lastRoomCode = localStorage.getItem("eliasRoomCode") || "";
let lastName = localStorage.getItem("eliasName") || "";
myName = lastName;

// ---------- хаб: выбор игры ----------
let selectedGameType = "elias"; // "elias" | "hundredToOne"
const GAME_LABELS = {
  elias: { logo: "🎤 Элиас", subtitle: "Объясни слово — команда угадывает" },
  hundredToOne: { logo: "💯 100 к 1", subtitle: "Угадайте самые популярные (или редкие) ответы" },
};
function updateHomeHeader() {
  const labels = GAME_LABELS[selectedGameType] || GAME_LABELS.elias;
  setText("home-logo", labels.logo);
  setText("home-subtitle", labels.subtitle);
  $("create-elias-options").classList.toggle("hidden", selectedGameType !== "elias");
}
function pickGame(gameType) {
  selectedGameType = gameType;
  updateHomeHeader();
  show("screen-home");
  showHomeSection("home-create");
}
$("pick-elias").onclick = () => pickGame("elias");
$("pick-h2o").onclick = () => pickGame("hundredToOne");
$("btn-hub-show-join").onclick = () => {
  show("screen-home");
  showHomeSection("home-join");
};
$("btn-hub-show-rooms").onclick = () => {
  show("screen-home");
  showHomeSection("home-rooms");
};
$("btn-home-back-1").onclick = () => show("screen-hub");
$("btn-home-back-2").onclick = () => show("screen-hub");
updateHomeHeader();

// Если есть сохранённая комната — сразу показываем экран переподключения,
// минуя хаб (комната уже выбрана раньше).
if (lastRoomCode) {
  show("screen-home");
  $("reconnecting").classList.remove("hidden");
  $("home-content").classList.add("hidden");
}

function rememberRoom(code, name) {
  localStorage.setItem("eliasRoomCode", code);
  if (name) localStorage.setItem("eliasName", name);
}
function forgetRoom() {
  localStorage.removeItem("eliasRoomCode");
}

// ---------- параметры ссылки (?room=CODE) ----------
const urlParams = new URLSearchParams(location.search);
const prefillRoom = urlParams.get("room");
if (prefillRoom && !lastRoomCode) {
  $("join-code").value = prefillRoom.toUpperCase();
  $("home-create").classList.add("hidden");
  $("home-join").classList.remove("hidden");
}

// ---------- тихое переподключение к последней комнате после перезагрузки ----------
let attemptedSilentRejoin = false;
socket.on("connect", () => {
  if (lastRoomCode && !attemptedSilentRejoin) {
    attemptedSilentRejoin = true;
    $("reconnecting").classList.remove("hidden");
    $("home-content").classList.add("hidden");
    socket.emit("join_room", { code: lastRoomCode, name: lastName, playerToken, silent: true });
  }
});

socket.on("rejoin_failed", () => {
  forgetRoom();
  $("reconnecting").classList.add("hidden");
  $("home-content").classList.remove("hidden");
});

// ---------- навигация по главному экрану ----------
function showHomeSection(section) {
  ["home-join", "home-create", "home-rooms"].forEach((id) => $(id).classList.toggle("hidden", id !== section));
  if (section === "home-rooms") {
    refreshRoomsList();
    if (!roomsRefreshTimer) roomsRefreshTimer = setInterval(refreshRoomsList, 5000);
  } else if (roomsRefreshTimer) {
    clearInterval(roomsRefreshTimer);
    roomsRefreshTimer = null;
  }
}
$("btn-show-join").onclick = () => showHomeSection("home-join");
$("btn-show-create").onclick = () => showHomeSection("home-create");
$("btn-show-rooms-1").onclick = () => showHomeSection("home-rooms");
$("btn-show-rooms-2").onclick = () => showHomeSection("home-rooms");
$("btn-rooms-back").onclick = () => showHomeSection("home-create");
$("btn-rooms-refresh").onclick = refreshRoomsList;

const CATEGORY_LABELS = { easy: "🟢 Легкие", medium: "🟡 Средние", hard: "🔴 Сложные", netmonet: "🍽️ Нетмонет" };
const STATUS_LABELS = { lobby: "В лобби", playing: "Игра идёт", turn_summary: "Игра идёт", finished: "Игра завершена" };

function refreshRoomsList() {
  socket.emit("list_rooms", (rooms) => {
    const list = $("rooms-list");
    list.innerHTML = "";
    $("rooms-empty").classList.toggle("hidden", rooms.length > 0);
    rooms.forEach((r) => {
      const card = document.createElement("div");
      card.className = "room-card";

      const main = document.createElement("div");
      main.className = "room-card-main";
      main.innerHTML = `
        <div class="room-card-code">${escapeHtml(r.code)} ${r.hasPassword ? "🔒" : ""}</div>
        <div class="room-card-meta">Хост: ${escapeHtml(r.hostName)} · ${r.playerCount} онлайн · ${CATEGORY_LABELS[r.category] || ""} · ${STATUS_LABELS[r.status] || ""}</div>
      `;
      card.appendChild(main);

      const joinBtn = document.createElement("button");
      joinBtn.className = "btn small";
      joinBtn.textContent = "Войти";
      joinBtn.onclick = () => {
        $("join-code").value = r.code;
        showHomeSection("home-join");
        if (r.hasPassword) $("join-password").focus();
        else $("join-name").focus();
      };
      card.appendChild(joinBtn);

      list.appendChild(card);
    });
  });
}

$("btn-create").onclick = () => {
  const name = $("create-name").value.trim();
  if (!name) return showHomeError("Введите имя");
  myName = name;
  socket.emit("create_room", {
    name,
    password: $("create-password").value.trim(),
    category: $("create-category").value,
    penalizeSkips: $("create-penalize").checked,
    gameType: selectedGameType,
    playerToken,
  });
};

$("btn-join").onclick = () => {
  const code = $("join-code").value.trim().toUpperCase();
  const name = $("join-name").value.trim();
  if (!code) return showHomeError("Введите код комнаты");
  if (!name) return showHomeError("Введите имя");
  myName = name;
  socket.emit("join_room", {
    code,
    name,
    password: $("join-password").value.trim(),
    playerToken,
  });
};

function showHomeError(msg) {
  $("home-error").textContent = msg;
  $("home-error").classList.remove("hidden");
}

socket.on("error_message", (msg) => {
  if (!$("screen-home").classList.contains("active")) {
    alert(msg);
  } else {
    showHomeError(msg);
  }
});

// ---------- выход из комнаты ----------
function leaveRoom() {
  socket.emit("leave_room");
  forgetRoom();
  myState = null;
  $("home-error").classList.add("hidden");
  $("reconnecting").classList.add("hidden");
  $("home-content").classList.remove("hidden");
  showHomeSection("home-create");
  show("screen-home");
}
$("btn-leave-lobby").onclick = leaveRoom;
$("btn-leave-game").onclick = () => {
  if (confirm("Выйти из игры?")) leaveRoom();
};

// ---------- копирование ссылки-приглашения ----------
$("btn-copy-link").onclick = () => {
  if (!myState) return;
  const url = `${location.origin}${location.pathname}?room=${myState.code}`;
  navigator.clipboard?.writeText(url).then(
    () => flashButton($("btn-copy-link"), "Скопировано ✓"),
    () => prompt("Скопируйте ссылку:", url)
  );
};
function flashButton(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1500);
}

// ---------- настройки (хост) ----------
$("set-win-mode").onchange = () => {
  const rounds = $("set-win-mode").value === "rounds";
  $("row-target-score").classList.toggle("hidden", rounds);
  $("row-max-rounds").classList.toggle("hidden", !rounds);
  pushSettings();
};
$("set-turn-seconds").onchange = pushSettings;
$("set-target-score").onchange = pushSettings;
$("set-max-rounds").onchange = pushSettings;
$("set-category").onchange = pushSettings;
$("set-penalize").onchange = pushSettings;
$("set-h2o-rounds").onchange = pushSettings;

function pushSettings() {
  socket.emit("update_settings", {
    turnSeconds: parseInt($("set-turn-seconds").value, 10),
    winMode: $("set-win-mode").value,
    targetScore: parseInt($("set-target-score").value, 10),
    maxRounds: parseInt($("set-max-rounds").value, 10),
    wordCategory: $("set-category").value,
    penalizeSkips: $("set-penalize").checked,
    h2oRounds: parseInt($("set-h2o-rounds").value, 10),
  });
}

$("btn-save-password").onclick = () => {
  socket.emit("update_settings", { password: $("set-password").value });
  flashButton($("btn-save-password"), "✓");
};

$("btn-add-team").onclick = () => socket.emit("add_team");
$("btn-start-game").onclick = () => socket.emit("start_game");

// ---------- игровые кнопки ----------
$("btn-correct").onclick = () => socket.emit("word_result", { result: "correct" });
$("btn-skip").onclick = () => socket.emit("word_result", { result: "skip" });
$("btn-continue").onclick = () => socket.emit("continue_after_summary");
$("btn-restart").onclick = () => socket.emit("start_game");

// ---------- "100 к 1": капитан и ответы ----------
function sendH2OGuess() {
  const input = $("h2o-guess-input");
  const val = input.value.trim();
  if (!val) return;
  socket.emit("h2o_guess", { text: val });
  input.value = "";
  input.focus();
}
$("btn-h2o-guess").onclick = sendH2OGuess;
$("h2o-guess-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendH2OGuess();
});
$("btn-h2o-continue").onclick = () => socket.emit("continue_after_summary");

// ---------- основной рендер по состоянию с сервера ----------
socket.on("state", (state) => {
  myState = state;
  $("reconnecting").classList.add("hidden");
  $("home-content").classList.remove("hidden");
  rememberRoom(state.code, state.me ? state.me.name : myName);

  // Игрок без команды (например, только что присоединился во время уже
  // идущей игры) всегда видит экран выбора команды — кроме хоста, у
  // которого свои элементы управления на игровом экране.
  const needsTeamChoice = !state.isHost && !state.me?.teamId && state.status !== "lobby";

  if (state.status === "lobby" || needsTeamChoice) {
    renderLobby(state);
    show("screen-lobby");
  } else {
    renderGame(state);
    show("screen-game");
  }
});

function renderLobby(state) {
  const isH2O = state.gameType === "hundredToOne";
  setText("lobby-code", state.code);
  $("host-settings").classList.toggle("hidden", !state.isHost);
  $("set-turn-seconds").value = state.settings.turnSeconds;
  $("set-win-mode").value = state.settings.winMode;
  $("set-target-score").value = state.settings.targetScore;
  $("set-max-rounds").value = state.settings.maxRounds;
  $("set-category").value = state.settings.wordCategory;
  $("set-penalize").checked = !!state.settings.penalizeSkips;
  $("set-h2o-rounds").value = state.settings.h2oRounds;
  $("set-password").placeholder = state.hasPassword ? "Пароль установлен (оставьте пустым, чтобы убрать)" : "Без пароля";

  document.querySelectorAll(".elias-only").forEach((el) => el.classList.toggle("hidden", isH2O));
  document.querySelectorAll(".h2o-only").forEach((el) => el.classList.toggle("hidden", !isH2O));
  if (!isH2O) {
    $("row-target-score").classList.toggle("hidden", state.settings.winMode === "rounds");
    $("row-max-rounds").classList.toggle("hidden", state.settings.winMode !== "rounds");
  }

  $("mid-game-notice").classList.toggle("hidden", state.status === "lobby" || isH2O);
  $("h2o-captain-notice").classList.toggle("hidden", !isH2O);

  const container = $("teams-container");
  container.innerHTML = "";
  state.teams.forEach((team) => {
    const box = document.createElement("div");
    box.className = "team-box";
    box.style.background = team.color;

    const header = document.createElement("div");
    header.className = "team-box-header";

    if (state.isHost) {
      const nameInput = document.createElement("input");
      nameInput.value = team.name;
      nameInput.maxLength = 20;
      nameInput.onchange = () => socket.emit("rename_team", { teamId: team.id, name: nameInput.value });
      header.appendChild(nameInput);
    } else {
      const nameEl = document.createElement("strong");
      nameEl.textContent = team.name;
      nameEl.style.flex = "1";
      header.appendChild(nameEl);
    }

    if (state.isHost && state.teams.length > 2) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "team-remove-btn";
      removeBtn.textContent = "✕";
      removeBtn.onclick = () => socket.emit("remove_team", { teamId: team.id });
      header.appendChild(removeBtn);
    }
    box.appendChild(header);

    const members = document.createElement("div");
    members.className = "team-members";
    team.members.forEach((m) => {
      const chip = document.createElement("span");
      chip.className = "member-chip" + (m.connected ? "" : " offline") + (isH2O && m.id === team.captainId ? " is-captain" : "");
      chip.textContent = m.name + (m.id === state.me?.id ? " (вы)" : "");
      members.appendChild(chip);
    });
    box.appendChild(members);

    if (state.me?.teamId !== team.id) {
      const joinBtn = document.createElement("button");
      joinBtn.className = "team-join-btn";
      joinBtn.textContent = "Присоединиться";
      joinBtn.onclick = () => socket.emit("choose_team", { teamId: team.id });
      box.appendChild(joinBtn);
    } else if (isH2O) {
      const amCaptain = team.captainId === state.me?.id;
      const capBtn = document.createElement("button");
      capBtn.className = "captain-btn" + (amCaptain ? " is-captain" : "");
      capBtn.textContent = amCaptain ? "👑 Вы капитан" : "Стать капитаном";
      capBtn.onclick = () => socket.emit("set_captain", { teamId: team.id });
      box.appendChild(capBtn);
    }

    container.appendChild(box);
  });

  const unassigned = $("unassigned-list");
  unassigned.innerHTML = "";
  state.unassigned
    .filter((p) => p.id !== state.me?.id)
    .forEach((p) => {
      const chip = document.createElement("span");
      chip.className = "member-chip" + (p.connected ? "" : " offline");
      chip.textContent = p.name;
      unassigned.appendChild(chip);
    });

  $("btn-start-game").classList.toggle("hidden", !state.isHost);
  const enoughTeams = state.teams.filter((t) => t.members.length > 0).length >= 2;
  $("btn-start-game").disabled = !enoughTeams;
  $("lobby-error").classList.toggle("hidden", enoughTeams);
  if (!enoughTeams) $("lobby-error").textContent = "Нужно минимум 2 команды с игроками, чтобы начать.";
}

function renderScoreboard(state) {
  const sb = $("scoreboard");
  sb.innerHTML = "";
  state.teams.forEach((t) => {
    const chip = document.createElement("span");
    chip.className = "score-chip";
    chip.style.background = t.color;
    chip.textContent = `${t.name}: ${t.score}`;
    sb.appendChild(chip);
  });
}

function hideAllGameViews() {
  [
    "view-explainer",
    "view-teammate",
    "view-other",
    "view-summary",
    "view-h2o-playing",
    "view-h2o-summary",
    "view-finished",
  ].forEach((id) => $(id).classList.add("hidden"));
}

function renderGame(state) {
  renderScoreboard(state);
  hideAllGameViews();

  if (state.gameType === "hundredToOne") {
    renderH2OGame(state);
    return;
  }

  if (state.status === "playing" && state.turn) {
    $("timer").textContent = state.turn.remaining;
    $("timer").classList.toggle("low", state.turn.remaining <= 10);

    const amExplainer = state.turn.explainerId === state.me?.id;
    const myTeam = state.me?.teamId;
    const turnTeam = state.teams.find((t) => t.id === state.turn.teamId);

    if (amExplainer) {
      $("view-explainer").classList.remove("hidden");
      setText("word-card", state.turn.word || "…");
      setText("guessed-count", state.turn.guessedCount);
    } else if (myTeam === state.turn.teamId) {
      $("view-teammate").classList.remove("hidden");
      const explainer = turnTeam.members.find((m) => m.id === state.turn.explainerId);
      setText("teammate-explainer-name", explainer ? explainer.name : "—");
      setText("guessed-count-2", state.turn.guessedCount);
    } else {
      $("view-other").classList.remove("hidden");
      setText("other-team-name", turnTeam ? turnTeam.name : "—");
    }
  } else if (state.status === "turn_summary" && state.lastSummary) {
    $("timer").textContent = "—";
    $("view-summary").classList.remove("hidden");
    setText("summary-team-name", state.lastSummary.teamName);
    setText("summary-correct", state.lastSummary.correctCount);
    const list = $("summary-words");
    list.innerHTML = "";
    state.lastSummary.words.forEach((w) => {
      const li = document.createElement("li");
      li.className = w.result;
      const word = document.createElement("span");
      word.textContent = w.word;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = w.result === "correct" ? "+1" : state.settings.penalizeSkips ? "−1" : "пропуск";
      li.appendChild(word);
      li.appendChild(tag);
      list.appendChild(li);
    });
    $("btn-continue").classList.toggle("hidden", !state.isHost);
    $("wait-host").classList.toggle("hidden", !!state.isHost);
  } else if (state.status === "finished") {
    $("timer").textContent = "🏁";
    $("view-finished").classList.remove("hidden");
    setText("winner-name", state.winner ? `Победила команда «${state.winner.name}»!` : "—");
    const fs = $("final-scoreboard");
    fs.innerHTML = "";
    state.teams
      .slice()
      .sort((a, b) => b.score - a.score)
      .forEach((t) => {
        const row = document.createElement("div");
        row.className = "final-row";
        row.style.background = t.color;
        row.innerHTML = `<span>${t.name}</span><span>${t.score}</span>`;
        fs.appendChild(row);
      });
    $("btn-restart").classList.toggle("hidden", !state.isHost);
    $("wait-host-2").classList.toggle("hidden", !!state.isHost);
  }
}

function renderH2OGame(state) {
  if (state.status === "playing" && state.h2o) {
    $("timer").textContent = "💯";
    $("view-h2o-playing").classList.remove("hidden");
    const h = state.h2o;
    setText(
      "h2o-round-label",
      `Раунд ${h.roundIndex + 1} из ${h.totalRounds} · ${h.roundType === "reverse" ? "обратный (редкие ответы дороже)" : "обычный"}`
    );
    setText("h2o-prompt", h.prompt || "—");

    const board = $("h2o-board");
    board.innerHTML = "";
    h.answers.forEach((a) => {
      const slot = document.createElement("div");
      slot.className = "h2o-slot" + (a.revealed ? " revealed" : "");
      const left = document.createElement("span");
      left.textContent = a.revealed ? a.text : "?????";
      const right = document.createElement("span");
      right.className = "slot-points";
      right.textContent = a.points;
      slot.appendChild(left);
      slot.appendChild(right);
      board.appendChild(slot);
    });

    setText("h2o-strikes", "Промахи: " + "✗ ".repeat(h.strikes) + "○ ".repeat(Math.max(0, h.maxStrikes - h.strikes)));

    const activeTeam = state.teams.find((t) => t.id === h.activeTeamId);
    setText("h2o-active-team", `Отвечает команда «${activeTeam ? activeTeam.name : "—"}»`);

    const amCaptain = !!activeTeam && activeTeam.captainId === state.me?.id;
    $("h2o-captain-input-box").classList.toggle("hidden", !amCaptain);
    $("h2o-wait-captain").classList.toggle("hidden", amCaptain);
  } else if (state.status === "turn_summary" && state.lastSummary && state.lastSummary.gameType === "hundredToOne") {
    $("timer").textContent = "—";
    $("view-h2o-summary").classList.remove("hidden");
    const s = state.lastSummary;
    setText("h2o-summary-prompt", s.prompt);

    const list = $("h2o-summary-answers");
    list.innerHTML = "";
    s.answers.forEach((a) => {
      const li = document.createElement("li");
      li.className = a.revealed ? "" : "missed";
      const word = document.createElement("span");
      word.textContent = a.text;
      const pts = document.createElement("span");
      pts.textContent = (a.revealed ? "+" : "") + a.points;
      li.appendChild(word);
      li.appendChild(pts);
      list.appendChild(li);
    });

    const scores = $("h2o-summary-scores");
    scores.innerHTML = "";
    state.teams.forEach((t) => {
      const gained = (s.roundScores && s.roundScores[t.id]) || 0;
      const row = document.createElement("div");
      row.className = "final-row";
      row.style.background = t.color;
      const nameEl = document.createElement("span");
      nameEl.textContent = t.name;
      const ptsEl = document.createElement("span");
      ptsEl.textContent = "+" + gained;
      row.appendChild(nameEl);
      row.appendChild(ptsEl);
      scores.appendChild(row);
    });

    $("btn-h2o-continue").classList.toggle("hidden", !state.isHost);
    $("h2o-wait-host").classList.toggle("hidden", !!state.isHost);
  } else if (state.status === "finished") {
    $("timer").textContent = "🏁";
    $("view-finished").classList.remove("hidden");
    setText("winner-name", state.winner ? `Победила команда «${state.winner.name}»!` : "—");
    const fs = $("final-scoreboard");
    fs.innerHTML = "";
    state.teams
      .slice()
      .sort((a, b) => b.score - a.score)
      .forEach((t) => {
        const row = document.createElement("div");
        row.className = "final-row";
        row.style.background = t.color;
        const nameEl = document.createElement("span");
        nameEl.textContent = t.name;
        const ptsEl = document.createElement("span");
        ptsEl.textContent = t.score;
        row.appendChild(nameEl);
        row.appendChild(ptsEl);
        fs.appendChild(row);
      });
    $("btn-restart").classList.toggle("hidden", !state.isHost);
    $("wait-host-2").classList.toggle("hidden", !!state.isHost);
  }
}
