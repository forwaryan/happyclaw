import { create } from 'zustand';
import { api } from '../api/client';
import type {
  AgentProfile,
  AgentProfileGovernance,
  AgentProfileRuntimePolicy,
  GroupInfo,
} from '../types';
import { useChatStore } from './chat';
import { useGroupsStore } from './groups';
import { buildWorkspaceAgentProfilePatch } from '../utils/agent-product';

interface AgentProfileDraft {
  name: string;
  identity_prompt: string;
}

interface AgentProfilesState {
  profiles: AgentProfile[];
  governanceByProfile: Record<string, AgentProfileGovernance | undefined>;
  governanceLoading: Record<string, boolean | undefined>;
  governanceErrors: Record<string, string | undefined>;
  loading: boolean;
  profilesError: string | null;
  error: string | null;
  loadProfiles: () => Promise<void>;
  loadProfileGovernance: (id: string) => Promise<AgentProfileGovernance>;
  generateProfileDraft: (description: string) => Promise<AgentProfileDraft>;
  createProfile: (data: {
    name: string;
    identity_prompt?: string;
    include_claude_preset?: boolean;
    runtime_policy?: AgentProfileRuntimePolicy;
  }) => Promise<AgentProfile>;
  updateProfile: (
    id: string,
    data: {
      name?: string;
      identity_prompt?: string;
      include_claude_preset?: boolean;
      runtime_policy?: AgentProfileRuntimePolicy;
    },
  ) => Promise<AgentProfile>;
  deleteProfile: (id: string) => Promise<void>;
  setWorkspaceAgentProfile: (jid: string, profileId: string) => Promise<void>;
}

export const useAgentProfilesStore = create<AgentProfilesState>((set, get) => ({
  profiles: [],
  governanceByProfile: {},
  governanceLoading: {},
  governanceErrors: {},
  loading: false,
  profilesError: null,
  error: null,

  loadProfiles: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ profiles: AgentProfile[] }>(
        '/api/agent-profiles',
      );
      set({
        profiles: data.profiles,
        loading: false,
        profilesError: null,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        loading: false,
        profilesError: message,
        error: message,
      });
    }
  },

  loadProfileGovernance: async (id) => {
    set((state) => ({
      governanceLoading: { ...state.governanceLoading, [id]: true },
      governanceErrors: { ...state.governanceErrors, [id]: undefined },
    }));
    try {
      const data = await api.get<AgentProfileGovernance>(
        `/api/agent-profiles/${encodeURIComponent(id)}/workspaces`,
      );
      set((state) => ({
        governanceByProfile: { ...state.governanceByProfile, [id]: data },
        governanceLoading: { ...state.governanceLoading, [id]: false },
        governanceErrors: { ...state.governanceErrors, [id]: undefined },
      }));
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        governanceLoading: { ...state.governanceLoading, [id]: false },
        governanceErrors: { ...state.governanceErrors, [id]: message },
      }));
      throw err;
    }
  },

  generateProfileDraft: async (description) => {
    try {
      const res = await api.post<{ draft: AgentProfileDraft }>(
        '/api/agent-profiles/generate',
        { description },
        60_000,
      );
      set({ error: null });
      return res.draft;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  createProfile: async (data) => {
    try {
      const res = await api.post<{ profile: AgentProfile }>(
        '/api/agent-profiles',
        data,
      );
      set((state) => ({
        profiles: [
          res.profile,
          ...state.profiles.filter((p) => p.id !== res.profile.id),
        ].sort((a, b) => Number(b.is_default) - Number(a.is_default)),
        error: null,
      }));
      await get().loadProfiles();
      return res.profile;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  updateProfile: async (id, data) => {
    try {
      const res = await api.patch<{ profile: AgentProfile }>(
        `/api/agent-profiles/${encodeURIComponent(id)}`,
        data,
      );
      set((state) => ({
        profiles: state.profiles.map((p) => (p.id === id ? res.profile : p)),
        governanceByProfile: {
          ...state.governanceByProfile,
          [id]: state.governanceByProfile[id]
            ? { ...state.governanceByProfile[id], profile: res.profile }
            : undefined,
        },
        error: null,
      }));
      await Promise.all([
        useChatStore.getState().loadGroups(),
        useGroupsStore.getState().loadGroups(),
      ]);
      return res.profile;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  deleteProfile: async (id) => {
    try {
      await api.delete(`/api/agent-profiles/${encodeURIComponent(id)}`);
      set((state) => ({
        profiles: state.profiles.filter((p) => p.id !== id),
        governanceByProfile: Object.fromEntries(
          Object.entries(state.governanceByProfile).filter(
            ([key]) => key !== id,
          ),
        ),
        governanceErrors: Object.fromEntries(
          Object.entries(state.governanceErrors).filter(([key]) => key !== id),
        ),
        error: null,
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  setWorkspaceAgentProfile: async (jid, profileId) => {
    try {
      const res = await api.patch<{
        success: boolean;
        agent_profile_id: string;
        agent_profile_name: string;
        agent_profile_version: number;
      }>(`/api/groups/${encodeURIComponent(jid)}/agent-profile`, {
        ...buildWorkspaceAgentProfilePatch(profileId),
      });
      const patchGroup = (group?: GroupInfo): GroupInfo | undefined =>
        group
          ? {
              ...group,
              agent_profile_id: res.agent_profile_id,
              agent_profile_name: res.agent_profile_name,
              agent_profile_version: res.agent_profile_version,
            }
          : group;

      useChatStore.setState((state) => {
        const patched = patchGroup(state.groups[jid]);
        if (!patched) return state;
        return { groups: { ...state.groups, [jid]: patched } };
      });
      useGroupsStore.setState((state) => {
        const patched = patchGroup(state.groups[jid]);
        if (!patched) return state;
        return { groups: { ...state.groups, [jid]: patched } };
      });
      set({ error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
}));
