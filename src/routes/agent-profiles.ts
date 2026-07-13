import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Variables } from '../web-context.js';
import { getWebDeps } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  AgentProfileCreateSchema,
  AgentProfileGenerateSchema,
  AgentProfilePatchSchema,
  AgentProfileRefinePromptSchema,
  AgentProfileRuntimePolicySchema,
} from '../schemas.js';
import type { AuthUser } from '../types.js';
import {
  generateAgentProfileDraft,
  refineAgentProfilePrompt,
} from '../agent-profile-generator.js';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';
import { buildAgentCapabilityPreview } from '../agent-capability-preview.js';
import { loadUserMcpServers } from '../mcp-utils.js';
import { validateSkillId } from '../skill-utils.js';
import {
  listWorkspaceGroupsForAgentProfile,
  quiesceWorkspaceRunnersAroundCommit,
  resolveEffectiveAgentProfile,
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
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const MAX_AVATAR_SIZE = 3 * 1024 * 1024;
const AVATAR_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function removeProfileAvatarFiles(profileId: string, keep?: string): void {
  if (!fs.existsSync(AVATARS_DIR)) return;
  const prefix = `agent-profile-${profileId}-`;
  for (const filename of fs.readdirSync(AVATARS_DIR)) {
    if (!filename.startsWith(prefix) || filename === keep) continue;
    fs.rmSync(path.join(AVATARS_DIR, filename), { force: true });
  }
}

function requestsHostClaudeContext(
  runtimePolicy: { context?: { source?: string } } | undefined,
): boolean {
  return runtimePolicy?.context?.source === 'host_claude';
}

function isUnauthorizedHostClaudeContext(
  user: AuthUser,
  runtimePolicy: { context?: { source?: string } } | undefined,
): boolean {
  return user.role !== 'admin' && requestsHostClaudeContext(runtimePolicy);
}

function validateRuntimePolicyReferences(
  userId: string,
  policy: ReturnType<typeof normalizeAgentProfileRuntimePolicy>,
): { skills: string[]; mcp: string[] } {
  const invalid = {
    skills: [] as string[],
    mcp: [] as string[],
  };

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
  return invalid.skills.length + invalid.mcp.length > 0;
}

agentProfileRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const profiles = listAgentProfilesForUser(user.id);
  return c.json({
    profiles: profiles.map((profile) => ({
      ...profile,
      // Persisted policy is kept for editing. The effective policy includes
      // system defaults and the current role check used at execution time.
      effective_runtime_policy:
        resolveEffectiveAgentProfile(profile)?.runtime_policy ??
        profile.runtime_policy,
    })),
  });
});

agentProfileRoutes.post('/', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfileCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  if (isUnauthorizedHostClaudeContext(user, parsed.data.runtime_policy)) {
    return c.json({ error: 'host_claude context requires an admin role' }, 403);
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
    avatarEmoji: parsed.data.avatar_emoji,
    avatarColor: parsed.data.avatar_color,
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

agentProfileRoutes.post(
  '/:id/effective-capabilities',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const id = c.req.param('id');
    const existing = getAgentProfileForUser(id, user.id);
    if (!existing) return c.json({ error: 'Agent profile not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const parsedPolicy =
      body.runtime_policy === undefined
        ? { success: true as const, data: undefined }
        : AgentProfileRuntimePolicySchema.safeParse(body.runtime_policy);
    if (!parsedPolicy.success)
      return c.json({ error: 'Invalid runtime policy' }, 400);
    if (isUnauthorizedHostClaudeContext(user, parsedPolicy.data)) {
      return c.json(
        { error: 'host_claude context requires an admin role' },
        403,
      );
    }

    const previewProfile = resolveEffectiveAgentProfile({
      ...existing,
      runtime_policy:
        parsedPolicy.data === undefined
          ? existing.runtime_policy
          : mergeAgentProfileRuntimePolicy(
              existing.runtime_policy,
              parsedPolicy.data,
            ),
    })!;
    const workspaceJid =
      typeof body.workspace_jid === 'string' && body.workspace_jid.trim()
        ? body.workspace_jid.trim()
        : undefined;
    let workspace:
      | {
          jid: string;
          group: ReturnType<typeof getAllRegisteredGroups>[string];
        }
      | undefined;
    if (workspaceJid) {
      const group = getAllRegisteredGroups()[workspaceJid];
      const defaultProfile = getOrCreateDefaultAgentProfile(user.id);
      const mappedProfileId = group
        ? (getWorkspaceAgentProfileId(group.folder) ?? defaultProfile.id)
        : undefined;
      if (
        !group ||
        !workspaceJid.startsWith('web:') ||
        group.created_by !== user.id ||
        mappedProfileId !== id
      ) {
        return c.json(
          { error: 'Workspace does not belong to this Agent' },
          400,
        );
      }
      workspace = { jid: workspaceJid, group };
    }

    return c.json({
      preview: buildAgentCapabilityPreview({
        profile: previewProfile,
        workspace,
      }),
    });
  },
);

agentProfileRoutes.post('/:id/avatar', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const profile = getAgentProfileForUser(id, user.id);
  if (!profile) return c.json({ error: 'Agent profile not found' }, 404);
  if (profile.is_default) {
    return c.json(
      { error: 'Configure the main HappyClaw avatar in system settings' },
      400,
    );
  }
  if (!(c.req.header('content-type') || '').includes('multipart/form-data')) {
    return c.json({ error: 'Expected multipart/form-data' }, 400);
  }
  const formData = await c.req.formData();
  const file = formData.get('avatar');
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No avatar file provided' }, 400);
  }
  if (file.size > MAX_AVATAR_SIZE) {
    return c.json({ error: 'File too large (max 3MB)' }, 400);
  }
  const extension = AVATAR_EXTENSIONS[file.type];
  if (!extension) {
    return c.json(
      { error: 'Unsupported image type. Use jpg, png, gif or webp' },
      400,
    );
  }

  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  const filename = `agent-profile-${id}-${randomBytes(4).toString('hex')}${extension}`;
  const destination = path.join(AVATARS_DIR, filename);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, Buffer.from(await file.arrayBuffer()));
  fs.renameSync(temporary, destination);
  const avatarUrl = `/api/auth/avatars/${filename}`;
  const updated = updateAgentProfile(id, user.id, { avatarUrl });
  removeProfileAvatarFiles(id, filename);
  return c.json({ profile: updated, avatarUrl });
});

agentProfileRoutes.delete('/:id/avatar', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const profile = getAgentProfileForUser(id, user.id);
  if (!profile) return c.json({ error: 'Agent profile not found' }, 404);
  if (profile.is_default) {
    return c.json(
      { error: 'Configure the main HappyClaw avatar in system settings' },
      400,
    );
  }
  const updated = updateAgentProfile(id, user.id, { avatarUrl: null });
  removeProfileAvatarFiles(id);
  return c.json({ profile: updated });
});

agentProfileRoutes.post('/:id/refine-prompt', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const profile = getAgentProfileForUser(id, user.id);
  if (!profile) return c.json({ error: 'Agent profile not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfileRefinePromptSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  try {
    const refinement = await refineAgentProfilePrompt({
      agentName: profile.name,
      currentPrompt: parsed.data.current_prompt,
      message: parsed.data.message,
      history: parsed.data.history,
    });
    return c.json({ refinement });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'AI 调整失败，请重试或手动修改';
    logger.warn(
      {
        err,
        agentProfileId: id,
        messageLen: parsed.data.message.length,
      },
      'Failed to refine Agent profile prompt',
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
  if (isUnauthorizedHostClaudeContext(user, parsed.data.runtime_policy)) {
    return c.json({ error: 'host_claude context requires an admin role' }, 403);
  }
  if (
    parsed.data.name === undefined &&
    parsed.data.identity_prompt === undefined &&
    parsed.data.include_claude_preset === undefined &&
    parsed.data.avatar_emoji === undefined &&
    parsed.data.avatar_color === undefined &&
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

    const sensitiveConfigurationChanged =
      (parsed.data.name !== undefined && parsed.data.name !== existing.name) ||
      (parsed.data.identity_prompt !== undefined &&
        parsed.data.identity_prompt !== existing.identity_prompt) ||
      (parsed.data.include_claude_preset !== undefined &&
        parsed.data.include_claude_preset !== existing.include_claude_preset) ||
      (parsed.data.runtime_policy !== undefined &&
        JSON.stringify(effectiveRuntimePolicy) !==
          JSON.stringify(
            normalizeAgentProfileRuntimePolicy(existing.runtime_policy),
          ));

    let invalidatedRuntimeJids = 0;
    const commit = () =>
      updateAgentProfile(id, user.id, {
        name: parsed.data.name,
        identityPrompt: parsed.data.identity_prompt,
        includeClaudePreset: parsed.data.include_claude_preset,
        avatarEmoji: parsed.data.avatar_emoji,
        avatarColor: parsed.data.avatar_color,
        runtimePolicy: parsed.data.runtime_policy,
      });
    let profile;
    const deps = getWebDeps();
    const workspaces = sensitiveConfigurationChanged
      ? listWorkspaceGroupsForAgentProfile(user.id, id)
      : [];
    if (sensitiveConfigurationChanged && deps && workspaces.length > 0) {
      try {
        const result = await quiesceWorkspaceRunnersAroundCommit(
          deps,
          workspaces.map((workspace) => ({
            folder: workspace.group.folder,
            primaryJid: workspace.jid,
          })),
          { reason: `Agent profile ${id} sensitive configuration changed` },
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
      return c.json(
        { error: 'The built-in HappyClaw Agent cannot be deleted' },
        400,
      );
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
