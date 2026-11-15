# dsh-del-chat

**Deleting a conversation in DeepSeek Harness, for real.** Archiving a Session
only hides it from the sidebar — the log stays on disk forever. This plugin adds a
**Delete conversation** item to the Session header "…" menu and removes an
archived Session's log, projection cache and Workspace record from disk.

<!-- prettier-ignore -->
| Before | After |
| ------ | ----- |
| Session archived, still 2.3 MB of `session.v4.jsonl.zstd` under `~/.dsh/sessions/**` | Log slot and projection cache gone; the sidebar row disappears; the archived id is gone from `workspace.json` |

## What it adds

One item in the menu that already carries *Copy conversation as Markdown* and
*Download Session log*, rendered in the danger style below a separator:

```
┌────────────────────────────┐
│ 复制会话为 Markdown          │
│ 下载 Session 日志            │
│ ────────────────────────── │
│ 在应用中打开            ›   │
│ ────────────────────────── │
│ 🗑 删除对话                  │  ← this plugin
│ ────────────────────────── │
│ 反馈                        │
└────────────────────────────┘
```

Clicking it opens a confirmation dialog that reports the Session id, the size of
its log and whether a projection cache exists — then the Host half deletes it. A
Session that was never archived is refused (`409`), so the flow is always
*archive → inspect → delete*.

## Requirements

* DeepSeek Harness with the Web client (Desktop app included), plus the
  `workspaceRegistry` and `sessionPersistence` services — both ship with the
  desktop profile.
* Node 22 or newer on the Host side (the routes use `Request`/`Response`).

## Install

Ask DSH to install the bundle, or use the **Plugins** page. The bundle is a normal
DSH bundle whose patch inserts one row:

```yaml
- insert:
    - id: dsh-del-chat
      name: dsh-del-chat
```

For a local checkout, point the installer at this directory instead of the package
name (e.g. `plugin_manager install_bundle` with the absolute path). The Host half
activates immediately; **refresh the Web page** so the client half loads.

## Usage

1. Archive the conversation you want gone — sidebar row → **归档 / Archive**, or
   the `Ctrl+Shift+A` shortcut on the open Session.
2. Open that Session's header **…** menu and pick **删除对话 / Delete conversation**.
3. Check the numbers in the dialog, then press **永久删除 / Delete permanently**.

The row leaves the sidebar after the next page refresh or DSH restart; the
`session-<id>/` directory is gone immediately.

## Where the bytes live

```
$DSH_HOME/sessions/<workspace-key>/session-<id>/session.v4.jsonl.zstd   deleted
$DSH_HOME/storages/session_projcache/sessions/session-<id>.json        deleted
$DSH_HOME/attachments/v1/objects/<2hex>/<sha256>                       kept (content addressed, shared)
$DSH_HOME/storages/cost-meter/ledger.json                              kept (third-party ledger)
```

The Workspace record and the archive mark are removed through the registry's own
write chain, never by editing `workspace.json`.

## How it works

See [`docs/DETAIL.md`](docs/DETAIL.md) for the reasoning, the guard table and the
known costs. In short: the client half registers a data-only menu contribution for
`sessionHeader` plus one `shell.overlay` dialog; the Host half exposes
`GET /plugin/dsh-del-chat/status` and `POST /plugin/dsh-del-chat/purge`, checks
that the id is archived and that the slot directory really is that Session's slot
under the persistence root, then detaches, unarchives and deletes.

## Troubleshooting

* **The item is missing** — refresh the page; the plugin's client half injects
  `@deepseek-ai/dsh-client-ui-workspace`, and the menu only renders on the
  Session header of an open Session.
* **"Only archived Sessions can be deleted permanently"** — archive it first;
  that prerequisite is deliberate.
* **`log-locked` (`423`)** — the log is still open in another process. Restart DSH
  and retry.
* **The row is still in the sidebar** — the registry index is rebuilt from disk at
  startup; refresh the page or restart.
* **Dialog works but nothing is deleted** — check the Host log for
  `delete-failed` and the reported `message`.

## Development

```bash
node --check index.js
node --check client.js
node test/purge-core.test.mjs
node test/host-routes.test.mjs
node test/smoke.mjs
```

`test/purge-core.test.mjs` exercises the filesystem helpers against temporary
trees; `test/host-routes.test.mjs` drives both routes with a stub Cordis context,
a stub registry and a temp `DSH_HOME`; `test/smoke.mjs` checks the manifest shape
and that every module imports.

CI runs the same commands on Ubuntu and Windows with Node 22 — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

MIT
