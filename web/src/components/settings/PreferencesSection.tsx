import { useState } from 'react';
import {
  Bell,
  BellOff,
  CheckCircle2,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Sun,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  useTheme,
  type ColorScheme,
  type FontStyle,
  type Theme,
} from '../../hooks/useTheme';
import {
  isRouteRestoreEnabled,
  setRouteRestoreEnabled,
} from '../../utils/routeRestore';
import { SettingsCard as Section } from './SettingsCard';

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

const SCHEME_OPTIONS: {
  value: ColorScheme;
  label: string;
  preview: { bg: string; accent: string; text: string };
}[] = [
  {
    value: 'default',
    label: '经典绿',
    preview: { bg: '#f8fafc', accent: '#0d9488', text: '#0f172a' },
  },
  {
    value: 'orange',
    label: '暖橙',
    preview: { bg: '#faf9f5', accent: '#f97316', text: '#141413' },
  },
  {
    value: 'neutral',
    label: '素白',
    preview: { bg: '#fafafa', accent: '#52525b', text: '#18181b' },
  },
];

const FONT_OPTIONS: {
  value: FontStyle;
  label: string;
  sample: string;
  fontFamily: string;
}[] = [
  {
    value: 'default',
    label: 'HappyClaw',
    sample: 'Hello 你好',
    fontFamily: "'Inter Variable', system-ui, sans-serif",
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    sample: 'Hello 你好',
    fontFamily: "Georgia, 'Noto Serif SC', serif",
  },
];

function OptionButton({
  active,
  onClick,
  children,
  className = '',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-11 rounded-xl border-2 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-muted-foreground/40'
      } ${className}`}
    >
      {children}
    </button>
  );
}

function DesktopNotificationSection() {
  const supported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : 'denied',
  );

  const handleRequest = async () => {
    if (!supported) return;
    setPermission(await Notification.requestPermission());
  };

  return (
    <Section
      icon={Bell}
      title="桌面通知"
      desc="当前设备：对话任务完成时通过浏览器通知提醒你"
    >
      {!supported ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <BellOff className="size-4 shrink-0" />
          当前浏览器不支持桌面通知
        </div>
      ) : permission === 'granted' ? (
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="size-4 shrink-0" />
          当前设备已允许桌面通知
        </div>
      ) : permission === 'denied' ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-warning">
            <BellOff className="size-4 shrink-0" />
            当前浏览器已拒绝通知权限
          </div>
          <p className="text-xs text-muted-foreground">
            请在浏览器的网站权限中允许通知，然后刷新页面。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            页面位于后台或你切换到其他会话时，任务完成会发送系统通知。
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRequest}
          >
            <Bell className="size-3.5" />
            允许当前设备通知
          </Button>
        </div>
      )}
    </Section>
  );
}

function RouteRestoreSection() {
  const [enabled, setEnabled] = useState(() => isRouteRestoreEnabled());

  const handleChange = (next: boolean) => {
    setEnabled(next);
    setRouteRestoreEnabled(next);
  };

  return (
    <Section
      icon={RotateCcw}
      title="恢复上次页面"
      desc="当前设备：再次打开 PWA 时回到上次访问的页面"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="route-restore" className="text-sm text-foreground">
            记住当前设备的最后访问位置
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">
            关闭后，每次重新打开都进入默认主页。
          </p>
        </div>
        <Switch
          id="route-restore"
          checked={enabled}
          onCheckedChange={handleChange}
        />
      </div>
    </Section>
  );
}

export function PreferencesSection() {
  const {
    theme,
    setTheme,
    colorScheme,
    setColorScheme,
    fontStyle,
    setFontStyle,
  } = useTheme();

  return (
    <div className="space-y-4">
      <Section
        icon={Palette}
        title="界面外观"
        desc="当前设备：主题、配色和字体不会同步到其他浏览器"
      >
        <div>
          <Label className="mb-2 text-xs text-muted-foreground">配色方案</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {SCHEME_OPTIONS.map((option) => (
              <OptionButton
                key={option.value}
                active={colorScheme === option.value}
                onClick={() => setColorScheme(option.value)}
                className="flex flex-col gap-2 p-2.5"
              >
                <div
                  className="flex h-10 w-full items-end gap-1 rounded-lg border border-border/60 p-1.5"
                  style={{ background: option.preview.bg }}
                >
                  <div
                    className="size-4 rounded-full"
                    style={{ background: option.preview.accent }}
                  />
                  <div className="flex-1 space-y-0.5">
                    <div
                      className="h-1 w-3/4 rounded-full opacity-60"
                      style={{ background: option.preview.text }}
                    />
                    <div
                      className="h-1 w-1/2 rounded-full opacity-25"
                      style={{ background: option.preview.text }}
                    />
                  </div>
                </div>
                <span className="text-xs font-medium text-foreground">
                  {option.label}
                </span>
              </OptionButton>
            ))}
          </div>
        </div>

        <div>
          <Label className="mb-2 text-xs text-muted-foreground">明暗模式</Label>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <OptionButton
                  key={option.value}
                  active={theme === option.value}
                  onClick={() => setTheme(option.value)}
                  className="flex flex-col items-center gap-1 px-2 py-2.5"
                >
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">
                    {option.label}
                  </span>
                </OptionButton>
              );
            })}
          </div>
        </div>

        <div>
          <Label className="mb-2 text-xs text-muted-foreground">字体风格</Label>
          <div className="grid grid-cols-2 gap-2">
            {FONT_OPTIONS.map((option) => (
              <OptionButton
                key={option.value}
                active={fontStyle === option.value}
                onClick={() => setFontStyle(option.value)}
                className="flex flex-col gap-1.5 p-2.5"
              >
                <span
                  className="truncate text-sm leading-snug text-foreground"
                  style={{ fontFamily: option.fontFamily }}
                >
                  {option.sample}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {option.label}
                </span>
              </OptionButton>
            ))}
          </div>
        </div>
      </Section>

      <DesktopNotificationSection />
      <RouteRestoreSection />
    </div>
  );
}
