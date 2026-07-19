import { Hono } from 'hono';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Variables } from '../web-context.js';
import { getWebDeps } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup, canModifyGroup } from '../web-context.js';
import {
  getRegisteredGroup,
  getAllRegisteredGroups,
  listAgentsByJid,
  getAgent,
  deleteAgent,
  updateAgentStatus,
  createAgent,
  ensureChatExists,
  deleteMessagesForChatJid,
  deleteSession,
  getGroupsByTargetAgent,
  setRegisteredGroup,
  getJidsByFolder,
  updateAgentLastImJid,
  updateAgentInfo,
  updateAgentContextInfo,
  updateChatName,
  getMessagesPageMulti,
  listImContextBindingsByAgent,
  listChannelMountsBySession,
  getChannelAccount,
} from '../db.js';
import { DATA_DIR } from '../config.js';
import type { AuthUser, RegisteredGroup, SubAgent } from '../types.js';
import { logger } from '../logger.js';
import { getChannelType, extractChatId } from '../im-channel.js';
import { ensureAgentDirectories } from '../utils.js';
import {
  buildSessionMountUpdate,
  buildDetachedWorkspaceUpdate,
  buildWorkspaceMountUpdate,
  commitChannelMountUpdate,
  hasRemainingThreadMapMount,
  hasSessionMountConflict,
  hasWorkspaceMountConflict,
  isNativeContextContainer,
  matchesWorkspaceMount,
  restoreDefaultChannelMount,
  resolveWorkspaceJid,
  type NativeContextMetadata,
} from '../channel-mount-service.js';
import { parseChannelAddress } from '../channel-address.js';

const router = new Hono<{ Variables: Variables }>();

type ChannelChatInfo = NativeContextMetadata & {
  avatar?: string;
  name?: string;
  user_count?: string;
};

// Only fetches live chat metadata — does NOT compute threadCapable. That
// decision must be (re-)computed by the caller against a freshly re-read
// imGroup taken AFTER this await, never against the pre-await snapshot:
// getChannelChatInfo/getFeishuChatInfo is a real network call that yields
// the event loop, during which the message router can upgrade
// native_context_type from 'none' to 'thread' for this exact imJid. Using a
// stale imGroup here would compute threadCapable from outdated persisted
// state and could bind a now-native-thread-capable container as a fixed
// single_session, breaking that thread's session isolation from its
// siblings. See callers for the fresh-read + recompute pattern.
async function fetchLiveChatInfo(
  userId: string,
  imJid: string,
): Promise<{ chatInfo?: ChannelChatInfo | null }> {
  const channelType = getChannelType(imJid);
  if (!channelType) return {};
  const deps = getWebDeps();
  const chatInfo = deps?.getChannelChatInfo
    ? ((await deps.getChannelChatInfo(imJid)) as ChannelChatInfo | null)
    : channelType === 'feishu' && deps?.getFeishuChatInfo
      ? await deps.getFeishuChatInfo(userId, extractChatId(imJid))
      : null;
  return { chatInfo };
}

/** Update workspace RegisteredGroup in DB + in-memory cache. */
function updateWorkspaceGroup(jid: string, workspace: RegisteredGroup): void {
  setRegisteredGroup(jid, workspace);
  const deps = getWebDeps();
  if (deps) {
    const groups = deps.getRegisteredGroups();
    groups[jid] = workspace;
  }
}

function hasConsistentChannelAccount(
  userId: string,
  imJid: string,
  group: RegisteredGroup,
): boolean {
  const encodedAccountId = parseChannelAddress(imJid)?.channelAccountId ?? null;
  const storedAccountId = group.channel_account_id ?? null;
  if (encodedAccountId !== storedAccountId) {
    // Legacy/default account chats intentionally retain their historical
    // unscoped JID while the normalized account id is stored on the row.
    if (!encodedAccountId && storedAccountId) {
      const account = getChannelAccount(storedAccountId);
      return (
        account?.is_legacy_default === true && account.owner_user_id === userId
      );
    }
    return false;
  }
  if (!storedAccountId) return true;
  return getChannelAccount(storedAccountId)?.owner_user_id === userId;
}

function markNativeContextWorkspace(jid: string, group: RegisteredGroup): void {
  updateWorkspaceGroup(jid, {
    ...group,
    conversation_source: 'native_thread',
    conversation_nav_mode: 'vertical_threads',
  });
}

/**
 * Keep native-thread navigation while any Feishu topic group or Telegram
 * forum still maps into the workspace. The source update must be committed
 * before calling this helper.
 */
function detachPreviousThreadMapIfLast(
  imJid: string,
  previous: RegisteredGroup,
  nextWorkspaceJid?: string,
  nextRoutingMode?: 'single_session' | 'thread_map',
): void {
  if (previous.binding_mode !== 'thread_map' || !previous.target_main_jid) {
    return;
  }
  const previousWorkspaceJid = resolveWorkspaceJid(previous.target_main_jid, {
    getRegisteredGroup,
    getJidsByFolder,
  });
  if (!previousWorkspaceJid) return;

  const nextResolvedWorkspaceJid =
    nextRoutingMode === 'thread_map'
      ? resolveWorkspaceJid(nextWorkspaceJid, {
          getRegisteredGroup,
          getJidsByFolder,
        })
      : null;
  if (nextResolvedWorkspaceJid === previousWorkspaceJid) return;
  if (hasRemainingThreadMapMount(previousWorkspaceJid, imJid)) return;

  const workspace = getRegisteredGroup(previousWorkspaceJid);
  if (workspace) {
    updateWorkspaceGroup(
      previousWorkspaceJid,
      buildDetachedWorkspaceUpdate(workspace),
    );
  }
}

function isNativeManagedSession(
  session: Pick<SubAgent, 'source_kind' | 'title_source'>,
): boolean {
  return (
    session.source_kind === 'native_thread' ||
    session.source_kind === 'feishu_thread' ||
    session.title_source === 'native_root' ||
    session.title_source === 'feishu_root'
  );
}

async function restoreBindingDefault(
  user: Pick<AuthUser, 'id' | 'role'>,
  imJid: string,
  imGroup: RegisteredGroup,
): Promise<
  | {
      status: 'resolved';
      workspaceJid: string;
      routingMode: 'single_session' | 'thread_map';
    }
  | {
      status: 'unavailable';
      reason: string;
    }
> {
  const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
  // Re-read + re-authorize after the await — fetchLiveChatInfo
  // yields the event loop on a live network call, during which ownership
  // may have changed. restoreDefaultChannelMount commits whatever `group`
  // it's given, so a stale pre-await snapshot could silently clobber a
  // concurrent write or cross the caller's original authorization boundary.
  const freshImGroup = getRegisteredGroup(imJid);
  if (!freshImGroup) {
    return { status: 'unavailable', reason: 'im_group_not_found' };
  }
  if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
    return { status: 'unavailable', reason: 'account_mismatch' };
  }
  const restored = restoreDefaultChannelMount(
    imJid,
    freshImGroup,
    user.id,
    chatInfo ?? {},
  );
  if (restored.status !== 'resolved') return restored;

  detachPreviousThreadMapIfLast(
    imJid,
    freshImGroup,
    restored.workspaceJid,
    restored.routingMode,
  );
  if (restored.routingMode === 'thread_map') {
    const workspace = getRegisteredGroup(restored.workspaceJid);
    if (workspace) markNativeContextWorkspace(restored.workspaceJid, workspace);
  }
  return {
    status: 'resolved',
    workspaceJid: restored.workspaceJid,
    routingMode: restored.routingMode,
  };
}

function restoreDefaultError(restored: { reason: string }): string {
  if (restored.reason === 'account_mismatch') {
    return 'Channel account does not match this chat or owner';
  }
  return 'Channel account has no default or owner home workspace';
}

// GET /api/groups/:jid/agents — list all agents for a group
router.get('/:jid/agents', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agents = listAgentsByJid(jid);
  const virtualChatJids = agents
    .filter((a) => a.kind === 'conversation')
    .map((a) => `${jid}#agent:${a.id}`);
  const latestMessages = getMessagesPageMulti(
    virtualChatJids,
    undefined,
    Math.max(virtualChatJids.length * 2, 50),
  );
  const latestByChatJid = new Map<
    string,
    { content: string; timestamp: string }
  >();
  for (const msg of latestMessages) {
    if (!latestByChatJid.has(msg.chat_jid)) {
      latestByChatJid.set(msg.chat_jid, {
        content: msg.content,
        timestamp: msg.timestamp,
      });
    }
  }
  return c.json({
    agents: agents.map((a) => {
      const base = {
        id: a.id,
        name: a.name,
        prompt: a.prompt,
        status: a.status,
        kind: a.kind,
        created_at: a.created_at,
        completed_at: a.completed_at,
        result_summary: a.result_summary,
        source_kind: a.source_kind ?? null,
        thread_id: a.thread_id ?? null,
        root_message_id: a.root_message_id ?? null,
        title_source: a.title_source ?? null,
        last_active_at: a.last_active_at ?? null,
      };
      if (a.kind === 'conversation') {
        const linked = getGroupsByTargetAgent(a.id);
        const latest = latestByChatJid.get(`${jid}#agent:${a.id}`);
        return {
          ...base,
          latest_message: latest
            ? {
                content: latest.content,
                timestamp: latest.timestamp,
              }
            : null,
          linked_im_groups: linked.map((l) => ({
            jid: l.jid,
            name: l.group.name,
          })),
        };
      }
      return base;
    }),
  });
});

// GET /api/groups/:jid/sessions — formal workspace session list
router.get('/:jid/sessions', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agents = listAgentsByJid(jid).filter((a) => a.kind === 'conversation');
  const virtualChatJids = agents.map((a) => `${jid}#agent:${a.id}`);
  const latestMessages = getMessagesPageMulti(
    virtualChatJids,
    undefined,
    Math.max(virtualChatJids.length * 2, 50),
  );
  const latestByChatJid = new Map<
    string,
    { content: string; timestamp: string }
  >();
  for (const msg of latestMessages) {
    if (!latestByChatJid.has(msg.chat_jid)) {
      latestByChatJid.set(msg.chat_jid, {
        content: msg.content,
        timestamp: msg.timestamp,
      });
    }
  }

  return c.json({
    sessions: [
      {
        id: 'main',
        name: '主会话',
        prompt: '',
        status: 'idle',
        kind: 'main',
        chat_jid: jid,
        is_main: true,
        created_at: group.added_at,
        source_kind: null,
        thread_id: null,
        root_message_id: null,
        title_source: null,
        last_active_at: null,
        latest_message: null,
      },
      ...agents.map((a) => {
        const latest = latestByChatJid.get(`${jid}#agent:${a.id}`);
        return {
          id: a.id,
          name: a.name,
          prompt: a.prompt,
          status: a.status,
          kind: 'conversation',
          chat_jid: jid,
          is_main: false,
          created_at: a.created_at,
          completed_at: a.completed_at,
          result_summary: a.result_summary,
          source_kind: a.source_kind ?? null,
          thread_id: a.thread_id ?? null,
          root_message_id: a.root_message_id ?? null,
          title_source: a.title_source ?? null,
          last_active_at: a.last_active_at ?? null,
          latest_message: latest
            ? {
                content: latest.content,
                timestamp: latest.timestamp,
              }
            : null,
          linked_im_groups: listChannelMountsBySession(a.id).map((mount) => {
            const imGroup = getRegisteredGroup(mount.channel_jid);
            return {
              jid: mount.channel_jid,
              name: imGroup?.name ?? mount.channel_jid,
            };
          }),
        };
      }),
    ],
  });
});

// POST /api/groups/:jid/agents — create a user conversation
router.post('/:jid/agents', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Conversation CRUD mutates the owner's workspace → owner-only, mirroring
  // workspace-config (skills/mcp). Shared members get 403; non-members were
  // already 404'd above so the group's existence stays hidden from them.
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage conversations' },
      403,
    );
  }
  if (
    group.conversation_source === 'feishu_thread' ||
    group.conversation_source === 'native_thread'
  ) {
    return c.json(
      { error: 'Native thread workspaces do not support manual conversations' },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  let name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > 40) {
    return c.json({ error: 'Name too long (max 40 chars)' }, 400);
  }
  const isAutoTitle = !name;
  if (!name) name = '新对话';
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';

  const agentId = crypto.randomUUID();
  const now = new Date().toISOString();

  const agent: SubAgent = {
    id: agentId,
    group_folder: group.folder,
    chat_jid: jid,
    name,
    prompt: description,
    status: 'idle',
    kind: 'conversation',
    created_by: user.id,
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    title_source: isAutoTitle ? 'auto_pending' : 'manual',
  };

  createAgent(agent);

  // Create IPC + session directories
  ensureAgentDirectories(group.folder, agentId);

  // Create virtual chat record for this agent's messages
  const virtualChatJid = `${jid}#agent:${agentId}`;
  ensureChatExists(virtualChatJid);

  // Broadcast agent_status (idle) via WebSocket
  // Import dynamically to avoid circular deps
  const { broadcastAgentStatus } = await import('../web.js');
  broadcastAgentStatus(jid, agentId, 'idle', name, description);

  logger.info(
    { agentId, jid, name, userId: user.id },
    'User conversation created',
  );

  return c.json({
    agent: {
      id: agent.id,
      name: agent.name,
      prompt: agent.prompt,
      status: agent.status,
      kind: agent.kind,
      created_at: agent.created_at,
      source_kind: agent.source_kind ?? null,
      thread_id: agent.thread_id ?? null,
      root_message_id: agent.root_message_id ?? null,
      title_source: agent.title_source ?? null,
      last_active_at: agent.last_active_at ?? null,
    },
  });
});

// POST /api/groups/:jid/sessions — create a workspace conversation session
router.post('/:jid/sessions', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage sessions' },
      403,
    );
  }
  if (
    group.conversation_source === 'feishu_thread' ||
    group.conversation_source === 'native_thread'
  ) {
    return c.json(
      { error: 'Native thread workspaces do not support manual sessions' },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  let name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > 40) {
    return c.json({ error: 'Name too long (max 40 chars)' }, 400);
  }
  const isAutoTitle = !name;
  if (!name) name = '新对话';
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const session: SubAgent = {
    id: sessionId,
    group_folder: group.folder,
    chat_jid: jid,
    name,
    prompt: description,
    status: 'idle',
    kind: 'conversation',
    created_by: user.id,
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    title_source: isAutoTitle ? 'auto_pending' : 'manual',
  };

  createAgent(session);
  ensureAgentDirectories(group.folder, sessionId);
  ensureChatExists(`${jid}#agent:${sessionId}`);

  const { broadcastAgentStatus } = await import('../web.js');
  broadcastAgentStatus(jid, sessionId, 'idle', name, description);

  logger.info(
    { sessionId, jid, name, userId: user.id },
    'Workspace session created',
  );

  const payload = {
    id: session.id,
    name: session.name,
    prompt: session.prompt,
    status: session.status,
    kind: session.kind,
    created_at: session.created_at,
    source_kind: session.source_kind ?? null,
    thread_id: session.thread_id ?? null,
    root_message_id: session.root_message_id ?? null,
    title_source: session.title_source ?? null,
    last_active_at: session.last_active_at ?? null,
    is_main: false,
  };
  return c.json({ session: payload, agent: payload });
});

// PATCH /api/groups/:jid/agents/:agentId — rename a conversation agent
router.patch('/:jid/agents/:agentId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Rename mutates the owner's workspace → owner-only (see POST for rationale).
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage conversations' },
      403,
    );
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== jid) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  if (isNativeManagedSession(agent)) {
    return c.json(
      { error: 'Native thread conversations use read-only titles' },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 40) {
    return c.json({ error: 'Name is required (max 40 chars)' }, 400);
  }

  // Update agent name in DB
  updateAgentInfo(agentId, name, agent.prompt);
  updateAgentContextInfo(agentId, { title_source: 'manual' });

  // Update virtual chat name
  const virtualChatJid = `${jid}#agent:${agentId}`;
  updateChatName(virtualChatJid, name);

  // Broadcast update via WebSocket
  const { broadcastAgentStatus } = await import('../web.js');
  broadcastAgentStatus(
    jid,
    agentId,
    agent.status as import('../types.js').AgentStatus,
    name,
    agent.prompt,
  );

  logger.info({ agentId, jid, name, userId: user.id }, 'Agent renamed');
  return c.json({ success: true });
});

// PATCH /api/groups/:jid/sessions/:sessionId — rename a workspace session
router.patch('/:jid/sessions/:sessionId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const sessionId = c.req.param('sessionId');
  const user = c.get('user');

  if (sessionId === 'main') {
    return c.json({ error: 'Main session is renamed with the workspace' }, 400);
  }

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage sessions' },
      403,
    );
  }

  const session = getAgent(sessionId);
  if (!session || session.chat_jid !== jid || session.kind !== 'conversation') {
    return c.json({ error: 'Session not found' }, 404);
  }
  if (isNativeManagedSession(session)) {
    return c.json(
      { error: 'Native thread sessions use read-only titles' },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 40) {
    return c.json({ error: 'Name is required (max 40 chars)' }, 400);
  }

  updateAgentInfo(sessionId, name, session.prompt);
  updateAgentContextInfo(sessionId, { title_source: 'manual' });
  updateChatName(`${jid}#agent:${sessionId}`, name);

  const { broadcastAgentStatus } = await import('../web.js');
  broadcastAgentStatus(
    jid,
    sessionId,
    session.status as import('../types.js').AgentStatus,
    name,
    session.prompt,
  );

  logger.info({ sessionId, jid, name, userId: user.id }, 'Session renamed');
  return c.json({ success: true });
});

// DELETE /api/groups/:jid/agents/:agentId — stop and delete an agent
router.delete('/:jid/agents/:agentId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Delete mutates the owner's workspace → owner-only (see POST for rationale).
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage conversations' },
      403,
    );
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== jid) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  if (agent.kind === 'conversation' && isNativeManagedSession(agent)) {
    return c.json(
      {
        error:
          'Native thread conversations are managed by their channel container and cannot be deleted directly',
      },
      409,
    );
  }
  // Block deletion if conversation agent has active IM bindings
  if (agent.kind === 'conversation') {
    const legacyLinkedImGroups = getGroupsByTargetAgent(agentId);
    const mountedImGroups = listChannelMountsBySession(agentId).map(
      (mount) => ({
        jid: mount.channel_jid,
        group: getRegisteredGroup(mount.channel_jid),
      }),
    );
    const linkedByJid = new Map<string, { jid: string; name: string }>();
    for (const { jid: imJid, group: imGroup } of legacyLinkedImGroups) {
      linkedByJid.set(imJid, { jid: imJid, name: imGroup.name });
    }
    for (const { jid: imJid, group: imGroup } of mountedImGroups) {
      linkedByJid.set(imJid, { jid: imJid, name: imGroup?.name ?? imJid });
    }
    const linkedImGroups = Array.from(linkedByJid.values());
    const threadBindings = listImContextBindingsByAgent(agentId);
    if (linkedImGroups.length > 0) {
      return c.json(
        {
          error:
            'Session has active IM bindings. Unbind all IM groups before deleting.',
          linked_im_groups: linkedImGroups,
        },
        409,
      );
    }
    if (threadBindings.length > 0) {
      const linkedThreadGroups = threadBindings.map((binding) => {
        const imGroup = getRegisteredGroup(binding.source_jid);
        return {
          jid: binding.source_jid,
          name: imGroup?.name ?? binding.source_jid,
          context_id: binding.context_id,
        };
      });
      return c.json(
        {
          error:
            'Session is managed by a thread-mapped IM channel. Unbind the workspace channel before deleting.',
          linked_im_groups: linkedThreadGroups,
        },
        409,
      );
    }
  }

  // If the agent is still running or idle, stop the process
  if (agent.status === 'running' || agent.status === 'idle') {
    updateAgentStatus(agentId, 'error', '用户手动停止');
    // Stop running process via queue
    const deps = getWebDeps();
    if (deps) {
      const virtualJid = `${jid}#agent:${agentId}`;
      deps.queue.stopGroup(virtualJid);
    }
  }

  // Clean up IPC/session directories
  const agentIpcDir = path.join(
    DATA_DIR,
    'ipc',
    group.folder,
    'agents',
    agentId,
  );
  try {
    fs.rmSync(agentIpcDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const agentSessionDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agents',
    agentId,
  );
  try {
    fs.rmSync(agentSessionDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // Delete virtual chat messages for conversation agents
  if (agent.kind === 'conversation') {
    const virtualChatJid = `${jid}#agent:${agentId}`;
    deleteMessagesForChatJid(virtualChatJid);

    // Note: IM bindings are checked above and block deletion if present.
    // No auto-clear here — user must unbind explicitly before deleting.
  }

  // Delete session records
  deleteSession(group.folder, agentId);

  deleteAgent(agentId);

  // Broadcast removal
  const { broadcastAgentRemoved } = await import('../web.js');
  broadcastAgentRemoved(jid, agentId, agent.name);

  logger.info({ agentId, jid, userId: user.id }, 'Agent deleted by user');
  return c.json({ success: true });
});

// DELETE /api/groups/:jid/sessions/:sessionId — delete a workspace session
router.delete('/:jid/sessions/:sessionId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const sessionId = c.req.param('sessionId');
  const user = c.get('user');

  if (sessionId === 'main') {
    return c.json({ error: 'Main session cannot be deleted' }, 400);
  }

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage sessions' },
      403,
    );
  }

  const session = getAgent(sessionId);
  if (!session || session.chat_jid !== jid || session.kind !== 'conversation') {
    return c.json({ error: 'Session not found' }, 404);
  }
  if (isNativeManagedSession(session)) {
    return c.json(
      {
        error:
          'Native thread sessions are managed by their channel container and cannot be deleted directly',
      },
      409,
    );
  }

  const legacyLinkedImGroups = getGroupsByTargetAgent(sessionId);
  const mountedImGroups = listChannelMountsBySession(sessionId).map(
    (mount) => ({
      jid: mount.channel_jid,
      group: getRegisteredGroup(mount.channel_jid),
    }),
  );
  const linkedByJid = new Map<string, { jid: string; name: string }>();
  for (const { jid: imJid, group: imGroup } of legacyLinkedImGroups) {
    linkedByJid.set(imJid, { jid: imJid, name: imGroup.name });
  }
  for (const { jid: imJid, group: imGroup } of mountedImGroups) {
    linkedByJid.set(imJid, { jid: imJid, name: imGroup?.name ?? imJid });
  }
  const linkedImGroups = Array.from(linkedByJid.values());
  if (linkedImGroups.length > 0) {
    return c.json(
      {
        error:
          'Session has active IM bindings. Unbind all IM groups before deleting.',
        linked_im_groups: linkedImGroups,
      },
      409,
    );
  }

  const threadBindings = listImContextBindingsByAgent(sessionId);
  if (threadBindings.length > 0) {
    return c.json(
      {
        error:
          'Session is managed by a thread-mapped IM channel. Unbind the workspace channel before deleting.',
        linked_im_groups: threadBindings.map((binding) => {
          const imGroup = getRegisteredGroup(binding.source_jid);
          return {
            jid: binding.source_jid,
            name: imGroup?.name ?? binding.source_jid,
            context_id: binding.context_id,
          };
        }),
      },
      409,
    );
  }

  if (session.status === 'running' || session.status === 'idle') {
    updateAgentStatus(sessionId, 'error', '用户手动停止');
    const deps = getWebDeps();
    if (deps) deps.queue.stopGroup(`${jid}#agent:${sessionId}`);
  }

  for (const dir of [
    path.join(DATA_DIR, 'ipc', group.folder, 'agents', sessionId),
    path.join(DATA_DIR, 'sessions', group.folder, 'agents', sessionId),
  ]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  deleteMessagesForChatJid(`${jid}#agent:${sessionId}`);
  deleteSession(group.folder, sessionId);
  deleteAgent(sessionId);

  const { broadcastAgentRemoved } = await import('../web.js');
  broadcastAgentRemoved(jid, sessionId, session.name);

  logger.info({ sessionId, jid, userId: user.id }, 'Session deleted by user');
  return c.json({ success: true });
});

// GET /api/groups/:jid/im-groups — list available IM group chats for this folder
router.get('/:jid/im-groups', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Find all IM groups this user can access (across all folders).
  const allGroups = getAllRegisteredGroups();
  const imJids = Object.keys(allGroups).filter((j) => {
    if (j.startsWith('web:')) return false;
    return canAccessGroup(user, { ...allGroups[j], jid: j });
  });

  // Build candidate list
  interface ImGroupCandidate {
    jid: string;
    name: string;
    bound_agent_id: string | null;
    bound_session_id: string | null;
    bound_main_jid: string | null;
    bound_workspace_jid: string | null;
    binding_mode: 'single_context' | 'thread_map';
    routing_mode: 'single_session' | 'thread_map';
    reply_policy: 'source_only' | 'mirror';
    bound_target_name: string | null;
    bound_workspace_name: string | null;
    avatar?: string;
    member_count?: number;
    channel_type: string;
    channel_account_id: string | null;
    channel_account_name: string | null;
    chat_mode?: string; // 'p2p' | 'group' — from Feishu API (distinguishes P2P vs group chat)
    group_message_type?: string;
    is_thread_capable?: boolean;
    activation_mode?: string;
    require_mention?: boolean;
    owner_im_id?: string | null;
    sender_allowlist_locked?: boolean;
  }

  const candidates: ImGroupCandidate[] = [];
  for (const j of imJids) {
    const g = allGroups[j];

    // Resolve bound target name for display
    let boundTargetName: string | null = null;
    let boundWorkspaceName: string | null = null;
    if (g.target_agent_id) {
      const boundAgent = getAgent(g.target_agent_id);
      if (boundAgent) {
        boundTargetName = boundAgent.name;
        const ownerGroup = getRegisteredGroup(boundAgent.chat_jid);
        if (ownerGroup) boundWorkspaceName = ownerGroup.name;
      }
    } else if (g.target_main_jid) {
      let boundGroup = getRegisteredGroup(g.target_main_jid);
      // Legacy fallback: old bindings stored web:${folder} instead of actual JID
      if (!boundGroup && g.target_main_jid.startsWith('web:')) {
        const folder = g.target_main_jid.slice(4);
        const jids = getJidsByFolder(folder);
        for (const fj of jids) {
          if (fj.startsWith('web:')) {
            boundGroup = getRegisteredGroup(fj);
            if (boundGroup) break;
          }
        }
      }
      if (boundGroup) boundTargetName = boundGroup.name;
    }

    candidates.push({
      jid: j,
      name: g.name,
      bound_agent_id: g.target_agent_id ?? null,
      bound_session_id: g.target_agent_id ?? null,
      bound_main_jid: g.target_main_jid ?? null,
      bound_workspace_jid: g.target_main_jid ?? null,
      binding_mode: g.binding_mode ?? 'single_context',
      routing_mode:
        g.binding_mode === 'thread_map' ? 'thread_map' : 'single_session',
      reply_policy: g.reply_policy === 'mirror' ? 'mirror' : 'source_only',
      bound_target_name: boundTargetName,
      bound_workspace_name: boundWorkspaceName,
      channel_type: getChannelType(j) ?? 'unknown',
      channel_account_id: g.channel_account_id ?? null,
      channel_account_name: g.channel_account_id
        ? (getChannelAccount(g.channel_account_id)?.name ?? null)
        : null,
      chat_mode: g.feishu_chat_mode,
      group_message_type: g.feishu_group_message_type,
      is_thread_capable: isNativeContextContainer(j, g),
      activation_mode: g.activation_mode,
      require_mention: g.require_mention === true,
      owner_im_id: g.owner_im_id ?? null,
      sender_allowlist_locked:
        Array.isArray(g.sender_allowlist) && g.sender_allowlist.length === 0,
    });
  }

  // Enrich chats with provider-native metadata (Feishu topic groups and
  // Telegram Forums both expose a native thread container).
  const deps = getWebDeps();
  if (deps?.getChannelChatInfo || deps?.getFeishuChatInfo) {
    const chatInfoPromises = candidates.map(async (g) => {
      const chatId = extractChatId(g.jid);
      const info = deps.getChannelChatInfo
        ? await deps.getChannelChatInfo(g.jid)
        : g.channel_type === 'feishu'
          ? await deps.getFeishuChatInfo!(user.id, chatId)
          : null;
      if (info) {
        g.avatar = info.avatar;
        g.chat_mode = info.chat_mode;
        g.group_message_type = info.group_message_type;
        g.is_thread_capable = isNativeContextContainer(
          g.jid,
          allGroups[g.jid],
          info as ChannelChatInfo,
        );
        if (info.user_count != null) {
          const count = parseInt(info.user_count, 10);
          if (!isNaN(count)) g.member_count = count;
        }
        if (info.name && info.name !== g.name) g.name = info.name;
      }
    });
    await Promise.allSettled(chatInfoPromises);
  }

  // Feishu: all registered chats (group and p2p) are now returned.
  // The member_count filter was removed because p2p chats have user_count=0 or 1
  // from the Feishu API (counting non-bot users), which is not a meaningful filter.
  return c.json({ imGroups: candidates });
});

// PUT /api/groups/:jid/sessions/:sessionId/im-binding — bind an IM group to a workspace session
router.put(
  '/:jid/sessions/:sessionId/im-binding',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const sessionId = c.req.param('sessionId');
    const user = c.get('user');

    const group = getRegisteredGroup(jid);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!jid.startsWith('web:')) {
      return c.json({ error: 'Binding target must be a workspace' }, 400);
    }
    if (!canAccessGroup(user, { ...group, jid })) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...group, jid })) {
      return c.json(
        { error: 'Only the workspace owner can manage IM bindings' },
        403,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
    if (!imJid) {
      return c.json({ error: 'im_jid is required' }, 400);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, imGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }

    const force = body.force === true;
    const replyPolicy =
      body.reply_policy === 'mirror' ? 'mirror' : 'source_only';

    if (sessionId !== 'main') {
      const session = getAgent(sessionId);
      if (
        !session ||
        session.chat_jid !== jid ||
        session.kind !== 'conversation'
      ) {
        return c.json({ error: 'Session not found' }, 404);
      }
      const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
      // Re-read after the await: fetchLiveChatInfo makes a live network
      // call (e.g. Feishu getFeishuChatInfo) that yields the event loop,
      // during which a concurrent bind request or the message router's
      // owner-learning path can commit a new mount for this exact imJid —
      // or upgrade native_context_type from 'none' to 'thread'. Building
      // the update, or computing threadCapable, from the pre-await
      // snapshot would silently clobber that concurrent write, bypass the
      // conflict check below (commitChannelMountUpdate persists the full
      // row), or bind a now-thread-capable container as a fixed single
      // session, breaking that thread's session isolation.
      const freshImGroup = getRegisteredGroup(imJid);
      if (!freshImGroup) {
        return c.json({ error: 'IM group not found' }, 404);
      }
      // The pre-await canModifyGroup/hasConsistentChannelAccount checks
      // above only proved authorization against the stale imGroup. During
      // the await, ownership could have changed (credential transfer,
      // delete+recreate, owner-learning) — re-run both checks against the
      // fresh row before committing, or a mutation could cross the
      // original authorization boundary.
      if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
        return c.json(
          { error: 'Invalid or inaccessible channel account' },
          400,
        );
      }
      if (isNativeContextContainer(imJid, freshImGroup, chatInfo ?? {})) {
        return c.json(
          {
            error:
              'Native thread containers can only bind to a workspace, not a single session',
          },
          400,
        );
      }
      const hasConflict = hasSessionMountConflict(freshImGroup, sessionId);
      if (hasConflict && !force) {
        return c.json({ error: 'IM group is already bound elsewhere' }, 409);
      }

      const updated = buildSessionMountUpdate(freshImGroup, sessionId, {
        replyPolicy,
      });
      commitChannelMountUpdate(imJid, updated);
      detachPreviousThreadMapIfLast(imJid, freshImGroup);
      logger.info(
        { imJid, sessionId, userId: user.id },
        'IM group bound to workspace session',
      );
      return c.json({ success: true });
    }

    const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
    // Re-read after the await — see the analogous comment in the
    // session-bind branch above: fetchLiveChatInfo yields the event loop
    // on a live network call, and a concurrent write to this imJid must
    // not be silently overwritten by the pre-await snapshot.
    const freshImGroup = getRegisteredGroup(imJid);
    if (!freshImGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    // Re-run authorization against the fresh row — see the analogous
    // comment in the session-bind branch above.
    if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }
    // Compute against freshImGroup, not the pre-await snapshot — see
    // fetchLiveChatInfo's doc comment.
    const threadCapable = isNativeContextContainer(
      imJid,
      freshImGroup,
      chatInfo ?? {},
    );
    const targetMainJid = jid;
    const legacyMainJid = `web:${group.folder}`;
    const hasConflict = hasWorkspaceMountConflict(
      freshImGroup,
      targetMainJid,
      legacyMainJid,
    );
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }
    const validActivationModes = [
      'always',
      'when_mentioned',
      'owner_mentioned',
      'auto',
      'disabled',
    ] as const;
    const rawActivationMode = body.activation_mode;
    const activationMode =
      typeof rawActivationMode === 'string' &&
      validActivationModes.includes(
        rawActivationMode as (typeof validActivationModes)[number],
      )
        ? (rawActivationMode as (typeof validActivationModes)[number])
        : undefined;
    const ownerImId =
      typeof body.owner_im_id === 'string' && body.owner_im_id.trim()
        ? body.owner_im_id.trim()
        : undefined;

    const updated: RegisteredGroup = {
      ...buildWorkspaceMountUpdate(
        freshImGroup,
        targetMainJid,
        threadCapable ? 'thread_map' : 'single_session',
        {
          replyPolicy,
          ...(activationMode !== undefined ? { activationMode } : {}),
          ...(ownerImId !== undefined ? { ownerImId } : {}),
        },
      ),
      feishu_chat_mode: chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
      feishu_group_message_type:
        chatInfo?.group_message_type ?? freshImGroup.feishu_group_message_type,
    };
    commitChannelMountUpdate(imJid, updated);
    detachPreviousThreadMapIfLast(
      imJid,
      freshImGroup,
      targetMainJid,
      threadCapable ? 'thread_map' : 'single_session',
    );
    if (threadCapable) markNativeContextWorkspace(jid, group);

    logger.info(
      { imJid, targetMainJid, threadCapable, userId: user.id },
      'IM group bound to workspace main session',
    );
    return c.json({ success: true });
  },
);

// DELETE /api/groups/:jid/sessions/:sessionId/im-binding/:imJid — unbind an IM group from a session
router.delete(
  '/:jid/sessions/:sessionId/im-binding/:imJid',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const sessionId = c.req.param('sessionId');
    const imJid = decodeURIComponent(c.req.param('imJid'));
    const user = c.get('user');

    const group = getRegisteredGroup(jid);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...group, jid })) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...group, jid })) {
      return c.json(
        { error: 'Only the workspace owner can manage IM bindings' },
        403,
      );
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (sessionId !== 'main') {
      const session = getAgent(sessionId);
      if (
        !session ||
        session.chat_jid !== jid ||
        session.kind !== 'conversation'
      ) {
        return c.json({ error: 'Session not found' }, 404);
      }
      if (imGroup.target_agent_id !== sessionId) {
        return c.json({ error: 'IM group is not bound to this session' }, 400);
      }
      const restored = await restoreBindingDefault(user, imJid, imGroup);
      if (restored.status !== 'resolved') {
        return c.json({ error: restoreDefaultError(restored) }, 409);
      }
      updateAgentLastImJid(sessionId, null);
      logger.info(
        {
          imJid,
          sessionId,
          defaultWorkspaceJid: restored.workspaceJid,
          userId: user.id,
        },
        'IM group restored to channel account default workspace',
      );
      return c.json({ success: true, target_main_jid: restored.workspaceJid });
    }

    const targetMainJid = jid;
    const legacyMainJid = `web:${group.folder}`;
    if (!matchesWorkspaceMount(imGroup, targetMainJid, legacyMainJid)) {
      return c.json({ error: 'IM group is not bound to this workspace' }, 400);
    }
    const restored = await restoreBindingDefault(user, imJid, imGroup);
    if (restored.status !== 'resolved') {
      return c.json({ error: restoreDefaultError(restored) }, 409);
    }

    logger.info(
      {
        imJid,
        targetMainJid,
        defaultWorkspaceJid: restored.workspaceJid,
        userId: user.id,
      },
      'IM group restored to channel account default workspace',
    );
    return c.json({ success: true, target_main_jid: restored.workspaceJid });
  },
);

// PUT /api/groups/:jid/agents/:agentId/im-binding — bind an IM group to this workspace session
router.put('/:jid/agents/:agentId/im-binding', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!jid.startsWith('web:')) {
    return c.json({ error: 'Binding target must be a workspace' }, 400);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // IM binding mutates the owner's workspace routing → owner-only, same as
  // agent CRUD (the imGroup-side check below stays Access — you only need
  // access to the IM group you're binding).
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage IM bindings' },
      403,
    );
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== jid) {
    return c.json({ error: 'Session not found' }, 404);
  }
  if (agent.kind !== 'conversation') {
    return c.json({ error: 'Only workspace sessions can bind IM groups' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
  if (!imJid) {
    return c.json({ error: 'im_jid is required' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, imGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }
  const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
  // Re-read + re-authorize after the await — see the analogous comment on
  // the PUT /:jid/sessions/:sessionId/im-binding route above.
  const freshImGroup = getRegisteredGroup(imJid);
  if (!freshImGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }
  // Compute against freshImGroup, not the pre-await snapshot — see
  // fetchLiveChatInfo's doc comment.
  if (isNativeContextContainer(imJid, freshImGroup, chatInfo ?? {})) {
    return c.json(
      {
        error:
          'Native thread containers can only bind to a workspace, not a single session',
      },
      400,
    );
  }
  const force = body.force === true;
  const replyPolicy = body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
  const hasConflict = hasSessionMountConflict(freshImGroup, agentId);
  if (hasConflict && !force) {
    return c.json({ error: 'IM group is already bound elsewhere' }, 409);
  }

  // Update DB + in-memory cache — clear target_main_jid to avoid conflicts
  const updated: RegisteredGroup = buildSessionMountUpdate(
    freshImGroup,
    agentId,
    {
      replyPolicy,
    },
  );
  commitChannelMountUpdate(imJid, updated);
  detachPreviousThreadMapIfLast(imJid, freshImGroup);

  logger.info(
    { imJid, sessionId: agentId, userId: user.id },
    'IM group bound to workspace session',
  );
  return c.json({ success: true });
});

// DELETE /api/groups/:jid/agents/:agentId/im-binding/:imJid — unbind an IM group from this workspace session
router.delete(
  '/:jid/agents/:agentId/im-binding/:imJid',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const agentId = c.req.param('agentId');
    const imJid = decodeURIComponent(c.req.param('imJid'));
    const user = c.get('user');

    const group = getRegisteredGroup(jid);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...group, jid })) {
      return c.json({ error: 'Group not found' }, 404);
    }
    // IM unbinding mutates the owner's workspace routing → owner-only.
    if (!canModifyGroup(user, { ...group, jid })) {
      return c.json(
        { error: 'Only the workspace owner can manage IM bindings' },
        403,
      );
    }

    const agent = getAgent(agentId);
    if (!agent || agent.chat_jid !== jid) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (imGroup.target_agent_id !== agentId) {
      return c.json({ error: 'IM group is not bound to this session' }, 400);
    }

    const restored = await restoreBindingDefault(user, imJid, imGroup);
    if (restored.status !== 'resolved') {
      return c.json({ error: restoreDefaultError(restored) }, 409);
    }

    // Clear persisted IM routing so restart won't route to unbound channel (#225)
    updateAgentLastImJid(agentId, null);

    logger.info(
      {
        imJid,
        sessionId: agentId,
        defaultWorkspaceJid: restored.workspaceJid,
        userId: user.id,
      },
      'IM group restored to channel account default workspace',
    );
    return c.json({ success: true, target_main_jid: restored.workspaceJid });
  },
);

// PUT /api/groups/:jid/im-binding — bind an IM group to this workspace's main conversation
router.put('/:jid/im-binding', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!jid.startsWith('web:')) {
    return c.json({ error: 'Binding target must be a workspace' }, 400);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Binding an IM group to the main conversation mutates the owner's workspace
  // routing → owner-only (the imGroup-side check below stays Access).
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage IM bindings' },
      403,
    );
  }
  const body = await c.req.json().catch(() => ({}));
  const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
  if (!imJid) {
    return c.json({ error: 'im_jid is required' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, imGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }
  const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
  // Re-read after the await — fetchLiveChatInfo yields the event loop on a
  // live network call, and a concurrent write to this imJid must not be
  // silently overwritten by the pre-await snapshot below.
  const freshImGroup = getRegisteredGroup(imJid);
  if (!freshImGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  // Re-run authorization against the fresh row — the pre-await checks above
  // only proved it against the stale imGroup.
  if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }
  // Compute against freshImGroup, not the pre-await snapshot — see
  // fetchLiveChatInfo's doc comment.
  const threadCapable = isNativeContextContainer(
    imJid,
    freshImGroup,
    chatInfo ?? {},
  );
  const targetMainJid = jid; // Use actual registered JID (not folder-based)
  const legacyMainJid = `web:${group.folder}`;
  const force = body.force === true;
  // Only update reply_policy if explicitly provided; otherwise preserve existing value
  const replyPolicy =
    body.reply_policy === 'mirror'
      ? 'mirror'
      : body.reply_policy === 'source_only'
        ? 'source_only'
        : undefined;
  const hasConflict = hasWorkspaceMountConflict(
    freshImGroup,
    targetMainJid,
    legacyMainJid,
  );
  if (hasConflict && !force) {
    return c.json({ error: 'IM group is already bound elsewhere' }, 409);
  }
  // Parse activation_mode from request body
  const validActivationModes = [
    'always',
    'when_mentioned',
    'owner_mentioned',
    'auto',
    'disabled',
  ] as const;
  const rawActivationMode = body.activation_mode;
  const activationMode =
    typeof rawActivationMode === 'string' &&
    validActivationModes.includes(
      rawActivationMode as (typeof validActivationModes)[number],
    )
      ? (rawActivationMode as (typeof validActivationModes)[number])
      : undefined;

  // Parse owner_im_id for owner_mentioned mode
  // 如果前端传了 owner_im_id 就用，否则 owner_mentioned 模式下自动设为空（后续首条消息自动学习）
  const ownerImId =
    typeof body.owner_im_id === 'string' && body.owner_im_id.trim()
      ? body.owner_im_id.trim()
      : undefined;

  // Update DB + in-memory cache — clear target_agent_id to avoid conflicts
  const updated: RegisteredGroup = {
    ...buildWorkspaceMountUpdate(
      freshImGroup,
      targetMainJid,
      threadCapable ? 'thread_map' : 'single_session',
      {
        ...(replyPolicy !== undefined ? { replyPolicy } : {}),
        ...(activationMode !== undefined ? { activationMode } : {}),
        ...(ownerImId !== undefined ? { ownerImId } : {}),
      },
    ),
    feishu_chat_mode: chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
    feishu_group_message_type:
      chatInfo?.group_message_type ?? freshImGroup.feishu_group_message_type,
  };
  commitChannelMountUpdate(imJid, updated);
  detachPreviousThreadMapIfLast(
    imJid,
    freshImGroup,
    targetMainJid,
    threadCapable ? 'thread_map' : 'single_session',
  );
  if (threadCapable) markNativeContextWorkspace(jid, group);

  logger.info(
    {
      imJid,
      targetMainJid,
      activationMode,
      threadCapable,
      userId: user.id,
    },
    'IM group bound to workspace main conversation',
  );
  return c.json({ success: true });
});

// DELETE /api/groups/:jid/im-binding/:imJid — unbind an IM group from this workspace's main conversation
router.delete('/:jid/im-binding/:imJid', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const imJid = decodeURIComponent(c.req.param('imJid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Unbinding mutates the owner's workspace routing → owner-only.
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage IM bindings' },
      403,
    );
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const targetMainJid = jid; // Use actual registered JID (not folder-based)
  const legacyMainJid = `web:${group.folder}`;
  if (!matchesWorkspaceMount(imGroup, targetMainJid, legacyMainJid)) {
    return c.json({ error: 'IM group is not bound to this workspace' }, 400);
  }

  const restored = await restoreBindingDefault(user, imJid, imGroup);
  if (restored.status !== 'resolved') {
    return c.json({ error: restoreDefaultError(restored) }, 409);
  }

  logger.info(
    {
      imJid,
      targetMainJid,
      defaultWorkspaceJid: restored.workspaceJid,
      userId: user.id,
    },
    'IM group restored to channel account default workspace',
  );
  return c.json({ success: true, target_main_jid: restored.workspaceJid });
});

export default router;
