import { render } from 'preact';

interface ModelOption {
  key: string;
  name: string;
  checked: boolean;
  description?: string;
  retirementAt?: number;
  disabled?: boolean;
  projectDefault?: boolean;
  shortcut?: number;
  tier?: string;
  modelId?: string;
  select: () => void;
}
function Option({ option, command }: {option: ModelOption; command: boolean}) {
  const date = Number.isSafeInteger(option.retirementAt) ? new Date(option.retirementAt! * 1000) : null;
  const retirement = date && Number.isFinite(date.getTime())
    ? '将于' + date.toLocaleDateString('zh-CN', {month: 'long', day: 'numeric', timeZone: 'UTC'}) + '下线' : '';
  const details = [retirement, option.description, option.tier].filter(Boolean).join(' · ');
  const subtitle = retirement || (option.projectDefault ? option.description : '');
  return <button type="button" class="modal-row" role="menuitemradio" aria-label={option.name}
    aria-checked={option.checked} aria-description={details || undefined} disabled={option.disabled}
    data-project-default={option.projectDefault ? '' : undefined} data-model-id={option.modelId}
    data-recent={option.shortcut ? '' : undefined} title={retirement ? option.description : undefined}
    onClick={option.select}>
    {option.shortcut && <kbd class="recent-key">{option.shortcut}</kbd>}
    <span class="model-option-label"><span class="model-option-name" title={option.name}>{option.name}</span>
      {subtitle && <span class="model-default-description">{subtitle}</span>}
    </span>
    {option.checked && !command && <svg aria-hidden="true"><use href="/icons.svg#check" /></svg>}
    {option.tier && <small class="recent-tier">{option.tier}</small>}
  </button>;
}
export function renderModelOptions(panel: HTMLElement, options: ModelOption[], command: boolean) {
  render(<>{options.map(option => <Option key={option.key} option={option} command={command} />)}</>, panel);
}
export function clearModelOptions(panel: HTMLElement) {
  render(null, panel);
}
