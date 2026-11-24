"use strict";

(() => {
  const SESSION_KEY = "zemsky-circle-online-session-v1";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
  const socket = typeof window.io === "function" ? window.io({ autoConnect: true, reconnection: true }) : null;
  let session = readSession();
  let currentRoom = null;
  let myId = session?.playerId || null;
  let toastTimer = null;
  let confirmCallback = null;
  let requestSequence = 0;

  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
    catch { return null; }
  }
  function storeSession() {
    try {
      if (!session) localStorage.removeItem(SESSION_KEY);
      else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {}
    updateResumeCard();
  }
  function clearSession() {
    session = null; myId = null; currentRoom = null;
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    updateResumeCard(); showScreen("homeScreen");
  }
  function updateResumeCard() {
    const card = $("#resumeCard");
    if (!card) return;
    card.classList.toggle("hidden", !session);
    $("#createRoomButton").disabled = !socket?.connected || Boolean(session);
    $("#joinRoomButton").disabled = !socket?.connected || Boolean(session);
    if (!session) return;
    const finished = session.phase === "finished";
    $("#resumeTitle").textContent = finished ? "Завершённая партия" : "Ваша сохранённая комната";
    $("#resumeText").textContent = finished ? "Откройте итог, журнал и финальные шкалы." : "Вернитесь в комнату и продолжите с того же места.";
    $("#resumeButton").textContent = finished ? "Посмотреть итог" : "Продолжить";
  }
  function showScreen(id) {
    ["homeScreen", "lobbyScreen", "gameScreen"].forEach(screenId => {
      $("#" + screenId).classList.toggle("hidden", screenId !== id);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function setConnection(text, status) {
    const element = $("#connectionState");
    element.classList.remove("online", "offline");
    if (status) element.classList.add(status);
    $("span", element).textContent = text;
    const ready = status === "online";
    $("#createRoomButton").disabled = !socket || !ready || Boolean(session);
    $("#joinRoomButton").disabled = !socket || !ready || Boolean(session);
    $("#serverHint").textContent = !socket
      ? "Для общих лобби нужен запущенный сервер игры. Откройте сайт по адресу сервера."
      : status === "online"
        ? session ? "Сначала откройте сохранённую комнату или удалите доступ к ней на этом устройстве." : "Комнаты закрытые: войти можно только по приглашению. Ссылка на комнату содержит код доступа."
        : "Связь с сервером восстанавливается. Ваше место и партия сохраняются.";
  }
  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2500);
  }
  function request(eventName, payload, onSuccess) {
    if (!socket || !socket.connected) { toast("Нет связи с игровым сервером."); return; }
    const id = ++requestSequence;
    let completed = false;
    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      toast("Сервер не ответил. Проверьте соединение и попробуйте ещё раз.");
    }, 9000);
    socket.emit(eventName, payload, response => {
      if (completed) return;
      completed = true; clearTimeout(timer);
      if (!response || !response.ok) { toast(response?.message || "Не удалось выполнить действие."); return; }
      if (typeof onSuccess === "function") onSuccess(response);
    });
    return id;
  }
  function receiveRoom(room) {
    currentRoom = room;
    if (session) {
      session.phase = room.phase;
      session.code = room.code;
      storeSession();
    }
    render();
  }
  function acceptSession(response) {
    myId = response.playerId || session?.playerId || myId;
    session = { code: response.room.code, token: response.token || session?.token, playerId: myId, phase: response.room.phase };
    storeSession();
    receiveRoom(response.room);
    toast(response.room.phase === "finished" ? "Завершённая партия восстановлена." : "Вы вернулись в комнату.");
  }
  function displayError(message) { toast(message || "Произошла ошибка."); }

  function startCreate() {
    if (session) { toast("Сначала откройте сохранённую комнату или удалите её доступ."); return; }
    const name = $("#playerName").value.trim() || "Игрок";
    request("room:create", { name }, acceptSession);
  }
  function startJoin() {
    if (session) { toast("Сначала откройте сохранённую комнату или удалите её доступ."); return; }
    const name = $("#playerName").value.trim() || "Игрок";
    const code = $("#roomCodeInput").value.trim().toUpperCase();
    if (code.length !== 8) { toast("Код лобби состоит из восьми символов."); $("#roomCodeInput").focus(); return; }
    request("room:join", { name, code }, acceptSession);
  }
  function resumeSession() {
    if (!session) return;
    request("room:reconnect", { code: session.code, token: session.token }, acceptSession);
  }
  function forgetSession() {
    if (!session) return;
    const oldSession = { ...session };
    const forget = () => {
      session = null; myId = null; currentRoom = null; storeSession();
      $("#playerName").value = "";
      toast("Сохранённый доступ удалён с этого устройства.");
    };
    if (socket?.connected) {
      request("room:reconnect", { code: oldSession.code, token: oldSession.token }, response => {
        myId = response.playerId;
        currentRoom = response.room;
        socket.emit("room:leave", {}, () => forget());
      });
    } else {
      forget();
      toast("Доступ удалён. Если вы были в лобби, место освободится после срока ожидания.");
    }
  }
  function sendReady(ready) {
    request("lobby:ready", { ready }, () => {});
  }
  function startGame() {
    request("lobby:start", {}, () => toast("Партия началась."));
  }
  function leaveRoom() {
    if (!currentRoom) return;
    request("room:leave", {}, response => {
      if (response.activeGame) {
        currentRoom = null;
        if (session) { session.phase = "game"; storeSession(); }
        showScreen("homeScreen");
        toast("Вы вышли. Ведущий подхватит вашу роль; вы можете вернуться по сохранённому доступу.");
      } else {
        clearSession();
        toast("Вы вышли из комнаты.");
      }
    });
  }
  function closeRoom() {
    request("room:close", {}, () => {
      clearSession();
      toast("Комната закрыта для всех участников.");
    });
  }
  function eventChoice(index) {
    request("game:event-choice", { index }, () => {});
  }
  function roleAction(roleKey, actionId) {
    request("game:action", { roleKey, actionId }, () => {});
  }
  function readyForNext(ready) {
    request("game:intermission-ready", { ready }, () => {});
  }
  function forceContinue() {
    request("game:intermission-force", {}, () => toast("Переходим дальше."));
  }
  function rematch() {
    request("game:rematch", {}, () => toast("Комната снова ждёт игроков."));
  }

  function currentPlayer() { return currentRoom?.players.find(player => player.id === myId) || null; }
  function isHost() { return Boolean(currentRoom && currentRoom.hostId === myId); }
  function inviteUrl() {
    return window.location.origin + window.location.pathname + "?room=" + encodeURIComponent(currentRoom?.code || "");
  }
  async function copyInvite() {
    if (!currentRoom) return;
    const value = inviteUrl();
    try {
      await navigator.clipboard.writeText(value);
      toast("Ссылка на лобби скопирована.");
    } catch {
      const input = document.createElement("textarea");
      input.value = value; input.setAttribute("readonly", ""); input.className = "copy-helper";
      document.body.appendChild(input); input.select();
      const ok = document.execCommand("copy"); input.remove();
      toast(ok ? "Ссылка на лобби скопирована." : "Скопируйте ссылку вручную: " + value);
    }
  }
  function downloadLog() {
    if (!currentRoom?.game) { toast("Журнал появится после начала партии."); return; }
    const game = currentRoom.game;
    const lines = [
      "ЗЕМСКИЙ КРУГ — ЖУРНАЛ ПАРТИИ",
      "Комната: " + currentRoom.code,
      "Игроки: " + currentRoom.players.map(p => p.name).join(", "),
      ""
    ];
    game.log.forEach(item => lines.push("Раунд " + item.round + " · " + item.title + "\n" + item.text));
    lines.push("", "Итоговые шкалы:",
      "Запасы: " + game.tracks.supplies, "Поддержка: " + game.tracks.support,
      "Согласие: " + game.tracks.unity, "Угроза: " + game.tracks.threat);
    if (game.phase === "finished") lines.push("", game.won ? "ПОБЕДА" : "ПОРАЖЕНИЕ", game.resultReason);
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "Земский-круг-журнал-" + currentRoom.code + ".txt";
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  }
  function openDialog(id) { const dialog = $("#" + id); if (dialog && !dialog.open) dialog.showModal(); }
  function confirm(title, text, label, callback) {
    $("#confirmTitle").textContent = title;
    $("#confirmText").textContent = text;
    $("#confirmActionButton").textContent = label;
    confirmCallback = callback;
    openDialog("confirmDialog");
  }
  function safeClose(id) { const dialog = $("#" + id); if (dialog?.open) dialog.close(); }

  function render() {
    if (!currentRoom) { showScreen("homeScreen"); return; }
    if (currentRoom.phase === "lobby") { showScreen("lobbyScreen"); renderLobby(); }
    else { showScreen("gameScreen"); renderGame(); }
  }
  function renderLobby() {
    const room = currentRoom;
    const me = currentPlayer();
    const host = isHost();
    $("#inviteCode").textContent = room.code;
    $("#miniCode").textContent = room.code;
    $("#inviteUrl").textContent = inviteUrl();
    $("#playerCountLabel").textContent = "Игроки · " + room.players.length + "/4";
    const allReady = room.players.length >= 2 && room.players.every(player => player.connected && player.ready);
    $("#lobbyStatus").textContent = allReady ? "Все готовы" : room.players.length >= 4 ? "Лобби заполнено" : "Ждём игроков";
    $("#lobbyPlayers").innerHTML = room.players.map(player => {
      const meta = [player.isHost ? "ведущий" : "участник", player.id === myId ? "вы" : ""].filter(Boolean).join(" · ");
      const status = player.connected ? (player.ready ? "Готов" : "Ожидает") : "Нет связи";
      const canKick = host && player.id !== myId;
      return '<div class="player-row"><div class="player-info"><span class="player-avatar">' +
        escapeHTML(player.name.trim().slice(0,1).toUpperCase() || "?") + '</span><span class="player-details"><span class="player-name">' +
        escapeHTML(player.name) + '</span><span class="player-meta">' + escapeHTML(meta) + '</span></span></div>' +
        '<span class="player-tools"><span class="player-status ' + (player.connected ? "" : "offline") + '">' + status + '</span>' +
        (canKick ? '<button type="button" class="kick-button" data-kick="' + escapeHTML(player.id) + '">Удалить</button>' : "") +
        '</span></div>';
    }).join("");
    let buttons = "";
    if (!host) buttons += '<button class="button button-primary" id="lobbyReadyButton" type="button">' + (me?.ready ? "Снять готовность" : "Я готов(а)") + '</button>';
    else buttons += '<button class="button button-secondary" type="button" disabled>Вы — ведущий</button>';
    if (host) buttons += '<button class="button button-primary" id="lobbyStartButton" type="button" ' + (allReady ? "" : "disabled") + '>Начать партию</button>';
    if (host) buttons += '<button class="button button-quiet" id="lobbyCloseButton" type="button">Закрыть комнату</button>';
    $("#lobbyActions").innerHTML = buttons;
    $("#lobbyNote").textContent = host
      ? allReady ? "Все подключены и готовы. Можно начинать партию." : "Нужно минимум два игрока. Дождитесь подключения и отметки «Готов» от каждого."
      : "Когда вы готовы, отметьтесь. Начать партию сможет ведущий после готовности всей команды.";
    $("#lobbyLeaveButton").textContent = host ? "Выйти и передать ведущего" : "Выйти из лобби";
  }

  function effectText(effect) {
    const names = { supplies: "запаса", support: "поддержки", unity: "согласия", threat: "угрозы" };
    return Object.entries(effect || {}).map(([key, amount]) => (amount > 0 ? "+" : "−") + Math.abs(amount) + " " + names[key]).join(" · ") || "без изменений";
  }
  function actionLesson(action) {
    const lessons = {
      gather: "Обмениваете запас на поддержку городов — полезно, если припасов достаточно для похода.",
      council: "Снижает угрозу и укрепляет согласие, но не продвигает отряд по маршруту.",
      wagon: "Пополняет обоз. Запасы нужны для движения и содержания лагеря.",
      levy: "Даёт больше припасов, чем обычный сбор, но ослабляет доверие городов.",
      march: "Продвигает отряд быстрее, но тратит запасы и повышает угрозу.",
      carefulMarch: "Тратит больше запасов, зато не увеличивает угрозу.",
      guard: "Помогает переждать опасность: угроза ниже, согласие выше, маршрут без изменений.",
      secure: "Стабилизирует подступы к Москве: уменьшает угрозу и возвращает поддержку.",
      reserve: "Пополняет запасы ценой роста угрозы — это подготовка, а не бесплатный бонус.",
      mediate: "Укрепляет согласие без расхода запасов; особенно полезно перед финальным решением.",
      letters: "Укрепляет поддержку и согласие, но отправка грамот стоит одного запаса.",
      sobor: "Последний шаг маршрута. Нужны поддержка и согласие не ниже 4 и достаточный запас."
    };
    return lessons[action.id] || "Сравните пользу и цену с текущими шкалами и целью команды.";
  }
  function choiceLesson(choice) {
    const effects = Object.entries(choice.effect || {});
    const cost = effects.filter(([, value]) => value < 0).map(([key]) => ({ supplies: "запасов", support: "поддержки городов", unity: "согласия", threat: "безопасности" }[key]));
    const gain = effects.filter(([, value]) => value > 0).map(([key]) => ({ supplies: "припасов", support: "поддержки", unity: "согласия", threat: "напряжения" }[key]));
    return (gain.length ? "Польза: " + gain.join(" и ") + ". " : "") + (cost.length ? "Цена: " + cost.join(" и ") + "." : "Ресурсы не тратятся.");
  }
  function upkeepLesson(round, threat) {
    const cost = round <= 2 ? 1 : round <= 4 ? 2 : 3;
    const surcharge = threat >= 4 ? 1 : 0;
    return "После этого раунда лагерь потратит " + (cost + surcharge) + ((cost + surcharge) === 1 ? " запас." : " запаса.") +
      (surcharge ? " Угроза 4+ добавляет 1 запас на охрану." : " Если удержать угрозу ниже 4, охрана не подорожает.") + " Обсудите, кто пополнит обоз.";
  }
  function renderRoute(game) {
    $("#routeList").innerHTML = window.ZemskyRules.ROUTE.map((stop, index) => {
      const cls = index < game.place ? "passed" : index === game.place ? "current" : "";
      return '<li class="route-stop ' + cls + '"><span class="route-dot">' + (index < game.place ? "✓" : (index + 1)) + '</span><span><span class="route-name">' +
        escapeHTML(stop.name) + '</span><span class="route-date">' + escapeHTML(stop.date) + '</span></span></li>';
    }).join("");
    $("#routeHint").textContent = window.ZemskyRules.ROUTE[game.place]?.hint || "";
  }
  function renderTracks(game) {
    const tracks = [
      { key: "supplies", title: "Запасы", detail: "2 — минимум для Собора · 3 — безопасный марш", icon: "◈", marks: [{ value: 2, label: "Финал" }, { value: 3, label: "Марш" }] },
      { key: "support", title: "Поддержка", detail: "Для Земского собора нужно не меньше 4", icon: "⌂", marks: [{ value: 4, label: "Собор" }] },
      { key: "unity", title: "Согласие", detail: "Для Земского собора нужно не меньше 4", icon: "◎", marks: [{ value: 4, label: "Собор" }] },
      { key: "threat", title: "Угроза", detail: "4 — опасная зона · 6 — поражение", icon: "⚑", marks: [{ value: 4, label: "Опасно" }, { value: 6, label: "Поражение" }] }
    ];
    $("#trackList").innerHTML = tracks.map(track => {
      const max = window.ZemskyRules.MAX[track.key], value = game.tracks[track.key];
      return '<div class="track-row"><div class="track-top"><span class="track-label">' + track.icon + '　' + track.title +
        '</span><span class="track-value">' + value + '<small> / ' + max + '</small></span></div><div class="track-bar" role="meter" aria-label="' +
        track.title + '" aria-valuemin="0" aria-valuemax="' + max + '" aria-valuenow="' + value + '"><div class="track-fill ' +
        track.key + '" data-value="' + value + '"></div>' + track.marks.map(mark => '<span class="track-mark ' + track.key + '" style="left:' + (mark.value / max * 100) + '%" title="' + mark.label + ': ' + mark.value + '">' + mark.value + '</span>').join("") +
        '</div><div class="track-foot">' + track.detail + '</div></div>';
    }).join("");
  }
  function ownerForRole(game, roleIndex) {
    const playerId = game.playerOrder[(roleIndex + game.round - 1) % game.playerOrder.length];
    return currentRoom.players.find(player => player.id === playerId) || { id: playerId, name: "Игрок", connected: false, left: false };
  }
  function canControlActor() {
    const actor = currentRoom?.currentActor;
    return Boolean(actor && (actor.playerId === myId || (isHost() && actor.canTakeover)));
  }
  function waitingMessage() {
    const actor = currentRoom.currentActor;
    if (!actor) return "";
    if (canControlActor()) {
      if (actor.playerId !== myId) return "Игрок " + actor.name + " не в сети больше двух минут. Ведущий может выбрать за него.";
      return actor.kind === "event" ? "Ваш выбор: решите, как команда ответит на событие." : "Ваш ход: роль «" + actor.roleName + "» выбирает действие.";
    }
    if (!actor.connected && !actor.left) return "Ждём, когда " + actor.name + " вернётся. Через две минуты ведущий сможет продолжить за него.";
    if (actor.left) return "Игрок " + actor.name + " вышел. Ведущий продолжит этот ход за него.";
    return "Ждём решения игрока " + actor.name + (actor.roleName ? " · роль «" + actor.roleName + "»." : ".");
  }
  function renderPhase(game) {
    const card = $("#phaseCard");
    if (game.phase === "event") {
      const event = window.ZemskyRules.EVENTS[game.round - 1];
      const allowed = canControlActor();
      card.innerHTML = '<div class="phase-kicker">Событие раунда ' + game.round + ' · выберите ответ</div><h2>' + escapeHTML(event.title) +
        '</h2><p>' + escapeHTML(event.fact) + '</p><p class="learning-note">У каждого ответа есть цена. Сравните последствия и выберите, какой ресурс важнее команде сейчас.</p>' + '<div class="choice-grid">' +
        event.choices.map((choice, index) => '<button type="button" class="choice-button" data-choice="' + index + '" ' + (allowed ? "" : "disabled") +
          '><b>' + escapeHTML(choice.title) + '</b><span>' + effectText(choice.effect) + '</span><span class="choice-reason">' + escapeHTML(choiceLesson(choice)) + '</span></button>').join("") + '</div>';
    } else if (game.phase === "actions") {
      const actor = currentRoom.currentActor;
      const activeRole = window.ZemskyRules.ROLES.find(role => role.key === actor?.roleKey);
      const roleActions = activeRole ? window.ZemskyRules.actionsFor(game, activeRole.key) : [];
      const lesson = roleActions.map(action => '<li><b>' + escapeHTML(action.title) + ':</b> ' + escapeHTML(actionLesson(action)) + '</li>').join("");
      card.innerHTML = '<div class="phase-kicker">Совет четырёх ролей · раунд ' + game.round + '</div><h2>Общее дело держится на каждом решении</h2><p>За раунд команда получает по одному ходу каждой роли. Один игрок выбирает, последствия почувствуют все — обсудите план вместе.</p>' +
        (activeRole ? '<div class="learning-note"><b>Сейчас действует роль «' + escapeHTML(activeRole.name) + '».</b><ul>' + lesson + '</ul></div>' : '') +
        '<p class="phase-note">' + escapeHTML(upkeepLesson(game.round, game.tracks.threat)) + '</p><div class="phase-wait">' + escapeHTML(waitingMessage()) + '</div><p class="phase-note">Осталось действий: ' + (4 - Object.values(game.actionsDone || {}).filter(Boolean).length) + ' из 4.</p>';
    } else if (game.phase === "intermission") {
      const fact = game.intermissionFact || window.ZemskyRules.BETWEEN_ROUND_FACTS[game.round - 1];
      const connected = currentRoom.players.filter(player => player.connected && !player.left);
      const readyIds = game.readyIds || [];
      const allReady = currentRoom.allConnectedReady;
      const meReady = readyIds.includes(myId);
      const readyNames = connected.map(player => (readyIds.includes(player.id) ? "✓ " : "○ ") + player.name).join(" · ");
      card.innerHTML = '<div class="phase-kicker">Передышка между раундами · ' + (game.round < 6 ? "раунд " + game.round + " завершён" : "последний раунд завершён") + '</div>' +
        '<span class="fact-mark">Интересный факт</span><h2>' + escapeHTML(fact.title) + '</h2><p>' + escapeHTML(fact.text) + '</p>' +
        '<p class="phase-note fact-source">' + escapeHTML(fact.source) + '</p><div class="intermission-actions">' +
        '<button type="button" class="button ' + (meReady ? "button-secondary" : "button-primary") + '" data-intermission-ready="' + (meReady ? "false" : "true") + '">' +
        (meReady ? "Жду остальных…" : "Прочитал(а), дальше") + '</button>' +
        (isHost() && !allReady ? '<button type="button" class="button button-secondary" data-force-continue="true">Продолжить без ожидания</button>' : "") +
        '</div><p class="ready-list">' + (allReady ? "Все на связи готовы продолжить." : "Отметились: " + escapeHTML(readyNames || "пока никто")) + '</p>';
    } else if (game.phase === "finished") {
      const won = Boolean(game.won);
      card.innerHTML = '<div class="phase-kicker">' + (won ? "Команда победила" : "Итог партии") + '</div><h2>' +
        (won ? "Земский круг состоялся" : "Общее решение не найдено") + '</h2><p>' + escapeHTML(game.resultReason) + '</p>' +
        '<div class="result-stats">' + [
          ["Запасы", game.tracks.supplies], ["Поддержка", game.tracks.support], ["Согласие", game.tracks.unity], ["Угроза", game.tracks.threat]
        ].map(([label,value]) => '<div class="result-stat"><b>' + value + '</b><span>' + label + '</span></div>').join("") + '</div>' +
        '<div class="result-controls">' +
        (isHost() ? '<button type="button" class="button button-primary" id="rematchButton">Новая партия в этой комнате</button>' : '<span class="phase-note">Ведущий может открыть новую партию для всей команды.</span>') +
        '<button type="button" class="button button-secondary" data-download-log="true">Скачать журнал</button></div>';
    }
  }
  function renderRoles(game) {
    const definitions = window.ZemskyRules.ROLES;
    const phaseActive = game.phase === "actions";
    $("#roleGrid").innerHTML = definitions.map((role, index) => {
      const owner = ownerForRole(game, index);
      const done = Boolean(game.actionsDone?.[role.key]);
      const actor = currentRoom.currentActor;
      const active = phaseActive && actor?.roleKey === role.key;
      const takeover = active && canControlActor() && actor.playerId !== myId;
      const canAct = active && canControlActor();
      const actions = window.ZemskyRules.actionsFor(game, role.key);
      let status = done ? "Действие выполнено" :
        active ? (takeover ? "Ведущий выбирает за отключившегося игрока" : canAct ? "Ваш ход — выберите действие" : "Ожидается решение участника") :
        phaseActive ? "Ожидает своей очереди" : game.phase === "intermission" ? "Раунд завершён" : game.phase === "finished" ? "Партия завершена" : "Действия откроются после события";
      return '<article class="role-card ' + (active ? "active " : "") + (done ? "done " : "") + (!phaseActive && !done ? "unavailable" : "") + '">' +
        '<div class="role-title-row"><span class="role-icon" aria-hidden="true">' + role.icon + '</span><h3>' + escapeHTML(role.name) + '</h3></div>' +
        '<p class="role-owner">' + escapeHTML(owner.name) + (owner.id === myId ? " · вы" : "") +
        (owner.connected ? "" : " · нет связи") + " — " + escapeHTML(role.description) + '</p>' +
        '<div class="action-list">' + actions.map(action => {
          const disabled = !canAct || !action.can;
          const reason = !action.can ? "Не хватает ресурсов для действия." : !canAct ? status : "";
          return '<button type="button" class="action-button" data-role="' + role.key + '" data-action="' + action.id + '" ' +
            (disabled ? "disabled " : "") + 'title="' + escapeHTML(reason) + '"><b>' + escapeHTML(action.title) + '</b><span>' +
            escapeHTML(action.text) + '</span><span class="action-lesson">Зачем: ' + escapeHTML(actionLesson(action)) + '</span><span class="effect">' + escapeHTML(action.note) + '</span></button>';
        }).join("") + '</div><div class="role-status">' + escapeHTML(status) + '</div></article>';
    }).join("");
  }
  function renderLog(game) {
    const entries = (game.log || []).slice(-9).reverse();
    $("#logList").innerHTML = entries.length ? entries.map(entry =>
      '<div class="log-entry"><b>Раунд ' + entry.round + " · " + escapeHTML(entry.title) + '</b>' + escapeHTML(entry.text) + '</div>'
    ).join("") : '<div class="empty-log">Здесь появятся решения команды.</div>';
  }
  function renderGame() {
    const room = currentRoom, game = room.game;
    if (!game) { render(); return; }
    $("#roomBadge").textContent = "Лобби " + room.code + (isHost() ? " · ведущий" : "");
    $("#gameCloseButton").classList.toggle("hidden", !isHost());
    $("#miniCode").textContent = room.code;
    $("#roundNumber").textContent = game.round;
    const banner = $("#turnBanner");
    banner.classList.toggle("waiting", Boolean(room.currentActor && room.currentActor.playerId !== myId));
    banner.innerHTML = game.phase === "finished"
      ? "<strong>Партия завершена.</strong> Итог и журнал доступны всем участникам."
      : game.phase === "intermission"
        ? "<strong>Между раундами.</strong> Прочитайте историческую вставку и отметьтесь, когда будете готовы продолжить."
        : "<strong>Текущая очередь.</strong> " + escapeHTML(waitingMessage());
    renderRoute(game); renderTracks(game); renderPhase(game); renderRoles(game); renderLog(game);
  }

  function handleConfirmedAction(action) {
    safeClose("confirmDialog");
    if (typeof action === "function") action();
  }

  if (socket) {
    socket.on("connect", () => {
      setConnection("Связь установлена", "online");
      if (session) updateResumeCard();
    });
    socket.on("disconnect", () => setConnection("Связь прервана · переподключаемся", "offline"));
    socket.on("connect_error", () => setConnection("Не удалось подключиться", "offline"));
    socket.on("room:state", room => receiveRoom(room));
    socket.on("app:error", payload => displayError(payload?.message));
    socket.on("room:closed", payload => {
      clearSession();
      displayError(payload?.message || "Комната закрыта.");
    });
    socket.on("room:kicked", payload => {
      clearSession();
      displayError(payload?.message || "Вас удалили из лобби.");
    });
  } else {
    setConnection("Откройте сайт через сервер игры", "offline");
  }

  $("#createRoomButton").addEventListener("click", startCreate);
  $("#joinRoomButton").addEventListener("click", startJoin);
  $("#roomCodeInput").addEventListener("input", event => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0,8);
  });
  $("#roomCodeInput").addEventListener("keydown", event => { if (event.key === "Enter") startJoin(); });
  $("#resumeButton").addEventListener("click", resumeSession);
  $("#forgetButton").addEventListener("click", () => confirm(
    "Удалить сохранённый доступ?",
    "Вы выйдете из комнаты, если сервер доступен. Если связи нет, сохранённый код удалится с этого устройства, а место освободится после срока ожидания.",
    "Удалить доступ",
    forgetSession
  ));
  $("#copyInviteButton").addEventListener("click", copyInvite);
  $("#miniCopyButton").addEventListener("click", copyInvite);
  $("#lobbyLeaveButton").addEventListener("click", () => confirm(
    "Выйти из лобби?",
    isHost() ? "Ведущим автоматически станет другой подключённый участник." : "Ваше место освободится, и ведущий сможет начать без вас.",
    "Выйти",
    leaveRoom
  ));
  $("#gameLeaveButton").addEventListener("click", () => confirm(
    "Выйти из партии?",
    "Ваше место останется в партии, а ведущий сможет выбрать за вашу роль. При желании вы сможете вернуться по той же ссылке.",
    "Выйти",
    leaveRoom
  ));
  $("#gameCloseButton").addEventListener("click", () => confirm(
    "Закрыть комнату для всех?",
    "Партия и сохранение комнаты будут удалены с сервера. Участники выйдут из комнаты.",
    "Закрыть комнату",
    closeRoom
  ));
  $("#downloadLogButton").addEventListener("click", downloadLog);
  $("#confirmActionButton").addEventListener("click", () => handleConfirmedAction(confirmCallback));
  document.addEventListener("click", event => {
    const open = event.target.closest("[data-open-dialog]");
    if (open) openDialog(open.dataset.openDialog);
    const close = event.target.closest("[data-close-dialog]");
    if (close) $("#" + close.dataset.closeDialog)?.close();
    const ready = event.target.closest("[data-intermission-ready]");
    if (ready) readyForNext(ready.dataset.intermissionReady === "true");
    const force = event.target.closest("[data-force-continue]");
    if (force) confirm("Продолжить без остальных?", "Не все подключённые игроки отметились. Раунд будет завершён и появится следующее событие.", "Продолжить", forceContinue);
    const choice = event.target.closest("[data-choice]");
    if (choice) eventChoice(Number(choice.dataset.choice));
    const action = event.target.closest("[data-role][data-action]");
    if (action) roleAction(action.dataset.role, action.dataset.action);
    const kick = event.target.closest("[data-kick]");
    if (kick) confirm("Удалить игрока?", "Участник будет выведен из комнаты, а его место освободится.", "Удалить", () => request("lobby:kick", { playerId: kick.dataset.kick }, () => {}));
    const download = event.target.closest("[data-download-log]");
    if (download) downloadLog();
    if (event.target.id === "lobbyReadyButton") sendReady(!currentPlayer()?.ready);
    if (event.target.id === "lobbyStartButton") startGame();
    if (event.target.id === "lobbyCloseButton") confirm("Закрыть комнату для всех?", "Все участники выйдут, а приглашение перестанет работать.", "Закрыть комнату", closeRoom);
    if (event.target.id === "rematchButton") confirm("Открыть новую партию?", "Текущая история останется в журнале этой комнаты до начала следующей партии.", "Новая партия", rematch);
  });

  const roomFromLink = new URLSearchParams(window.location.search).get("room");
  if (roomFromLink) $("#roomCodeInput").value = roomFromLink.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0,8);
  let savedName = "";
  try { savedName = localStorage.getItem("zemsky-circle-player-name") || ""; } catch {}
  if (savedName) $("#playerName").value = savedName;
  $("#playerName").addEventListener("change", event => {
    try { localStorage.setItem("zemsky-circle-player-name", event.target.value.trim().slice(0,22)); } catch {}
    if (currentRoom && !currentRoom.game) request("room:rename", { name: event.target.value.trim() }, () => {});
  });
  updateResumeCard();
  if (session) {
    $("#createRoomButton").disabled = true;
    $("#joinRoomButton").disabled = true;
  }
})();
