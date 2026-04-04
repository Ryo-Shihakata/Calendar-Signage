# Calendar-Signage プロジェクトガイド

本リポジトリの**全体像・使い方・運用**を説明します。バックエンドの API 仕様や KV の詳細は **[README-backend.md](README-backend.md)** に分離してあります。

---

## 1. これは何か

- **目的**: 壁掛けディスプレイ等で、複数の iCal（Google Calendar 等の ICS URL）をまとめて **今日〜近未来の予定**として表示する。
- **特徴**:
  - ブラウザは **Cloudflare Worker の HTTP API だけ**を呼ぶ（iCal 直 fetch や公開 CORS プロキシは使わない）。
  - 設定（プロファイル、カレンダー URL、テーマ等）は **Worker 側の KV** に保存。
  - **ホスト**（設定担当）と **クライアント**（表示専用端末）を **HOST_SECRET** と **招待 ID（`?invite=`）** で分離。

---

## 2. ディレクトリ構成

```
Calendar-Signage/
├── frontend/index.html    # サイネージ UI + 管理 UI（単一 HTML）
├── worker/                # Cloudflare Worker（TypeScript）
│   ├── src/index.ts       # ルート・認証
│   ├── src/ical.ts        # iCal 取得・パース・RRULE 展開
│   ├── src/aggregate.ts   # プロファイル単位の一括取得・マージ
│   ├── src/store.ts       # KV（tenant:default）
│   ├── src/types.ts
│   ├── wrangler.toml
│   ├── package.json
│   ├── .dev.vars.example
│   └── .gitignore         # .dev.vars を除外
├── index.html             # frontend/index.html への誘導
├── docs/
│   ├── README.md          # 本ファイル
│   └── README-backend.md  # API・データモデル詳細
└── README.md              # リポジトリ入口（要約とドキュメント索引）
```

---

## 3. ホストとクライアントの違い

| 項目 | ホスト（管理） | クライアント（サイネージ） |
|------|----------------|----------------------------|
| URL | 通常 `frontend/index.html`（`invite` なし） | **`?invite=<招待ID>`** 付き |
| 認証 | モーダルに **HOST_SECRET** 入力 → `sessionStorage` に保持 | 不要（招待 ID のみ） |
| できること | プロファイル編集、iCal URL 登録、テーマ・更新間隔、**招待リンクの追加/削除** | **表示のみ**（設定変更 UI なし） |
| 呼ぶ API | `GET/PUT /api/host/tenant`、`GET /api/host/events`、`POST /api/host/calendar-preview` 等 | **`GET /api/public/events?invite=`** が中心 |

招待 ID は URL に含まれるため、**リンクを知っている人はそのプロファイルの予定を取得できます**。漏えいしたら管理画面から該当招待を削除し、必要なら新規発行してください。

---

## 4. ローカル開発の手順（詳細）

### 4.1 Worker

1. ターミナルで `cd worker`
2. `npm install`
3. `cp .dev.vars.example .dev.vars`（Windows はコピーで同様）
4. `.dev.vars` に `HOST_SECRET=（長いランダム文字列）` を記載
5. `npx wrangler dev --local --port 8787`

起動ログに表示される URL（例: `http://127.0.0.1:8787`）が API のベースです。

### 4.2 フロント

1. `frontend/index.html` をブラウザで開く（Live Server 等でも可）
2. **API の向き先**を一致させる:
   - HTML 先頭付近の `<meta name="calendar-api-base" content="http://127.0.0.1:8787">` を実際の Worker に合わせる、**または**
   - 一度ホストでログイン後、**グローバル設定**の「Worker API の URL」に入力（`localStorage` の `signage_api_base` に保存され、meta より優先）

### 4.3 初回セットアップの流れ

1. サイネージ画面右上の **歯車** → `HOST_SECRET` を入力（`.dev.vars` と同じ値）
2. 初回は Worker が KV に **デフォルトテナント**（プロファイル 1、招待 1 本）を作成
3. サイドバーでプロファイルを選び、**カレンダー一覧**に **HTTPS** の iCal URL を追加
4. **「プロファイルを保存」** で `PUT /api/host/tenant`
5. **グローバル設定** を開き、**招待リンク**の URL をコピー
6. 新しいタブで `?invite=...` 付き URL を開く → クライアントモードで表示

### 4.4 便利な操作

- **1 本だけ疎通確認**: 各カレンダー行の「取得」→ Worker の `POST /api/host/calendar-preview`
- **編集中プロファイルの全 URL を一括**: 「全カレンダー取得」→ `GET /api/host/events?...&suggestions=1` で名前候補も取得し、続けてサイネージ用データを更新
- **別端末用の URL を増やす**: 「このプロファイル用の招待を追加」→ `POST /api/host/displays`

---

## 5. 本番デプロイの手順（概要）

1. Cloudflare ダッシュボードで **KV 名前空間**を作成
2. `worker/wrangler.toml` の `[[kv_namespaces]]` に **`id = "..."`** を記入（テンプレ内コメント参照）
3. `cd worker && npx wrangler secret put HOST_SECRET`（値はローカルと別推奨）
4. `npx wrangler deploy`
5. フロントを **Cloudflare Pages** や静的ホスティングに配置し、`calendar-api-base`（または管理画面の API URL）を **デプロイした Worker のオリジン**に変更

HTTPS とカスタムドメインを使う場合は、Worker と Pages のドメイン関係に合わせて CORS を必要なら厳格化してください（現状 Worker は `Access-Control-Allow-Origin: *`）。

---

## 6. よくある質問

**Q. プロファイルは複数あるが、クライアントはどれを表示するか**  
A. 各 **招待リンク** が 1 つの `profileId` に紐づきます。同じプロファイルを複数画面で出すなら同じ invite を共有するか、同じ profile に invite を複数作ります。

**Q. 設定はブラウザの localStorage に残るか**  
A. プロファイル本体は **残しません**（Worker がソースオブトゥルース）。保存されるのは API ベース URL 用のキーと、ホストのトークン用 `sessionStorage` 程度です。

**Q. `PUT` で 409**  
A. 別タブで保存済みで `version` が進んでいます。管理画面を再読み込みしてから編集し直してください。

---

## 7. ドキュメント間の対応（迷ったら）

| 知りたいこと | 参照先（docs） |
|--------------|----------------|
| 全体のデータの流れ・図 | [README-backend.md §1](README-backend.md#1-全体アーキテクチャ) |
| Worker の各ファイルの役割 | [README-backend.md §2](README-backend.md#2-ディレクトリとソースの対応worker) |
| KV に何が入るか | [README-backend.md §3](README-backend.md#3-データモデルkv-に保存する-json) |
| エンドポイント一覧・HTTP メソッド | [README-backend.md §4](README-backend.md#4-http-api-リファレンス) |
| Wrangler・シークレット・デプロイコマンド | [README-backend.md §5](README-backend.md#5-環境変数wrangler) |
| フロントの `?invite=` / meta / localStorage | [README-backend.md §6](README-backend.md#6-フロントエンドfrontendindexhtmlとの対応) |
| JSON の形・`from`/`to` | [README-backend.md §7](README-backend.md#7-レスポンスリクエスト例参考) |
| RRULE・タイムゾーンの限界 | [README-backend.md §8](README-backend.md#8-制限事項既知の挙動) |
| エラー時の切り分け | [README-backend.md §9](README-backend.md#9-トラブルシューティング) |
| 本番の CORS・バックアップ | [README-backend.md §10](README-backend.md#10-セキュリティ運用) |

## 8. 次に読むもの

- **[README-backend.md](README-backend.md)** … 上表の通り、API・KV・セキュリティの一次情報
