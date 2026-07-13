import { Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import type { Skill } from '../../stores/skills';
import { useSkillsStore } from '../../stores/skills';

interface SkillCardProps {
  skill: Skill;
  selected: boolean;
  onSelect: () => void;
}

const SOURCE_LABELS: Record<Skill['source'], string> = {
  user: '用户级',
  project: '项目级',
  external: '宿主机',
};

export function SkillCard({ skill, selected, onSelect }: SkillCardProps) {
  const toggleSkill = useSkillsStore((s) => s.toggleSkill);
  const isReadonly = skill.source !== 'user';

  return (
    <div
      className={`w-full text-left rounded-lg border p-4 transition-all ${
        selected
          ? 'ring-2 ring-ring bg-brand-50 border-primary'
          : 'border-border hover:bg-muted'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">
              {skill.name}
            </h3>
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${
                skill.source === 'user'
                  ? 'bg-brand-100 text-primary'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {SOURCE_LABELS[skill.source]}
            </span>
            {skill.userInvocable && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                可调用
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2">
            {skill.description}
          </p>
          {skill.packageName && (
            <p className="text-xs text-muted-foreground mt-1 font-mono truncate">
              {skill.packageName}
            </p>
          )}
        </button>

        {isReadonly && (
          <div
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title="此来源由系统或宿主机管理"
          >
            <Lock size={16} className="text-muted-foreground" />
            <Badge variant="outline">
              {skill.enabled ? '已启用' : '已停用'}
            </Badge>
          </div>
        )}

        {skill.source === 'user' && (
          <Switch
            checked={skill.enabled}
            onCheckedChange={(checked) => void toggleSkill(skill.id, checked)}
            aria-label={`${checkedLabel(skill.enabled)}技能 ${skill.name}`}
          />
        )}
      </div>
    </div>
  );
}

function checkedLabel(enabled: boolean): string {
  return enabled ? '停用' : '启用';
}
