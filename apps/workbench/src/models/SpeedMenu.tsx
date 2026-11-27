import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

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
  const hoverTimer = useRef<number | undefined>(undefined);
  const openedByHover = useRef(false);
  const stopTracking = useRef<(() => void) | undefined>(undefined);
  const standard = {id: 'default', name: '标准', description: '默认速度'};
  const tiers = [standard, ...props.tiers.filter(tier => tier.id && tier.id !== 'default').map(tier => {
    if (tier.id === 'ultrafast') return {...tier, name: '超快', description: tier.description || '为时延敏感型任务提供最快响应'};
    if (!isFast(tier)) return tier;
    const multiplier = tier.description?.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*speed(?:,\s*(increased usage))?\.?$/i);
    const description = multiplier ? multiplier[1] + ' 倍速度' + (multiplier[2] ? '，用量更多' : '') :
      tier.description || '1.5 倍速度，用量更多';
    return {...tier, name: '快速', description};
  })];
  const selected = tiers.find(tier => tier.id === (props.choice || props.effective?.id)) || standard;
  const fast = tiers.find(isFast);
  const submenu = tiers.some(tier => tier.id !== 'default' && !isFast(tier));
  const active = selected.id !== 'default';
  const label = submenu ? '速度 ' + selected.name : active ? '启用标准模式' : '启用快速模式';
  const hint = props.unavailable ? '当前主机的 Remote 插件只支持沿用主机速度。' : submenu ? label : fast?.description;
  function isFast(tier: Tier) {
    return tier.id === 'priority' || tier.id === 'fast' || /^fast$/i.test(tier.name) || tier.name === '快速';
  }
  function cancelHover() {
    window.clearTimeout(hoverTimer.current);
    stopTracking.current?.();
    stopTracking.current = undefined;
  }
  useEffect(() => cancelHover, []);
  function open(focus: boolean) {
    cancelHover();
    const panel = menu.current;
    if (!panel?.isConnected || !trigger.current?.closest('dialog[open]')) return;
    if (speedMenuOpen(panel)) {
      if (focus) {
        openedByHover.current = false;
        panel.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus();
      }
      return;
    }
    openedByHover.current = !focus;
    if (panel instanceof HTMLDialogElement) panel.showModal();
    else panel.showPopover();
    setExpanded(true);
    props.position(panel);
    if (focus) panel.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus();
  }
  function leave(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    cancelHover();
    if (!openedByHover.current || !speedMenuOpen(menu.current)) return;
    const target = e.relatedTarget;
    if (target instanceof Node && (menu.current?.contains(target) || trigger.current?.contains(target))) return;
    const destination = e.currentTarget === trigger.current ? menu.current : trigger.current;
    if (!destination) return;
    const bounds = destination.getBoundingClientRect();
    const edgeX = bounds.left >= e.clientX ? bounds.left : bounds.right;
    const close = () => { cancelHover(); dismissSpeedMenu(menu.current) };
    const arm = () => {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(close, 100);
    };
    const track = (move: PointerEvent) => {
      if (destination.contains(move.target as Node)) { cancelHover(); return }
      const fraction = (move.clientX - e.clientX) / (edgeX - e.clientX);
      const top = e.clientY + fraction * (bounds.top - e.clientY);
      const bottom = e.clientY + fraction * (bounds.bottom - e.clientY);
      if (fraction >= 0 && fraction <= 1 && move.clientY >= top - 3 && move.clientY <= bottom + 3) arm();
      else close();
    };
    document.addEventListener('pointermove', track);
    stopTracking.current = () => document.removeEventListener('pointermove', track);
    arm();
  }
  const Flyout = nativePopover ? 'div' : 'dialog';
  return <>
    <button ref={trigger} type="button" class="icon speed-trigger" aria-label={label} title={hint}
      disabled={props.unavailable || tiers.length === 1} aria-description={hint}
      role={submenu ? 'menuitem' : 'menuitemcheckbox'} aria-checked={submenu ? undefined : active}
      aria-haspopup={submenu ? 'menu' : undefined} aria-expanded={submenu ? expanded : undefined} data-fast={String(active)}
      onPointerEnter={e => { if (submenu && !props.unavailable && e.pointerType === 'mouse') {
        cancelHover(); hoverTimer.current = window.setTimeout(() => open(false), 200);
      } }}
      onPointerLeave={leave}
      onClick={() => {
        cancelHover();
        if (!submenu && fast) props.select(active ? standard.id : fast.id);
        else if (openedByHover.current || !dismissSpeedMenu(menu.current)) open(true);
      }}
      onKeyDown={e => { if (submenu && ['ArrowRight', 'ArrowDown', 'Enter', ' '].includes(e.key)) {
        e.preventDefault(); e.stopPropagation(); open(true);
      } }}>
      <span class="speed-trigger-content"><svg aria-hidden="true"><use href={'/icons.svg#' + props.iconFor(isFast(selected) ? 'priority' : selected.id)} /></svg></span>
    </button>
    {submenu && !props.unavailable && <Flyout ref={(node: HTMLElement | null) => {menu.current=node}} class="speed-flyout" popover={nativePopover ? 'auto' : undefined} aria-label="速度"
      onPointerEnter={cancelHover} onPointerLeave={leave}
      onPointerDown={() => { openedByHover.current = false; cancelHover() }}
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
        openedByHover.current = false; cancelHover();
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
        {tiers.map(tier => <button key={tier.id} type="button" class="modal-row speed-option" role="menuitemradio"
          aria-label={tier.name} aria-checked={tier === selected} aria-description={tier.description}
          onClick={() => { dismissSpeedMenu(menu.current); props.select(tier.id) }}>
          <span class="speed-option-label">{tier.name}{tier.description && <span class="model-default-description">{tier.description}</span>}</span>
          {tier === selected && <svg aria-hidden="true"><use href="/icons.svg#check" /></svg>}
        </button>)}
      </div>
    </Flyout>}
  </>;
}
export function renderSpeedMenu(header: HTMLElement, props: SpeedMenuProps) {
  const mount = document.createElement('div');
  mount.style.display = 'contents';
  header.append(mount);
  render(<SpeedMenu {...props} />, mount);
}
