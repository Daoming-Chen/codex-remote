import { render } from 'preact';
import { useRef, useState } from 'preact/hooks';

interface Tier {
  id: string;
  name: string;
  description?: string;
}
interface SpeedMenuProps {
  unavailable?: boolean;
  tiers: Tier[];
  choice?: string;
  effective?: Tier;
  iconFor: (id?: string) => string;
  position: (menu: HTMLElement) => void;
  select: (id: string) => void;
}
const nativePopover = typeof HTMLElement.prototype.showPopover === 'function' &&
  typeof HTMLElement.prototype.hidePopover === 'function' && CSS.supports('selector(:popover-open)');

export function speedMenuOpen(panel?: HTMLElement | null) {
  return panel instanceof HTMLDialogElement ? panel.open : !!panel && nativePopover && panel.matches(':popover-open');
}
export function dismissSpeedMenu(panel?: HTMLElement | null) {
  if (!panel || !speedMenuOpen(panel)) return false;
  if (panel instanceof HTMLDialogElement) panel.close();
  else panel.hidePopover();
  return true;
}
function SpeedMenu(props: SpeedMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
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
    if (dismissSpeedMenu(panel)) return;
    if (panel instanceof HTMLDialogElement) panel.showModal();
    else panel.showPopover();
    setExpanded(true);
    props.position(panel);
    panel.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus();
  }
  const Flyout = nativePopover ? 'div' : 'dialog';
  return <>
    <button ref={trigger} type="button" class="icon speed-trigger" aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={expanded} data-fast={String(!!speed && speed !== 'default')}
      onClick={toggle} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); toggle() } }}>
      <svg aria-hidden="true"><use href={'/icons.svg#' + props.iconFor(speed)} /></svg>
    </button>
    <Flyout ref={(node: HTMLElement | null) => {menu.current=node}} class="speed-flyout" popover={nativePopover ? 'auto' : undefined} aria-label="速度"
      onToggle={e => setExpanded(speedMenuOpen(e.currentTarget))}
      onClose={e => setExpanded(speedMenuOpen(e.currentTarget))}
      onClick={e => {
        const node=e.currentTarget;
        if (!(node instanceof HTMLDialogElement) || e.target!==node) return;
        const bounds=node.getBoundingClientRect();
        if (e.clientX<bounds.left || e.clientX>bounds.right || e.clientY<bounds.top || e.clientY>bounds.bottom) {
          node.close(); trigger.current?.focus();
        }
      }}
      onKeyDown={e => {
        if (e.key === 'Escape' || e.key === 'ArrowLeft') {
          e.preventDefault(); e.stopPropagation();
          dismissSpeedMenu(menu.current); trigger.current!.focus(); return;
        }
        const options = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const i = options.findIndex(option => option === document.activeElement);
        const next: Record<string, number> = {Home: 0, End: options.length - 1,
          ArrowDown: (i + 1) % options.length, ArrowUp: (i + options.length - 1) % options.length};
        if (Object.hasOwn(next, e.key)) { e.preventDefault(); options[next[e.key]].focus() }
      }}>
      <div role="menu" aria-label="速度">
        {props.unavailable && <p class="quiet">当前主机的 Remote 插件只支持沿用主机速度。</p>}
        {tiers.map(tier => <button disabled={props.unavailable && !!tier.id} key={tier.id} type="button" class="modal-row" role="menuitemradio"
          aria-label={tier.name} aria-checked={tier === selected} aria-description={tier.description}
          onClick={() => { dismissSpeedMenu(menu.current); props.select(tier.id) }}>
          <span>{tier.name}{tier.description && <span class="model-default-description">{tier.description}</span>}</span>
          {tier === selected && <svg aria-hidden="true"><use href="/icons.svg#check" /></svg>}
        </button>)}
      </div>
    </Flyout>
  </>;
}
export function renderSpeedMenu(header: HTMLElement, props: SpeedMenuProps) {
  const mount = document.createElement('div');
  mount.style.display = 'contents';
  header.append(mount);
  render(<SpeedMenu {...props} />, mount);
}
