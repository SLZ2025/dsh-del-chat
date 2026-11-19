# dsh-del-chat

**真删归档对话**。DeepSeek Harness 的「归档」只是把会话从侧栏折起来，日志永远留在磁盘上。
这个插件在**侧栏会话右键菜单**里加一项 **删除归档**，把已归档会话的日志、投影缓存和
工作区记录真正从磁盘上删掉。

<!-- prettier-ignore -->
| 之前 | 之后 |
| ---- | ---- |
| 会话已归档，`~/.dsh/sessions/**` 里仍躺着 2.3 MB 的 `session.v4.jsonl.zstd` | 日志槽与投影缓存都不在了；侧栏行消失；`workspace.json` 里的归档 id 也清掉 |

## 它做了什么

加在侧栏会话行右键菜单里（「重命名」「分叉会话」「复制 Session ID」「取消归档」所在的那个
菜单），红色危险样式、上方带分隔线：

```
┌────────────────────────────┐
│ 重命名           Ctrl+Alt+G │
│ 分叉会话         Ctrl+Alt+F │
│ ────────────────────────── │
│ 复制 Session ID             │
│ 在应用中打开            ›   │
│ 取消归档                    │
│ ────────────────────────── │
│ 🗑 删除归档                  │  ← 本插件
└────────────────────────────┘
```

这一项**只在会话已归档时出现**：没归档的会话菜单里没有它，因为运行中的会话随时可能被写入，
不应该删；已归档的会话又打不开头部菜单，所以入口放在侧栏。

点击后先弹确认框，列出会话 id、日志占用字节、有没有投影缓存，确认后由 Host 侧真正删除。
Host 侧还有一道独立防线：**没归档过的会话会被 409 拒绝**，所以流程永远是
「先归档 → 看事实 → 再删除」。

## 环境要求

* 带 Web 界面（含桌面版）的 DeepSeek Harness，并且 `workspaceRegistry` 与
  `sessionPersistence` 两个服务可用（桌面版 profile 自带）。
* Host 侧 Node 22 以上（路由用的是 `Request`/`Response`）。

## 安装

让 DSH 安装这个 bundle，或在 **插件** 页面安装。它的 patch 只插入一行：

```yaml
- insert:
    - id: dsh-del-chat
      name: dsh-del-chat
```

从 npm 安装：

```bash
dsh plugin add dsh-del-chat
```

也可以直接从本仓库安装并锁定提交：

```bash
dsh plugin add git+https://github.com/SLZ2025/dsh-del-chat.git#<commit>
```

本地 checkout 也一样：`dsh plugin add D:\path\to\dsh-del-chat`。

装完必须**完全退出 DSH 再重新启动**。刷新网页只会加载客户端部分：菜单项会冒出来，
但 Host 端路由并没有注册，点下去会提示 Host 端未加载。

## 使用

1. 先归档要删的会话——侧栏行右键 → **归档**，或在该会话上按 `Ctrl+Shift+A`。
2. 在侧栏那一行（已变灰）上右键，选 **删除归档**。
3. 看一眼弹窗里的数字，点 **永久删除**。

会话目录会立刻消失，Host 同时广播 `api-session/removed`，侧栏那一行不用刷新页面就会跟着消失。

Host 若还把这个会话常驻在内存里，它的目录依然会列出它，而插件拿不到那份 detach 能力；这时插件只保留归档标记、不做 detach，等 `session/disposed` 到来时再补做收尾，这样那一行就不会变成「未分组」里的幽灵行。

## 数据删在哪里

```
$DSH_HOME/sessions/<workspace-key>/session-<id>/session.v4.jsonl.zstd   删除
$DSH_HOME/storages/session_projcache/sessions/session-<id>.json        删除
$DSH_HOME/attachments/v1/objects/<2hex>/<sha256>                       保留（内容寻址，跨会话共享）
$DSH_HOME/storages/cost-meter/ledger.json                              保留（第三方账本）
```

工作区记录与归档标记走注册表自己的写链移除，插件不手改 `workspace.json`。

## 实现说明

见 [`docs/DETAIL.md`](docs/DETAIL.md)：设计取舍、防线表与已知代价。简述：客户端注册一条
针对 `session` 的纯数据菜单贡献（打开菜单时先问一次状态，只有已归档才出现），外加一个
`shell.overlay` 弹窗；Host 侧通过 `ctx.connection.fetch` 在 DSH 的**认证** API 通道上注册
两条 exact 路由——`GET|HEAD /api/dsh-del-chat/status` 与 `POST /api/dsh-del-chat/purge`。
Connection 会在 handler 之前做 `Host`/`Origin` 信任检查与浏览器认证，只有 owner Peer 能
到达 exact 路由：未认证的页面得到 401，非 owner 得到 403，都没有删除能力。随后才确认该 id
已归档、槽目录名确实等于会话 id 且在持久化根内，再 detach、unarchive、删文件。

## 常见问题

* **菜单里没有这一项** —— 它只对已归档的会话出现。先归档（`Ctrl+Shift+A`），刷新页面
  让客户端半加载，再在侧栏右键。
* **提示「只有已归档的会话才能彻底删除」** —— 先归档，这个前置条件是故意的。
* **提示 Host 端插件还没加载** —— 客户端已加载但 Host 半没起来，完全退出 DSH 再启动；
  判据见 `%TEMP%\dsh-del-chat.log` 里的 `[apply]` 行。
* **`log-locked`（423）** —— 日志还被别的进程占着，重启 DSH 再试。
* **侧栏还有那一行** —— 分两种情况。如果它还是灰的、并且仍在原来那一组里，说明 Host 内存里还常驻着这个会话（插件的进程里没法把它摘掉），等 Host 释放它之后插件会补做收尾，那一行就彻底消失。如果它跑到了**「未分组」**，说明日志还在：看弹窗数字和 Host 日志。
* **弹窗正常但没删掉** —— 看 Host 日志里的 `delete-failed` 和返回的 `message`。

## 开发

```bash
node --check index.js
node --check client.js
node test/purge-core.test.mjs
node test/host-routes.test.mjs
node test/smoke.mjs
```

`test/purge-core.test.mjs` 用临时目录树测纯文件操作；`test/host-routes.test.mjs` 用桩
Cordis 上下文、桩注册表和临时 `DSH_HOME` 驱动两个路由；`test/smoke.mjs` 校验 manifest
形状并确认各模块可导入。

CI 在 Ubuntu 与 Windows + Node 22 上跑同样的命令，见
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

## 许可证

MIT
