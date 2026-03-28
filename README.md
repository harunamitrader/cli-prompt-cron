# cli-prompt-cron-ui

AI CLI 向けの cron デーモン + ブラウザダッシュボード。
Claude Code・Gemini CLI・Codex のプロンプトをスケジュール実行し、実行状況をブラウザでリアルタイムに確認できます。

[cli-prompt-cron](https://github.com/example/cli-prompt-cron) をベースに、ブラウザ UI を追加したフォークです。

---

## 概要

`~/.cli-prompt-cron-ui/jobs/` に JSON ファイルを置くだけで AI CLI コマンドを定期実行できます。
実行結果やログはブラウザのダッシュボード（`http://localhost:3300`）でリアルタイムに確認できます。
`node start.js` 一発でデーモン・ダッシュボードサーバー・ブラウザを同時に起動します。

---

## 特徴

- **ブラウザダッシュボード** — ジョブ一覧・ライブログ・実行結果をブラウザで確認
- **自然言語でジョブ管理** — `skills/SKILL.md` を Claude Code に読み込ませることで、チャットでジョブを追加・編集・削除
- **ワンコマンド起動** — `npm start` でデーモン + ダッシュボード + ブラウザが一括起動
- **ファイルベース管理** — `~/.cli-prompt-cron-ui/jobs/` の JSON ファイルで完結。デーモン再起動不要のホットリロード対応
- **マルチ CLI 対応** — Claude Code / Gemini CLI / Codex すべてに対応
- **結果の永続保存** — 実行結果を `~/.cli-prompt-cron-ui/results/` に JSON で保存

---

## インストール

```bash
git clone <repository-url> cli-prompt-cron-ui
cd cli-prompt-cron-ui
npm install
```

Node.js 20 以上が必要です。

---

## 起動方法

```bash
npm start
```

起動すると以下が自動で行われます：

1. cron デーモンが起動し、`~/.cli-prompt-cron-ui/jobs/` のジョブを読み込む
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

`~/.cli-prompt-cron-ui/jobs/<名前>.json` に以下の形式で作成します。

```json
{
  "cron": "0 9 * * *",
  "command": "claude -p '今日のタスクをまとめてください'",
  "timezone": "Asia/Tokyo",
  "active": true
}
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

- **ジョブ一覧** — 登録済みジョブの一覧と次回実行時刻
- **ライブログ** — 実行中のコマンド出力をリアルタイム表示
- **実行結果** — 過去の実行履歴と出力内容

---

## ログ・結果の確認

### 実行ログ

```
~/.cli-prompt-cron-ui/logs/YYYY-MM-DD.log
```

```bash
# 今日のログを表示
cat ~/.cli-prompt-cron-ui/logs/$(date +%Y-%m-%d).log

# リアルタイム監視
tail -f ~/.cli-prompt-cron-ui/logs/$(date +%Y-%m-%d).log
```

### 実行結果

```
~/.cli-prompt-cron-ui/results/
```

各ジョブの実行結果が JSON ファイルとして保存されます。

```bash
ls ~/.cli-prompt-cron-ui/results/
```

---

## cli-prompt-cron との違い

| 機能                         | cli-prompt-cron | cli-prompt-cron-ui |
|-----------------------------|-----------------|-------------|
| cron デーモン               | ✓               | ✓           |
| ファイルベースのジョブ管理  | ✓               | ✓           |
| ホットリロード（Chokidar）  | ✓               | ✓           |
| ブラウザダッシュボード      | -               | ✓           |
| ライブログ表示              | -               | ✓           |
| 実行結果の永続保存          | -               | ✓           |
| ブラウザ自動起動            | -               | ✓           |
| ジョブディレクトリ          | `~/.cli-prompt-cron/jobs/` | `~/.cli-prompt-cron-ui/jobs/` |
| ログディレクトリ            | `~/.cli-prompt-cron/logs/` | `~/.cli-prompt-cron-ui/logs/` |

---

## ライセンス

MIT
