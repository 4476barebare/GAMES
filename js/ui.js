/**
 * ui.js
 * gameState から卓・手牌・河・アクションボタン・吹き出しを描画する
 */

import { getTileVisual, tileIdToLabel } from "./tiles.js";
import { getLegalActions } from "./engine.js";
import { analyzeDiscardCandidates } from "./shanten.js";

const WIND_JP = { E: "東", S: "南", W: "西", N: "北" };

function createTileElement(tileId, options = {}) {
  const div = document.createElement("div");
  div.className = "tile";
  if (options.small) div.classList.add("small");
  if (options.drawn) div.classList.add("drawn");
  if (options.clickable) div.classList.add("clickable");
  if (options.riichi) div.classList.add("riichi-tile");
  if (options.tsumogiri) div.classList.add("tsumogiri");

  if (options.faceDown) {
    div.classList.add("back");
    return div;
  }

  const vis = getTileVisual(tileId, options.redDora !== false);
  const top = document.createElement("span");
  top.className = vis.cls;
  top.textContent = vis.top;
  div.appendChild(top);

  if (vis.bottom) {
    const bot = document.createElement("span");
    bot.className = vis.cls;
    bot.style.fontSize = options.small ? "0.62rem" : "0.72rem";
    bot.textContent = vis.bottom;
    div.appendChild(bot);
  }

  if (options.onClick) {
    div.addEventListener("click", () => options.onClick(tileId));
  }

  return div;
}

export function renderGame(state, uiOptions, handlers) {
  const red = state.config.redDora;
  const self = state.players[0];
  const opp = state.players[1];

  // 局・山・ドラ情報
  document.getElementById("round-label").textContent = `${WIND_JP[state.round.wind]}${
    state.round.number
  }局 ${state.round.honba}本場`;
  document.getElementById("wall-count").textContent = `残り山: ${state.wall.remaining}枚`;
  document.getElementById("riichi-sticks").textContent = `供託: ${state.round.riichiSticks}本`;

  const doraBox = document.getElementById("dora-indicators");
  doraBox.innerHTML = "";
  for (const dId of state.wall.doraIndicators) {
    doraBox.appendChild(createTileElement(dId, { small: true, redDora: red }));
  }

  // ターンバナー
  const activePlayer = state.players[state.turn.playerIndex];
  const banner = document.getElementById("turn-banner");
  if (state.status === "round_end") {
    banner.textContent = "局終了";
  } else if (state.turn.phase === "claim_check") {
    banner.textContent = "ロン判定中！";
  } else {
    banner.textContent = `${activePlayer.name} の手番（${state.turn.turnCount}巡目）`;
  }

  // 相手（Seat 1）表示
  document.getElementById("opp-wind").textContent = WIND_JP[opp.wind];
  document.getElementById("opp-name").textContent = opp.name;
  document.getElementById("opp-points").textContent = opp.points.toLocaleString();
  document.getElementById("opp-riichi").classList.toggle("hidden", !opp.isRiichi);
  document.getElementById("opp-status").textContent = uiOptions.oppThinking
    ? "AI思考中..."
    : state.turn.playerIndex === 1
    ? "手番中"
    : "待機中";

  if (opp.lastTalk) document.getElementById("opp-talk").textContent = `「${opp.lastTalk}」`;
  if (opp.lastThought) document.getElementById("opp-thought").textContent = opp.lastThought;

  const oppHandEl = document.getElementById("opp-hand");
  oppHandEl.innerHTML = "";
  const showOppHand = uiOptions.openHand || state.status === "round_end";
  for (const tid of opp.hand) {
    oppHandEl.appendChild(
      createTileElement(tid, { small: true, faceDown: !showOppHand, redDora: red })
    );
  }
  if (opp.drawnTile !== null) {
    oppHandEl.appendChild(
      createTileElement(opp.drawnTile, {
        small: true,
        drawn: true,
        faceDown: !showOppHand,
        redDora: red
      })
    );
  }

  // 相手の河
  const oppRiverEl = document.getElementById("opp-river");
  oppRiverEl.innerHTML = "";
  for (const d of opp.discards) {
    oppRiverEl.appendChild(
      createTileElement(d.tileId, {
        small: true,
        riichi: d.isRiichi,
        tsumogiri: d.isTsumogiri,
        redDora: red
      })
    );
  }

  // 自分の河
  const selfRiverEl = document.getElementById("self-river");
  selfRiverEl.innerHTML = "";
  for (const d of self.discards) {
    selfRiverEl.appendChild(
      createTileElement(d.tileId, {
        small: true,
        riichi: d.isRiichi,
        tsumogiri: d.isTsumogiri,
        redDora: red
      })
    );
  }

  // 自分（Seat 0）情報
  document.getElementById("self-wind").textContent = WIND_JP[self.wind];
  document.getElementById("self-name").textContent = self.name;
  document.getElementById("self-points").textContent = self.points.toLocaleString();
  document.getElementById("self-riichi").classList.toggle("hidden", !self.isRiichi);

  const selfBubble = document.getElementById("self-bubble");
  if (self.control === "ai" && (self.lastTalk || self.lastThought)) {
    selfBubble.classList.remove("hidden");
    document.getElementById("self-talk").textContent = self.lastTalk ? `「${self.lastTalk}」` : "";
    document.getElementById("self-thought").textContent = self.lastThought || "";
  } else {
    selfBubble.classList.add("hidden");
  }

  // 自分の手牌＆クリック打牌制御
  const isHumanTurn =
    state.status === "playing" &&
    self.control === "human" &&
    state.turn.phase === "discard" &&
    state.turn.playerIndex === 0;

  const selfHandEl = document.getElementById("self-hand");
  selfHandEl.innerHTML = "";
  for (const tid of self.hand) {
    const clickable = isHumanTurn && !self.isRiichi;
    selfHandEl.appendChild(
      createTileElement(tid, {
        clickable,
        redDora: red,
        onClick: clickable ? (id) => handlers.onHumanDiscard(id) : null
      })
    );
  }
  if (self.drawnTile !== null) {
    selfHandEl.appendChild(
      createTileElement(self.drawnTile, {
        drawn: true,
        clickable: isHumanTurn,
        redDora: red,
        onClick: isHumanTurn ? (id) => handlers.onHumanDiscard(id) : null
      })
    );
  }

  // シャンテン表示＆特殊アクションボタン（ツモ・ロン・リーチ・パス）
  const visible = [];
  state.players.forEach((pl) => pl.discards.forEach((d) => visible.push(d.tileId)));
  state.wall.doraIndicators.forEach((d) => visible.push(d));
  const cands = analyzeDiscardCandidates(self.hand, self.drawnTile, visible, red);
  const bestS = cands.length > 0 ? cands[0].shantenAfter : "-";
  document.getElementById("shanten-info").textContent =
    bestS === 0
      ? `テンパイ！（待ち: ${cands[0].waits.map((w) => w.label).join(", ")}）`
      : `現在: ${bestS}シャンテン`;

  const btnBox = document.getElementById("action-buttons");
  btnBox.innerHTML = "";
  if (state.status === "playing" && self.control === "human") {
    const legal = getLegalActions(state, 0);

    const tsumoAct = legal.find((a) => a.action === "tsumo");
    if (tsumoAct) {
      const b = document.createElement("button");
      b.className = "btn btn-danger";
      b.textContent = `ツモ和了 (${tsumoAct.winInfo.points}点)`;
      b.onclick = () => handlers.onHumanAction(tsumoAct);
      btnBox.appendChild(b);
    }

    const ronAct = legal.find((a) => a.action === "ron");
    if (ronAct) {
      const b = document.createElement("button");
      b.className = "btn btn-danger";
      b.textContent = `ロン和了 (${ronAct.winInfo.points}点)`;
      b.onclick = () => handlers.onHumanAction(ronAct);
      btnBox.appendChild(b);
    }

    const riichiActs = legal.filter((a) => a.action === "riichi");
    for (const rAct of riichiActs) {
      const b = document.createElement("button");
      b.className = "btn btn-warn";
      b.textContent = `リーチ (${rAct.tile}切り)`;
      b.onclick = () => handlers.onHumanAction(rAct);
      btnBox.appendChild(b);
    }

    const passAct = legal.find((a) => a.action === "pass");
    if (passAct) {
      const b = document.createElement("button");
      b.className = "btn btn-secondary";
      b.textContent = "見送り（パス）";
      b.onclick = () => handlers.onHumanAction(passAct);
      btnBox.appendChild(b);
    }
  }
}

export function appendLog(text) {
  const list = document.getElementById("game-log");
  const item = document.createElement("div");
  item.className = "log-item";
  item.textContent = text;
  list.prepend(item);
}

export function showRoundResultModal(state) {
  const res = state.lastResult;
  if (!res) return;

  const title = document.getElementById("result-title");
  const body = document.getElementById("result-body");
  const red = state.config.redDora;

  if (res.type === "tsumo" || res.type === "ron") {
    const w = res.winners[0];
    title.textContent = `${res.type === "tsumo" ? "ツモ和了" : "ロン和了"} - ${w.name}`;
    const yakuHtml = w.winInfo.yakus.map((y) => `${y.name} (${y.han}翻)`).join(" / ");
    body.innerHTML = `
      <p><strong>アガリ牌:</strong> ${tileIdToLabel(w.winTileId, red)}</p>
      <p><strong>成立役:</strong> ${yakuHtml}</p>
      <p><strong>得点:</strong> ${w.winInfo.label} <strong>${w.winInfo.points.toLocaleString()}点</strong></p>
      <hr/>
      <p>${state.players
        .map((p, i) => `${p.name}: ${p.points.toLocaleString()}点 (${res.scoreDeltas[i] >= 0 ? "+" : ""}${res.scoreDeltas[i]})`)
        .join("<br/>")}</p>
    `;
  } else {
    title.textContent = "流局（荒牌平局）";
    body.innerHTML = `
      <p>山牌がなくなりました。</p>
      <p>${state.players
        .map((p, i) => `${p.name}: ${p.points.toLocaleString()}点 (${res.scoreDeltas[i] >= 0 ? "+" : ""}${res.scoreDeltas[i]})`)
        .join("<br/>")}</p>
    `;
  }

  document.getElementById("result-modal").showModal();
}
