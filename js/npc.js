/**
 * npc.js
 * 不思議の国のアリス系NPCキャラクター定義・アバター解決・キャラ別思考/セリフ生成
 * ・アリス（Alice.png）      : デジタル派 (digital_balanced)
 * ・白ウサギ（Rabbit.png）   : 超攻撃型   (aggressive_riichi)
 * ・チェシャ猫（Cheshire.png）: 鉄壁守備派 (iron_defense)
 * ・帽子屋（TheHatter.png）  : オカルト派 (occult_flow)
 */

import { tileIdToKind, indicatorToDoraKind, toCounts34 } from "./tiles.js";
import { calcShanten, analyzeDiscardCandidates } from "./shanten.js";

export const DEFAULT_NPC_PROFILES = [
  {
    id: "digital_balanced",
    name: "アリス（デジタル派）",
    characterName: "アリス",
    styleName: "デジタル派",
    avatar: "assets/npc/Alice.png",
    accentColor: "#3b82f6",
    emoji: "🎀",
    prompt:
      "あなたは『アリス』として4人麻雀を打ちます。素直で丁寧、好奇心旺盛な少女です（一人称『わたし』）。受け入れ枚数と期待値を冷静に計算して打ちます。"
  },
  {
    id: "aggressive_riichi",
    name: "白ウサギ（超攻撃型）",
    characterName: "白ウサギ",
    styleName: "超攻撃型",
    avatar: "assets/npc/Rabbit.png",
    accentColor: "#f43f5e",
    emoji: "⏱️",
    prompt:
      "あなたは懐中時計を持った『白ウサギ』として4人麻雀を打ちます。いつも時間に追われせっかちで元気です（一人称『ボク』）。聴牌即リーチと積極的な仕掛けで押し切ります。"
  },
  {
    id: "iron_defense",
    name: "チェシャ猫（鉄壁守備派）",
    characterName: "チェシャ猫",
    styleName: "鉄壁守備派",
    avatar: "assets/npc/Cheshire.png",
    accentColor: "#d946ef",
    emoji: "😼",
    prompt:
      "あなたは小悪魔的に微笑む『チェシャ猫』として4人麻雀を打ちます（一人称『アタシ』）。絶対に振り込まないことを第一とし、危険牌をかわして門前で手堅く打ちます。"
  },
  {
    id: "occult_flow",
    name: "帽子屋（オカルト派）",
    characterName: "帽子屋",
    styleName: "オカルト派",
    avatar: "assets/npc/TheHatter.png",
    accentColor: "#f59e0b",
    emoji: "🎩",
    prompt:
      "あなたはティーカップを手にした『帽子屋』として4人麻雀を打ちます（一人称『ボク』）。場の流れとドラを愛し、飄々とお茶会のように局を動かします。"
  }
];

let loadedProfiles = DEFAULT_NPC_PROFILES.map((p) => ({ ...p }));

export function setNpcProfiles(externalList) {
  if (!Array.isArray(externalList) || externalList.length === 0) return;
  loadedProfiles = externalList.map((raw) => {
    const base =
      DEFAULT_NPC_PROFILES.find((d) => d.id === raw.id) || DEFAULT_NPC_PROFILES[0];
    return {
      ...base,
      ...raw,
      characterName: raw.characterName || base.characterName,
      styleName: raw.styleName || base.styleName,
      avatar: raw.avatar || base.avatar,
      accentColor: raw.accentColor || base.accentColor,
      emoji: raw.emoji || base.emoji
    };
  });
}

export function getAllNpcProfiles() {
  return loadedProfiles;
}

export function getNpcProfile(personaId) {
  return (
    loadedProfiles.find((p) => p.id === personaId) ||
    DEFAULT_NPC_PROFILES.find((p) => p.id === personaId) ||
    DEFAULT_NPC_PROFILES[0]
  );
}

export function getNpcProfileForPlayer(player) {
  if (!player || player.control !== "ai") return null;
  return getNpcProfile(player.aiConfig?.personaId || "digital_balanced");
}

function pickLine(list, seed) {
  if (!Array.isArray(list) || list.length === 0) return "";
  const idx = Math.abs(Number(seed) || 0) % list.length;
  return list[idx];
}

function formatShantenJp(shanten) {
  if (shanten <= 0) return "聴牌";
  if (shanten === 1) return "一向聴";
  return `${shanten}向聴`;
}

function inspectContext(state, seatIndex, actionObj) {
  const p = state.players[seatIndex];
  const red = state.config.redDora;
  const oppRiichi = state.players.some((pl) => pl.seatIndex !== seatIndex && pl.isRiichi);
  const safeKinds = new Set();
  for (const opp of state.players) {
    if (opp.seatIndex !== seatIndex && opp.isRiichi) {
      opp.discards.forEach((d) => safeKinds.add(tileIdToKind(d.tileId)));
    }
  }

  let shantenAfter = null;
  let acceptance = 0;
  let isSafeCut = false;
  let holdsDora = false;

  const doraKinds = new Set(state.wall.doraIndicators.map(indicatorToDoraKind));
  const allTiles = [...p.hand, ...(p.drawnTile !== null ? [p.drawnTile] : [])];
  holdsDora = allTiles.some(
    (tid) => doraKinds.has(tileIdToKind(tid)) || (red && (tid === 16 || tid === 52 || tid === 88))
  );

  if (actionObj.action === "discard" || actionObj.action === "riichi") {
    const visible = [];
    state.players.forEach((pl) => {
      pl.discards.forEach((d) => visible.push(d.tileId));
      pl.melds.forEach((m) => m.tiles.forEach((t) => visible.push(t)));
    });
    state.wall.doraIndicators.forEach((d) => visible.push(d));

    const cands = analyzeDiscardCandidates(p.hand, p.drawnTile, visible, red, p.melds.length);
    const chosen = cands.find((c) => c.label === actionObj.tile) || cands[0];
    if (chosen) {
      shantenAfter = chosen.shantenAfter;
      acceptance = chosen.acceptanceCount;
      isSafeCut = oppRiichi && safeKinds.has(chosen.kindId);
    }
  } else {
    shantenAfter = calcShanten(toCounts34(p.hand), p.melds.length);
  }

  const seed =
    (state.round?.roundsPlayed || 1) * 31 +
    (state.turn?.turnCount || 1) * 17 +
    seatIndex * 13 +
    (actionObj.tile ? actionObj.tile.charCodeAt(0) : 7) +
    (state.wall?.remaining || 0);

  return {
    oppRiichi,
    isSafeCut,
    holdsDora,
    shantenAfter,
    shantenText: shantenAfter !== null ? formatShantenJp(shantenAfter) : "",
    acceptance,
    isRiichiSelf: p.isRiichi,
    tile: actionObj.tile || "",
    remaining: state.wall?.remaining ?? 70,
    seed
  };
}

/**
 * 内蔵AI用：キャラの性格・口調・局面に合わせたセリフ(talk)と思考ログ(thought)を生成
 */
export function buildNpcBuiltinResponse(state, seatIndex, actionObj, prefixNote = "") {
  const player = state.players[seatIndex];
  const profile = getNpcProfile(player.aiConfig?.personaId);
  const ctx = inspectContext(state, seatIndex, actionObj);
  const t = ctx.tile;
  const sh = ctx.shantenText || "手組み中";
  const accStr = ctx.acceptance > 0 ? `受け入れ${ctx.acceptance}枚` : "手堅く進行";
  const prefix = prefixNote ? `${prefixNote} ` : "";

  let talk = "";
  let thought = "";

  if (profile.id === "digital_balanced") {
    // アリス（デジタル派）
    switch (actionObj.action) {
      case "tsumo":
        talk = pickLine(
          ["わぁ、ツモです！やりました！", "計算どおりにツモれました！", "ツモです！素敵な手になりました！"],
          ctx.seed
        );
        thought = `期待値どおりに引き当てられました！このままツモ和了でしっかり点数をいただきます。`;
        break;
      case "ron":
        talk = pickLine(
          ["あ、それロンです！いただきます！", "待っていた牌です、ロン！", "ロンです！見逃しませんよ！"],
          ctx.seed
        );
        thought = `狙っていた待ち牌がこぼれましたね。ここは確実にロンして局を収めます。`;
        break;
      case "riichi":
        talk = pickLine(
          ["テンパイです！リーチしますね！", "いい形になりました！リーチ！", "期待値よし！ここでリーチです！"],
          ctx.seed
        );
        thought = `${t}切りで${accStr}の聴牌になりました。先制リーチの期待値が高いのでしっかり勝負に出ます！`;
        break;
      case "pon":
        talk = pickLine(
          ["あっ、それポンします！", "効率がいいのでポンしますね！", "役が進みます、ポン！"],
          ctx.seed
        );
        thought = `${t}をポンすると打点とスピードのバランスが良くなりますね。ここは柔軟に仕掛けます。`;
        break;
      case "chi":
        talk = pickLine(
          ["ここはチーで進めますね！", "好形になるのでチーします！"],
          ctx.seed
        );
        thought = `${t}をチーして一気に前進させます。無駄なく和了へ向かえる形です。`;
        break;
      case "daiminkan":
      case "ankan":
      case "kakan":
        talk = pickLine(
          ["4枚そろいました！カンします！", "ドラも増えますし、カンですね！"],
          ctx.seed
        );
        thought = `${t}のカンで打点アップとツモチャンスを増やします。`;
        break;
      case "pass":
        talk = pickLine(
          ["ここは見送りますね", "今は門前で進めようかな", "焦らずスルーにしますね"],
          ctx.seed
        );
        thought = `今の形から無理に鳴くと打点や守備力が落ちるので、ここは冷静にスルーします。`;
        break;
      default:
        if (ctx.isRiichiSelf) {
          talk = pickLine(
            ["ツモ切りで待ちますね…！", "次こそ来ますように！", `そのまま${t}を切りますね`],
            ctx.seed
          );
          thought = `リーチ中なのでツモ切り（${t}）で待ち牌を待ちます。次巡に期待です！`;
        } else if (ctx.isSafeCut) {
          talk = pickLine(
            ["危ないので安全にいきますね", `ここは無理せず${t}で守ります`, "放銃は避けたいので安全牌です"],
            ctx.seed
          );
          thought = `リーチが入っていてこちらは${sh}とまだ遠いので、期待値優先で安全な${t}を選んでオリます。`;
        } else if (ctx.shantenAfter === 0) {
          talk = pickLine(
            ["テンパイしました…！様子を見ますね", `静かに${t}切りで構えます`],
            ctx.seed
          );
          thought = `${t}切りで聴牌（${accStr}）をキープしました。状況を見て押し引きを判断します。`;
        } else {
          talk = pickLine(
            [`受け入れ重視で${t}切りです`, `うーん、${t}にしてみます！`, `整理して${t}から切りますね`, `この形なら${t}がよさそう！`],
            ctx.seed
          );
          thought = `受け入れ枚数を比べると${t}切りが一番効率的です（${sh}・${accStr}）。着実に和了を目指します。`;
        }
        break;
    }
  } else if (profile.id === "aggressive_riichi") {
    // 白ウサギ（超攻撃型）
    switch (actionObj.action) {
      case "tsumo":
        talk = pickLine(
          ["やったぁ！時間ぴったりツモ！", "間に合ったよ！ツモだぁ！", "最速ツモ！次の局も急ごう！"],
          ctx.seed
        );
        thought = `時計の針が止まる前に引き当てたよ！全力スピード攻撃の大勝利だ！`;
        break;
      case "ron":
        talk = pickLine(
          ["捕まえた！ロンだよ、間に合った！", "そこだっ！ロン！遅刻しないぞ！", "ロン！ボクのスピード勝ちだね！"],
          ctx.seed
        );
        thought = `やった、待ち牌が出た！待ってる暇はないから即ロンで決着だよ！`;
        break;
      case "riichi":
        talk = pickLine(
          ["間に合った！即リーチだよ！", "待ってられない！リーチだ！", "チクタク…今だ、勝負リーチ！"],
          ctx.seed
        );
        thought = `ぐずぐずしてたら遅刻しちゃう！${t}切りで聴牌したなら迷わず即リーチで押し切るよ（${accStr}）！`;
        break;
      case "pon":
        talk = pickLine(
          ["急いでポンだ！時間がない！", "それもらうよ、ポン！急げ急げ！", "どんどん仕掛けるよ、ポン！"],
          ctx.seed
        );
        thought = `1巡でも早くアガらなきゃ！${t}をポンしてスピード全開で駆け抜けるよ！`;
        break;
      case "chi":
        talk = pickLine(
          ["それもらうよ、チー！急げ！", "テンポ重視だ！チーするよ！"],
          ctx.seed
        );
        thought = `聴牌まであと少し！${t}をチーして一気にゴールへ飛び込むよ！`;
        break;
      case "daiminkan":
      case "ankan":
      case "kakan":
        talk = pickLine(
          ["どんどん行こう、カンだ！", "ドラを増やして一気に決めるよ、カン！"],
          ctx.seed
        );
        thought = `${t}をカンして嶺上ツモもドラも狙うよ！攻めあるのみだ！`;
        break;
      case "pass":
        talk = pickLine(
          ["今は急いでるからスルー！", "次！次いこう！", "それはパス、自力ツモの方が早いよ！"],
          ctx.seed
        );
        thought = `ここは鳴くよりツモで真っすぐ進めた方が早そうだ。どんどん回して行こう！`;
        break;
      default:
        if (ctx.isRiichiSelf) {
          talk = pickLine(
            ["早く来い来い！ツモ切り！", `チクタク…${t}切り、次こそ！`, "遅刻しちゃうよ、早くアガらせて！"],
            ctx.seed
          );
          thought = `リーチで全速力中！${t}はそのままツモ切り、次のツモで絶対に決めるよ！`;
        } else if (ctx.oppRiichi) {
          talk = pickLine(
            [`リーチなんて気にしない！${t}切り！`, `時間がないんだ、${t}で押すよ！`, `止まってられない、${t}だ！`],
            ctx.seed
          );
          thought = `相手からリーチが来ても止まってる時間はないよ！${t}を切って真っすぐ押し返す（${sh}・${accStr}）！`;
        } else {
          talk = pickLine(
            [`急げ急げ、${t}切りだ！`, `時間がないよ！${t}！`, `どんどん前に進めるよ、${t}！`, `チクタク…よし${t}切り！`],
            ctx.seed
          );
          thought = `遅れちゃうから最速ルート一択だよ！${t}を切って受け入れ最大の攻め手にする（${sh}・${accStr}）。`;
        }
        break;
    }
  } else if (profile.id === "iron_defense") {
    // チェシャ猫（鉄壁守備派）
    switch (actionObj.action) {
      case "tsumo":
        talk = pickLine(
          ["にゃはっ、こっそりツモっちゃった♪", "ふふっ、静かにツモだよ♪", "捕まらないままツモ和了にゃ♪"],
          ctx.seed
        );
        thought = `ふふっ、危険を避けながら門前で仕上げた甲斐があったね。綺麗にツモ和了だよ。`;
        break;
      case "ron":
        talk = pickLine(
          ["残念♪ それはアタシのロンだよ", "ふふっ、罠にかかったね…ロン♪", "にゃはっ、見逃さないよ？ロン！"],
          ctx.seed
        );
        thought = `じっと待ってた甲斐があったよ。安全に構えていたアタシのロン、いただいちゃうね♪`;
        break;
      case "riichi":
        talk = pickLine(
          ["ふふっ…準備完了、リーチだよ", "今なら安全に狙えそう…リーチ♪", "そろそろ本気を出そっかな、リーチ♪"],
          ctx.seed
        );
        thought = `守りを固めたうえで満を持して聴牌したよ。${t}切りなら十分勝負になるからリーチといこうか（${accStr}）。`;
        break;
      case "pon":
        talk = pickLine(["たまには鳴いてあげよっか、ポン♪"], ctx.seed);
        thought = `普段は門前派だけど、この${t}なら守備を崩さず進められるね。`;
        break;
      case "chi":
        talk = pickLine(["ふふ、それはチーさせてもらうよ"], ctx.seed);
        thought = `手牌の安全度を保ちつつ${t}をチーして形を整えるよ。`;
        break;
      case "daiminkan":
      case "ankan":
      case "kakan":
        talk = pickLine(["おや、4枚そろったね…カン♪"], ctx.seed);
        thought = `安全な範囲で${t}をカン。相手をちょっと揺さぶってみようかな。`;
        break;
      case "pass":
        talk = pickLine(
          ["ふふ、それはいらないよ", "手牌を狭くするのはヤダな♪", "すーっとスルーしとこっと"],
          ctx.seed
        );
        thought = `鳴いて手牌が減ると守れなくなるからね。アタシは門前で安全に構えてスルーするよ。`;
        break;
      default:
        if (ctx.isRiichiSelf) {
          talk = pickLine(
            ["ふふっ、静かに見てるだけだよ♪", `にゃはっ、${t}はそのままバイバイ`],
            ctx.seed
          );
          thought = `リーチ中だから${t}をツモ切り。あとはニヤニヤしながら待つだけだよ。`;
        } else if (ctx.isSafeCut) {
          talk = pickLine(
            ["おっと危ない♪ スッと消えちゃお", `そこは当たらないよ？${t}っと`, "ふふ、罠にはかからないにゃ♪"],
            ctx.seed
          );
          thought = `リーチの気配がぷんぷんするね。アタシは絶対に振り込まないから、安全な${t}で綺麗にかわすよ。`;
        } else if (ctx.oppRiichi) {
          talk = pickLine(
            [`念のため危険を減らしとこ、${t}っと`, "ふふっ、慎重にかわすよ♪"],
            ctx.seed
          );
          thought = `他家がリーチ中だから警戒レベル最大。通りやすさと安全度を考えて${t}を処理するよ。`;
        } else if (ctx.shantenAfter === 0) {
          talk = pickLine(
            ["ふふっ、ここはダマでこっそりね♪", `気配を消して${t}切りだよ`],
            ctx.seed
          );
          thought = `聴牌だけど無理に宣言せず、いつでもオリられるように${t}切りでダマに構えておくよ。`;
        } else {
          talk = pickLine(
            [`ふふっ、まずは${t}からね`, `にゃはっ、${t}で様子見だよ`, "危険な気配は先に消しておこっと", `あせらない、あせらない♪ ${t}切り`],
            ctx.seed
          );
          thought = `無茶して飛び込むのはバカらしいからね。守備を意識しながら${t}を整理しておくよ（${sh}）。`;
        }
        break;
    }
  } else {
    // 帽子屋（オカルト派）
    switch (actionObj.action) {
      case "tsumo":
        talk = pickLine(
          ["お見事！極上のツモで乾杯さ！", "お茶会の主役はボクさ、ツモ！", "流れが微笑んだね！ツモだよ！"],
          ctx.seed
        );
        thought = `完璧な流れがお茶会を彩ってくれたよ！最高のタイミングでツモ和了さ！`;
        break;
      case "ron":
        talk = pickLine(
          ["チェックメイト…おっと、ロンだね！", "おや、素敵な贈り物だ。ロンさ！", "その牌を待っていたのさ、ロン！"],
          ctx.seed
        );
        thought = `場の風がボクの味方をしたね。美しく差し出されたその牌、ありがたくロンさせてもらうよ！`;
        break;
      case "riichi":
        talk = pickLine(
          ["お待たせ！お茶会リーチの時間さ！", "最高の風が吹いたよ、リーチ！", "さあ、乾杯といこうか！リーチ！"],
          ctx.seed
        );
        thought = `ツモの勢いが完璧に噛み合ったね！ドラと流れを信じて${t}切りで華麗にリーチさ（${accStr}）！`;
        break;
      case "pon":
        talk = pickLine(
          ["おっと、席替えだ！ポン！", "流れをかき混ぜようか、ポン！", "その牌、お茶会へようこそ！ポン！"],
          ctx.seed
        );
        thought = `そろそろ場況を動かす時間さ。${t}をポンしてお茶会の流れをこちらへ引き寄せるよ！`;
        break;
      case "chi":
        talk = pickLine(
          ["その牌、お茶会に招待しよう。チー！", "流れをつなぐ一撃さ、チー！"],
          ctx.seed
        );
        thought = `絶妙な風が吹いてきたね。${t}をチーして一気に勝負形へ持ち込むよ！`;
        break;
      case "daiminkan":
      case "ankan":
      case "kakan":
        talk = pickLine(
          ["おかわりをもらおうか！カン！", "新しいドラを呼ぶマジックさ、カン！"],
          ctx.seed
        );
        thought = `${t}をカンして場に新しいドラと波乱を呼び込むよ。お茶会は賑やかな方が楽しいさ！`;
        break;
      case "pass":
        talk = pickLine(
          ["まだお茶が冷めていないのさ", "その流れはパスしておこうか", "おや、今はまだ席替えの時じゃないね"],
          ctx.seed
        );
        thought = `今ここで流れを切るのはもったいないね。もう少しツモの風を信じてスルーするのさ。`;
        break;
      default:
        if (ctx.isRiichiSelf) {
          talk = pickLine(
            ["さあ、運命のカップが回るよ…", `おや、まだかな？${t}切りさ`],
            ctx.seed
          );
          thought = `リーチ宣言済みさ。${t}を流して、奇跡のツモが舞い降りるのを優雅に待つよ。`;
        } else if (ctx.holdsDora) {
          talk = pickLine(
            [`ドラは大事に抱えて${t}切りさ`, `輝きは手放さないよ、${t}だね`, `お茶会の流れに合わせて${t}さ`],
            ctx.seed
          );
          thought = `手元のドラが心地よく光っているね。ドラは大事に残しつつ流れに沿って${t}を切るのさ（${sh}）。`;
        } else {
          talk = pickLine(
            [`おや、${t}が帰りたがってるよ`, `お茶会の流れに合わせて${t}さ`, `さあ、次のカップを回そうか。${t}切り`, `風がこっちに吹いてきたね、${t}さ`],
            ctx.seed
          );
          thought = `場の空気とツモの勢いを感じ取ると、今は${t}を手放すのが一番美しいお茶会になるのさ（${sh}・${accStr}）。`;
        }
        break;
    }
  }

  return {
    thought: `${prefix}${thought}`,
    talk
  };
}

/**
 * API切替・エラーフォールバック時のキャラ口調セリフ＆思考
 */
export function buildNpcFallbackErrorResponse(personaId, mode, detail = "") {
  const profile = getNpcProfile(personaId);
  if (mode === "quota") {
    const map = {
      digital_balanced: {
        talk: "頭がいっぱいです…ここからは直感で打ちますね！",
        thought: `[自動切替: ${detail}] API上限のため、この半荘の残りはアリス内蔵AI（デジタル派）で続行します。`
      },
      aggressive_riichi: {
        talk: "時計が止まっちゃった！自力で急いで打つよ！",
        thought: `[自動切替: ${detail}] API上限のため、この半荘の残りは白ウサギ内蔵AI（超攻撃型）で突っ走ります！`
      },
      iron_defense: {
        talk: "ふふ、力が切れちゃった♪ ここからは気まぐれでかわすよ",
        thought: `[自動切替: ${detail}] API上限のため、この半荘の残りはチェシャ猫内蔵AI（鉄壁守備派）で手堅く続行します。`
      },
      occult_flow: {
        talk: "おや、お茶が切れたね。ここからは勘と流れでいこうか！",
        thought: `[自動切替: ${detail}] API上限のため、この半荘の残りは帽子屋内蔵AI（オカルト派）で続行します。`
      }
    };
    return map[profile.id] || map.digital_balanced;
  }

  const map = {
    digital_balanced: {
      talk: "あっ、ちょっと迷っちゃいました…これにします！",
      thought: `[自動補正: ${detail}] アリス内蔵AIの推奨手に切り替えました。`
    },
    aggressive_riichi: {
      talk: "おっと急ぎすぎた！でも止まらないよ！",
      thought: `[自動補正: ${detail}] 白ウサギ内蔵AIの推奨手で即座に続行します。`
    },
    iron_defense: {
      talk: "おっと危ない♪ ここは安全に切り替えよっと",
      thought: `[自動補正: ${detail}] チェシャ猫内蔵AIの推奨手に自動補正しました。`
    },
    occult_flow: {
      talk: "おや、カップが揺れたね。流れに任せようか",
      thought: `[自動補正: ${detail}] 帽子屋内蔵AIの推奨手に自動補正しました。`
    }
  };
  return map[profile.id] || map.digital_balanced;
}
