/**
 * ui.js
 * 4人麻雀 UI描画（差分描画ガード・1タップ即時ハイライト・喰い替え禁止牌グレーアウト・SVG牌描画）
 */

import { tileIdToKind, tileIdToLabel } from "./tiles.js";
import { getTileSvg } from "./tileSvg.js";
import { getLegalActions } from "./engine.js";
import { analyzeDiscardCandidates } from "./shanten.js";

const WIND_JP = { E: "東", S: "南", W: "西", N: "北" };
let lastAutoScrollDrawKey = null;
let lastShantenCacheKey = null;
let lastActionButtonsKey = null;
let activeHandlers = null;

function createMiniTileIcon(code) {
  const span = document.createElement("span");
  span.className = "btn-tile-icon";
  span.setAttribute("aria-label", String(code));
  span.innerHTML = getTileSvg(code);
  return span;
}

function createActionTileButton(className, labelText, tileCodes, suffixText = "") {
  const b = document.createElement("button");
  b.className = `${className} btn-with-tiles`;

  const lbl = document.createElement("span");
  lbl.textContent = labelText;
  b.appendChild(lbl);

  if (Array.isArray(tileCodes) && tileCodes.length > 0) {
    const group = document.createElement("span");
    group.className = "btn-tile-group";
    for (const code of tileCodes) {
      group.appendChild(createMiniTileIcon(code));
    }
    b.appendChild(group);
  }

  if (suffixText) {
    const suf = document.createElement("span");
    suf.textContent = suffixText;
    b.appendChild(suf);
  }

  return b;
}

function createTileElement(tileId, options = {}) {
  const div = document.createElement("div");
  div.className = "tile";
  div.dataset.tileId = String(tileId);
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
  if (options.kuikaeBlocked) div.classList.add("kuikae-blocked");

  if (options.faceDown) {
    div.classList.add("back");
    div.innerHTML = getTileSvg("back");
    return div;
  }

  const code = tileIdToLabel(tileId, options.redDora !== false, false);
  div.innerHTML = getTileSvg(code);
  div.setAttribute("aria-label", tileIdToLabel(tileId, options.redDora !== false, true));

  if (options.clickMode === "pass") {
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeHandlers?.onHumanPass) activeHandlers.onHumanPass();
    });
  } else if (options.clickMode === "tap") {
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeHandlers?.onHumanTileTap) activeHandlers.onHumanTileTap(tileId);
    });
  }

  return div;
}

export function updateSelectedTileHighlight(selectedTileId) {
  const handEl = document.getElementById("hand-0");
  if (!handEl) return;
  const tiles = handEl.querySelectorAll(".tile");
  for (const el of tiles) {
    const tid = Number(el.dataset.tileId);
    el.classList.toggle("selected-tile", selectedTileId !== null && tid === selectedTileId);
  }
}

function renderMelds(containerEl, melds, redDora) {
  const key = `${redDora ? 1 : 0}|` + melds
    .map((m) => `${m.type}:${m.calledTile}:${m.tiles.join(",")}`)
    .join(";");
  if (containerEl.dataset.renderKey === key) return;
  containerEl.dataset.renderKey = key;

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
  activeHandlers = handlers;
  const red = state.config.redDora;
  const showAllHands = state.status === "round_end" || state.status === "match_end";

  // 中央HUD
  document.getElementById("round-label").textContent = `${WIND_JP[state.round.wind]}${
    state.round.number
  }局 ${state.round.honba}本場`;
  document.getElementById("wall-count").textContent = `残${state.wall.remaining}`;
  document.getElementById("riichi-sticks").textContent = `供託${state.round.riichiSticks}`;

  const doraBox = document.getElementById("dora-indicators");
  const doraKey = `${red ? 1 : 0}|${state.wall.doraIndicators.join(",")}`;
  if (doraBox.dataset.renderKey !== doraKey) {
    doraBox.dataset.renderKey = doraKey;
    doraBox.innerHTML = "";
    for (const dId of state.wall.doraIndicators) {
      doraBox.appendChild(createTileElement(dId, { variant: "opp", redDora: red }));
    }
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

  // 全4席の情報・河・副露・手牌を描画（変更のないDOMは再構築スキップ）
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

    // 河（差分描画ガード）
    const riverEl = document.getElementById(`river-${seat}`);
    const visibleDiscards = p.discards.filter((d) => d.calledBy === null);
    const riverKey =
      `${red ? 1 : 0}|${seat !== 0 ? latestOppDiscardTileId : ""}|` +
      visibleDiscards
        .map((d) => `${d.tileId}:${d.isRiichi ? 1 : 0}:${d.isTsumogiri ? 1 : 0}`)
        .join(",");
    if (riverEl.dataset.renderKey !== riverKey) {
      riverEl.dataset.renderKey = riverKey;
      riverEl.innerHTML = "";
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
    }

    // 4家それぞれの副露（差分描画ガード内蔵）
    const meldsEl = document.getElementById(`melds-${seat}`);
    if (meldsEl) {
      renderMelds(meldsEl, p.melds, red);
    }

    // 手牌（Seat 0＝自分、Seat 2＝対面）
    const handEl = document.getElementById(`hand-${seat}`);
    if (!handEl) continue;

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

      const forbiddenKinds =
        isHumanDiscardTurn && Array.isArray(state.turn.forbiddenDiscardKinds)
          ? state.turn.forbiddenDiscardKinds
          : [];
      const hasAnyNonForbidden =
        forbiddenKinds.length === 0 ||
        [...p.hand, ...(p.drawnTile !== null ? [p.drawnTile] : [])].some(
          (tid) => !forbiddenKinds.includes(tileIdToKind(tid))
        );
      const effectiveForbidden = hasAnyNonForbidden ? forbiddenKinds : [];

      const scrollWrap = document.getElementById("hand-scroll-wrap");
      scrollWrap.classList.toggle("through-target", isHumanClaimTurn);
      scrollWrap.onclick = isHumanClaimTurn
        ? () => activeHandlers?.onHumanPass && activeHandlers.onHumanPass()
        : null;

      const selfHandKey = [
        red ? 1 : 0,
        isHumanDiscardTurn ? 1 : 0,
        isHumanClaimTurn ? 1 : 0,
        p.isRiichi ? 1 : 0,
        effectiveForbidden.join(","),
        p.hand.join(","),
        p.drawnTile ?? "none"
      ].join("|");

      if (handEl.dataset.renderKey !== selfHandKey) {
        handEl.dataset.renderKey = selfHandKey;
        handEl.innerHTML = "";

        for (const tid of p.hand) {
          const isKuikaeBlocked =
            isHumanDiscardTurn && effectiveForbidden.includes(tileIdToKind(tid));
          const canTapDiscard = isHumanDiscardTurn && !p.isRiichi && !isKuikaeBlocked;
          const clickable = canTapDiscard || isHumanClaimTurn;
          const isSelected = canTapDiscard && uiOptions.selectedTileId === tid;
          handEl.appendChild(
            createTileElement(tid, {
              variant: "self",
              clickable,
              kuikaeBlocked: isKuikaeBlocked,
              selected: isSelected,
              redDora: red,
              clickMode: isHumanClaimTurn ? "pass" : canTapDiscard ? "tap" : null
            })
          );
        }

        if (p.drawnTile !== null) {
          const isKuikaeBlocked =
            isHumanDiscardTurn && effectiveForbidden.includes(tileIdToKind(p.drawnTile));
          const canTapDiscard = isHumanDiscardTurn && !isKuikaeBlocked;
          const isSelected = canTapDiscard && uiOptions.selectedTileId === p.drawnTile;
          handEl.appendChild(
            createTileElement(p.drawnTile, {
              variant: "self",
              drawn: true,
              clickable: canTapDiscard || isHumanClaimTurn,
              kuikaeBlocked: isKuikaeBlocked,
              highlightYellow: true,
              selected: isSelected,
              redDora: red,
              clickMode: isHumanClaimTurn ? "pass" : canTapDiscard ? "tap" : null
            })
          );
        }
      } else {
        updateSelectedTileHighlight(isHumanDiscardTurn ? uiOptions.selectedTileId : null);
      }

      // ツモってきた際は毎回手牌スクロールを右端（ツモ牌側）へリセット
      if (p.drawnTile !== null) {
        if (state.status === "playing" && state.turn.phase === "discard" && state.turn.playerIndex === 0) {
          const drawKey = `${state.round.roundsPlayed}-${state.round.wind}${state.round.number}-${state.round.honba}-${state.turn.turnCount}-${p.drawnTile}-${p.melds.length}-${state.wall.remaining}`;
          if (drawKey !== lastAutoScrollDrawKey) {
            lastAutoScrollDrawKey = drawKey;
            scrollWrap.scrollLeft = scrollWrap.scrollWidth;
            requestAnimationFrame(() => {
              scrollWrap.scrollLeft = scrollWrap.scrollWidth;
            });
          }
        }
      } else {
        lastAutoScrollDrawKey = null;
      }
    } else if (seat === 2) {
      const oppHandKey = `${red ? 1 : 0}|${showAllHands ? 1 : 0}|${p.hand.join(",")}|${p.drawnTile ?? "none"}`;
      if (handEl.dataset.renderKey !== oppHandKey) {
        handEl.dataset.renderKey = oppHandKey;
        handEl.innerHTML = "";
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
    const shantenKey = `${state.version}|${state.round.roundsPlayed}|${self.hand.join(",")}|${self.drawnTile ?? "none"}`;
    if (shantenKey !== lastShantenCacheKey) {
      lastShantenCacheKey = shantenKey;
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
  }

  const actionsKey = `${state.version}|${state.status}|${self.control}|${state.turn.phase}|${state.turn.playerIndex}|${isHumanClaimTurn ? 1 : 0}`;
  if (actionsKey !== lastActionButtonsKey) {
    lastActionButtonsKey = actionsKey;
    btnBox.innerHTML = "";
    if (state.status === "playing" && self.control === "human") {
      const legal = getLegalActions(state, 0);

      // 1. ツモ・ロン
      for (const act of legal.filter((a) => a.action === "tsumo" || a.action === "ron")) {
        const b = createActionTileButton(
          "btn btn-danger",
          act.action === "tsumo" ? "ツモ" : "ロン",
          act.tile ? [act.tile] : [],
          `(${act.winInfo.points})`
        );
        b.onclick = () => activeHandlers?.onHumanAction && activeHandlers.onHumanAction(act);
        btnBox.appendChild(b);
      }

      // 2. リーチ
      const riichiActs = legal.filter((a) => a.action === "riichi");
      for (const rAct of riichiActs) {
        const b = createActionTileButton("btn btn-warn", "立直", [rAct.tile]);
        b.onclick = () => activeHandlers?.onHumanAction && activeHandlers.onHumanAction(rAct);
        btnBox.appendChild(b);
      }

      // 3. ポン・大明槓・暗槓・加槓
      for (const cAct of legal.filter((a) => ["pon", "daiminkan", "ankan", "kakan"].includes(a.action))) {
        const labelMap = { pon: "ポン", daiminkan: "カン", ankan: "暗槓", kakan: "加槓" };
        const b = createActionTileButton("btn btn-call", labelMap[cAct.action], [cAct.tile]);
        b.onclick = () => activeHandlers?.onHumanAction && activeHandlers.onHumanAction(cAct);
        btnBox.appendChild(b);
      }

      // 4. チー（通常5・赤5の選択も含め消費牌をSVGで表示）
      for (const chiAct of legal.filter((a) => a.action === "chi")) {
        const b = createActionTileButton("btn btn-call", "チー", chiAct.consume);
        b.onclick = () => activeHandlers?.onHumanAction && activeHandlers.onHumanAction(chiAct);
        btnBox.appendChild(b);
      }
    }
  }

  renderThoughtCards(state);
}

function renderThoughtCards(state) {
  const container = document.getElementById("thought-cards");
  const key = state.players
    .filter((p) => p.control === "ai")
    .map((p) => `${p.seatIndex}|${p.wind}|${p.name}|${p.points}|${p.lastTalk}|${p.lastThought}`)
    .join("||");
  if (container.dataset.renderKey === key) return;
  container.dataset.renderKey = key;

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
