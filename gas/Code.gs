/**
 * AI Mahjong Arena 4P - GAS Backend (ver.0.8 / A案: 楽観ロック排他保存 + CacheService省クォータ設計)
 *
 * 特徴:
 * - 初回アクセス時に "Rooms" シートを自動作成
 * - 読み取り系 (list / get) は CacheService を優先し、リロード連打でもスプレッドシートを読まず高速・省クォータで応答
 * - 書き込み系 (create / join / leave / kick / start / update / next_round_ok) は LockService で排他制御
 * - 30分以上更新のない放置ルームを自動掃除
 */

const SHEET_NAME = "Rooms";
const ROOM_EXPIRE_MS = 30 * 60 * 1000; // 30分放置で自動削除
const LIST_CACHE_KEY = "mahjong_rooms_list_v1";
const LIST_CACHE_TTL_SEC = 5;
const ROOM_CACHE_PREFIX = "mahjong_room_v1_";
const ROOM_CACHE_TTL_SEC = 600;
const HEADERS = [
  "room_id",
  "is_public",
  "status",
  "version",
  "host_id",
  "host_name",
  "players_json",
  "state_json",
  "logs_json",
  "updated_at"
];

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = String(params.action || "ping");

    if (action === "ping") {
      return jsonResponse({ status: "ok", version: "0.8", now: Date.now() });
    }

    if (action === "list") {
      return jsonResponse({ status: "ok", rooms: getPublicRoomsCached() });
    }

    if (action === "get") {
      const roomId = normalizeRoomId(params.roomId);
      if (!roomId) return jsonResponse({ status: "error", message: "roomId が不正です" });

      const room = getRoomCached(roomId);
      if (!room) return jsonResponse({ status: "not_found", message: "指定されたルームが見つかりません" });

      const sinceVersion = Number(params.sinceVersion || -1);
      if (!isNaN(sinceVersion) && sinceVersion >= 0 && Number(room.version) === sinceVersion) {
        return jsonResponse({
          status: "ok",
          unchanged: true,
          roomId: room.roomId,
          roomStatus: room.status,
          version: room.version,
          updatedAt: room.updatedAt
        });
      }
      return jsonResponse({ status: "ok", unchanged: false, room: room });
    }

    return jsonResponse({ status: "error", message: "Unknown GET action: " + action });
  } catch (err) {
    return jsonResponse({ status: "error", message: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return jsonResponse({ status: "busy", message: "サーバーが混雑しています。少し待って再試行してください。" });
  }

  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const body = JSON.parse(raw);
    const action = String(body.action || "");

    if (action === "create") {
      return jsonResponse(handleCreateRoom(body));
    }
    if (action === "join") {
      return jsonResponse(handleJoinRoom(body));
    }
    if (action === "leave") {
      return jsonResponse(handleLeaveRoom(body));
    }
    if (action === "kick") {
      return jsonResponse(handleKickPlayer(body));
    }
    if (action === "start") {
      return jsonResponse(handleStartMatch(body));
    }
    if (action === "update") {
      return jsonResponse(handleUpdateState(body));
    }
    if (action === "next_round_ok") {
      return jsonResponse(handleNextRoundOk(body));
    }

    return jsonResponse({ status: "error", message: "Unknown POST action: " + action });
  } catch (err) {
    return jsonResponse({ status: "error", message: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

/* ======================== シート・キャッシュ操作 ======================== */

function getOrInitSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function rowToRoomObject(row) {
  return {
    roomId: String(row[0]),
    isPublic: row[1] === true || String(row[1]).toUpperCase() === "TRUE",
    status: String(row[2] || "waiting"),
    version: Number(row[3] || 0),
    hostId: String(row[4] || ""),
    hostName: String(row[5] || ""),
    players: safeJsonParse(row[6], []),
    gameState: safeJsonParse(row[7], null),
    logs: safeJsonParse(row[8], []),
    updatedAt: Number(row[9] || 0)
  };
}

function roomObjectToRow(room) {
  return [
    String(room.roomId),
    Boolean(room.isPublic),
    String(room.status || "waiting"),
    Number(room.version || 0),
    String(room.hostId || ""),
    String(room.hostName || ""),
    JSON.stringify(room.players || []),
    room.gameState ? JSON.stringify(room.gameState) : "",
    JSON.stringify((room.logs || []).slice(0, 120)),
    Number(room.updatedAt || Date.now())
  ];
}

function writeRoomToCache(room) {
  try {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(room);
    if (json.length < 95000) {
      cache.put(ROOM_CACHE_PREFIX + room.roomId, json, ROOM_CACHE_TTL_SEC);
    }
  } catch (e) {
    // キャッシュ容量超過時は無視してシート参照にフォールバック
  }
}

function removeRoomFromCache(roomId) {
  try {
    CacheService.getScriptCache().remove(ROOM_CACHE_PREFIX + roomId);
  } catch (e) {}
}

function invalidateListCache() {
  try {
    CacheService.getScriptCache().remove(LIST_CACHE_KEY);
  } catch (e) {}
}

function getRoomCached(roomId) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(ROOM_CACHE_PREFIX + roomId);
  if (cached) {
    const parsed = safeJsonParse(cached, null);
    if (parsed && Date.now() - Number(parsed.updatedAt || 0) <= ROOM_EXPIRE_MS) {
      return parsed;
    }
  }

  const sheet = getOrInitSheet();
  const found = findRoomRow(sheet, roomId);
  if (!found) return null;
  if (Date.now() - Number(found.room.updatedAt || 0) > ROOM_EXPIRE_MS) {
    return null;
  }
  writeRoomToCache(found.room);
  return found.room;
}

function getPublicRoomsCached() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(LIST_CACHE_KEY);
  if (cached) {
    const parsed = safeJsonParse(cached, null);
    if (Array.isArray(parsed)) return parsed;
  }

  const sheet = getOrInitSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    cache.put(LIST_CACHE_KEY, "[]", LIST_CACHE_TTL_SEC);
    return [];
  }

  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const now = Date.now();
  const publicRooms = [];

  for (let i = 0; i < values.length; i++) {
    const r = rowToRoomObject(values[i]);
    if (!r.roomId) continue;
    if (now - r.updatedAt > ROOM_EXPIRE_MS) continue;
    if (r.isPublic && r.status === "waiting") {
      publicRooms.push({
        roomId: r.roomId,
        hostName: r.hostName,
        playerCount: r.players.length,
        maxPlayers: 4,
        updatedAt: r.updatedAt
      });
    }
  }

  publicRooms.sort(function (a, b) {
    return b.updatedAt - a.updatedAt;
  });

  try {
    cache.put(LIST_CACHE_KEY, JSON.stringify(publicRooms), LIST_CACHE_TTL_SEC);
  } catch (e) {}

  return publicRooms;
}

function findRoomRow(sheet, roomId) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(roomId)) {
      return { rowIndex: i + 2, room: rowToRoomObject(values[i]) };
    }
  }
  return null;
}

function cleanupExpiredRooms(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const now = Date.now();
  for (let i = values.length - 1; i >= 0; i--) {
    const updatedAt = Number(values[i][9] || 0);
    if (!values[i][0] || now - updatedAt > ROOM_EXPIRE_MS) {
      const rid = String(values[i][0] || "");
      sheet.deleteRow(i + 2);
      if (rid) removeRoomFromCache(rid);
    }
  }
}

function generateUniqueRoomId(sheet) {
  const existing = {};
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      existing[String(ids[i][0])] = true;
    }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!existing[code]) return code;
  }
  return String(Date.now()).slice(-4);
}

/* ======================== ルーム操作ハンドラ ======================== */

function handleCreateRoom(body) {
  const sheet = getOrInitSheet();
  cleanupExpiredRooms(sheet);

  const playerId = sanitizeText(body.playerId, 48);
  const playerName = sanitizeText(body.playerName, 16) || "ホスト";
  if (!playerId) return { status: "error", message: "playerId が必要です" };

  const roomId = generateUniqueRoomId(sheet);
  const now = Date.now();
  const room = {
    roomId: roomId,
    isPublic: Boolean(body.isPublic),
    status: "waiting",
    version: 1,
    hostId: playerId,
    hostName: playerName,
    players: [{ id: playerId, name: playerName, joinedAt: now }],
    gameState: null,
    logs: [],
    updatedAt: now
  };

  sheet.appendRow(roomObjectToRow(room));
  writeRoomToCache(room);
  invalidateListCache();
  return { status: "ok", room: room };
}

function handleJoinRoom(body) {
  const sheet = getOrInitSheet();
  const roomId = normalizeRoomId(body.roomId);
  const playerId = sanitizeText(body.playerId, 48);
  const playerName = sanitizeText(body.playerName, 16) || "ゲスト";
  if (!roomId || !playerId) return { status: "error", message: "roomId と playerId が必要です" };

  const found = findRoomRow(sheet, roomId);
  if (!found) return { status: "not_found", message: "ルームが見つかりません" };

  const room = found.room;
  const existing = room.players.find(function (p) {
    return p.id === playerId;
  });

  // 既に着席済み（リロード再接続）
  if (existing) {
    return { status: "ok", rejoined: true, room: room };
  }

  if (room.status !== "waiting") {
    return { status: "error", message: "このルームはすでに対局中です" };
  }
  if (room.players.length >= 4) {
    return { status: "error", message: "満席（4人）のため参加できません" };
  }

  room.players.push({ id: playerId, name: playerName, joinedAt: Date.now() });
  room.version += 1;
  room.updatedAt = Date.now();

  sheet.getRange(found.rowIndex, 1, 1, HEADERS.length).setValues([roomObjectToRow(room)]);
  writeRoomToCache(room);
  invalidateListCache();
  return { status: "ok", rejoined: false, room: room };
}

function handleLeaveRoom(body) {
  const sheet = getOrInitSheet();
  const roomId = normalizeRoomId(body.roomId);
  const playerId = sanitizeText(body.playerId, 48);
  if (!roomId || !playerId) return { status: "error", message: "パラメータ不足" };

  const found = findRoomRow(sheet, roomId);
  if (!found) return { status: "ok", deleted: true };

  const room = found.room;
  if (room.status !== "waiting") {
    return { status: "error", message: "対局中は退出できません（ホストのキック機能を使用してください）" };
  }

  room.players = room.players.filter(function (p) {
    return p.id !== playerId;
  });

  if (room.players.length === 0) {
    sheet.deleteRow(found.rowIndex);
    removeRoomFromCache(roomId);
    invalidateListCache();
    return { status: "ok", deleted: true };
  }

  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
    room.hostName = room.players[0].name;
  }

  room.version += 1;
  room.updatedAt = Date.now();
  sheet.getRange(found.rowIndex, 1, 1, HEADERS.length).setValues([roomObjectToRow(room)]);
  writeRoomToCache(room);
  invalidateListCache();
  return { status: "ok", deleted: false, room: room };
}

function handleKickPlayer(body) {
  const sheet = getOrInitSheet();
  const roomId = normalizeRoomId(body.roomId);
  const hostId = sanitizeText(body.hostId, 48);
  const targetId = sanitizeText(body.targetId, 48);
  if (!roomId || !hostId || !targetId) return { status: "error", message: "パラメータ不足" };

  const found = findRoomRow(sheet, roomId);
  if (!found) return { status: "not_found", message: "ルームが見つかりません" };

  const room = found.room;
  if (room.hostId !== hostId) {
    return { status: "error", message: "ホストのみキック可能です" };
  }
  if (targetId === hostId) {
    return { status: "error", message: "ホスト自身はキックできません" };
  }

  // 待機中：空き席に戻す
  if (room.status === "waiting") {
    room.players = room.players.filter(function (p) {
      return p.id !== targetId;
    });
    room.version += 1;
    room.updatedAt = Date.now();
    sheet.getRange(found.rowIndex, 1, 1, HEADERS.length).setValues([roomObjectToRow(room)]);
    writeRoomToCache(room);
    invalidateListCache();
    return { status: "ok", room: room };
  }

  // 対局中：対象席を内蔵AI（ホスト代行）へ切り替え
  if (room.gameState && Array.isArray(room.gameState.players)) {
    const targetPlayer = room.gameState.players.find(function (p) {
      return p.id === targetId;
    });
    if (targetPlayer && targetPlayer.control === "human") {
      const oldName = targetPlayer.name;
      targetPlayer.control = "ai";
      targetPlayer.name = "内蔵(代行)";
      targetPlayer.aiConfig = {
        provider: "gemini",
        model: "builtin",
        personaId: "digital_balanced",
        customPrompt: "",
        fallbackActive: false,
        fallbackReason: ""
      };
      room.players = room.players.filter(function (p) {
        return p.id !== targetId;
      });
      room.logs = Array.isArray(room.logs) ? room.logs : [];
      room.logs.unshift("⚠️ " + oldName + " をキックし、内蔵AI（ホスト代行）へ切り替えました");
      if (room.logs.length > 120) room.logs.length = 120;

      // 局終了待ちだった場合はOKリストも整理
      if (room.gameState.nextRoundReadyIds && Array.isArray(room.gameState.nextRoundReadyIds)) {
        room.gameState.nextRoundReadyIds = room.gameState.nextRoundReadyIds.filter(function (id) {
          return id !== targetId;
        });
      }

      room.version += 1;
      room.gameState.version = room.version;
      room.updatedAt = Date.now();
      room.gameState.updatedAt = room.updatedAt;

      sheet.getRange(found.rowIndex, 1, 1, HEADERS.length).setValues([roomObjectToRow(room)]);
      writeRoomToCache(room);
      return { status: "ok", room: room };
    }
  }

  return { status: "error", message: "対象プレイヤーが見つかりません" };
}

function handleStartMatch(body) {
  const sheet = getOrInitSheet();
  const roomId = normalizeRoomId(body.roomId);
  const hostId = sanitizeText(body.hostId, 48);
  if (!roomId || !hostId || !body.gameState) {
    return { status: "error", message: "パラメータ不足" };
  }

  const found = findRoomRow(sheet, roomId);
  if (!found) return { status: "not_found", message: "ルームが見つかりません" };

  const room = found.room;
  if (room.hostId !== hostId) {
    return { status: "error", message: "ホストのみ対局開始できます" };
  }

  const safeState = stripApiKeys(body.gameState);
  room.status = safeState.status || "playing";
  room.version += 1;
  safeState.roomId = roomId;
  safeState.version = room.version;
  room.gameState = safeState;
  room.logs = Array.isArray(body.logs) ? body.logs.slice(0, 120) : [];
  room.updatedAt = Date.now();
  safeState.updatedAt = room.updatedAt;

  sheet.getRange(found.rowIndex, 1, 1, HEADERS.length).setValues([roomObjectToRow(room)]);
  writeRoomToCache(room);
  invalidateListCache();
  return { status: "ok", room: room };
}

function handleUpdateState(body) {
  const sheet = getOrInitSheet();
  const roomId = normalizeRoomId(body.roomId);
  const expectedVersion = Number(body.expectedVersion);
  if (!roomId || !body.gameState) {
    return { status: "error", message: "パラメータ不足" };
  }

  const found = findRoomRow(sheet, roomId);
  if (!found) return { status: "not_found", message: "ルームが見つかりません" };

  const room = found.room;
  if (!isNaN(expectedVersion) && expectedVersion !== room.version) {
    return { status: "conflict", room: room };
  }

  const safeState = stripApiKeys(body.gameState);
  room.version += 1;
  room.status = safeState.status || room.status;
  safeState.roomId = roomId;
  safeState.version = room.version;
  room.gameState = safeState;
  if (Array.isArray(body.logs)) {
    room.logs = body.logs.slice(0, 120);
  }
  room.updatedAt = Date.now();
  safeState.updatedAt = room.updatedAt;

  sheet.getRange(found.rowIndex, 1, 1, HEADERS.length).setValues([roomObjectToRow(room)]);
  writeRoomToCache(room);
  return { status: "ok", room: room };
}

function handleNextRoundOk(body) {
  const sheet = getOrInitSheet();
  const roomId = normalizeRoomId(body.roomId);
  const playerId = sanitizeText(body.playerId, 48);
  if (!roomId || !playerId) return { status: "error", message: "パラメータ不足" };

  const found = findRoomRow(sheet, roomId);
  if (!found) return { status: "not_found", message: "ルームが見つかりません" };

  const room = found.room;
  if (!room.gameState || room.gameState.status !== "round_end") {
    return { status: "ok", allReady: false, room: room };
  }

  const readyIds = Array.isArray(room.gameState.nextRoundReadyIds)
    ? room.gameState.nextRoundReadyIds
    : [];
  if (readyIds.indexOf(playerId) === -1) {
    readyIds.push(playerId);
  }
  room.gameState.nextRoundReadyIds = readyIds;

  const humanIds = room.gameState.players
    .filter(function (p) {
      return p.control === "human";
    })
    .map(function (p) {
      return p.id;
    });
  const allReady = humanIds.every(function (hid) {
    return readyIds.indexOf(hid) !== -1;
  });

  room.version += 1;
  room.gameState.version = room.version;
  room.updatedAt = Date.now();
  room.gameState.updatedAt = room.updatedAt;

  sheet.getRange(found.rowIndex, 1, 1, HEADERS.length).setValues([roomObjectToRow(room)]);
  writeRoomToCache(room);
  return { status: "ok", allReady: allReady, room: room };
}

/* ======================== ユーティリティ ======================== */

function stripApiKeys(state) {
  if (!state || !Array.isArray(state.players)) return state;
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p && p.aiConfig && "apiKey" in p.aiConfig) {
      delete p.aiConfig.apiKey;
    }
  }
  return state;
}

function normalizeRoomId(raw) {
  const s = String(raw || "").trim();
  return /^[0-9]{4}$/.test(s) ? s : "";
}

function sanitizeText(raw, maxLen) {
  return String(raw || "")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, maxLen);
}

function safeJsonParse(str, fallback) {
  try {
    if (!str) return fallback;
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
