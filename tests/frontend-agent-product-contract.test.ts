import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceAgentProfilePatch,
  groupWorkspacesByAgent,
  workspaceCreationBlockReason,
} from '../web/src/utils/agent-product';
import {
  buildTaskWorkspacePatch,
  canSelectTaskExecutionMode,
  getAllowedTaskExecutionModes,
} from '../web/src/utils/task-edit';
import type { GroupEntry } from '../web/src/utils/group-utils';

function workspace(
  jid: string,
  agentProfileId: string,
  agentProfileName: string,
): GroupEntry {
  return {
    jid,
    name: jid,
    folder: jid,
    agent_profile_id: agentProfileId,
    agent_profile_name: agentProfileName,
  } as GroupEntry;
}

describe('Agent-first frontend product contracts', () => {
  it('sends the canonical Agent assignment payload for workspace migration', () => {
    expect(buildWorkspaceAgentProfilePatch('agent-reviewer')).toEqual({
      agent_profile_id: 'agent-reviewer',
    });
  });

  it('moves a task from a host workspace to a container workspace atomically', () => {
    expect(
      buildTaskWorkspacePatch({
        currentChatJid: 'web:host',
        currentExecutionMode: 'host',
        targetChatJid: 'web:container',
        targetExecutionMode: 'container',
      }),
    ).toEqual({
      chat_jid: 'web:container',
      execution_mode: 'container',
    });
  });

  it('only exposes host task execution to admins', () => {
    expect(getAllowedTaskExecutionModes('admin')).toEqual([
      'host',
      'container',
    ]);
    expect(getAllowedTaskExecutionModes('member')).toEqual(['container']);
    expect(canSelectTaskExecutionMode('member', 'host')).toBe(false);
    expect(canSelectTaskExecutionMode('member', 'container')).toBe(true);
  });

  it('blocks workspace creation when Agent loading failed instead of using a silent default', () => {
    expect(
      workspaceCreationBlockReason({
        name: 'Review workspace',
        submitting: false,
        profilesLoading: false,
        profilesError: 'network down',
        selectedAgentProfileId: '',
      }),
    ).toBe('Agent 列表加载失败');
  });

  it('preserves Agent hierarchy for pinned and collaboration collections', () => {
    expect(
      groupWorkspacesByAgent([
        workspace('web:one', 'agent-a', 'Reviewer'),
        workspace('web:two', 'agent-b', 'Builder'),
        workspace('web:three', 'agent-a', 'Reviewer'),
      ]).map((section) => [
        section.name,
        section.items.map((item) => item.jid),
      ]),
    ).toEqual([
      ['Builder', ['web:two']],
      ['Reviewer', ['web:one', 'web:three']],
    ]);
  });
});
