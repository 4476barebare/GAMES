# AI Mahjong Arena (ver.0)

BYOK（ユーザー持ち込みAPIキー）型のマルチAI麻雀アリーナ プロトタイプ（2人打ちver.0）。
将来の4人打ち拡張およびGASオンライン対戦ロビー接続を見据えた設計になっています。

## 特徴
- **サーバー不要・GitHub Pages完結**: `index.html` を静的ホスティングするだけで動作。
- **拡張前提のアーキテクチャ**:
  - `players[]` 配列ベースの席管理（2人打ち / 4人打ち対応）
  - 単一純粋JSON `gameState` による状態管理（GASスプレッドシート同期互換）
  - 自作ルールエンジン（シャンテン数・有効牌・待ち牌・主要役・点数計算）＋ AI用解析カンペ付きMarkdown生成
- **BYOK Gemini API連携**: ブラウザから直接Gemini REST APIを呼び出し、思考ログとセリフ付きで対局（APIキー未入力時は内蔵AIフォールバックで即プレイ可能）。

## 使い方
1. `GAMES` リポジトリにそのままアップロードし、GitHub Pages を有効化します（ローカル検証時は `npx serve` や VSCode Live Server 等のHTTPサーバー経由で開いてください。ES Modulesを使用しているため `file://` 直開きではブラウザのCORS制限がかかります）。
2. 画面上部の「API・対局設定」から Gemini API キー（任意）と対局モード（人間 vs AI / AI vs AI オート観戦）を選択して「新規対局開始」を押します。
