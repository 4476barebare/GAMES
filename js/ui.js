/**
 * ui.js
 * 4人麻雀 UI描画（4家すべての河横に副露を整列・ツモ牌/最新相手捨て牌の黄色枠・2段階タップ打牌・手牌黄色枠スルー）
 */

import { getTileVisual, tileIdToLabel } from "./tiles.js";
import { getLegalActions } from "./engine.js";
import { analyzeDiscardCandidates } from "./shanten.js";

const WIND_JP = { E: "東", S: "南", W: "西", N: "北" };

function createTileElement(tileId, options = {}) {
  const div = document.createElement("div");
  div.className = "tile";
  if (options.variant === "river") div.classList.add("river-tile");
  if (options.variant === "opp") div.classList.add("opp-tile");
  if (options.variant === "meld") div.classList.add("meld-tile");
  if (options.drawn) div.classList.add("drawn");
  if (options.clickable) div.classList.add("clickable");
  if (options.riichi) div.classList.add("riichi-tile");
  if (options.tsumogiri) div.classList.add("tsumogiri");
  if (options.calledHighlight) div.classList.add("called-highlight");
  if (options.highlightYellow) div.classList.add("highlight-yellow");
  if (options.selected) div.classList.add("selected-tile");

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
    bot.style.fontSize = options.variant === "self" ? "0.66rem" : "0.5rem";
    bot.textContent = vis.bottom;
    div.appendChild(bot);
  }

  if (options.onClick) {
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      options.onClick(tileId);
    });
  }

  return div;
}

function renderMelds(containerEl, melds, redDora) {
  containerEl.innerHTML = "";
  for (const m of melds) {
    const group = document.createElement("div");
    group.className = "meld-group";
    m.tiles.forEach((tid, idx) => {
      const faceDown = m.type === "ankan" && (idx === 0 || idx === 3);
      const calledHighlight = m.calledTile === tid;
      group.appendChild(
        createTileElement(tid, {
          variant: "meld",
          faceDown,
          calledHighlight,
          redDora
        })
      );
    });
    containerEl.appendChild(group);
  }
}

export function renderGame(state, uiOptions, handlers) {
  const red = state.config.redDora;
  const showAllHands =
    uiOptions.openHand || state.status === "round_end" || state.status === "match_end";

  // 中央HUD
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
    banner.textContent = "鳴き/ロン判定";
  } else {
    banner.textContent = `${WIND_JP[activePlayer.wind]}:${activePlayer.name}`;
  }

  // 直前の相手（Seat 1, 2, 3）の最新捨て牌IDを特定
  const lastDiscard = state.turn.lastDiscard;
  const latestOppDiscardTileId =
    lastDiscard && lastDiscard.playerIndex !== 0 ? lastDiscard.tileId : null;

  // 全4席の情報・河・副露・手牌を描画
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

    // 河
    const riverEl = document.getElementById(`river-${seat}`);
    riverEl.innerHTML = "";
    const visibleDiscards = p.discards.filter((d) => d.calledBy === null);
    visibleDiscards.forEach((d, idx) => {
      const isLatestOpp =
        seat !== 0 &&
        idx === visibleDiscards.length - 1 &&
        latestOppDiscardTileId !== null &&
        d.tileId === latestOppDiscardTileId;

      riverEl.appendChild(
        createTileElement(d.tileId, {
          variant: "river",
          riichi: d.isRiichi,
          tsumogiri: d.isTsumogiri,
          highlightYellow: isLatestOpp,
          redDora: red
        })
      );
    });

    // 4家それぞれの河の横に配置された副露（鳴き牌）コンテナを描画
    const meldsEl = document.getElementById(`melds-${seat}`);
    if (meldsEl) {
      renderMelds(meldsEl, p.melds, red);
    }

    // 手牌（Seat 0＝自分、Seat 2＝対面）
    const handEl = document.getElementById(`hand-${seat}`);
    if (!handEl) continue;
    handEl.innerHTML = "";

    if (seat === 0) {
      const isHumanDiscardTurn =
        state.status === "playing" &&
        p.control === "human" &&
        state.turn.phase === "discard" &&
        state.turn.playerIndex === 0;

      const isHumanClaimTurn =
        state.status === "playing" &&
        p.control === "human" &&
        state.turn.phase === "claim_check" &&
        state.turn.pendingClaims.includes(0);

      const scrollWrap = document.getElementById("hand-scroll-wrap");
      scrollWrap.classList.toggle("through-target", isHumanClaimTurn);
      scrollWrap.onclick = isHumanClaimTurn ? () => handlers.onHumanPass() : null;

      for (const tid of p.hand) {
        const clickable = (isHumanDiscardTurn && !p.isRiichi) || isHumanClaimTurn;
        const isSelected = isHumanDiscardTurn && uiOptions.selectedTileId === tid;
        handEl.appendChild(
          createTileElement(tid, {
            variant: "self",
            clickable,
            selected: isSelected,
            redDora: red,
            onClick: isHumanClaimTurn
              ? () => handlers.onHumanPass()
              : clickable
              ? (id) => handlers.onHumanTileTap(id)
              : null
          })
        );
      }

      if (p.drawnTile !== null) {
        const isSelected = isHumanDiscardTurn && uiOptions.selectedTileId === p.drawnTile;
        handEl.appendChild(
          createTileElement(p.drawnTile, {
            variant: "self",
            drawn: true,
            clickable: isHumanDiscardTurn || isHumanClaimTurn,
            highlightYellow: true,
            selected: isSelected,
            redDora: red,
            onClick: isHumanClaimTurn
              ? () => handlers.onHumanPass()
              : isHumanDiscardTurn
              ? (id) => handlers.onHumanTileTap(id)
              : null
          })
        );
      }
    } else if (seat === 2) {
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
            drawn: true,
            faceDown: !showAllHands,
            redDora: red
          })
        );
      }
    }
  }

  // 自分（Seat 0）のアクションバー＆全選択肢表示
  const self = state.players[0];
  const isHumanClaimTurn =
    state.status === "playing" &&
    self.control === "human" &&
    state.turn.phase === "claim_check" &&
    state.turn.pendingClaims.includes(0);

  const actionBarEl = document.getElementById("action-bar");
  const selfHeaderEl = document.getElementById("seat-header-0");
  const shantenEl = document.getElementById("shanten-info");
  const btnBox = document.getElementById("action-buttons");

  actionBarEl.classList.toggle("claim-mode", isHumanClaimTurn);
  selfHeaderEl.classList.toggle("hidden", isHumanClaimTurn);
  shantenEl.classList.toggle("hidden", isHumanClaimTurn);

  if (!isHumanClaimTurn) {
    const visible = [];
    state.players.forEach((pl) => {
      pl.discards.forEach((d) => visible.push(d.tileId));
      pl.melds.forEach((m) => m.tiles.forEach((t) => visible.push(t)));
    });
    state.wall.doraIndicators.forEach((d) => visible.push(d));

    const cands = analyzeDiscardCandidates(
      self.hand,
      self.drawnTile,
      visible,
      red,
      self.melds.length
    );
    const bestS = cands.length > 0 ? cands[0].shantenAfter : "-";
    if (bestS === 0) {
      shantenEl.textContent = `聴牌 待:${cands[0].waits.map((w) => w.label).join(",")}`;
    } else {
      shantenEl.textContent = `${bestS}向聴`;
    }
  }

  btnBox.innerHTML = "";
  if (state.status === "playing" && self.control === "human") {
    const legal = getLegalActions(state, 0);

    // 1. ツモ・ロン
    for (const act of legal.filter((a) => a.action === "tsumo" || a.action === "ron")) {
      const b = document.createElement("button");
      b.className = "btn btn-danger";
      b.textContent = `${act.action === "tsumo" ? "ツモ" : "ロン"}(${act.winInfo.points})`;
      b.onclick = () => handlers.onHumanAction(act);
      btnBox.appendChild(b);
    }

    // 2. リーチ
    const riichiActs = legal.filter((a) => a.action === "riichi");
    for (const rAct of riichiActs) {
      const b = document.createElement("button");
      b.className = "btn btn-warn";
      b.textContent = `立直(${rAct.tile})`;
      b.onclick = () => handlers.onHumanAction(rAct);
      btnBox.appendChild(b);
    }

    // 3. ポン・大明槓・暗槓・加槓
    for (const cAct of legal.filter((a) => ["pon", "daiminkan", "ankan", "kakan"].includes(a.action))) {
      const labelMap = { pon: "ポン", daiminkan: "カン", ankan: "暗槓", kakan: "加槓" };
      const b = document.createElement("button");
      b.className = "btn btn-call";
      b.textContent = `${labelMap[cAct.action]}(${cAct.tile})`;
      b.onclick = () => handlers.onHumanAction(cAct);
      btnBox.appendChild(b);
    }

    // 4. チー
    for (const chiAct of legal.filter((a) => a.action === "chi")) {
      const b = document.createElement("button");
      b.className = "btn btn-call";
      b.textContent = `チー[${chiAct.consume.join("")}]`;
      b.onclick = () => handlers.onHumanAction(chiAct);
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
            <p style="margin:2px 0;"><strong>和了者:</strong> ${escapeHtml(w.name)} / アガリ牌: <strong>${tileIdToLabel(w.winTileId, red)}</strong></p>
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
