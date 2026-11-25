/**
 * markdown.js
 * 4人麻雀（半荘・鳴きあり・喰い替え禁止対応）の局面レポートMarkdown生成
 */

import { tileIdToLabel, indicatorToDoraKind, kindToLabel } from "./tiles.js";
import { analyzeDiscardCandidates } from "./shanten.js";
import { getLegalActions } from "./engine.js";

const WIND_JP = { E: "東", S: "南", W: "西", N: "北" };
const MELD_JP = {
  chi: "チー",
  pon: "ポン",
  daiminkan: "大明槓",
  ankan: "暗槓",
  kakan: "加槓"
};

export function buildTurnPromptMarkdown(state, seatIndex) {
  const me = state.players[seatIndex];
  const red = state.config.redDora;
  const roundStr = `${WIND_JP[state.round.wind]}${state.round.number}局 ${state.round.honba}本場`;
  const doraIndStr = state.wall.doraIndicators.map((id) => `\`${tileIdToLabel(id, red)}\``).join(", ");
  const actualDoraStr = state.wall.doraIndicators
    .map((id) => `\`${kindToLabel(indicatorToDoraKind(id))}\``)
    .join(", ");

  const ranked = [...state.players].sort((a, b) =>
    b.points !== a.points ? b.points - a.points : a.seatIndex - b.seatIndex
  );
  const myRank = ranked.findIndex((p) => p.seatIndex === seatIndex) + 1;
  const topDiff = me.points - ranked[0].points;
  const isMenzen = me.melds.every((m) => m.type === "ankan");

  const lines = [];
  lines.push(
    `# 4人半荘 局面レポート（${roundStr} / 供託: ${state.round.riichiSticks}本 / 残り山: ${state.wall.remaining}枚 / ${state.turn.turnCount}巡目）`
  );
  lines.push("");
  lines.push("## 1. 卓の基本情報");
  lines.push(
    `- **あなた:** ${WIND_JP[me.wind]}家（現在${myRank}位 / 持ち点: ${me.points.toLocaleString()}点 / トップ差: ${
      topDiff >= 0 ? "トップ" : topDiff.toLocaleString()
    }点 / 状態: ${me.isRiichi ? "リーチ中" : isMenzen ? "門前" : "副露あり"}）`
  );
  lines.push(`- **ドラ表示牌:** ${doraIndStr}（現ドラ: ${actualDoraStr}）`);
  lines.push(
    `- **現在のフェーズ:** ${
      state.turn.phase === "claim_check"
        ? "他家の打牌に対するロン・鳴き（ポン/チー/カン）判定"
        : "あなたの打牌・ツモ和了・暗槓/加槓選択"
    }`
  );
  lines.push("");

  lines.push("## 2. 4家の状況（河・鳴き・持ち点）");
  lines.push("| 席 | 名前 | 持ち点 | 状態 | 副露（鳴き） | 捨て牌（古い順 / `*`ツモ切り / `[R]`リーチ） |");
  lines.push("| :--- | :--- | ---: | :---: | :--- | :--- |");

  for (const pl of state.players) {
    const isMe = pl.seatIndex === seatIndex;
    const seatLabel = isMe ? `**${WIND_JP[pl.wind]} (YOU)**` : WIND_JP[pl.wind];
    const nameLabel = isMe ? `**${pl.name}**` : pl.name;
    const ptsLabel = isMe ? `**${pl.points.toLocaleString()}**` : pl.points.toLocaleString();
    const statusLabel = pl.isRiichi ? "リーチ" : pl.melds.length > 0 ? "副露" : "門前";
    const meldsStr =
      pl.melds.length === 0
        ? "なし"
        : pl.melds
            .map((m) => `${MELD_JP[m.type]}[${m.tiles.map((t) => tileIdToLabel(t, red)).join("")}]`)
            .join(", ");

    const riverStr =
      pl.discards.length === 0
        ? "なし"
        : pl.discards
            .filter((d) => d.calledBy === null)
            .map((d) => {
              let t = tileIdToLabel(d.tileId, red);
              if (d.isTsumogiri) t += "*";
              if (d.isRiichi) t += "[R]";
              return `\`${t}\``;
            })
            .join(", ") || "なし";
    lines.push(`| ${seatLabel} | ${nameLabel} | ${ptsLabel} | ${statusLabel} | ${meldsStr} | ${riverStr} |`);
  }
  lines.push("");

  lines.push("## 3. あなたの手牌");
  const handStr = me.hand.map((id) => tileIdToLabel(id, red)).join(" ");
  lines.push(`- **手牌（${me.hand.length}枚）:** \`${handStr}\``);
  if (me.drawnTile !== null) {
    lines.push(`- **今ツモった牌:** \`${tileIdToLabel(me.drawnTile, red)}\``);
  }
  if (state.turn.phase === "claim_check" && state.turn.lastDiscard) {
    const discarder = state.players[state.turn.lastDiscard.playerIndex];
    lines.push(
      `- **直前の捨て牌（${WIND_JP[discarder.wind]}家・${discarder.name}）:** \`${tileIdToLabel(
        state.turn.lastDiscard.tileId,
        red
      )}\``
    );
  }
  const forbiddenKinds =
    state.turn.phase === "discard" &&
    state.turn.playerIndex === seatIndex &&
    Array.isArray(state.turn.forbiddenDiscardKinds)
      ? state.turn.forbiddenDiscardKinds
      : [];
  if (forbiddenKinds.length > 0) {
    lines.push(
      `- **喰い替え禁止牌（この巡は切れません）:** ${forbiddenKinds
        .map((k) => `\`${kindToLabel(k)}\``)
        .join(", ")}`
    );
  }
  const furiten = me.isFuriten || me.isTempFuriten || me.isRiichiFuriten;
  lines.push(`- **フリテン状態:** ${furiten ? "フリテン中（ロン不可）" : "なし"}`);
  lines.push("");

  const legalActions = getLegalActions(state, seatIndex);
  if (state.turn.phase === "discard" && !me.isRiichi) {
    const visible = [];
    state.players.forEach((pl) => {
      pl.discards.forEach((d) => visible.push(d.tileId));
      pl.melds.forEach((m) => m.tiles.forEach((t) => visible.push(t)));
    });
    state.wall.doraIndicators.forEach((d) => visible.push(d));

    const legalDiscardLabels = new Set(
      legalActions.filter((a) => a.action === "discard").map((a) => a.tile)
    );
    const candidates = analyzeDiscardCandidates(
      me.hand,
      me.drawnTile,
      visible,
      red,
      me.melds.length
    ).filter((c) => legalDiscardLabels.has(c.label));
    const bestShanten = candidates.length > 0 ? candidates[0].shantenAfter : "-";

    lines.push("## 4. システム解析カンペ（自作エンジン算出・厳密値）");
    lines.push(
      `- **打牌後の最小シャンテン数:** ${bestShanten}${bestShanten === 0 ? "（テンパイ）" : ""}`
    );
    lines.push("- **打牌候補ごとの受け入れ解析（上位6件）:**");
    for (const c of candidates.slice(0, 6)) {
      const waitNames =
        c.waits.length > 0
          ? c.waits.map((w) => `${w.label}(残${w.remaining})`).join(", ")
          : "なし";
      const canRiichi = legalActions.some((a) => a.action === "riichi" && a.tile === c.label);
      lines.push(
        `  - 打 \`${c.label}\` → ${c.shantenAfter}シャンテン / 有効牌: ${waitNames}（計${
          c.acceptanceCount
        }枚）${canRiichi ? " / **リーチ可**" : ""}`
      );
    }
    lines.push("");
  }

  lines.push("## 5. 実行可能な合法アクション一覧（この中から必ず1つ選択）");
  for (const act of legalActions) {
    if (act.action === "tsumo") {
      lines.push(
        `- \`{"action": "tsumo", "tile": "${act.tile}", "consume": []}\` （ツモ和了！ ${act.winInfo.label} ${act.winInfo.points}点）`
      );
    } else if (act.action === "ron") {
      lines.push(
        `- \`{"action": "ron", "tile": "${act.tile}", "consume": []}\` （ロン和了！ ${act.winInfo.label} ${act.winInfo.points}点）`
      );
    } else if (act.action === "riichi") {
      lines.push(
        `- \`{"action": "riichi", "tile": "${act.tile}", "consume": []}\` （${act.tile}を切ってリーチ宣言）`
      );
    } else if (act.action === "discard") {
      lines.push(
        `- \`{"action": "discard", "tile": "${act.tile}", "consume": []}\` （${act.tile}を切る）`
      );
    } else if (act.action === "pon") {
      lines.push(`- \`{"action": "pon", "tile": "${act.tile}", "consume": []}\` （${act.tile}をポン）`);
    } else if (act.action === "daiminkan") {
      lines.push(
        `- \`{"action": "daiminkan", "tile": "${act.tile}", "consume": []}\` （${act.tile}を大明槓）`
      );
    } else if (act.action === "ankan") {
      lines.push(`- \`{"action": "ankan", "tile": "${act.tile}", "consume": []}\` （${act.tile}を暗槓）`);
    } else if (act.action === "kakan") {
      lines.push(`- \`{"action": "kakan", "tile": "${act.tile}", "consume": []}\` （${act.tile}を加槓）`);
    } else if (act.action === "chi") {
      lines.push(
        `- \`{"action": "chi", "tile": "${act.tile}", "consume": ${JSON.stringify(
          act.consume
        )}}\` （${act.consume.join("・")}で${act.tile}をチー）`
      );
    } else if (act.action === "pass") {
      lines.push(`- \`{"action": "pass", "tile": "", "consume": []}\` （見送り / スルー）`);
    }
  }

  return lines.join("\n");
}
