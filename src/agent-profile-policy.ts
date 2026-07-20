import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { loadManagedMcpLayers, resolveManagedMcpPolicy } from './mcp-utils.js';
import { validateSkillId } from './skill-utils.js';
import type { AgentProfileRuntimePolicy, AuthUser } from './types.js';

export function requestsHostClaudeContext(
  runtimePolicy: { context?: { source?: string } } | undefined,
): boolean {
  return runtimePolicy?.context?.source === 'host_claude';
}

export function isUnauthorizedHostClaudeContext(
  user: Pick<AuthUser, 'role'>,
  runtimePolicy: { context?: { source?: string } } | undefined,
): boolean {
  return user.role !== 'admin' && requestsHostClaudeContext(runtimePolicy);
}

export function validateRuntimePolicyReferences(
  userId: string,
  policy: AgentProfileRuntimePolicy,
  allowAdminOnlySystemMcp: boolean,
): { skills: string[]; mcp: string[]; restricted_system_mcp: string[] } {
  const invalid = {
    skills: [] as string[],
    mcp: [] as string[],
    restricted_system_mcp: [] as string[],
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
    const layers = loadManagedMcpLayers(userId, {
      allowAdminOnlySystemMcp,
    });
    invalid.mcp.push(...resolveManagedMcpPolicy(layers, policy.mcp).missing);
    if (!allowAdminOnlySystemMcp) {
      const restricted = new Set(layers.restrictedSystemIds);
      invalid.restricted_system_mcp.push(
        ...policy.mcp.ids.filter((reference) => {
          if (!reference.startsWith('system:')) return false;
          return restricted.has(reference.slice('system:'.length));
        }),
      );
    }
  }
  return invalid;
}

export function hasInvalidRuntimePolicyReferences(
  invalid: ReturnType<typeof validateRuntimePolicyReferences>,
): boolean {
  return invalid.skills.length + invalid.mcp.length > 0;
}
