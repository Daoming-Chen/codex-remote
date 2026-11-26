import { render } from 'preact';
export { renderAttachments } from './AttachmentTray.js';

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
