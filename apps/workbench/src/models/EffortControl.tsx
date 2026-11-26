import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

interface EffortControlProps {
  steps: string[];
  initial: string;
  label: (effort: string) => string;
  preview: (effort: string) => void;
  commit: (effort: string) => void;
  confirm: () => void;
}
function EffortControl(props: EffortControlProps) {
  const { steps, initial } = props;
  const [index, setIndex] = useState(Math.max(0, steps.indexOf(steps.includes(initial) ? initial : 'medium')));
  const committed = useRef(index);
  const fraction = index / Math.max(1, steps.length - 1);
  const warn = steps[index] === 'ultra' && steps.length > 1;
  const warning = '使用额度消耗更快';
  useLayoutEffect(() => props.preview(steps[index]), [props.preview, steps, index]);
  return <>
    <div class="effort-control">
      <div class="effort-ticks" aria-hidden="true"
        style={{'--selected-width': 'calc(' + fraction * 100 + '% + ' + (14 - 28 * fraction) + 'px)'}}>
        {steps.map((step, i) => <i key={step} data-selected={String(i <= index)} />)}
      </div>
      <input id="effort-slider" class="effort-slider" type="range" min={0} max={steps.length - 1}
        step={1} value={index} disabled={steps.length < 2} aria-label="强度"
        aria-describedby="effort-hint" aria-keyshortcuts="ArrowLeft ArrowRight"
        aria-valuetext={props.label(steps[index]) + '，第 ' + (index + 1) + ' 项，共 ' + steps.length + ' 项。' + (warn ? warning : '')}
        onInput={e => setIndex(e.currentTarget.valueAsNumber)}
        onPointerCancel={e => { e.currentTarget.valueAsNumber = committed.current; setIndex(committed.current) }}
        onChange={e => {
          const next = e.currentTarget.valueAsNumber;
          if (next === committed.current) return;
          committed.current = next;
          setIndex(next);
          props.commit(steps[next]);
        }}
        onKeyDown={e => {
          if (e.key !== 'Enter' || e.isComposing) return;
          e.preventDefault(); e.stopPropagation(); props.confirm();
        }} />
    </div>
    <span id="effort-hint" class="effort-hint">使用左右方向键调整强度</span>
    <p class="effort-usage-reminder" hidden={!warn}>{warning}</p>
  </>;
}
export function renderEffortControl(panel: HTMLElement, props: EffortControlProps) {
  const mount = document.createElement('div');
  mount.style.display = 'contents';
  panel.append(mount);
  render(<EffortControl {...props} />, mount);
  return mount.querySelector('.effort-control')!;
}
