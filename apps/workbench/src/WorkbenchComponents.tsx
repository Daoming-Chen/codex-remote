import { render } from 'preact';
export { renderAttachments } from './AttachmentTray.js';

export function renderHomePanelToggle(container: HTMLElement, visible: boolean, pressed: boolean, toggle: () => void) {
  render(visible ? <button class="icon" type="button" aria-label="切换侧面板" title="切换侧面板"
    aria-controls="workbench" aria-pressed={pressed} onClick={toggle}>
    <svg aria-hidden="true" style={{ transform: 'scaleX(-1)' }}><use href="/icons.svg#panel-left" /></svg>
  </button> : null, container);
}

interface WelcomeProps {
  project?: string;
  cwd?: string;
  hasGitRoot?: boolean;
}
function WelcomeTitle({ project, cwd, hasGitRoot }: WelcomeProps) {
  if (!project) return <>我们要构建什么？</>;
  return <>{hasGitRoot ? '你想让我们在 ' : '我们应该在'}
    <button type="button" class="hero-project" data-action="project" aria-haspopup="dialog" title={cwd || project}>{project}</button>
    {hasGitRoot ? ' 中构建什么？' : '中做些什么？'}</>;
}
export function renderWelcome(container: HTMLElement, props: WelcomeProps) {
  render(<WelcomeTitle {...props} />, container);
}

export { sameConfiguration, recentModelChoices } from './models/configurations.js';
export { renderModelSearch } from './models/ModelSearch.js';
export { renderEffortControl } from './models/EffortControl.js';
export { renderSpeedMenu } from './models/SpeedMenu.js';
export { renderModelOptions, clearModelOptions } from './models/ModelOptions.js';
export { permissionLabel, renderPermissionChoices } from './PermissionChoices.js';
