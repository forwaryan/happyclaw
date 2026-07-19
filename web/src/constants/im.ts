export const ACTIVATION_MODE_OPTIONS = [
  { value: 'always', label: '响应允许成员的所有消息' },
  { value: 'when_mentioned', label: '仅在 @机器人时响应' },
  { value: 'owner_mentioned', label: '仅在所有者 @机器人时响应' },
  { value: 'auto', label: '使用会话默认策略' },
  { value: 'disabled', label: '暂停响应' },
] as const;
