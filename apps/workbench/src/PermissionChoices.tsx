import { render } from 'preact';

const labels = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'remote-workspace': '工作区写入（按需审批）',
  'danger-full-access': '完全访问',
} as const;
type Mode = keyof typeof labels;
const nativeModes: Mode[] = ['remote-workspace', 'danger-full-access'];
const daemonModes: Mode[] = ['read-only', 'workspace-write', 'danger-full-access'];

export function permissionLabel(mode: Mode) { return labels[mode] || labels['read-only'] }

interface PermissionProps {
  native: boolean;
  selected: Mode;
  ask: boolean;
  beforeSend: boolean;
  select: (mode: Mode) => void;
}
function PermissionChoices(props: PermissionProps) {
  return <>
    {props.native && props.beforeSend && <p class="quiet">请为这台主机选择任务权限，再发送草稿。</p>}
    {(props.native ? nativeModes : daemonModes).map(mode => {
      const checked = props.selected === mode && !(props.native && mode === 'danger-full-access' && props.ask);
      const name = permissionLabel(mode);
      return <button key={mode} type="button" class="modal-row" title={name} aria-label={name}
        aria-pressed={checked} onClick={() => props.select(mode)}>
        <svg aria-hidden="true"><use href="/icons.svg#shield" /></svg><span>{name}</span>
        {checked && <small>✓</small>}
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
