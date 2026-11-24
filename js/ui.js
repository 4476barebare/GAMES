/**
 * ui.js
 * 4人麻雀 SVG牌セット完全対応 UI描画・2タップ選択・黄色ハイライト・自河/他家河横の鳴き牌配置
 */

import { tileIdToLabel } from "./tiles.js";
import { getTileSvg, getTileSvgById } from "./tileSvg.js";
import { getLegalActions } from "./engine.js";
import { analyzeDiscardCandidates } from "./shanten.js";

const WIND_JP = { E: "東", S: "南", W: "西", N: "北" };

function createTileElement(tileId, options = {}) {
  const div = document.createElement("div");
  div.className = "tile";
  if (options.variant === "river") div.classList.add("river-tile");
  if (options.variant === "opp") div.classList.add("opp-tile");
  if (options.variant === "meld") div.classList.add("meld-tile");
  if (options.sideways) div.classList.add("tile-sideways");
  if (options.drawn) div.classList.add("drawn");
  if (options.clickable) div.classList.add("clickable");
  if (options.riichi) div.classList.add("riichi-tile");
  if (options.tsumogiri) div.classList.add("tsumogiri");
  if (options.yellowHighlight) div.classList.add("yellow-highlight");
  if (options.selected) div.classList.add("selected-tile");

  if (options.faceDown) {
    div.innerHTML = getTileSvg("back");
    return div;
  }

  div.innerHTML = getTileSvgById(tileId, options.redDora !== false);

  if (options.onClick) {
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      options.onClick(tileId);
    });
  }

  return div;
}

function renderPlayerMelds(seat, player, red) {
  const container = document.getElementById(`melds-${seat}`);
  if (!container) return;
  container.innerHTML = "";

  for (const m of player.melds) {
    const group = document.createElement("div");
    group.className = "meld-group";

    if (m.type === "ankan") {
      m.tiles.forEach((tid, idx) => {
        const isBack = idx === 0 || idx === 3;
        group.appendChild(
          createTileElement(tid, {
            variant: "meld",
            faceDown: isBack,
            redDora: red
          })
        );
      });
    } else {
      m.tiles.forEach((tid) => {
        const isCalled = m.calledTile !== null && tid === m.calledTile;
        group.appendChild(
          createTileElement(tid, {
            variant: "meld",
            sideways: isCalled,
            redDora: red
          })
        );
      });
    }
    container.appendChild(group);
  }
}

export function renderGame(state, uiOptions, handlers) {
  const red = state.config.redDora;
  const showAllHands =
    uiOptions.openHand || state.status === "round_end" || state.status === "match_end";

  document.getElementById("round-label").textContent = `${WIND_JP[state.round.wind]}${
    state.round.number
  }局 ${state.round.honba}本場`;
  document.getElementById("wall-count").textContent = `残${state.wall.remaining}`;
  document.getElementById("riichi-sticks").textContent = `供託${state.round.riichiSticks}`;

  const doraBox = document.getElementById("dora-indicators");
  doraBox.innerHTML = "";
  for (const dId of state.wall.doraIndicators) {
    doraBox.appendChild(createTileElement(dId, { variant: "opp", redDora: red }));
  }

  const activePlayer = state.players[state.turn.playerIndex];
  const banner = document.getElementById("turn-banner");
  if (state.status === "match_end") {
    banner.textContent = "半荘終了";
  } else if (state.status === "round_end") {
    banner.textContent = "終局";
  } else if (state.turn.phase === "claim_check") {
    banner.textContent = "鳴き・ロン判定";
  } else {
    banner.textContent = `${WIND_JP[activePlayer.wind]}家 (${activePlayer.name})`;
  }

  const self = state.players[0];
  const legalSelf =
    state.status === "playing" && self.control === "human" ? getLegalActions(state, 0) : [];
  const isHumanClaimCheck =
    state.status === "playing" &&
    self.control === "human" &&
    state.turn.phase === "claim_check" &&
    state.turn.pendingClaims.includes(0) &&
    legalSelf.length > 0;

  const isHumanDiscardTurn =
    state.status === "playing" &&
    self.control === "human" &&
    state.turn.phase === "discard" &&
    state.turn.playerIndex === 0;

  for (let seat = 0; seat < 4; seat++) {
    const p = state.players[seat];
    document.getElementById(`wind-${seat}`).textContent = WIND_JP[p.wind];
    document.getElementById(`name-${seat}`).textContent = p.name;
    document.getElementById(`pts-${seat}`).textContent = p.points.toLocaleString();
    document.getElementById(`riichi-${seat}`).classList.toggle("hidden", !p.isRiichi);

    const headerEl = document.getElementById(`seat-header-${seat}`);
    const isTurn = state.status === "playing" && state.turn.playerIndex === seat;
    headerEl.classList.toggle("active-turn", isTurn);

    const thinkEl = document.getElementById(`think-${seat}`);
    if (thinkEl) {
      thinkEl.classList.toggle("hidden", uiOptions.thinkingSeat !== seat);
    }

    // 河描画（最新打牌に黄色い枠・リーチ宣言牌は横倒し）
    const riverEl = document.getElementById(`river-${seat}`);
    riverEl.innerHTML = "";
    const lastDiscard = state.turn.lastDiscard;
    p.discards.forEach((d, idx) => {
      const isLatestDiscard =
        state.status === "playing" &&
        lastDiscard &&
        lastDiscard.playerIndex === seat &&
        idx === p.discards.length - 1 &&
        d.calledBy === null;

      riverEl.appendChild(
        createTileElement(d.tileId, {
          variant: "river",
          riichi: d.isRiichi,
          sideways: d.isRiichi,
          tsumogiri: d.isTsumogiri,
          yellowHighlight: isLatestDiscard,
          redDora: red
        })
      );
    });

    // 鳴き牌描画（自河・他家河の横に配置）
    renderPlayerMelds(seat, p, red);

    // 手牌描画
    const handEl = document.getElementById(`hand-${seat}`);
    handEl.innerHTML = "";

    if (seat === 0) {
      // 鳴き/ロン選択待機中は自分の手牌すべてを黄色枠で囲み、タップでスルー
      if (isHumanClaimCheck) {
        const passAct = legalSelf.find((a) => a.action === "pass");
        for (const tid of p.hand) {
          handEl.appendChild(
            createTileElement(tid, {
              variant: "self",
              clickable: true,
              yellowHighlight: true,
              redDora: red,
              onClick: passAct ? () => handlers.onHumanAction(passAct) : null
            })
          );
        }
      } else {
        const defaultHighlightId =
          isHumanDiscardTurn && uiOptions.selectedTileId === null ? p.drawnTile : uiOptions.selectedTileId;

        for (const tid of p.hand) {
          const clickable = isHumanDiscardTurn && !p.isRiichi;
          const isSelected = isHumanDiscardTurn && defaultHighlightId === tid;
          handEl.appendChild(
            createTileElement(tid, {
              variant: "self",
              clickable,
              yellowHighlight: isSelected,
              selected: isHumanDiscardTurn && uiOptions.selectedTileId === tid,
              redDora: red,
              onClick: clickable ? (id) => handlers.onHumanTileTap(id) : null
            })
          );
        }
        if (p.drawnTile !== null) {
          const isSelected = isHumanDiscardTurn && defaultHighlightId === p.drawnTile;
          handEl.appendChild(
            createTileElement(p.drawnTile, {
              variant: "self",
              drawn: true,
              clickable: isHumanDiscardTurn,
              yellowHighlight: isSelected,
              selected: isHumanDiscardTurn && uiOptions.selectedTileId === p.drawnTile,
              redDora: red,
              onClick: isHumanDiscardTurn ? (id) => handlers.onHumanTileTap(id) : null
            })
          );
        }
      }
    } else {
      for (const tid of p.hand) {
        handEl.appendChild(
          createTileElement(tid, {
            variant: "opp",
            faceDown: !showAllHands,
            redDora: red
          })
        );
      }
      if (p.drawnTile !== null) {
        handEl.appendChild(
          createTileElement(p.drawnTile, {
            variant: "opp",
            drawn: seat === 2,
            faceDown: !showAllHands,
            redDora: red
          })
        );
      }
    }
  }

  // シャンテン表示
  const visible = [];
  state.players.forEach((pl) => {
    pl.discards.forEach((d) => visible.push(d.tileId));
    pl.melds.forEach((m) => m.tiles.forEach((t) => visible.push(t)));
  });
  state.wall.doraIndicators.forEach((d) => visible.push(d));
  const cands = analyzeDiscardCandidates(self.hand, self.drawnTile, visible, red, self.melds.length);
  const bestS = cands.length > 0 ? cands[0].shantenAfter : "-";
  const shantenEl = document.getElementById("shanten-info");
  if (isHumanClaimCheck) {
    shantenEl.textContent = "鳴き・ロン選択中（手牌タップでスルー）";
  } else if (bestS === 0) {
    shantenEl.textContent = `テンパイ！待:${cands[0].waits.map((w) => w.label).join(",")}`;
  } else {
    shantenEl.textContent = `${bestS}シャンテン`;
  }

  // アクションボタン描画（スルーボタンは出さず、全選択肢を表示）
  const btnBox = document.getElementById("action-buttons");
  btnBox.innerHTML = "";
  if (state.status === "playing" && self.control === "human") {
    const tsumoAct = legalSelf.find((a) => a.action === "tsumo");
    if (tsumoAct) {
      const b = document.createElement("button");
      b.className = "btn btn-danger";
      b.textContent = `ツモ (${tsumoAct.winInfo.points}点)`;
      b.onclick = () => handlers.onHumanAction(tsumoAct);
      btnBox.appendChild(b);
    }

    const ronAct = legalSelf.find((a) => a.action === "ron");
    if (ronAct) {
      const b = document.createElement("button");
      b.className = "btn btn-danger";
      b.textContent = `ロン (${ronAct.winInfo.points}点)`;
      b.onclick = () => handlers.onHumanAction(ronAct);
      btnBox.appendChild(b);
    }

    const ponAct = legalSelf.find((a) => a.action === "pon");
    if (ponAct) {
      const b = document.createElement("button");
      b.className = "btn btn-call";
      b.textContent = `ポン (${ponAct.tile})`;
      b.onclick = () => handlers.onHumanAction(ponAct);
      btnBox.appendChild(b);
    }

    const minkanAct = legalSelf.find((a) => a.action === "minkan");
    if (minkanAct) {
      const b = document.createElement("button");
      b.className = "btn btn-call";
      b.textContent = `カン (${minkanAct.tile})`;
      b.onclick = () => handlers.onHumanAction(minkanAct);
      btnBox.appendChild(b);
    }

    const chiActs = legalSelf.filter((a) => a.action === "chi");
    for (const cAct of chiActs) {
      const b = document.createElement("button");
      b.className = "btn btn-call";
      b.textContent = `チー (${cAct.chiLabel})`;
      b.onclick = () => handlers.onHumanAction(cAct);
      btnBox.appendChild(b);
    }

    const ankanActs = legalSelf.filter((a) => a.action === "ankan");
    for (const aAct of ankanActs) {
      const b = document.createElement("button");
      b.className = "btn btn-call";
      b.textContent = `暗槓 (${aAct.tile})`;
      b.onclick = () => handlers.onHumanAction(aAct);
      btnBox.appendChild(b);
    }

    const kakanActs = legalSelf.filter((a) => a.action === "kakan");
    for (const kAct of kakanActs) {
      const b = document.createElement("button");
      b.className = "btn btn-call";
      b.textContent = `加槓 (${kAct.tile})`;
      b.onclick = () => handlers.onHumanAction(kAct);
      btnBox.appendChild(b);
    }

    const riichiActs = legalSelf.filter((a) => a.action === "riichi");
    for (const rAct of riichiActs) {
      const b = document.createElement("button");
      b.className = "btn btn-warn";
      b.textContent = `リーチ(${rAct.tile})`;
      b.onclick = () => handlers.onHumanAction(rAct);
      btnBox.appendChild(b);
    }
  }

  renderThoughtCards(state);
}

function renderThoughtCards(state) {
  const container = document.getElementById("thought-cards");
  container.innerHTML = "";
  for (const p of state.players) {
    if (p.control !== "ai") continue;
    const card = document.createElement("div");
    card.className = "thought-card";
    card.innerHTML = `
      <div class="thought-card-head">
        <span>[${WIND_JP[p.wind]}] ${escapeHtml(p.name)}</span>
        <span>${p.points.toLocaleString()}点</span>
      </div>
      <div class="thought-card-talk">${p.lastTalk ? `「${escapeHtml(p.lastTalk)}」` : "（待機中）"}</div>
      <div class="thought-card-body">${p.lastThought ? escapeHtml(p.lastThought) : "まだ打牌していません。"}</div>
    `;
    container.appendChild(card);
  }
}

export function updateTicker(speaker, text) {
  document.getElementById("ticker-speaker").textContent = speaker;
  document.getElementById("ticker-text").textContent = text;
}

export function renderLogs(logs) {
  const list = document.getElementById("game-log");
  list.innerHTML = "";
  for (const text of logs) {
    const item = document.createElement("div");
    item.className = "log-item";
    item.textContent = text;
    list.appendChild(item);
  }
}

export function showRoundResultModal(state) {
  const res = state.lastResult;
  if (!res) return;

  const title = document.getElementById("result-title");
  const body = document.getElementById("result-body");
  const red = state.config.redDora;
  const roundStr = `${WIND_JP[state.round.wind]}${state.round.number}局 ${state.round.honba}本場`;

  if (res.type === "tsumo" || res.type === "ron") {
    const winKindLabel =
      res.type === "tsumo" ? "ツモ和了" : res.winners.length > 1 ? "ダブロン/トリロン" : "ロン和了";
    title.textContent = `${roundStr} - ${winKindLabel}`;

    const winnersHtml = res.winners
      .map((w) => {
        const yakuStr = w.winInfo.yakus.map((y) => `${y.name}(${y.han}翻)`).join(" / ");
        const payDetail = w.winInfo.tsumoPay ? ` (${w.winInfo.tsumoPay.text})` : "";
        return `
          <div style="margin-bottom:8px;">
            <p style="margin:2px 0;"><strong>和了者:</strong> ${escapeHtml(w.name)} / アガリ牌: <strong>${tileIdToLabel(
          w.winTileId,
          red
        )}</strong></p>
            <p style="margin:2px 0;"><strong>役:</strong> ${escapeHtml(yakuStr)}</p>
            <p style="margin:2px 0;"><strong>得点:</strong> ${w.winInfo.label} <strong>${w.winInfo.points.toLocaleString()}点</strong>${payDetail}</p>
          </div>
        `;
      })
      .join("<hr/>");

    const scoresHtml = state.players
      .map(
        (p, i) =>
          `${WIND_JP[p.wind]} ${escapeHtml(p.name)}: <strong>${p.points.toLocaleString()}点</strong> (${
            res.scoreDeltas[i] >= 0 ? "+" : ""
          }${res.scoreDeltas[i].toLocaleString()})`
      )
      .join("<br/>");

    body.innerHTML = `${winnersHtml}<hr/><p style="margin:6px 0 0;">${scoresHtml}</p>`;
  } else {
    title.textContent = `${roundStr} - 流局（荒牌平局）`;
    const tenpaiNames =
      res.tenpaiSeats.length > 0
        ? res.tenpaiSeats.map((idx) => state.players[idx].name).join("、")
        : "全員ノーテン";
    const scoresHtml = state.players
      .map(
        (p, i) =>
          `${WIND_JP[p.wind]} ${escapeHtml(p.name)}: <strong>${p.points.toLocaleString()}点</strong> (${
            res.scoreDeltas[i] >= 0 ? "+" : ""
          }${res.scoreDeltas[i].toLocaleString()})`
      )
      .join("<br/>");

    body.innerHTML = `
      <p style="margin:0 0 6px;"><strong>聴牌:</strong> ${escapeHtml(tenpaiNames)}</p>
      <hr/>
      <p style="margin:6px 0 0;">${scoresHtml}</p>
    `;
  }

  const nextBtn = document.getElementById("btn-next-round");
  const isBusted = state.players.some((p) => p.points < 0);
  nextBtn.textContent = isBusted ? "最終精算へ" : "次の局へ";

  const modal = document.getElementById("result-modal");
  if (!modal.open) modal.showModal();
}

export function showMatchEndModal(state) {
  const s = state.finalSettlement;
  if (!s) return;

  document.getElementById("match-end-title").textContent = "半荘終了・最終精算（ウマ10-30 / オカ+20）";
  const rows = s.standings
    .map((st) => {
      const cls = st.finalScore >= 0 ? "score-pos" : "score-neg";
      const sign = st.finalScore >= 0 ? "+" : "";
      const umaSign = st.uma >= 0 ? "+" : "";
      return `
        <tr>
          <td><strong>${st.rank}位</strong></td>
          <td>${escapeHtml(st.name)}</td>
          <td>${st.points.toLocaleString()}点</td>
          <td>${st.rawDiffPt >= 0 ? "+" : ""}${st.rawDiffPt.toFixed(1)}</td>
          <td>${umaSign}${st.uma}${st.oka > 0 ? ` (+${st.oka})` : ""}</td>
          <td class="${cls}">${sign}${st.finalScore.toFixed(1)}</td>
        </tr>
      `;
    })
    .join("");

  const extra =
    s.leftoverRiichiAwarded > 0
      ? `<p style="margin:4px 0;">※残供託 ${s.leftoverRiichiAwarded.toLocaleString()}点 は1位に加算済み</p>`
      : "";

  document.getElementById("match-end-body").innerHTML = `
    <p style="margin:0 0 6px;">${escapeHtml(s.reason)}（全${s.roundsPlayed}局）</p>
    ${extra}
    <table class="settlement-table">
      <thead>
        <tr>
          <th>順位</th>
          <th>プレイヤー</th>
          <th>最終点</th>
          <th>素点</th>
          <th>ウマ(オカ)</th>
          <th>最終Pt</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  const modal = document.getElementById("match-end-modal");
  if (!modal.open) modal.showModal();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
