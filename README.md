# Calendar-Signage

会議室・フロア向けのカレンダー表示（サイネージ）。**フロントエンド**は単体 HTML（`frontend/index.html`）、**バックエンド**は **Cloudflare Worker**（`worker/`）。iCal（ICS）の取得・パース・繰り返し予定の展開は **すべて Worker** が行い、ブラウザは **Worker の HTTP API のみ**を呼び出します（ブラウザから iCal 配信元への直アクセスや公開 CORS プロキシは使いません）。

---

## ドキュメントの読み分け

| 文書 | 内容 |
|------|------|
| **本ファイル（README.md）** | プロジェクトの位置づけ、構成ツリー、ホスト/クライアントの役割、**手順ベースの使い方**、本番の要点 |
| **[docs/README.md](docs/README.md)** | 上記をさらに手順詳細化（初回セットアップのステップ、便利操作、FAQ） |
| **[docs/README-backend.md](docs/README-backend.md)** | **アーキテクチャ図（Mermaid）**、KV の JSON 形、**全 API の仕様**、フロント実装との対応、トラブルシューティング |

---

## リポジトリ構成

```
Calendar-Signage/
├── frontend/index.html     # サイネージ UI + 管理 UI（単一ファイル）
├── worker/                 # Cloudflare Worker（TypeScript）
│   ├── src/
│   │   ├── index.ts        # ルーティング・CORS・HOST_SECRET 検証
│   │   ├── ical.ts         # iCal HTTPS 取得・パース・RRULE 展開
│   │   ├── aggregate.ts    # プロファイル内カレンダー並列取得・マージ
│   │   ├── store.ts        # KV: tenant:default
│   │   └── types.ts
│   ├── wrangler.toml       # KV バインド名 DATA（本番は id 要設定）
│   ├── package.json
│   ├── .dev.vars.example   # ローカル用 HOST_SECRET の例
│   └── .gitignore          # .dev.vars を除外
├── index.html              # frontend/index.html への誘導
├── docs/
│   ├── README.md           # プロジェクトガイド（詳しめ）
│   └── README-backend.md   # バックエンド詳細（最も技術的）
└── README.md               # 本ファイル
```

---

## ホストとクライアント（役割）

| 役割 | URL の例 | 認証 | できること |
|------|-----------|------|------------|
| **ホスト** | `frontend/index.html`（`invite` なし） | 画面の歯車から **HOST_SECRET** 入力（`Authorization: Bearer` と同じ文字列） | プロファイル・iCal URL・テーマ・更新間隔の編集、**招待リンクの発行・削除** |
| **クライアント** | 同じ HTML に **`?invite=〈ID〉`** | なし | **表示のみ**。紐づいたプロファイルの予定を `GET /api/public/events` で取得 |

- 設定の正本は **KV**（キー `tenant:default`）。クライアントには iCal の生 URL を渡さず、**集約済みイベント JSON** のみ返します。
- 招待 URL は **推測困難な ID** ですが、**リンクを知る人は予定を読めます**。漏えい時は管理画面から招待を削除し、新規発行してください。

---

## ローカルで動かす（手順）

### 1. Worker

```bash
cd worker
npm install
```

`.dev.vars.example` をコピーして `worker/.dev.vars` を作り、次の 1 行を設定します。

```
HOST_SECRET=（十分長いランダム文字列）
```

```bash
npx wrangler dev --local --port 8787
```

ターミナルに表示された URL（多くの場合 `http://127.0.0.1:8787`）が **API ベース**です。

### 2. フロント

`frontend/index.html` をブラウザで開きます。

- `<meta name="calendar-api-base" content="http://127.0.0.1:8787">` を、手順 1 の URL に合わせる。
- または、ホストログイン後に **グローバル設定 → Worker API の URL** に入力（`localStorage` に保存され、meta より優先）。

### 3. 初回のおすすめフロー

1. サイネージ画面 **歯車** → `HOST_SECRET` でログイン（初回 `GET /api/host/tenant` で KV にデフォルトテナントが作成されることがあります）。
2. プロファイルに **HTTPS** の iCal URL を追加（`webcal://` は Worker 内で `https://` に置換）。
3. **「プロファイルを保存」** で Worker に反映。
4. **グローバル設定** の **招待リンク** をコピーし、`?invite=...` 付き URL で別タブを開き、クライアント表示を確認。

---

## 本番デプロイ

1. Cloudflare で **KV 名前空間**を作成し、`worker/wrangler.toml` の `[[kv_namespaces]]` に **`id`** を記載。
2. `cd worker && npx wrangler secret put HOST_SECRET`（本番専用の強いシークレット）。
3. `npx wrangler deploy`。
4. フロントを Pages 等に配置し、API ベース URL を **デプロイした Worker のオリジン**に合わせる。

詳細・API 一覧・エラーの意味は **[docs/README-backend.md](docs/README-backend.md)** を参照してください。

---

## セキュリティ

- `HOST_SECRET` と `worker/.dev.vars` を **Git にコミットしない**（`worker/.gitignore` 済み）。
- 招待リンクは **共有リンクと同じ扱い**にする。

---

## English

Single-page UI in `frontend/index.html`; API and iCal logic in Cloudflare Worker. Hosts authenticate with `HOST_SECRET`; read-only signage uses `?invite=`. Full API and architecture: **docs/README-backend.md**.
