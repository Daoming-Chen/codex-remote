import { render } from 'preact';
import { useRef, useState } from 'preact/hooks';

interface Tier {
  id: string;
  name: string;
  description?: string;
}
interface SpeedMenuProps {
  tiers: Tier[];
  choice?: string;
  effective?: Tier;
  iconFor: (id?: string) => string;
  position: (menu: HTMLElement) => void;
  select: (id: string) => void;
}
function SpeedMenu(props: SpeedMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const tiers: Tier[] = [
    {id: '', name: '沿用主机设置'},
    {id: 'default', name: '标准'},
    ...props.tiers.filter(tier => tier.id !== 'default'),
  ];
  const selected = tiers.find(tier => tier.id === props.choice) || tiers[0];
  if (!selected.id && props.effective) selected.description = props.effective.name;
  const speed = selected.id || props.effective?.id;
  const label = ['速度', selected.name, !selected.id && selected.description].filter(Boolean).join(' · ');
  function toggle() {
    const panel = menu.current!;
    if (panel.matches(':popover-open')) { panel.hidePopover(); return }
    panel.showPopover();
    props.position(panel);
    panel.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus();
  }
  return <>
    <button ref={trigger} type="button" class="icon speed-trigger" aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={expanded} data-fast={String(!!speed && speed !== 'default')}
      onClick={toggle} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); toggle() } }}>
      <svg aria-hidden="true"><use href={'/icons.svg#' + props.iconFor(speed)} /></svg>
    </button>
    <div ref={menu} class="speed-flyout" popover="auto" role="menu" aria-label="速度"
      onToggle={e => setExpanded(e.currentTarget.matches(':popover-open'))}
      onKeyDown={e => {
        if (e.key === 'Escape' || e.key === 'ArrowLeft') {
          e.preventDefault(); e.stopPropagation();
          menu.current!.hidePopover(); trigger.current!.focus(); return;
        }
        const options = Array.from(e.currentTarget.querySelectorAll('button'));
        const i = options.findIndex(option => option === document.activeElement);
        const next: Record<string, number> = {Home: 0, End: options.length - 1,
          ArrowDown: (i + 1) % options.length, ArrowUp: (i + options.length - 1) % options.length};
        if (Object.hasOwn(next, e.key)) { e.preventDefault(); options[next[e.key]].focus() }
      }}>
      {tiers.map(tier => <button key={tier.id} type="button" class="modal-row" role="menuitemradio"
        aria-label={tier.name} aria-checked={tier === selected} aria-description={tier.description}
        onClick={() => { menu.current!.hidePopover(); props.select(tier.id) }}>
        <span>{tier.name}{tier.description && <span class="model-default-description">{tier.description}</span>}</span>
        {tier === selected && <svg aria-hidden="true"><use href="/icons.svg#check" /></svg>}
      </button>)}
    </div>
  </>;
}
export function renderSpeedMenu(header: HTMLElement, props: SpeedMenuProps) {
  const mount = document.createElement('div');
  mount.style.display = 'contents';
  header.append(mount);
  render(<SpeedMenu {...props} />, mount);
}
