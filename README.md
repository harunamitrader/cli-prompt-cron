<p align="center">
  <img src="assets/header.jpg" alt="cli-prompt-cron" width="100%">
</p>

AI CLI 向けの cron デーモン + ブラウザダッシュボード。
Gemini CLI・Codex など、スケジュール実行機能を持たない AI CLI にプロンプトの定期実行を追加します。
Claude Code でも利用可能です。

---

## 概要

`./data/jobs/` に JSON ファイルを置くだけで AI CLI コマンドを定期実行できます。
実行結果やログはブラウザのダッシュボード（`http://localhost:3300`）でリアルタイムに確認できます。
`node start.js` 一発でデーモン・ダッシュボードサーバー・ブラウザを同時に起動します。
公開リポジトリには実運用の `data/jobs/` や `data/logs/` は含めず、サンプルは `examples/job.sample.json` を置いています。

---

## 対応 CLI

| CLI | 対応状況 | 備考 |
|-----|---------|------|
| **Gemini CLI** | メイン対応 | スケジュール機能なし → 本ツールで補完 |
| **Codex** | メイン対応 | 非インタラクティブ実行には `codex exec` を使用 |
| **Claude Code** | 対応 | 自前のスケジュール機能（CronCreate）あり。本ツールは外部からの定期実行に |

---

## 特徴

- **ブラウザダッシュボード** — ジョブ一覧・実行中モニター・ライブログ・実行結果をブラウザで確認。経過時間表示・停止・再開・強制停止もワンクリック
- **UI から新規ジョブ作成** — ダッシュボード上で送信先 CLI・権限・セッション・cron・プロンプトを入力して、そのまま定期実行を追加
- **自然言語でジョブ管理** — `skills/SKILL.md` を AI に読み込ませることで、チャットでジョブを追加・編集・削除
- **ワンコマンド起動** — `npm start` でデーモン + ダッシュボード + ブラウザが一括起動
- **ファイルベース管理** — `./data/jobs/` の JSON ファイルで完結。デーモン再起動不要のホットリロード対応
- **結果の永続保存** — 実行結果を `./data/results/` にテキストで保存
- **セッション再利用** — `fresh` で毎回新規セッション、または過去の `cli-prompt-cron` 管理 session を選んで継続可能
- **自動タイムアウト** — ジョブが一定時間（デフォルト60分）を超えると自動で強制停止。無限ループ防止

---

## プロンプトでの導入・使い方

### Step 1: セットアップ

お使いの AI CLI に以下のプロンプトを貼ってください：

```
https://github.com/harunamitrader/cli-prompt-cron をクローンして、npm install して
```

AI が自動でクローン → インストールを行います。
SKILL.md の読み込みは Step 3 のジョブ管理時に毎回行います。

---

### Step 2: デーモン・ダッシュボード起動

```
cli-prompt-cron のデーモンとダッシュボードを起動して
```

または手動で：

```bash
npm start        # デーモン + ダッシュボード + ブラウザが一括起動
```

**デスクトップショートカット**

`npm install` 時にデスクトップへショートカットが自動作成されます（Windows / Mac / Linux 対応）。
手動で再作成したい場合：

```bash
node scripts/create-shortcut.js
```

---

### Step 3: ジョブ管理

自然言語でジョブを管理できます。プロンプトに `skills/SKILL.md を読んで` を含めてください。

**テスト用（毎分実行）:**

Codex:
```
cli-prompt-cron の skills/SKILL.md を読んで、毎分「AIに関するトリビアを1つtxtに追記して」というプロンプトをcodexに送信するジョブを作って。
```

Gemini CLI:
```
cli-prompt-cron の skills/SKILL.md を読んで、毎分「AIに関するトリビアを1つtxtに追記して」というプロンプトをgeminiに送信するジョブを作って。
```

**その他のプロンプト例:**

```
cli-prompt-cron の skills/SKILL.md を読んで、毎朝9時にGeminiに「GitHubのトレンドをまとめて」というプロンプトを送信するジョブを追加して。
```

```
cli-prompt-cron の skills/SKILL.md を読んで、毎週月曜8時にCodexに「今週の作業計画を立てて」というプロンプトを送信するジョブを作って。
```

```
cli-prompt-cron の skills/SKILL.md を読んで、morning-reportを止めて。
```

```
cli-prompt-cron の skills/SKILL.md を読んで、登録されてるジョブを一覧で見せて。
```

---

### SKILL.md とは

`skills/SKILL.md` は、AI CLI にジョブの管理方法を教えるドキュメントです。
プラグインやインストールは不要で、AI に読ませるだけで機能します。
SKILL.md のファイル位置からプロジェクトルートを自動解決するため、作業ディレクトリがどこでも正しく動きます。

---

## インストール（手動）

```bash
git clone https://github.com/harunamitrader/cli-prompt-cron.git
cd cli-prompt-cron
npm install
```

Node.js 20 以上が必要です。

---

## 起動方法

```bash
npm start
```

起動すると以下が自動で行われます：

1. cron デーモンが起動し、`./data/jobs/` のジョブを読み込む
2. ダッシュボードサーバーが `http://localhost:3300` で起動
3. ブラウザが自動で開く

デーモンのみ起動したい場合：

```bash
npm run daemon
```

ダッシュボードのみ起動したい場合：

```bash
npm run ui
```

### タイムアウト設定

ジョブの実行時間がデフォルト 60 分を超えると自動で強制停止されます。変更する場合は環境変数 `JOB_TIMEOUT_MINUTES` を設定してください。

```bash
# 例: 30分に変更
JOB_TIMEOUT_MINUTES=30 npm start
```

---

## ジョブファイル形式

`./data/jobs/<名前>.json` に以下の形式で作成します。

```json
{
  "logId": "0001",
  "targetCli": "gemini",
  "permissionProfile": "safe",
  "sessionStrategy": "fresh",
  "prompt": "今日のニュースをまとめて",
  "cron": "0 9 * * *",
  "timezone": "Asia/Tokyo",
  "active": true
}
```

サンプルファイル:
- `examples/job.sample.json`

### 実行時のコマンド生成

```bash
# safe
gemini -p 'タスクの内容'
claude --permission-mode default -p 'タスクの内容'
codex exec --sandbox read-only 'タスクの内容'

# edit
gemini --approval-mode=auto_edit -p 'タスクの内容'
claude --permission-mode acceptEdits -p 'タスクの内容'
codex exec --sandbox workspace-write 'タスクの内容'

# plan
gemini --approval-mode=plan -p 'タスクの内容'
claude --permission-mode plan -p 'タスクの内容'
codex exec --sandbox read-only 'タスクの内容'

# full
gemini --approval-mode=yolo -p 'タスクの内容'
claude --permission-mode bypassPermissions -p 'タスクの内容'
codex exec --dangerously-bypass-approvals-and-sandbox 'タスクの内容'
```

JSON には上のコマンド文字列を保存しません。`targetCli` と `permissionProfile` と `sessionStrategy` と `prompt` から、`cli-prompt-cron` が実行時に組み立てます。

| フィールド  | 型      | 必須 | 説明                                                    |
|------------|---------|------|---------------------------------------------------------|
| `logId` | string | ✓ | `0000`〜`9999` の4桁数字。既存ジョブと重複不可 |
| `targetCli` | string | ✓    | `gemini` / `claude` / `codex` |
| `permissionProfile` | string |      | `safe` / `edit` / `plan` / `full`。省略時は `safe` |
| `sessionStrategy` | string |      | `fresh` または `session:<sessionId>`。省略時は `fresh` |
| `prompt`   | string  | ✓    | CLI に送る本文。実際のコマンドは実行時に組み立て |
| `cron`     | string  | ✓    | cron 式（5フィールド形式）                               |
| `timezone` | string  |      | タイムゾーン（例: `"Asia/Tokyo"`）省略時はローカル時刻  |
| `active`   | boolean |      | `false` にするとジョブを一時停止（デフォルト: `true`）   |

`sessionStrategy` は既定で `fresh` です。毎回新規セッションで実行します。`session:<sessionId>` を選ぶと、`cli-prompt-cron` が過去に作成した既存セッションを再利用します。セッション候補は `logId / job名 / 作成時刻 / sessionId末尾` で表示されるため、同じ job の fresh 実行が複数あっても見分けられます。現時点では Codex を優先対応とし、未対応 CLI では安全のため `fresh` にフォールバックします。

---

## ダッシュボード

ブラウザで `http://localhost:3300` を開くと以下が確認できます：

- **実行中モニター** — 実行中のプロセスを経過時間付きでリアルタイム表示。強制停止もワンクリック
- **新規定期実行フォーム** — `＋ 新規定期実行` を押すとフォームが開き、ジョブ名・`logId`・送信先 CLI・権限・セッション・cron・プロンプトを UI 上から入力して、そのままジョブを作成可能
- **ジョブ一覧** — 登録済みジョブの一覧・送信先 CLI・権限プロファイル・次回実行時刻を表示。停止・再開ボタンで有効/無効を切り替え。`logId`・送信先・権限・セッション・cron式・プロンプトはクリックでインライン編集可能。`logId` は 4 桁数字のみで、既存ジョブとの重複は保存できません
- **Default CWD 設定** — ダッシュボード上部から全ジョブ共通の作業ディレクトリを変更可能
- **ライブログ** — 新しいログが上に積まれる形式でリアルタイム表示。表示エリア内で個別スクロール可能
- **実行結果** — 過去の実行履歴と出力内容。表示エリア内で個別スクロール可能
- **結果モーダルから session へ追送** — sessionId を含む結果から、その会話に追加プロンプトを即時送信可能
- **デスクトップ通知** — ジョブ完了時に実行結果の内容をブラウザ通知でポップアップ表示

---

## ログ・結果の確認

### 実行ログ

```
./data/logs/YYYY-MM-DD.log
```

```bash
# 今日のログを表示
cat ./data/logs/$(date +%Y-%m-%d).log

# リアルタイム監視
tail -f ./data/logs/$(date +%Y-%m-%d).log
```

### 実行結果

```
./data/results/
```

各ジョブの実行結果がテキストファイルとして保存されます。

```bash
ls ./data/results/
```

---

## ライセンス

MIT
