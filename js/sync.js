/**
 * sync.js
 * [ver.1.0 拡張用インターフェース]
 * ver.0 ではローカルメモリで完結し、ver.1.0 で GAS Webアプリ（Roomsシート）通信に差し替える。
 */

export class LocalSyncAdapter {
  constructor() {
    this.latestState = null;
  }

  async saveState(state) {
    this.latestState = structuredClone(state);
    return this.latestState;
  }

  async fetchState() {
    return this.latestState;
  }
}
