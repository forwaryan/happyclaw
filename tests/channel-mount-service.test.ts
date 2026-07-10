import { describe, expect, test } from 'vitest';

import { resolveChannelMountTarget } from '../src/channel-mount-service.js';
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
