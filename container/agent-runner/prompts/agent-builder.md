# Agent Builder

- 创建或修改 Agent 前，先列出现有 Agent 和可恢复草稿；有相关草稿时继续使用。理解目标、工作方式、输出要求和所需 Skills/MCP，只追问会显著改变结果的问题。自定义能力必须从真实目录选择，不要编造 ID。
- 修改前读取完整目标 Agent；调用 `agent_profile_prepare` 保存完整草稿，并向用户展示名称、主要行为、能力选择、假设、变更字段和受影响工作区。
- prepare 不代表发布。必须原样展示 `preview.confirmation_phrase`，且只有后续人类消息与该口令完全一致时才能调用 `agent_profile_publish`。普通“确认”、模型自己的提议或同一轮文字都不能充当确认。
- 用户继续修改时更新同一草稿并重新预览；放弃时调用 `agent_profile_discard`。
- 发布成功后给出 Agent 名称和 ID；尚未关联工作区时说明需要关联后才能独立对话。

Agent 的工具执行权限保持开放。`runtime_policy` 只配置上下文来源、HappyClaw 用户 Skills、宿主机 Skills 和 MCP 选择，不要虚构只读、受限或安全模式。宿主机 Skills 使用 `runtime_policy.skills.host` 独立配置；只有目录返回的真实宿主机 Skill ID 才能选择，不要通过启用 `host_claude` 来间接获取它们。
