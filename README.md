# dsh-del-chat

**Deleting an archived conversation in DeepSeek Harness, for real.** Archiving a
Session only hides it from the sidebar — the log stays on disk forever. This plugin
adds a **Delete archive** item to the sidebar Session context menu and removes an
archived Session's log, projection cache and Workspace record from disk.

<!-- prettier-ignore -->
| Before | After |
| ------ | ----- |
| Session archived, still 2.3 MB of `session.v4.jsonl.zstd` under `~/.dsh/sessions/**` | Log slot and projection cache gone; the sidebar row disappears; the archived id is gone from `workspace.json` |

## What it adds

One item in the sidebar Session context menu — the menu that carries *Rename*,
*Fork Session*, *Copy Session ID* and *Unarchive* — rendered in the danger style
below a separator:

```
┌────────────────────────────┐
│ 重命名           Ctrl+Alt+G │
│ 分叉会话         Ctrl+Alt+F │
│ ────────────────────────── │
│ 复制 Session ID             │
│ 在应用中打开            ›   │
│ 取消归档                    │
│ ────────────────────────── │
│ 🗑 删除归档                  │  ← this plugin
└────────────────────────────┘
```

The item only shows up for a Session that is already archived: an unarchived one
may still be written to and must not be purged, while an archived one can no
longer be opened, so the header "…" menu can never reach it.

Clicking it opens a confirmation dialog that reports the Session id, the size of
its log and whether a projection cache exists — then the Host half deletes it. The
Host keeps an independent guard: a Session that was never archived is refused
(`409`), so the flow is always *archive → inspect → delete*.

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

Install straight from this repository — the bundle is not on npm:

```bash
dsh plugin add git+https://github.com/SLZ2025/dsh-del-chat.git
```

Add `#<commit>` to pin a revision. A local checkout installs the same way:
`dsh plugin add D:\path\to\dsh-del-chat`.

Either way, **quit DSH completely and start it again** afterwards. A page refresh
loads only the client half: the menu item shows up, but the Host routes stay
unregistered and the dialog says the Host half is not loaded.

## Usage

1. Archive the conversation you want gone — right-click the sidebar row → **归档 /
   Archive**, or the `Ctrl+Shift+A` shortcut on the open Session.
2. Right-click that (now greyed out) sidebar row and pick **删除归档 / Delete archive**.
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
`session` (it asks the status route once when the menu opens, and only offers the
item for an archived Session) plus one `shell.overlay` dialog; the Host half
exposes `GET /plugin/dsh-del-chat/status` and `POST /plugin/dsh-del-chat/purge`,
checks that the id is archived and that the slot directory really is that Session's
slot under the persistence root, then detaches, unarchives and deletes.

## Troubleshooting

* **The item is missing** — it only appears for archived Sessions. Archive first
  (`Ctrl+Shift+A`), refresh the page so the client half is loaded, then
  right-click the sidebar row.
* **"The Host half of this plugin is not loaded"** — the plugin is installed but
  the running DSH process predates it. Quit the app completely and start it
  again; `%TEMP%\dsh-del-chat.log` should then contain `[apply]`.
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
