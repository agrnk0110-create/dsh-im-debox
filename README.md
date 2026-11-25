# dsh-im-debox

## 安装

从 npm 安装（发布后的用法）：

```bash
dsh plugin install dsh-im-debox        # 或 GUI：插件 → 发现/安装
```

本地开发时，源码位于 `~/.dsh/local-plugins/dsh-im-debox`，可直接把目录当 bundle 链接进 desktop profile：

```bash
plugin_manager install_bundle target:~/.dsh/local-plugins/dsh-im-debox
```

安装后出现在「设置 → 插件」里，标题「DeBox」，可随时禁用/卸载。运行时状态与日志在 `~/.dsh/integrations/dsh-im-debox/`（`state.json`、`plugin.log`）。

> 不要把源码放回会话工作区：工作区被清空时插件也会一起消失，而 profile 里的链接会变成悬空链接。

把 DeBox 私聊/群聊接到 DeepSeek Harness 的 **进程内** IM 渠道插件。它不是独立进程：长轮询、会话驱动、回发都在 DSH Host 进程里完成。

## 工作方式

```
DeBox Bot API (https://open.debox.pro)
   │  getUpdates 长轮询 30s
   ▼
DeBoxClient ──► 白名单/指令 ──► ctx.typertGateway.invoke('session','create'|'prompt')
                                      │  (宿主进程内，带 owner peer)
                                      ▼
                                 Harness Session + 模型调用
                                      │  ctx.on('session/event')
                                      ▼
                              收集 assistant/message 文本 ──► sendMessage 回原会话
```

- 每个聊天（`chat type:id`）独占一个 Harness Session，映射持久化在 `$DSH_HOME/integrations/dsh-im-debox/state.json`。
- 消息串行处理（一条任务跑完才处理下一条），单任务超时 10 分钟。
- 回复按 4000 字符分片，最多 6 片。

## 在设置里配置（推荐）

新会话会加入 `workdir` 对应的 Workspace（侧边栏按工作区分组，而不是「未分组」），侧边栏的会话行前面会显示 DeBox 的标志；私聊标题是 `DeBox`，群聊标题就是群名本身；旧的 DeBox 会话如果被归档过，发 `/new` 即可换到新会话。

安装后打开 DSH 的 **设置 → DeBox**（`settings.section` id 为 `debox`，顺序 22），面板可以直接完成全部配置：

- 状态卡：是否已连接、机器人名字与 user_id、最近一次收到消息的时间、最近错误。
- **Bot App Key**：留空表示不修改；保存后写入凭证库 `DSH_DEBOX_BOT_API_KEY`，不会出现在任何 patch 文件里。
- **测试连接**：用当前密钥调用 `getMe`，返回机器人身份即说明密钥可用。
- **清除密钥**：从凭证库删除该引用；正在运行的通道会沿用旧密钥直到插件重载。
- **工作区目录**（可点「选择目录…」调起系统目录选择面板，也可手填）/ **允许的用户** / **允许任意用户**：写入 profile 的 `cordis.patch.yml`（走 `configEditor`），保存后插件自动重启一次，面板会自行刷新。

面板通过 Connection 的单向 RPC 通信：Host 注册 `POST /api/dsh-im-debox`，Client 用 `ctx.connection.rpc.call('/api', 'dsh-im-debox', { method, payload })`，方法为 `status` / `save` / `test` / `clearKey`。

不改界面也行：下面三层文件配置仍然有效，面板只是它们的可视化入口。

## 配置分三层

| 层 | 位置 | 放什么 |
| --- | --- | --- |
| 包默认值 | `<包>/cordis.patch.yml` | 只有 `apiKeyRef`、空 `workdir`、`allowAll: false`、空白名单，可随包分发 |
| 用户配置 | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 `- id: dsh-im-debox` 行 | `workdir`、`allowAll`、`allowedUsers`，按 id 覆盖包默认值 |
| 密钥 | `$DSH_HOME/.credentials.yaml` 的 `refs.DSH_DEBOX_BOT_API_KEY`（0600） | DeBox Bot 的 App Key，**不写进任何 patch 文件** |

| 键 | 说明 |
| --- | --- |
| `apiKeyRef` | 凭证引用名，默认 `DSH_DEBOX_BOT_API_KEY`；插件经 `ctx.credentials.resolve()` 每次启动读取 |
| `apiKey` | 仅兼容旧配置的明文迁移入口：配置里存在时插件会把值写进凭证库，然后请把它从 patch 删掉 |
| `workdir` | 新建会话的工作目录 |
| `allowAll` | `true` 时忽略白名单 |
| `allowedUsers` | 允许使用的 DeBox `user_id` 列表 |

密钥写在凭证库里，所以配置面板只能看到「已配置/掩码」，看不到明文；`/mybots` 重置 key 后，改 `refs.DSH_DEBOX_BOT_API_KEY` 再禁用→启用插件即可生效（插件在 apply 时解析一次）。

## 指令

| 指令 | 作用 |
| --- | --- |
| 任意文本 | 作为任务执行 |
| `/task <文本>` | 同上，显式前缀 |
| `/id` | 查看自己的 user_id / chat_id |
| `/new` | 丢弃当前会话映射，下条消息开新会话 |
| `/stop` | 请求停止当前任务 |
| `/help` | 帮助 |

未授权用户发消息时，机器人会回复其 `user_id`/`chat_id`，方便加白名单。

## 安装/更新

```bash
dsh plugin install dsh-im-debox                 # 从 npm
dsh plugin install /path/to/dsh-im-debox        # 本地目录
```

装好后在插件页启用 `dsh-im-debox`。改动 `index.js` 后禁用再启用该插件即可热加载，无需重启 DSH。

诊断日志：`$DSH_HOME/integrations/dsh-im-debox/plugin.log`

## 注意事项

- DeBox 的 Webhook 与长轮询互斥，用本插件前必须先清空 Webhook（BotMother）。
- 插件以 `owner` 身份调用宿主，任务实际权限跟随 DSH 的权限策略/审批设置，不额外提权。
- 长轮询服务端约 30 秒返回一次空结果属正常。
- 代码里任何 async 路径都必须自有 catch：宿主把未处理的 Promise rejection 视为致命错误。

## 群名解析

`getUpdates` 里的群消息只带 `chat.id`（即群的 `gid`，例如 `cc0onr82`）和 `chat.type: group`，不带群名。插件收到群消息时会调用 DeBox 的 `GET /openapi/group/info?gid=<gid>` 取 `data.group_name`，缓存到 `state.json` 的 `groups` 字段，并用它给会话命名（`session.rename`）。查询失败（例如 429 限流）时退回 `chat.title` 或 `gid`，不会阻塞任务。`/id` 指令在群里也会额外返回 `group_name`。

## 更新记录

- 1.8.2：设置面板把「连接状态」和「Bot App Key」并到同一张「连接」卡片里——状态行变成卡片首行（去掉独立胶囊外框，保留浅色底 + 分隔线），密钥输入框和「测试连接 / 清除」紧跟其下，一眼能看到"连没连、用的哪个 key"。

- 1.8.1：修复「清空密钥后重新填入仍连不上」——面板每次保存都会带上工作区/白名单，配置没变时 config editor 的写入是空操作、不会重启插件，新密钥因此一直没被读取。现在保存前先比对当前配置，未变化但带了新密钥就直接重启通道；`clearKey` 也会重启一次让通道立即停下；面板保存后依次在 1.2s / 3s / 6s 拉取状态，状态条自动从「未连接」翻到「已连接」。

- 1.8.0：包名改为 `dsh-im-debox` 以便发布到 npm（去掉 `private`，补 keywords/engines/publishConfig），文档补充从 npm 安装的用法。

- 1.7.0：设置面板改为大气轻奢风——52px 品牌徽标 + 22px 标题的 hero、唯一一道黄铜渐变细线、胶囊状状态条、金色竖条分组标题、18px 圆角卡片与行式布局、深墨色主按钮；`:hover`/`:focus` 由注入的 `.dp-*` 样式表实现（绿色描边 + 光晕、行悬停底色、按钮悬浮阴影），面板宽度收敛到 780px。

- 1.6.0：设置面板重排——顶部状态条、分组列表式布局（密钥 / 任务执行）、开关式「允许任意用户」、单一主按钮「保存」+「还原」与未保存提示。

- 1.5.0：设置里的插件名改为「DeBox 机器人」（英文 DeBox Bot）；清掉代码/文档里的个人标识（示例 user_id、机器路径、真实群 gid），用户、工作区、白名单一律走配置，密钥走凭证库。

- 1.4.0：会话行 DeBox 标志改为每 10 秒刷新，窗口重新获得焦点时立即刷新；重新打包安装。
- 1.3.0：群消息通过 `GET /openapi/group/info?gid=` 解析群名，缓存到 `state.json` 的 `groups`，并用于会话标题；`/id` 在群里附加 `group_name`。
- 1.2.1：侧边栏会话行前显示 DeBox 图标；私聊标题 `DeBox`，群聊标题只用群名。
- 1.2.0：会话归入工作区（`workspace.create` → `workspaceId`）、DeBox 名称与官方图标、设置页图标。
- 1.1.x：设置面板、目录选择、空回答重试。
