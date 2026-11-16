# Delete archive (`dsh-del-chat`)

## The problem it solves

Archiving a Session in DSH only records the Session id in
`~/.dsh/storages/workspace.json` under `global.archivedSessionIds`: the sidebar
folds it away, and not one byte leaves the disk. The persistence seam has no
deletion API at all — `dsh-session-persistence-jsonl/README.md` says it plainly:

> **Nothing deletes session files** — logs accumulate under `root` until removed
> externally; the seam has no deletion API.

and `dsh-workspace/README.md` describes archiving as *hiding sessions from
grouping without deleting their histories*.

This plugin adds that missing step in the form the Workspace package asks for —
separately named, explicitly confirmed. One item, **删除归档 / Delete archive**,
appears in the sidebar Session context menu (the menu that already carries
*Rename*, *Fork Session*, *Copy Session ID* and *Unarchive*), and it deletes an
archived Session's artifacts for real. It is listed only for a Session that is
already archived: an unarchived one may still have a writer, and an archived one
can no longer be opened, so the header menu could never reach it.

## Mental model

```
Sidebar Session context menu (	arget: 'session')
   └─ Delete archive ──> shell.overlay confirmation dialog
                              (first GET /plugin/dsh-del-chat/status)
                                   └─ confirm ──> POST /plugin/dsh-del-chat/purge
                                        ├─ guard: must be archived
                                        ├─ entity.detachSession(id)     (Workspace record)
                                        ├─ registry.unarchiveSession(id)
                                        ├─ rm -rf <home>/sessions/*/session-<id>/
                                        └─ rm    <home>/storages/session_projcache/sessions/<id>.json
```

- **Archived Sessions only.** Archival is the one signal that the user already
  decided not to look at this conversation, and it gives deletion a harmless
  precondition (archive → inspect → delete). A Session that was never archived
  is refused with `409`.
- **Registry first, files second.** `detachSession` / `unarchiveSession` run
  through the `workspace` domain's own write chain, so persistence and the
  follow feed stay authoritative and the plugin never hand-edits JSON. Deleting
  files first would leave an id pointing at an empty slot.
- **Exactly two places are deleted**: the Session's log slot and its projection
  cache slot. Attachments are content-addressed
  (`attachments/v1/objects/<2hex>/<sha256>`) and shared between Sessions, with
  no session→attachment mapping — they are never touched. Spill files live in a
  per-process directory under the OS temp dir and are swept at startup; they are
  not touched either.
- **The cost ledger is kept.** `~/.dsh/storages/cost-meter/ledger.json` belongs
  to the third-party `dsh-cost-meter` plugin and records usage per day. Deleting
  a Session does not erase what was already spent.

## Guards

| Where | Check |
| --- | --- |
| Menu item | only for an archived Session (`target: 'session'`, decided by one read-only `/status` call when the menu opens); `danger: true` plus a separator |
| Dialog | shows Session id, log size and whether a projection cache exists; confirm is disabled for a Session that is not archived |
| `GET /status` | read-only; returns `archived / exists / bytes / projCache` |
| `POST /purge` | Session-id allow-list regex; the id must be in the archive set |
| `assertSessionDir` | the slot directory name must **equal** the Session id and must sit under the persistence root (`isInside`) |
| Delete timing | `rmSync` runs only after every check passed, so a refusal leaves the disk untouched |
| Failure classes | `EBUSY / EPERM / ENOTEMPTY` → `423` "log is in use, restart DSH and retry" |

## Known costs

- **Irreversible.** There is no trash: once deleted, the Session cannot be
  restored, and `workspace.json` is not backed up by this plugin.
- The sidebar row is dropped by asking the Client to refresh its Session
  catalog (`ctx.sessions.refresh()`); a failed refresh only leaves the row until
  the next page load.
- If the log was already removed outside DSH, `/purge` only finishes the
  registry bookkeeping (`removed: ['registry-only']`) and clears the stale
  archived id.

## Files

- `purge-core.js` — pure filesystem helpers (`isInside / assertSessionDir /
  measureDirectory / removeSessionArtifacts / projCachePath / sessionDirOf`),
  no context dependency, unit-tested.
- `index.js` — Host half: `GET /plugin/dsh-del-chat/status`,
  `POST /plugin/dsh-del-chat/purge`.
- `client.js` — client half: the menu item and the confirmation dialog.
- `test/*.mjs` — `node test/purge-core.test.mjs`, `node test/host-routes.test.mjs`,
  `node test/smoke.mjs`.

---

## 中文

### 它解决什么问题

DSH 的「归档」只是把会话 id 记进 `~/.dsh/storages/workspace.json` 的
`global.archivedSessionIds`：侧栏把它折起来，磁盘上一个字节都没少。持久化层本身
没有删除 API——`dsh-session-persistence-jsonl/README.md` 的原话是「Nothing
deletes session files — logs accumulate under `root` until removed externally;
the seam has no deletion API.」；`dsh-workspace/README.md` 也写着归档只是「hide
sessions from grouping without deleting their histories」。

本插件补上「单独命名、显式确认」的那一步：在侧栏会话右键菜单里加一项
**删除归档**，把已归档会话真正从磁盘上删掉。这一项只对已归档的会话出现——未归档的
会话可能还有写入者，而已归档的会话打不开头部菜单，入口只能放在侧栏。

### 心智模型

```
侧栏会话右键菜单（target: 'session'）
   └─ 删除归档 ──> 确认弹窗（先 GET /plugin/dsh-del-chat/status 拿事实）
                        └─ 确认 ──> POST /plugin/dsh-del-chat/purge
                             ├─ 校验：必须已归档
                             ├─ 从 Workspace 实体 detachSession(id)
                             ├─ registry.unarchiveSession(id)
                             └─ 删 <home>/sessions/*/session-<id>/
                                删 <home>/storages/session_projcache/sessions/<id>.json
```

- **只允许删已归档的会话**：归档是「用户已经决定不再看它」的唯一信号，也让删除有一
  个非破坏性的前置动作。未归档的会话会被 409 拒绝。
- **先走注册表、再删文件**：`detachSession` / `unarchiveSession` 走 `workspace`
  domain 自己的写链，持久化与 follow feed 由内核负责；插件不手改 JSON。
- **只删两处**：会话日志槽与投影缓存槽。附件是内容寻址且跨会话共享去重，没有
  session→attachment 映射，永远不删；spill 溢出文件在系统临时目录、由启动 sweep
  自清，也不碰。
- **不删成本账本**：`~/.dsh/storages/cost-meter/ledger.json` 属于第三方插件
  dsh-cost-meter，记的是「花过的钱」，删会话不该抹掉历史花费。

### 已知代价

- **不可撤销**：没有回收站，删除后无法恢复。
- 删除后插件会调用 `ctx.sessions.refresh()` 让客户端重拉会话目录；刷新失败时那一行会留到下次加载页面。
- 若日志已被外部删掉，`/purge` 只做注册表收尾（`removed: ['registry-only']`），
  用来清掉 `archivedSessionIds` 里的残留 id。
