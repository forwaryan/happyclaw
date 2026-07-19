# HappyClaw Web API 参考

> 本文档从 `CLAUDE.md` §7 拆分而来。修改 / 新增 API 端点时请同步更新。
>
> 顶层 `CLAUDE.md` 只保留路由文件入口索引作为 Agent 快速导航锚点；
> 详细端点清单按需 Read 本文档（每请求约节省 ~1K cache_read tokens）。

## 认证

- `GET /api/auth/status` — 系统初始化状态（`initialized`、是否有用户）
- `POST /api/auth/setup` — 创建首个管理员（仅用户表为空时可用）
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`（含 `setupStatus`）
- `POST /api/auth/register` · `PUT /api/auth/profile` · `PUT /api/auth/change-password`

## 工作区与消息

- `GET /api/groups` · `POST /api/groups`（创建 Web 会话）
- `PATCH /api/groups/:jid`（重命名） · `DELETE /api/groups/:jid`
- `POST /api/groups/:jid/reset-session`（重建工作区）
- `GET /api/groups/:jid/messages`（分页 + 轮询，支持多 JID 查询）
- `POST /api/messages`（向工作区发送消息；首字符 `/clear` 触发会话重置，返回 `{ success: true, cleared: true }`）
- `GET|PUT /api/groups/:jid/env`（群组级容器环境变量）

## Agent Profiles

- `GET|POST /api/agent-profiles`（列出/创建当前用户的自定义 Agent）
- `POST /api/agent-profiles/generate` · `POST /api/agent-profiles/:id/refine-prompt`（生成或优化四段提示词）
- `POST /api/agent-profiles/:id/effective-capabilities`（预览最终 Skills、MCP 与工具策略）
- `PATCH|DELETE /api/agent-profiles/:id` · `GET /api/agent-profiles/:id/workspaces`
- `POST|DELETE /api/agent-profiles/:id/avatar`
- `GET /api/agent-profiles/:id/prompt-versions` · `POST /api/agent-profiles/:id/prompt-versions/:version/restore`

## 工作区治理

- `GET /api/workspaces` · `GET /api/workspaces/:jid`（仅返回当前用户可访问的工作区）
- `GET /api/workspaces/mounts`（消息渠道挂载概览）
- `GET /api/workspaces/:jid/runtime-sessions`（工作区运行态会话）
- `GET /api/workspaces/:jid/channel-mounts`（工作区/会话渠道绑定）

## 渠道账号

- `GET|POST /api/channel-accounts` · `GET|PATCH|DELETE /api/channel-accounts/:id`（owner-only 多 Bot 账号）
- `POST /api/channel-accounts/:id/test` · `POST /api/channel-accounts/:id/toggle`
- `POST /api/channel-accounts/:id/onboarding` · `GET /api/channel-accounts/:id/onboarding/status` · `POST /api/channel-accounts/:id/onboarding/verify`（扫码/协议引导）
- `POST /api/channel-accounts/:id/pairing-code` · `GET /api/channel-accounts/:id/paired-chats` · `DELETE /api/channel-accounts/:id/paired-chats/:jid`
- `POST /api/channel-accounts/:id/disconnect` · `POST /api/channel-accounts/:id/logout`

旧 `/api/config/user-im/:provider` 仍作为默认账号兼容 facade；新功能应使用 `/api/channel-accounts`。

## 文件

- `GET /api/groups/:jid/files` · `POST /api/groups/:jid/files`（上传，50MB 限制）
- `GET /api/groups/:jid/files/download/:path` · `DELETE /api/groups/:jid/files/:path`
- `POST /api/groups/:jid/directories`

## 记忆

- `GET /api/memory/sources` · `GET /api/memory/search`（全文检索）
- `GET|PUT /api/memory/file`

## 配置

- `GET|PUT /api/config/claude` · `PUT /api/config/claude/secrets`
- `GET|PUT /api/config/claude/custom-env`
- `POST /api/config/claude/test`（连通性测试） · `POST /api/config/claude/apply`（应用到所有容器）
- `GET|PUT /api/config/feishu`（**deprecated**，使用 `/api/config/user-im/feishu` 代替）
- `GET|PUT /api/config/telegram` · `POST /api/config/telegram/test`（**deprecated**，使用 `/api/config/user-im/telegram` 代替）
- `GET|PUT /api/config/appearance` · `GET /api/config/appearance/public`（外观配置，public 端点无需认证）
- `GET|PUT /api/config/system` — 系统运行参数（容器超时、并发限制、`autoCompactWindow` 等），需要 `manage_system_config` 权限
- `GET /api/config/user-im/status`（所有渠道连接状态，含 QQ）
- `GET|PUT /api/config/user-im/feishu`（用户级飞书 IM 配置，GET 返回 `connected` 字段）
- `GET|PUT /api/config/user-im/telegram`（用户级 Telegram IM 配置，GET 返回 `connected`、`effectiveProxyUrl`、`proxySource`，PUT 支持 `proxyUrl`/`clearProxyUrl`）
- `POST /api/config/user-im/telegram/test`（Telegram Bot Token 连通性测试，使用 per-user proxyUrl）
- `GET|PUT /api/config/user-im/qq`（用户级 QQ IM 配置，GET 返回 `connected` 字段）
- `POST /api/config/user-im/qq/test`（QQ 凭据连通性测试）
- `POST /api/config/user-im/qq/pairing-code`（生成 QQ 配对码）
- `GET /api/config/user-im/qq/paired-chats`（已配对的 QQ 聊天列表）
- `DELETE /api/config/user-im/qq/paired-chats/:jid`（移除 QQ 配对）
- `GET|PUT /api/config/user-im/dingtalk`（用户级钉钉 IM 配置，GET 返回 `connected` 字段）

## 任务

- `GET /api/tasks` · `POST /api/tasks`（列出/创建任务；间隔任务最短 60 秒）
- `PATCH /api/tasks/:id` · `DELETE /api/tasks/:id`（更新/软删除；写操作使用 `expected_revision` 防止覆盖并发修改）
- `POST /api/tasks/:id/restore`（恢复软删除任务；恢复后保持暂停，一次性任务重新启用时会校验执行时间）
- `POST /api/tasks/:id/runs`（立即运行；请求体传 `idempotency_key`，返回稳定 `runId`）
- `GET /api/tasks/:id/runs` · `GET /api/tasks/runs/:runId`（查询合并后的历史或单次持久化运行详情）
- `POST /api/tasks/runs/:runId/cancel`（只停止当前运行，不影响周期任务的后续计划）
- `POST /api/tasks/:id/run`（兼容旧客户端的立即运行入口；支持 `Idempotency-Key` 请求头或请求体 `idempotency_key`）
- `GET /api/tasks/:id/logs`（旧版运行日志兼容入口）
- `POST /api/tasks/ai` · `POST /api/tasks/parse`（AI 创建任务/解析自然语言任务草稿）

任务运行状态与通知状态分别记录：通知失败只重试通知，不会重新执行 Agent 或脚本。脚本任务只允许管理员在有权限的宿主机工作区创建和运行，容器工作区不会降级到宿主机执行。

## 管理

- `GET /api/admin/users` · `POST /api/admin/users` · `PATCH /api/admin/users/:id`
- `DELETE /api/admin/users/:id` · `POST /api/admin/users/:id/restore`
- `POST /api/admin/invites` · `GET /api/admin/invites` · `DELETE /api/admin/invites/:code`
- `GET /api/admin/audit-log`
- `GET|PUT /api/admin/settings/registration`

## 工作区运行态会话（兼容路由）

- `GET /api/groups/:jid/agents` · `POST /api/groups/:jid/agents`（历史路径名，实际创建/列出工作区会话）
- `PATCH|DELETE /api/groups/:jid/agents/:agentId`

## 目录浏览

- `GET /api/browse/directories`（列出可选目录，受挂载白名单约束）
- `POST /api/browse/directories`（创建自定义工作目录）

## MCP Servers

- `GET /api/mcp-servers` · `POST /api/mcp-servers`（`scope=user|system`；system 仅 admin 可写）
- `PATCH /api/mcp-servers/:id` · `DELETE /api/mcp-servers/:id`
- `POST /api/mcp-servers/sync-host`（admin 从宿主机导入个人副本）

系统 MCP 默认 `memberAccess=admin_only`；只有管理员显式设为 `shared` 才会进入普通成员 Agent runtime。API 永不回传 secret values。

## Claude Code Plugins

数据模型：admin 共享导入的 catalog（immutable，按内容 hash 寻址） + per-user enable refs + per-user versioned runtime snapshot。详见 `docs/claude-code-plugin-automation-design.md` 与 `CLAUDE.md` §10。

| Method   | Path                                    | Auth                           | 用途                                                                                                                                                                                           |
| -------- | --------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/plugins`                          | 登录                           | 返回 catalog 全集 + 当前用户 enabled 状态投影（一次取齐前端列表所需数据）                                                                                                                      |
| `GET`    | `/api/plugins/catalog`                  | 登录                           | catalog 索引（`marketplaces[].plugins[].versions[]` 元数据）                                                                                                                                   |
| `GET`    | `/api/plugins/catalog/marketplaces/:mp` | 登录                           | 单个 marketplace 详情                                                                                                                                                                          |
| `POST`   | `/api/plugins/catalog/scan`             | admin (`manage_system_config`) | 触发宿主机 `~/.claude/plugins/marketplaces/` 扫描并入 catalog；返回 `ImportReport`（`marketplaces` / `plugins` / `created` / `skipped`）。主进程启动 5s 后 + 每小时自动调用同一逻辑            |
| `PATCH`  | `/api/plugins/enabled/:fullId`          | 登录                           | body `{ enabled: boolean }`，read-modify-write `users/{userId}/plugins.json`；启用时自动 `materializeUserRuntime` 写入 `runtime/{userId}/snapshots/{snapshotId}/`；UI 必须提示"下次新会话生效" |
| `POST`   | `/api/plugins/materialize`              | 登录                           | 手动重建当前用户的 runtime snapshot（用于 catalog 更新后强制刷新）                                                                                                                             |
| `DELETE` | `/api/plugins/marketplaces/:name`       | 登录                           | **NOT a catalog deletion** — 仅清理调用者自己的 `enabled.*@{name}` 引用，共享只读 catalog 不动（admin 共享导入、按内容 hash 寻址）                                                             |

**已废弃**（PR1 删除，新代码不要引用）：~~`POST /api/plugins/sync-host`~~、~~`GET /api/plugins/available-on-host`~~。

## 用量统计

- `GET /api/usage/stats?days=7&userId=&model=`（从 `usage_daily_summary` 查询，支持用户/模型筛选）
- `GET /api/usage/models`（去重模型列表）
- `GET /api/usage/filters`（当前权限范围内可选 Agent/工作区/来源）
- `GET /api/usage/records`（分页明细）
- `GET /api/usage/export.csv`（按当前筛选导出）
- `GET /api/usage/users`（有用量数据的用户列表，admin 可见全部）

## 监控

- `GET /api/status` · `GET /api/health`（无需认证）

## WebSocket

- `/ws`（详见 `CLAUDE.md` §3.6 WebSocket 协议）
