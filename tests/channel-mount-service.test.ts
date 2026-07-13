import { describe, expect, test } from 'vitest';

import {
  buildDetachedWorkspaceUpdate,
  buildSessionMountUpdate,
  buildWorkspaceMountUpdate,
  findWorkspaceThreadMapConflict,
  hasSessionMountConflict,
  hasWorkspaceMountConflict,
  matchesWorkspaceMount,
  resolveChannelMountTarget,
} from '../src/channel-mount-service.js';
import {
  IM_CHANNEL_CAPABILITIES,
  isThreadMapCapableChat,
} from '../src/im-channel-capabilities.js';
import type { RegisteredGroup, SubAgent } from '../src/types.js';

function makeWorkspace(name: string, folder: string): RegisteredGroup {
  return {
    name,
    folder,
    added_at: '2026-07-09T00:00:00.000Z',
  };
}

function makeSession(id: string, chatJid: string): SubAgent {
  return {
    id,
    group_folder: 'workspace-a',
    chat_jid: chatJid,
    name: `Session ${id}`,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'owner-a',
    created_at: '2026-07-09T00:00:00.000Z',
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  };
}

describe('resolveChannelMountTarget', () => {
  test('resolves a session mount through the session owner workspace', () => {
    const result = resolveChannelMountTarget(
      { session_id: 'session-a', workspace_jid: 'web:workspace-a' },
      {
        getAgent: (id) =>
          id === 'session-a' ? makeSession(id, 'web:workspace-a') : undefined,
        getRegisteredGroup: (jid) =>
          jid === 'web:workspace-a'
            ? makeWorkspace('Workspace A', 'workspace-a')
            : undefined,
      },
    );

    expect(result).toMatchObject({
      status: 'resolved',
      effectiveJid: 'web:workspace-a#agent:session-a',
      workspaceJid: 'web:workspace-a',
      agentId: 'session-a',
    });
  });

  test('does not fall back when a session mount points at a missing session', () => {
    const result = resolveChannelMountTarget(
      { session_id: 'missing-session', workspace_jid: 'web:workspace-a' },
      {
        getAgent: () => undefined,
        getRegisteredGroup: (jid) =>
          jid === 'web:workspace-a'
            ? makeWorkspace('Workspace A', 'workspace-a')
            : undefined,
      },
    );

    expect(result).toEqual({
      status: 'stale',
      reason: 'missing_session',
      sessionId: 'missing-session',
      workspaceJid: 'web:workspace-a',
    });
  });

  test('uses the session owner workspace when stored workspace_jid is stale', () => {
    const result = resolveChannelMountTarget(
      { session_id: 'session-a', workspace_jid: 'web:old-workspace' },
      {
        getAgent: (id) =>
          id === 'session-a' ? makeSession(id, 'web:workspace-a') : undefined,
        getRegisteredGroup: (jid) =>
          jid === 'web:workspace-a'
            ? makeWorkspace('Workspace A', 'workspace-a')
            : undefined,
      },
    );

    expect(result).toMatchObject({
      status: 'resolved',
      effectiveJid: 'web:workspace-a#agent:session-a',
      workspaceJid: 'web:workspace-a',
      agentId: 'session-a',
      workspaceMismatch: {
        storedWorkspaceJid: 'web:old-workspace',
        actualWorkspaceJid: 'web:workspace-a',
      },
    });
  });

  test('does not fall back when a workspace mount points at a missing workspace', () => {
    const result = resolveChannelMountTarget(
      { session_id: null, workspace_jid: 'web:missing-workspace' },
      {
        getAgent: () => undefined,
        getRegisteredGroup: () => undefined,
      },
    );

    expect(result).toEqual({
      status: 'stale',
      reason: 'missing_workspace',
      workspaceJid: 'web:missing-workspace',
    });
  });
});

describe('channel binding product contract', () => {
  test('only Feishu exposes workspace binding capability', () => {
    expect(IM_CHANNEL_CAPABILITIES.feishu.can_bind_workspace).toBe(true);
    expect(
      Object.values(IM_CHANNEL_CAPABILITIES)
        .filter((capability) => capability.channel_type !== 'feishu')
        .every((capability) => !capability.can_bind_workspace),
    ).toBe(true);
  });

  test('only Feishu topic or thread chats qualify for workspace binding', () => {
    expect(
      isThreadMapCapableChat({ channel_type: 'feishu', chat_mode: 'topic' }),
    ).toBe(true);
    expect(
      isThreadMapCapableChat({
        channel_type: 'feishu',
        chat_mode: 'group',
        group_message_type: 'thread',
      }),
    ).toBe(true);
    expect(
      isThreadMapCapableChat({ channel_type: 'feishu', chat_mode: 'group' }),
    ).toBe(false);
    expect(
      isThreadMapCapableChat({ channel_type: 'telegram', chat_mode: 'topic' }),
    ).toBe(false);
  });

  test('workspace and session targets remain mutually exclusive', () => {
    const source = makeWorkspace('Channel', 'channel-a');
    const sessionBound = buildSessionMountUpdate(
      { ...source, target_main_jid: 'web:old' },
      'session-a',
    );
    expect(sessionBound.target_agent_id).toBe('session-a');
    expect(sessionBound.target_main_jid).toBeUndefined();

    const workspaceBound = buildWorkspaceMountUpdate(
      { ...source, target_agent_id: 'old-session' },
      'web:workspace-a',
      'thread_map',
    );
    expect(workspaceBound.target_agent_id).toBeUndefined();
    expect(workspaceBound.target_main_jid).toBe('web:workspace-a');
  });

  test('centralizes conflict and legacy workspace matching semantics', () => {
    const sessionBound = {
      ...makeWorkspace('Channel', 'channel-a'),
      target_agent_id: 'session-a',
    };
    expect(hasSessionMountConflict(sessionBound, 'session-a')).toBe(false);
    expect(hasSessionMountConflict(sessionBound, 'session-b')).toBe(true);

    const workspaceBound = {
      ...makeWorkspace('Topic', 'channel-b'),
      target_main_jid: 'web:workspace-folder',
      binding_mode: 'thread_map' as const,
    };
    expect(
      matchesWorkspaceMount(
        workspaceBound,
        'web:workspace-uuid',
        'web:workspace-folder',
      ),
    ).toBe(true);
    expect(
      hasWorkspaceMountConflict(
        workspaceBound,
        'web:workspace-uuid',
        'web:workspace-folder',
      ),
    ).toBe(false);
    expect(
      findWorkspaceThreadMapConflict(
        { 'feishu:topic': workspaceBound },
        'feishu:other',
        'web:workspace-uuid',
        'web:workspace-folder',
      )?.[0],
    ).toBe('feishu:topic');
  });

  test('detaching a topic workspace preserves its data and only resets navigation', () => {
    const workspace: RegisteredGroup = {
      ...makeWorkspace('Workspace A', 'workspace-a'),
      conversation_source: 'feishu_thread',
      conversation_nav_mode: 'vertical_threads',
      skill_ids: ['skill-a'],
    };

    expect(buildDetachedWorkspaceUpdate(workspace)).toEqual({
      ...workspace,
      conversation_source: 'manual',
      conversation_nav_mode: 'horizontal',
    });
  });
});
