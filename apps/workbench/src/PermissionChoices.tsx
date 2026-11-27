import { render } from 'preact';

const labels = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'remote-workspace': '请求批准',
  'ask-for-approval': '请求批准',
  'auto-review': '帮我批准',
  'danger-full-access': '完全访问',
} as const;
type Mode = keyof typeof labels;
const descriptions: Record<Mode, string> = {
  'remote-workspace': '编辑外部文件和使用互联网时始终询问',
  'ask-for-approval': '编辑外部文件和使用互联网时始终询问',
  'auto-review': '仅对检测到的风险操作请求批准',
  'danger-full-access': '可不受限制地访问互联网和主机上的任何文件',
  'read-only': '允许读取文件。',
  'workspace-write': '允许修改工作区内的文件。',
};
export function permissionIcon(mode: Mode) {
  if (mode === 'danger-full-access') return 'permission-full';
  if (mode === 'auto-review') return 'permission-review';
  if (mode === 'remote-workspace' || mode === 'ask-for-approval') return 'permission-ask';
  return 'shield';
}

export function permissionLabel(mode: Mode) { return labels[mode] || labels['read-only'] }

interface PermissionProps {
  native: boolean;
  selected: Mode;
  ask: boolean;
  autoReview: boolean;
  beforeSend: boolean;
  select: (mode: Mode) => void;
}
function PermissionChoices(props: PermissionProps) {
  const modes: Mode[] = [props.native ? 'remote-workspace' : 'ask-for-approval', 'auto-review', 'danger-full-access'];
  if (!props.native) modes.push('read-only', 'workspace-write');
  return <>
    {props.native && props.beforeSend && <p class="quiet">请为这台主机选择任务权限，再发送草稿。</p>}
    {modes.map(mode => {
      const checked = props.selected === mode && !(props.native && mode === 'danger-full-access' && props.ask);
      const name = mode === 'danger-full-access' ? '完全访问权限' : permissionLabel(mode);
      const disabled = mode === 'auto-review' && !props.autoReview;
      const description = disabled ? '当前主机连接未提供自动审批。' : descriptions[mode];
      return <button key={mode} type="button" class={'modal-row permission-option ' + (mode === 'danger-full-access' ? 'permission-full' : '')}
        aria-label={name} aria-description={description} disabled={disabled}
        aria-pressed={checked} onClick={() => props.select(mode)}>
        <svg aria-hidden="true"><use href={'/icons.svg#' + permissionIcon(mode)} /></svg>
        <span class="permission-text">{name}<span>{description}</span></span>
        {checked && <svg class="permission-check" aria-hidden="true"><use href="/icons.svg#check" /></svg>}
      </button>;
    })}
  </>;
}
export function renderPermissionChoices(container: HTMLElement, props: PermissionProps) {
  const mount = document.createElement('div');
  mount.style.display = 'contents';
  container.append(mount);
  render(<PermissionChoices {...props} />, mount);
}
