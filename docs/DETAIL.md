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
Sidebar Session context menu (target: 'session')
   └─ Delete archive ──> shell.overlay confirmation dialog
                              (first GET|HEAD /api/dsh-del-chat/status)
                                   └─ confirm ──> POST /api/dsh-del-chat/purge
                                        ├─ guard: must be archived
                                        ├─ rm -rf <home>/sessions/*/session-<id>/
                                        ├─ rm    <home>/storages/session_projcache/sessions/<id>.json
                                        ├─ Host: ctx.emit('api-session/removed', id)
                                        ├─ if the Host already released the Session:
                                        │     entity.detachSession(id)     (Workspace record)
                                        │     registry.unarchiveSession(id)
                                        │     Client: ctx.sessions.refresh()
                                        └─ if the Host still holds it: keep both marks, settle on session/disposed
```

- **Archived Sessions only.** Archival is the one signal that the user already
  decided not to look at this conversation, and it gives deletion a harmless
  precondition (archive → inspect → delete). A Session that was never archived
  is refused with `409`.
- **Files first, registry second.** The unlink is the irreversible step, so it
  runs while every precondition still holds: a failed unlink leaves the Session
  archived and inside its workspace group, with the menu item still available to
  retry. `detachSession` / `unarchiveSession` then run through the `workspace`
  domain's own write chain, so persistence and the follow feed stay
  authoritative and the plugin never hand-edits JSON.
- **Clients are told the Session is gone.** The Host emits the built-in
  `api-session/removed` event; `dsh-api-remotes` forwards it and
  `dsh-api-session-controller` applies it as a list removal, so the sidebar row
  disappears at once — no page reload, no GUI restart.
- **A Session the Host still holds is settled later.** The Host catalog lists a
  Session from the in-memory `SessionStore` before it looks at the log, and a
  resident Session cannot be dropped by a plugin: the store hands its detach
  capability to whoever entered it. Settling such a Session up front would move its
  row into the Ungrouped section while the catalog kept listing it, so the delete
  keeps both marks and the row invisible instead, and a single `session/disposed`
  listener finishes the bookkeeping the moment the Host lets go. A sweep at `apply`
  does the same for marks left behind by an older version.
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
| Admission | both routes live on DSH's authenticated API channel (`ctx.connection.fetch`): `Host`/`Origin` trust and browser authentication are checked before the handler runs, an unauthenticated page gets `401` and a non-owner Peer `403` |
| `GET|HEAD /status` | read-only; returns `archived / exists / bytes / projCache` |
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
- `index.js` — Host half: `GET|HEAD /api/dsh-del-chat/status`,
  `POST /api/dsh-del-chat/purge`. Both are registered through `ctx.connection.fetch`, so Connection applies its trust and authentication policy and only an owner Peer reaches them.
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
   └─ 删除归档 ──> 确认弹窗（先 GET|HEAD /api/dsh-del-chat/status 拿事实）
                        └─ 确认 ──> POST /api/dsh-del-chat/purge
                             ├─ 校验：必须已归档
                             ├─ rm -rf <home>/sessions/*/session-<id>/
                             ├─ rm    <home>/storages/session_projcache/sessions/<id>.json
                             ├─ 从 Workspace 实体 detachSession(id)
                             ├─ registry.unarchiveSession(id)
                             ├─ Host 广播 api-session/removed
                             └─ 客户端：ctx.sessions.refresh()
                             └─ 删 <home>/sessions/*/session-<id>/
                                删 <home>/storages/session_projcache/sessions/<id>.json
```

- **只允许删已归档的会话**：归档是「用户已经决定不再看它」的唯一信号，也让删除有一
  个非破坏性的前置动作。未归档的会话会被 409 拒绝。
- **先删文件、再走注册表**：删文件是不可逆的一步，所以放在所有前置条件都还成立的时候做。
- **被 Host 常驻的会话延后结算**：Host 的会话目录先看内存里的 `SessionStore`，而常驻会话的
  detach 能力属于当初 enter 它的那一方，插件拿不到。此时若照常 detach 并取消归档，侧栏就会把
  这一行挪到「未分组」，而目录仍然列着它。所以遇到常驻会话时保留归档标记、只广播移除，等
  `session/disposed` 事件到来再补做 detach 与取消归档；`apply` 时的清扫负责收拾旧版本留下的标记。
  删失败时会话仍处于归档态、仍留在原工作区，菜单项还在，用户可以重试。之后
  `detachSession` / `unarchiveSession` 走 `workspace`
  domain 自己的写链，持久化与 follow feed 由内核负责；插件不手改 JSON。
- **只接受认证的调用**：两条路由都注册在 DSH 的认证 API 通道上（`ctx.connection.fetch`，路径
  `/api/dsh-del-chat/…`）。Connection 在 handler 之前校验 `Host`/`Origin` 信任与浏览器认证，
  只有 owner Peer 能到达 exact 路由：未认证页面得到 401、非 owner Peer 得到 403。插件不再
  暴露匿名端点，所以任何一个网页都无法直接请求删除。
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
