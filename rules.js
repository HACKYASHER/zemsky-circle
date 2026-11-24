"use strict";

const ZemskyRules = (() => {
  const MAX = Object.freeze({ supplies: 10, support: 10, unity: 10, threat: 6 });
  const ROUTE = Object.freeze([
    { name: "Нижний Новгород", date: "Осень 1611 · начало ополчения", hint: "Здесь начинает складываться Второе ополчение. Сначала нужны люди, средства и доверие городов." },
    { name: "Ярославль", date: "Весна–лето 1612 · Совет всея земли", hint: "В Ярославле ополчение укрепилось и провело несколько месяцев. Здесь особенно важны снабжение и согласие." },
    { name: "Москва", date: "Осень 1612 · освобождение столицы", hint: "Дойти до Москвы — ещё не конец пути. Впереди нужно договориться о будущем страны." },
    { name: "Земский собор", date: "Февраль 1613 · решение о новом государе", hint: "Итог зависит от общего решения: поддержка, согласие и запасы должны сохраниться до конца партии." }
  ]);
  const EVENTS = Object.freeze([
    {
      title: "Призыв в Нижнем Новгороде",
      fact: "В 1611 году в Нижнем Новгороде начало складываться Второе ополчение. В игре первые решения задают тон всей кампании.",
      choices: [
        { title: "Сначала заручиться поддержкой", effect: { support: 2, supplies: -1 }, result: "Команда обратилась к городам за помощью." },
        { title: "Наполнить обоз", effect: { supplies: 2, unity: -1 }, result: "Первые средства направили на обоз." }
      ]
    },
    {
      title: "Сбор средств и припасов",
      fact: "Для похода требовались деньги, продовольствие и снаряжение. Ресурсы можно собрать быстро, но важно не потерять доверие.",
      choices: [
        { title: "Сбор по согласию", effect: { supplies: 2, support: 1 }, result: "Города внесли посильный вклад." },
        { title: "Чрезвычайный сбор", effect: { supplies: 3, support: -1, threat: 1 }, result: "Запасы пополнили ценой недовольства." }
      ]
    },
    {
      title: "Ярославль становится опорой",
      fact: "Весной 1612 года ополчение пришло в Ярославль и оставалось там до лета. Город стал важным центром сбора и управления.",
      choices: [
        { title: "Поддержать жителей города", effect: { support: 1, unity: 1, supplies: -1 }, result: "Забота о городе укрепила взаимное доверие." },
        { title: "Сосредоточиться на обозе", effect: { supplies: 2, support: -1 }, result: "Главным приоритетом стало снабжение." }
      ]
    },
    {
      title: "Совет всея земли",
      fact: "В Ярославле действовал Совет всея земли — временный центр управления. В игре это повод проверить, готовы ли участники уступать друг другу.",
      choices: [
        { title: "Обсудить план вместе", effect: { unity: 2, supplies: -1 }, result: "Совет согласовал общий план." },
        { title: "Принять решение быстро", effect: { supplies: 2, unity: -1, threat: 1 }, result: "Решение ускорило сбор, но усилило разногласия." }
      ]
    },
    {
      title: "Дорога к Москве",
      fact: "Летом 1612 года ополчение выступило из Ярославля к Москве. Долгий путь требовал выбирать между осторожностью и скоростью.",
      choices: [
        { title: "Идти осторожно", effect: { supplies: -1, threat: -1 }, result: "Команда уделила внимание безопасности пути." },
        { title: "Не задерживаться", effect: { threat: 1, unity: 1 }, result: "Решительный настрой поддержал участников, но обстановка стала опаснее." }
      ]
    },
    {
      title: "К общему решению",
      fact: "После освобождения Москвы в октябре 1612 года был созван Земский собор. В феврале 1613 года участники достигли согласия об избрании Михаила Фёдоровича.",
      choices: [
        { title: "Собирать представителей", effect: { unity: 2, supplies: -1 }, result: "Стороны сделали шаг к общему решению." },
        { title: "Снизить напряжение", effect: { threat: -1, support: 1 }, result: "Команда постаралась сохранить порядок и доверие." }
      ]
    }
  ]);
  const BETWEEN_ROUND_FACTS = Object.freeze([
    {
      title: "С чего началось Второе ополчение",
      text: "Осенью 1611 года в Нижнем Новгороде по призыву Кузьмы Минина начали собирать новое ополчение. В нашей игре роли старосты, казначея, воеводы и посланника — собирательные: они показывают, сколько разных задач нужно было решать одновременно.",
      source: "Историческая опора: материалы Ярославского музея-заповедника о Втором ополчении."
    },
    {
      title: "Путь через города",
      text: "К ополчению присоединялись люди из разных городов и земель. Его устойчивость зависела не только от военной силы: требовалось договариваться, собирать средства и поддерживать порядок.",
      source: "Историческая опора: материалы экспозиции «История Ярославского края»."
    },
    {
      title: "Почему важен Ярославль",
      text: "Второе ополчение находилось в Ярославле с весны до лета 1612 года. За эти месяцы город стал важным местом сбора и подготовки похода.",
      source: "Историческая опора: справка Ярославской областной Думы о памятных датах региона."
    },
    {
      title: "Совет всея земли",
      text: "В Ярославле действовал Совет всея земли — временный орган управления. Он помогал связывать интересы разных городов и отрядов. Именно поэтому в игре шкала согласия влияет на общий исход.",
      source: "Историческая опора: исследовательская хронология событий 1612 года на портале «Открытый текст»."
    },
    {
      title: "Из Ярославля — к Москве",
      text: "Летом 1612 года ополчение двинулось к Москве. Освобождение столицы стало поворотным событием, однако государству всё ещё требовалось восстановить управление.",
      source: "Историческая опора: Ярославская областная Дума и исследовательская хронология портала «Открытый текст»."
    },
    {
      title: "Решение Земского собора",
      text: "21 февраля по старому стилю (3 марта по новому стилю) 1613 года участники Земского собора достигли согласия об избрании Михаила Фёдоровича. В игре это финальная проверка: удалось ли сохранить ресурсы и договориться.",
      source: "Историческая опора: Музеи Московского Кремля, материал «Заседание Земского собора»."
    }
  ]);
  const ROLES = Object.freeze([
    { key: "elder", name: "Староста", icon: "⌂", description: "Связывает города и людей." },
    { key: "treasurer", name: "Казначей", icon: "◈", description: "Следит за запасами и сборами." },
    { key: "commander", name: "Воевода", icon: "⚔", description: "Выбирает темп и путь похода." },
    { key: "envoy", name: "Посланник", icon: "✉", description: "Ищет согласие между сторонами." }
  ]);

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function eventFor(game) { return EVENTS[game.round - 1]; }
  function roleIndexFor(game) { return ROLES.findIndex(role => !game.actionsDone[role.key]); }
  function assignedPlayerId(game, roleIndex) {
    return game.playerOrder[(roleIndex + game.round - 1) % game.playerOrder.length];
  }
  function effectText(effects) {
    const names = { supplies: "запаса", support: "поддержки", unity: "согласия", threat: "угрозы" };
    return Object.entries(effects || {}).map(([key, amount]) =>
      (amount > 0 ? "+" : "−") + Math.abs(amount) + " " + names[key]
    ).join(" · ") || "без изменений";
  }
  function applyEffects(game, effects) {
    const changed = {};
    for (const [key, amount] of Object.entries(effects || {})) {
      const old = game.tracks[key];
      game.tracks[key] = clamp(old + amount, 0, MAX[key]);
      changed[key] = game.tracks[key] - old;
    }
    return changed;
  }
  function collapseReason(game) {
    if (game.tracks.threat >= MAX.threat) return "Угроза достигла критического уровня — порядок не удалось сохранить.";
    if (game.tracks.support <= 0) return "Поддержка исчезла — города больше не готовы помогать общему делу.";
    if (game.tracks.unity <= 0) return "Согласие распалось — команда не смогла продолжить общий путь.";
    return "";
  }
  function conclude(game, won, reason) {
    game.phase = "finished";
    game.finished = true;
    game.won = Boolean(won);
    game.resultReason = reason;
    game.finishedAt = Date.now();
    game.log.push({ round: game.round, title: won ? "Общее решение найдено" : "Партия завершилась", text: reason });
  }
  function createGame(players) {
    if (!Array.isArray(players) || players.length < 2 || players.length > 4) throw new Error("Для начала партии нужны 2–4 игрока.");
    return {
      round: 1, phase: "event", place: 0, playerOrder: players.map(p => p.id),
      tracks: { supplies: 6, support: 6, unity: 6, threat: 2 },
      actionsDone: {}, readyIds: [], eventChoice: null, log: [],
      finished: false, won: false, resultReason: "", createdAt: Date.now()
    };
  }
  function currentActor(game) {
    if (!game || !game.playerOrder.length) return null;
    if (game.phase === "event") {
      const index = (game.round - 1) % game.playerOrder.length;
      return { playerId: game.playerOrder[index], kind: "event", roleKey: null, roleName: null };
    }
    if (game.phase === "actions") {
      const index = roleIndexFor(game);
      if (index < 0) return null;
      return { playerId: assignedPlayerId(game, index), kind: "action", roleKey: ROLES[index].key, roleName: ROLES[index].name };
    }
    return null;
  }
  function actionsFor(game, roleKey) {
    switch (roleKey) {
      case "elder":
        return [
          { id: "gather", title: "Собрать помощь городов", text: "Обратиться к посадским и соседним волостям.", effect: { support: 2, supplies: -1 }, note: "+2 поддержка · −1 запас", can: game.tracks.supplies >= 1 },
          { id: "council", title: "Собрать общий совет", text: "Укрепить согласие и снизить напряжение.", effect: { unity: 1, threat: -1 }, note: "+1 согласие · −1 угроза", can: true }
        ];
      case "treasurer":
        return [
          { id: "wagon", title: "Снарядить обоз", text: "Пополнить продовольствие и средства.", effect: { supplies: 3 }, note: "+3 запаса", can: true },
          { id: "levy", title: "Чрезвычайный сбор", text: "Получить больше сейчас, рискуя доверием.", effect: { supplies: 4, support: -1 }, note: "+4 запаса · −1 поддержка", can: true }
        ];
      case "commander":
        if (game.place < 2) return [
          { id: "march", title: "Продвинуться по тракту", text: "Быстрый путь к следующей точке маршрута.", effect: { supplies: -2, threat: 1 }, placeTo: game.place + 1, note: "−2 запаса · +1 угроза · шаг по маршруту", can: game.tracks.supplies >= 2 },
          { id: "carefulMarch", title: "Выбрать безопасный путь", text: "Потратить больше запасов и избежать лишнего риска.", effect: { supplies: -3 }, placeTo: game.place + 1, note: "−3 запаса · шаг по маршруту", can: game.tracks.supplies >= 3 },
          { id: "guard", title: "Укрепить лагерь", text: "Передышка поможет снизить угрозу.", effect: { threat: -1, unity: 1 }, note: "−1 угроза · +1 согласие", can: true }
        ];
        return [
          { id: "secure", title: "Укрепить подступы", text: "Снизить угрозу и вернуть доверие людей.", effect: { threat: -2, support: 1 }, note: "−2 угроза · +1 поддержка", can: true },
          { id: "reserve", title: "Распорядиться запасами", text: "Подготовить команду к решению на соборе.", effect: { supplies: 2, threat: 1 }, note: "+2 запаса · +1 угроза", can: true }
        ];
      case "envoy": {
        const options = [
          { id: "mediate", title: "Посредничать между отрядами", text: "Снизить разногласия и сохранить единство.", effect: { unity: 2 }, note: "+2 согласия", can: true },
          { id: "letters", title: "Отправить грамоты городам", text: "Укрепить поддержку и согласие.", effect: { unity: 1, support: 1, supplies: -1 }, note: "+1 согласие · +1 поддержка · −1 запас", can: game.tracks.supplies >= 1 }
        ];
        if (game.place === 2) options.unshift({
          id: "sobor", title: "Созвать Земский собор", text: "Перейти к общему решению о будущем страны.",
          effect: { supplies: -2, unity: 1 }, placeTo: 3, note: "−2 запаса · +1 согласие · завершить маршрут",
          can: game.tracks.supplies >= 2 && game.tracks.support >= 4 && game.tracks.unity >= 4
        });
        return options;
      }
      default: return [];
    }
  }
  function chooseEvent(game, index, playerName) {
    if (game.phase !== "event") throw new Error("Сейчас нельзя выбирать событие.");
    const choice = eventFor(game)?.choices[index];
    if (!choice) throw new Error("Такого решения нет.");
    const changed = applyEffects(game, choice.effect);
    game.eventChoice = { title: choice.title, by: playerName, round: game.round };
    game.log.push({ round: game.round, title: eventFor(game).title + " · " + playerName, text: choice.result + " (" + effectText(changed) + ")." });
    const reason = collapseReason(game);
    if (reason) conclude(game, false, reason);
    else game.phase = "actions";
  }
  function performAction(game, roleKey, actionId, playerName) {
    if (game.phase !== "actions") throw new Error("Сейчас не время выбирать действие.");
    const next = currentActor(game);
    if (!next || next.roleKey !== roleKey) throw new Error("Сейчас ход другой роли.");
    const role = ROLES.find(item => item.key === roleKey);
    const action = actionsFor(game, roleKey).find(item => item.id === actionId);
    if (!action || !action.can) throw new Error("Это действие сейчас недоступно.");
    const changed = applyEffects(game, action.effect);
    if (Number.isInteger(action.placeTo)) game.place = action.placeTo;
    game.actionsDone[roleKey] = true;
    const routeNote = Number.isInteger(action.placeTo) ? " — теперь " + ROUTE[game.place].name + "." : ".";
    const changes = effectText(changed) === "без изменений" ? "" : " (" + effectText(changed) + ").";
    game.log.push({ round: game.round, title: role.name + " · " + playerName, text: action.title + routeNote + changes });
    const reason = collapseReason(game);
    if (reason) { conclude(game, false, reason); return; }
    if (roleIndexFor(game) < 0) {
      game.phase = "intermission";
      game.readyIds = [];
      game.intermissionFact = BETWEEN_ROUND_FACTS[game.round - 1];
    }
  }
  function finishIntermission(game) {
    if (game.phase !== "intermission") throw new Error("Сейчас нельзя завершить раунд.");
    const baseCost = game.round <= 2 ? 1 : game.round <= 4 ? 2 : 3;
    const dangerSurcharge = game.tracks.threat >= 4 ? 1 : 0;
    const upkeepCost = baseCost + dangerSurcharge;
    const upkeep = applyEffects(game, { supplies: -upkeepCost });
    game.log.push({ round: game.round, title: "Итог раунда " + game.round, text: "По мере удаления от городов снабжать лагерь труднее" + (dangerSurcharge ? ", а из-за угрозы пришлось усилить охрану" : "") + ". Расходы на дорогу и лагерь: " + effectText(upkeep) + "." });
    const collapse = collapseReason(game);
    if (collapse) { conclude(game, false, collapse); return; }
    if (game.round >= 6) {
      const won = game.place === 3 && game.tracks.supplies >= 2 && game.tracks.support >= 4 && game.tracks.unity >= 4 && game.tracks.threat <= 4;
      const reason = won
        ? "Вы дошли до Земского собора и сохранили условия для общего решения."
        : "К концу шестого раунда не удалось одновременно пройти маршрут и удержать нужные шкалы.";
      conclude(game, won, reason);
      return;
    }
    game.round += 1;
    game.phase = "event";
    game.actionsDone = {};
    game.readyIds = [];
    game.eventChoice = null;
    game.intermissionFact = null;
  }
  return Object.freeze({ MAX, ROUTE, EVENTS, BETWEEN_ROUND_FACTS, ROLES, createGame, currentActor, actionsFor, chooseEvent, performAction, finishIntermission, roleIndexFor });
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZemskyRules;
if (typeof window !== "undefined") window.ZemskyRules = ZemskyRules;
