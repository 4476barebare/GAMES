/**
 * sync.js
 * オフライン（LocalSyncAdapter）および GAS オンライン対戦（GasSyncAdapter）通信層
 * ・GET: ?action=... クエリパラメータ
 * ・POST: CORSプリフライト回避のため Content-Type: text/plain でJSON文字列を送信
 * ・リロード連打対策: ブラウザ側クールダウン＆ローカルキャッシュ併用でGAS無料枠を保護
 */

import {
  saveMatchSession,
  loadMatchSession,
  sanitizeGameStateSecrets,
  saveCachedOnlineRoom,
  loadCachedOnlineRoom
} from "./storage.js";

export const GAS_WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbzIxYlwWFRhobprsZhlGr1zL40dzyVNCD_D2_izPCLsLeKymY0K1JVLKM9gmR6V5LDVLA/exec";

const MIN_GET_ROOM_INTERVAL_MS = 1800;
const MIN_LIST_INTERVAL_MS = 4000;

export class LocalSyncAdapter {
  async saveState(state, logs = []) {
    saveMatchSession(state, logs);
    return state;
  }

  async fetchState() {
    const session = loadMatchSession();
    return session ? session.gameState : null;
  }
}

export class GasSyncAdapter {
  constructor(endpointUrl = GAS_WEBAPP_URL) {
    this.endpointUrl = endpointUrl;
    this.lastGetAtByRoom = new Map();
    this.lastListAt = 0;
    this.cachedPublicRooms = [];
  }

  async _get(params) {
    const url = new URL(this.endpointUrl);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    });
    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store"
    });
    if (!res.ok) {
      throw new Error(`GAS GET HTTP ${res.status}`);
    }
    return await res.json();
  }

  async _post(payload) {
    const safePayload = structuredClone(payload);
    if (safePayload.gameState) {
      safePayload.gameState = sanitizeGameStateSecrets(safePayload.gameState);
    }
    const res = await fetch(this.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(safePayload)
    });
    if (!res.ok) {
      throw new Error(`GAS POST HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data && data.room) {
      saveCachedOnlineRoom(data.room);
      this.lastGetAtByRoom.set(data.room.roomId, Date.now());
    }
    return data;
  }

  async listPublicRooms(force = false) {
    const now = Date.now();
    if (!force && now - this.lastListAt < MIN_LIST_INTERVAL_MS) {
      return this.cachedPublicRooms;
    }
    this.lastListAt = now;
    const data = await this._get({ action: "list" });
    if (data.status === "ok" && Array.isArray(data.rooms)) {
      this.cachedPublicRooms = data.rooms;
      return data.rooms;
    }
    throw new Error(data.message || "ルーム一覧の取得に失敗しました");
  }

  async getRoom(roomId, sinceVersion = -1, { force = false } = {}) {
    const now = Date.now();
    const cachedEntry = loadCachedOnlineRoom(roomId);
    const lastAt = this.lastGetAtByRoom.get(roomId) || 0;

    // リロード連打・短時間連続リクエスト時はローカルキャッシュを即返却してGAS消費を抑える
    if (!force && cachedEntry && now - cachedEntry.cachedAt < MIN_GET_ROOM_INTERVAL_MS) {
      const cRoom = cachedEntry.room;
      if (sinceVersion >= 0 && Number(cRoom.version) === Number(sinceVersion)) {
        return { status: "ok", unchanged: true, room: cRoom, fromCache: true };
      }
      return { status: "ok", unchanged: false, room: cRoom, fromCache: true };
    }

    if (!force && now - lastAt < 900 && cachedEntry) {
      return { status: "ok", unchanged: true, room: cachedEntry.room, fromCache: true };
    }

    this.lastGetAtByRoom.set(roomId, now);
    const effectiveSince =
      sinceVersion >= 0
        ? sinceVersion
        : cachedEntry && cachedEntry.room
        ? Number(cachedEntry.room.version || -1)
        : -1;

    const data = await this._get({
      action: "get",
      roomId,
      sinceVersion: effectiveSince
    });

    if (data.status === "ok") {
      if (data.unchanged) {
        if (cachedEntry && cachedEntry.room) {
          saveCachedOnlineRoom(cachedEntry.room);
          return { status: "ok", unchanged: true, room: cachedEntry.room };
        }
        // キャッシュが無いのにunchangedが返った場合は全件取得し直す
        const full = await this._get({ action: "get", roomId, sinceVersion: -1 });
        if (full.status === "ok" && full.room) {
          saveCachedOnlineRoom(full.room);
          return { status: "ok", unchanged: false, room: full.room };
        }
        return full;
      }
      if (data.room) {
        saveCachedOnlineRoom(data.room);
        return { status: "ok", unchanged: false, room: data.room };
      }
    }

    return data;
  }

  async createRoom({ playerId, playerName, isPublic }) {
    return await this._post({
      action: "create",
      playerId,
      playerName,
      isPublic: Boolean(isPublic)
    });
  }

  async joinRoom({ roomId, playerId, playerName }) {
    return await this._post({
      action: "join",
      roomId,
      playerId,
      playerName
    });
  }

  async leaveRoom({ roomId, playerId }) {
    return await this._post({
      action: "leave",
      roomId,
      playerId
    });
  }

  async kickPlayer({ roomId, hostId, targetId }) {
    return await this._post({
      action: "kick",
      roomId,
      hostId,
      targetId
    });
  }

  async startMatch({ roomId, hostId, gameState, logs }) {
    return await this._post({
      action: "start",
      roomId,
      hostId,
      gameState,
      logs
    });
  }

  async updateState({ roomId, expectedVersion, gameState, logs }) {
    return await this._post({
      action: "update",
      roomId,
      expectedVersion,
      gameState,
      logs
    });
  }

  async sendNextRoundOk({ roomId, playerId }) {
    return await this._post({
      action: "next_round_ok",
      roomId,
      playerId
    });
  }
}
