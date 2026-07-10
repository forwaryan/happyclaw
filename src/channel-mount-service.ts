import type {
  ChannelMount,
  ChannelRoutingMode,
  RegisteredGroup,
  SubAgent,
} from './types.js';
import { getChannelType } from './im-channel.js';

export interface ChannelMountResolutionDeps {
  getAgent: (sessionId: string) => Pick<SubAgent, 'id' | 'chat_jid'> | undefined;
  getRegisteredGroup: (
    jid: string,
  ) => RegisteredGroup | undefined;
  getJidsByFolder?: (folder: string) => string[];
}

export interface ChannelMountUpdateOptions {
  replyPolicy?: 'source_only' | 'mirror';
  activationMode?: ChannelMount['activation_mode'];
  ownerImId?: string | null;
}

export type ChannelMountTargetResolution =
  | {
      status: 'resolved';
      effectiveJid: string;
      workspaceJid: string;
      workspace: RegisteredGroup;
      agentId: string | null;
      workspaceMismatch?: {
        storedWorkspaceJid: string;
        actualWorkspaceJid: string;
      };
    }
  | {
      status: 'stale';
      reason: 'missing_session' | 'missing_workspace';
      sessionId?: string;
      workspaceJid: string;
    };

export function isImChannelJid(jid: string): boolean {
  return jid !== '' && !jid.startsWith('web:') && getChannelType(jid) !== null;
}

export function toRoutingMode(group: Pick<RegisteredGroup, 'binding_mode'>): ChannelRoutingMode {
  return group.binding_mode === 'thread_map' ? 'thread_map' : 'single_session';
}

export function resolveWorkspaceJid(
  workspaceJid: string | undefined,
  deps: Pick<ChannelMountResolutionDeps, 'getRegisteredGroup' | 'getJidsByFolder'>,
): string | null {
  if (!workspaceJid) return null;
  if (deps.getRegisteredGroup(workspaceJid)) return workspaceJid;

  // Legacy compatibility: old records sometimes stored web:{folder} instead
  // of the actual registered web:{uuid} workspace JID.
  if (!workspaceJid.startsWith('web:')) return null;
  const folder = workspaceJid.slice(4);
  const candidates = deps.getJidsByFolder?.(folder) ?? [];
  for (const jid of candidates) {
    if (jid.startsWith('web:') && deps.getRegisteredGroup(jid)) return jid;
  }
  return null;
}

export function normalizeChannelMountFromGroup(
  channelJid: string,
  group: RegisteredGroup,
  deps: ChannelMountResolutionDeps,
  now = new Date().toISOString(),
): Omit<ChannelMount, 'created_at' | 'updated_at'> | null {
  if (!isImChannelJid(channelJid)) return null;

  const channelType = getChannelType(channelJid);
  if (!channelType) return null;

  if (group.target_agent_id) {
    const session = deps.getAgent(group.target_agent_id);
    if (!session?.chat_jid) return null;
    return {
      channel_jid: channelJid,
      channel_type: channelType,
      workspace_jid: session.chat_jid,
      session_id: group.target_agent_id,
      routing_mode: 'single_session',
      reply_policy: group.reply_policy === 'mirror' ? 'mirror' : 'source_only',
      activation_mode: group.activation_mode ?? 'auto',
      owner_im_id: group.owner_im_id ?? null,
    };
  }

  if (group.target_main_jid) {
    const workspaceJid = resolveWorkspaceJid(group.target_main_jid, deps);
    if (!workspaceJid) return null;
    return {
      channel_jid: channelJid,
      channel_type: channelType,
      workspace_jid: workspaceJid,
      session_id: null,
      routing_mode: toRoutingMode(group),
      reply_policy: group.reply_policy === 'mirror' ? 'mirror' : 'source_only',
      activation_mode: group.activation_mode ?? 'auto',
      owner_im_id: group.owner_im_id ?? null,
    };
  }

  void now;
  return null;
}

export function resolveChannelMountTarget(
  mount: Pick<ChannelMount, 'session_id' | 'workspace_jid'>,
  deps: Pick<ChannelMountResolutionDeps, 'getAgent' | 'getRegisteredGroup'>,
): ChannelMountTargetResolution {
  if (mount.session_id) {
    const session = deps.getAgent(mount.session_id);
    if (!session?.chat_jid) {
      return {
        status: 'stale',
        reason: 'missing_session',
        sessionId: mount.session_id,
        workspaceJid: mount.workspace_jid,
      };
    }
    const workspace = deps.getRegisteredGroup(session.chat_jid);
    if (!workspace) {
      return {
        status: 'stale',
        reason: 'missing_workspace',
        sessionId: mount.session_id,
        workspaceJid: session.chat_jid,
      };
    }
    return {
      status: 'resolved',
      effectiveJid: `${session.chat_jid}#agent:${mount.session_id}`,
      workspaceJid: session.chat_jid,
      workspace,
      agentId: mount.session_id,
      ...(mount.workspace_jid !== session.chat_jid
        ? {
            workspaceMismatch: {
              storedWorkspaceJid: mount.workspace_jid,
              actualWorkspaceJid: session.chat_jid,
            },
          }
        : {}),
    };
  }

  const workspace = deps.getRegisteredGroup(mount.workspace_jid);
  if (!workspace) {
    return {
      status: 'stale',
      reason: 'missing_workspace',
      workspaceJid: mount.workspace_jid,
    };
  }
  return {
    status: 'resolved',
    effectiveJid: mount.workspace_jid,
    workspaceJid: mount.workspace_jid,
    workspace,
    agentId: null,
  };
}

export function buildSessionMountUpdate(
  group: RegisteredGroup,
  sessionId: string,
  options: ChannelMountUpdateOptions = {},
): RegisteredGroup {
  return {
    ...group,
    target_agent_id: sessionId,
    target_main_jid: undefined,
    binding_mode: 'single_context',
    reply_policy: options.replyPolicy ?? group.reply_policy ?? 'source_only',
    ...(options.activationMode !== undefined
      ? { activation_mode: options.activationMode }
      : {}),
    ...(options.ownerImId !== undefined
      ? { owner_im_id: options.ownerImId ?? undefined }
      : {}),
  };
}

export function buildWorkspaceMountUpdate(
  group: RegisteredGroup,
  workspaceJid: string,
  routingMode: ChannelRoutingMode,
  options: ChannelMountUpdateOptions = {},
): RegisteredGroup {
  return {
    ...group,
    target_agent_id: undefined,
    target_main_jid: workspaceJid,
    binding_mode: routingMode === 'thread_map' ? 'thread_map' : 'single_context',
    reply_policy: options.replyPolicy ?? group.reply_policy ?? 'source_only',
    ...(options.activationMode !== undefined
      ? { activation_mode: options.activationMode }
      : {}),
    ...(options.ownerImId !== undefined
      ? { owner_im_id: options.ownerImId ?? undefined }
      : {}),
  };
}

export function buildUnmountUpdate(
  group: RegisteredGroup,
  options: { resetActivation?: boolean } = {},
): RegisteredGroup {
  return {
    ...group,
    target_agent_id: undefined,
    target_main_jid: undefined,
    binding_mode: 'single_context',
    ...(options.resetActivation ? { activation_mode: 'auto' as const } : {}),
  };
}
