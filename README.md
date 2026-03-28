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

---

## 対応 CLI

| CLI | 対応状況 | 備考 |
|-----|---------|------|
| **Gemini CLI** | メイン対応 | スケジュール機能なし → 本ツールで補完 |
| **Codex** | メイン対応 | 非インタラクティブ実行には `codex exec` を使用 |
| **Claude Code** | 対応 | 自前のスケジュール機能（CronCreate）あり。本ツールは外部からの定期実行に |

---

## 特徴

- **ブラウザダッシュボード** — ジョブ一覧・ライブログ・実行結果をブラウザで確認。ジョブの停止・再開もワンクリック
- **自然言語でジョブ管理** — `skills/SKILL.md` を AI に読み込ませることで、チャットでジョブを追加・編集・削除
- **ワンコマンド起動** — `npm start` でデーモン + ダッシュボード + ブラウザが一括起動
- **ファイルベース管理** — `./data/jobs/` の JSON ファイルで完結。デーモン再起動不要のホットリロード対応
- **結果の永続保存** — 実行結果を `./data/results/` にテキストで保存

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

```
cli-prompt-cron の skills/SKILL.md を読んで、毎朝9時にGeminiに「GitHubのトレンドをまとめて」と実行するジョブを追加して。
```

```
cli-prompt-cron の skills/SKILL.md を読んで、毎週月曜8時にCodexに「今週の作業計画を立てて」と実行するジョブを作って。
```

```
cli-prompt-cron の skills/SKILL.md を読んで、morning-reportを止めて。
```

```
cli-prompt-cron の skills/SKILL.md を読んで、登録されてるジョブを一覧で見せて。
```

**テスト用（毎分実行）:**

Codex:
```
cli-prompt-cron の skills/SKILL.md を読んで、毎分「AIに関するトリビアを1つtxtに追記してnotepadで開いて」というプロンプトをcodexに送信するジョブを作って。
```

Gemini CLI:
```
cli-prompt-cron の skills/SKILL.md を読んで、毎分「AIに関するトリビアを1つtxtに追記してnotepadで開いて」というプロンプトをgeminiに送信するジョブを作って。
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

---

## ジョブファイル形式

`./data/jobs/<名前>.json` に以下の形式で作成します。

```json
{
  "cron": "0 9 * * *",
  "command": "gemini -p '今日のニュースをまとめて'",
  "timezone": "Asia/Tokyo",
  "active": true
}
```

### CLI 別コマンド例

```bash
# Gemini CLI
"command": "gemini -p 'タスクの内容'"

# Codex（非インタラクティブ実行には exec サブコマンドが必要）
"command": "codex exec 'タスクの内容'"

# Claude Code（--system-prompt で確認要求を抑制）
"command": "claude --system-prompt \"Execute the task immediately. Do not ask for confirmation or clarification.\" -p \"タスクの内容\""

# プロジェクトディレクトリ内で実行
"command": "cd /path/to/project && gemini -p 'このプロジェクトをレビューして'"
```

| フィールド  | 型      | 必須 | 説明                                                    |
|------------|---------|------|---------------------------------------------------------|
| `cron`     | string  | ✓    | cron 式（5フィールド形式）                               |
| `command`  | string  | ✓    | 実行するシェルコマンド                                   |
| `timezone` | string  |      | タイムゾーン（例: `"Asia/Tokyo"`）省略時はローカル時刻  |
| `active`   | boolean |      | `false` にするとジョブを一時停止（デフォルト: `true`）   |

---

## ダッシュボード

ブラウザで `http://localhost:3300` を開くと以下が確認できます：

- **ジョブ一覧** — 登録済みジョブの一覧と次回実行時刻。停止・再開ボタンで有効/無効を切り替え
- **ライブログ** — 実行中のコマンド出力をリアルタイム表示
- **実行結果** — 過去の実行履歴と出力内容

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
