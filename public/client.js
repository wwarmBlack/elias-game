const socket = io();

let myState = null; // последний полученный "state" от сервера
let myName = "";

// ---------- утилиты ----------
const $ = (id) => document.getElementById(id);
function show(screenId) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screenId).classList.add("active");
}
function setText(id, text) { $(id).textContent = text; }

// ---------- параметры ссылки (?room=CODE) ----------
const urlParams = new URLSearchParams(location.search);
const prefillRoom = urlParams.get("room");
if (prefillRoom) {
  $("join-code").value = prefillRoom.toUpperCase();
  $("home-create").classList.add("hidden");
  $("home-join").classList.remove("hidden");
}

// ---------- экран "главная" ----------
$("btn-show-join").onclick = () => {
  $("home-create").classList.add("hidden");
  $("home-join").classList.remove("hidden");
};
$("btn-show-create").onclick = () => {
  $("home-join").classList.add("hidden");
  $("home-create").classList.remove("hidden");
};

$("btn-create").onclick = () => {
  const name = $("create-name").value.trim();
  if (!name) return showHomeError("Введите имя");
  myName = name;
  socket.emit("create_room", { name });
};

$("btn-join").onclick = () => {
  const code = $("join-code").value.trim().toUpperCase();
  const name = $("join-name").value.trim();
  if (!code) return showHomeError("Введите код комнаты");
  if (!name) return showHomeError("Введите имя");
  myName = name;
  socket.emit("join_room", { code, name });
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

function pushSettings() {
  socket.emit("update_settings", {
    turnSeconds: parseInt($("set-turn-seconds").value, 10),
    winMode: $("set-win-mode").value,
    targetScore: parseInt($("set-target-score").value, 10),
    maxRounds: parseInt($("set-max-rounds").value, 10),
  });
}

$("btn-add-team").onclick = () => socket.emit("add_team");
$("btn-start-game").onclick = () => socket.emit("start_game");

// ---------- игровые кнопки ----------
$("btn-correct").onclick = () => socket.emit("word_result", { result: "correct" });
$("btn-skip").onclick = () => socket.emit("word_result", { result: "skip" });
$("btn-continue").onclick = () => socket.emit("continue_after_summary");
$("btn-restart").onclick = () => socket.emit("start_game");

// ---------- основной рендер по состоянию с сервера ----------
socket.on("state", (state) => {
  myState = state;

  if (state.status === "lobby") {
    renderLobby(state);
    show("screen-lobby");
  } else {
    renderGame(state);
    show("screen-game");
  }
});

function renderLobby(state) {
  setText("lobby-code", state.code);
  $("host-settings").classList.toggle("hidden", !state.isHost);
  $("set-turn-seconds").value = state.settings.turnSeconds;
  $("set-win-mode").value = state.settings.winMode;
  $("set-target-score").value = state.settings.targetScore;
  $("set-max-rounds").value = state.settings.maxRounds;
  $("row-target-score").classList.toggle("hidden", state.settings.winMode === "rounds");
  $("row-max-rounds").classList.toggle("hidden", state.settings.winMode !== "rounds");

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
      chip.className = "member-chip" + (m.connected ? "" : " offline");
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
  ["view-explainer", "view-teammate", "view-other", "view-summary", "view-finished"].forEach((id) =>
    $(id).classList.add("hidden")
  );
}

function renderGame(state) {
  renderScoreboard(state);
  hideAllGameViews();

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
      tag.textContent = w.result === "correct" ? "+1" : "пропуск";
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
