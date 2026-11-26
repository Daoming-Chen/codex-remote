import { render } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';

type KeyHandler = (event: KeyboardEvent) => void;

function filterOptions(panel: HTMLElement, query: string): string {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let matches = 0;
  for (const row of panel.querySelectorAll<HTMLButtonElement>(':scope > button')) {
    const recent = row.hasAttribute('data-recent');
    const label = [row.getAttribute('aria-label'), row.dataset.modelId].join(' ').toLowerCase();
    row.hidden = terms.length ? recent || !terms.every(term => label.includes(term)) : !recent;
    if (!row.hidden) matches++;
  }
  return !terms.length ? '最近使用的模型' : matches ? '匹配的模型' : '没有匹配的模型';
}
function ModelSearch({panel, onKey}: {panel: HTMLElement; onKey: KeyHandler}) {
  const [summary, setSummary] = useState('');
  useLayoutEffect(() => setSummary(filterOptions(panel, '')), [panel]);
  return <>
    <input class="model-command-search" type="text" placeholder="搜索模型" aria-label="搜索模型"
      onInput={event => setSummary(filterOptions(panel, event.currentTarget.value))}
      onKeyDown={onKey} />
    <span class="model-command-summary" role="status">{summary}</span>
  </>;
}
export function renderModelSearch(container: HTMLElement, panel: HTMLElement, onKey: KeyHandler) {
  render(null, container);
  container.replaceChildren();
  render(<ModelSearch panel={panel} onKey={onKey} />, container);
  return container.querySelector('input')!;
}
