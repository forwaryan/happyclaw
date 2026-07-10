import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Variables } from '../web-context.js';
import { getWebDeps } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  AgentProfileCreateSchema,
  AgentProfileGenerateSchema,
  AgentProfilePatchSchema,
} from '../schemas.js';
import type { AuthUser } from '../types.js';
import { generateAgentProfileDraft } from '../agent-profile-generator.js';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';
import { loadUserMcpServers } from '../mcp-utils.js';
import { getEnabledProviders } from '../runtime-config.js';
import { validateSkillId } from '../skill-utils.js';
import {
  listWorkspaceGroupsForAgentProfile,
  quiesceWorkspaceRunnersAroundCommit,
  withAgentProfileLocks,
  WorkspaceRuntimeQuiesceError,
} from '../agent-profile-runtime.js';
import {
  archiveAgentProfile,
  createAgentProfile,
  getAgentProfileForUser,
  getAllRegisteredGroups,
  getOrCreateDefaultAgentProfile,
  getWorkspaceAgentProfileId,
  listAgentChannelMountsForProfile,
  listAgentProfilesForUser,
  listWorkspaceRuntimeSessionsByWorkspace,
  mergeAgentProfileRuntimePolicy,
  normalizeAgentProfileRuntimePolicy,
  updateAgentProfile,
} from '../db.js';

const agentProfileRoutes = new Hono<{ Variables: Variables }>();

function validateRuntimePolicyReferences(
  userId: string,
  policy: ReturnType<typeof normalizeAgentProfileRuntimePolicy>,
): { providers: string[]; skills: string[]; mcp: string[] } {
  const invalid = {
    providers: [] as string[],
    skills: [] as string[],
    mcp: [] as string[],
  };
  if (
    policy.provider_id &&
    !getEnabledProviders().some(
      (provider) => provider.id === policy.provider_id,
    )
  ) {
    invalid.providers.push(policy.provider_id);
  }

  if (policy.skills.mode === 'custom') {
    const root = path.join(DATA_DIR, 'skills', userId);
    for (const id of policy.skills.ids) {
      if (
        !validateSkillId(id) ||
        !fs.existsSync(path.join(root, id, 'SKILL.md'))
      ) {
        invalid.skills.push(id);
      }
    }
  }

  if (policy.mcp.mode === 'custom') {
    const enabledServers = loadUserMcpServers(userId);
    for (const id of policy.mcp.ids) {
      if (!Object.prototype.hasOwnProperty.call(enabledServers, id)) {
        invalid.mcp.push(id);
      }
    }
  }
  return invalid;
}

function hasInvalidRuntimePolicyReferences(
  invalid: ReturnType<typeof validateRuntimePolicyReferences>,
): boolean {
  return (
    invalid.providers.length + invalid.skills.length + invalid.mcp.length > 0
  );
}

agentProfileRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const profiles = listAgentProfilesForUser(user.id);
  return c.json({ profiles });
});

agentProfileRoutes.post('/', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfileCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  const runtimePolicy = normalizeAgentProfileRuntimePolicy(
    parsed.data.runtime_policy,
  );
  const invalidReferences = validateRuntimePolicyReferences(
    user.id,
    runtimePolicy,
  );
  if (hasInvalidRuntimePolicyReferences(invalidReferences)) {
    return c.json(
      {
        error: 'Runtime policy references unavailable capabilities',
        invalid_runtime_policy: invalidReferences,
      },
      400,
    );
  }
  const profile = createAgentProfile({
    ownerUserId: user.id,
    name: parsed.data.name,
    identityPrompt: parsed.data.identity_prompt ?? '',
    includeClaudePreset: parsed.data.include_claude_preset ?? true,
    runtimePolicy,
  });
  return c.json({ profile }, 201);
});

agentProfileRoutes.post('/generate', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfileGenerateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  try {
    const draft = await generateAgentProfileDraft(parsed.data.description);
    return c.json({ draft });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'AI 解析失败，请重试或手动填写';
    logger.warn(
      { err, descriptionLen: parsed.data.description.length },
      'Failed to generate Agent profile draft',
    );
    return c.json({ error: message }, message.includes('未配置') ? 503 : 502);
  }
});

agentProfileRoutes.patch('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfilePatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  if (
    parsed.data.name === undefined &&
    parsed.data.identity_prompt === undefined &&
    parsed.data.include_claude_preset === undefined &&
    parsed.data.runtime_policy === undefined
  ) {
    return c.json({ error: 'No changes provided' }, 400);
  }
  return withAgentProfileLocks([id], async () => {
    // Membership mutations for this profile use the same lock. Reading the
    // profile and workspace snapshot here prevents a new A-owned workspace
    // from being published between snapshot and post-commit cleanup.
    const existing = getAgentProfileForUser(id, user.id);
    if (!existing) return c.json({ error: 'Agent profile not found' }, 404);

    const effectiveRuntimePolicy =
      parsed.data.runtime_policy === undefined
        ? existing.runtime_policy
        : mergeAgentProfileRuntimePolicy(
            existing.runtime_policy,
            parsed.data.runtime_policy,
          );
    const invalidReferences = validateRuntimePolicyReferences(
      user.id,
      effectiveRuntimePolicy,
    );
    if (hasInvalidRuntimePolicyReferences(invalidReferences)) {
      return c.json(
        {
          error: 'Runtime policy references unavailable capabilities',
          invalid_runtime_policy: invalidReferences,
        },
        400,
      );
    }

    const sensitivePayloadProvided =
      parsed.data.name !== undefined ||
      parsed.data.identity_prompt !== undefined ||
      parsed.data.include_claude_preset !== undefined ||
      parsed.data.runtime_policy !== undefined;

    let invalidatedRuntimeJids = 0;
    const commit = () =>
      updateAgentProfile(id, user.id, {
        name: parsed.data.name,
        identityPrompt: parsed.data.identity_prompt,
        includeClaudePreset: parsed.data.include_claude_preset,
        runtimePolicy: parsed.data.runtime_policy,
      });
    let profile;
    const deps = getWebDeps();
    const workspaces = sensitivePayloadProvided
      ? listWorkspaceGroupsForAgentProfile(user.id, id)
      : [];
    if (sensitivePayloadProvided && deps && workspaces.length > 0) {
      try {
        const result = await quiesceWorkspaceRunnersAroundCommit(
          deps,
          workspaces.map((workspace) => ({
            folder: workspace.group.folder,
            primaryJid: workspace.jid,
          })),
          { reason: `Agent profile ${id} sensitive configuration submitted` },
          commit,
        );
        profile = result.value;
        invalidatedRuntimeJids = result.runtimeJids.length;
      } catch (err) {
        if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
        const persistedProfile = err.persisted
          ? (err.committedValue as ReturnType<typeof commit>)
          : undefined;
        logger.error(
          { err, agentProfileId: id, persisted: err.persisted },
          err.persisted
            ? 'Agent profile persisted but post-commit runtime cleanup failed'
            : 'Agent profile update aborted before persistence',
        );
        return c.json(
          {
            error: err.persisted
              ? 'Agent profile was updated, but runtime cleanup failed; retry the same request'
              : 'Failed to quiesce active workspaces; profile was not updated',
            persisted: err.persisted,
            retryable: true,
            profile: persistedProfile,
          },
          503,
        );
      }
    } else {
      profile = commit();
    }
    if (!profile) return c.json({ error: 'Agent profile not found' }, 404);

    return c.json({
      profile,
      invalidated_runtime_jids: invalidatedRuntimeJids,
    });
  });
});

agentProfileRoutes.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  return withAgentProfileLocks([id], () => {
    // Target-profile validation in create/migrate is repeated under this same
    // lock, so either archive wins and publication is rejected, or membership
    // wins and archive observes the mapping and returns 409.
    const result = archiveAgentProfile(id, user.id);
    if (result === 'not_found') {
      return c.json({ error: 'Agent profile not found' }, 404);
    }
    if (result === 'is_default') {
      return c.json({ error: 'Default Agent cannot be deleted' }, 400);
    }
    if (result === 'has_workspaces') {
      return c.json(
        {
          error:
            'Agent profile still owns workspaces; move or delete them first',
        },
        409,
      );
    }
    if (result === 'has_mounts') {
      return c.json(
        {
          error:
            'Agent profile still owns IM channel mounts; unbind them first',
        },
        409,
      );
    }
    return c.json({ success: true });
  });
});

agentProfileRoutes.get('/:id/workspaces', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const profile = getAgentProfileForUser(id, user.id);
  if (!profile) return c.json({ error: 'Agent profile not found' }, 404);

  const defaultProfile = getOrCreateDefaultAgentProfile(user.id);
  const groups = getAllRegisteredGroups();
  const workspaces = Object.entries(groups)
    .filter(([jid, group]) => {
      if (!jid.startsWith('web:')) return false;
      if (group.created_by !== user.id) return false;
      const mapped =
        getWorkspaceAgentProfileId(group.folder) ?? defaultProfile.id;
      return mapped === id;
    })
    .map(([jid, group]) => ({
      jid,
      name: group.name,
      folder: group.folder,
      is_home: !!group.is_home,
      execution_mode: group.executionMode ?? 'container',
      added_at: group.added_at,
      runtime_sessions: listWorkspaceRuntimeSessionsByWorkspace(jid).map(
        (session) => ({
          runtime_agent_id: session.runtime_agent_id,
          sdk_session_id: session.sdk_session_id,
          provider_id: session.provider_id,
          agent_profile_id: session.agent_profile_id,
          agent_profile_version: session.agent_profile_version,
          identity_hash: session.identity_hash,
          updated_at: session.updated_at,
        }),
      ),
    }));
  const workspaceJids = new Set(workspaces.map((workspace) => workspace.jid));
  const channelMounts = listAgentChannelMountsForProfile(id)
    .filter((mount) => workspaceJids.has(mount.workspace_jid))
    .map((mount) => ({
      channel_jid: mount.channel_jid,
      channel_type: mount.channel_type,
      workspace_jid: mount.workspace_jid,
      workspace_folder: mount.workspace_folder,
      session_id: mount.session_id ?? null,
      routing_mode: mount.routing_mode,
      reply_policy: mount.reply_policy,
      activation_mode: mount.activation_mode,
      owner_im_id: mount.owner_im_id ?? null,
      updated_at: mount.updated_at,
    }));

  return c.json({ profile, workspaces, channel_mounts: channelMounts });
});

export default agentProfileRoutes;
