import MarkdownIt from 'markdown-it';
import {tasklist} from '@mdit/plugin-tasklist';
import {tex} from '@mdit/plugin-tex';
import {ParseError, renderToString} from 'katex';

declare global {
  interface Window {
    renderMarkdown: (text: string) => string;
    renderMarkdownBlocks: (text: string, streaming?: boolean) => string[];
  }
}
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.disable('image');
markdown.use(tasklist, {label:false});
markdown.use(tex, {
  delimiters: 'all',
  mathFence: true,
  render(source, displayMode, environment) {
    const streaming = 'streaming' in environment && environment.streaming === true;
    try {
      return renderToString(source, {displayMode, throwOnError:streaming, trust:false, maxSize:20});
    } catch (error) {
      if (streaming && error instanceof ParseError) return '';
      throw error;
    }
  },
});

// The block rules handle standalone equations. Codex also accepts these
// delimiters inside a paragraph, where the expression uses inline math.
const bracketEquation = /\\\[((?:[^\\\n]|\\(?!\])[^\n])+)\\\]/y;
const dollarEquation = /\$\$(?!\$)((?:[^$\\\n]|\\[^\n]|\$(?!\$))+)\$\$(?!\$)/y;
markdown.inline.ruler.before('escape', 'codex_inline_equation', (state, silent) => {
  const opening = state.src.slice(state.pos, state.pos + 2);
  const rule = opening === '\\[' ? bracketEquation : opening === '$$' ? dollarEquation : null;
  if (!rule || (opening === '$$' && state.src[state.pos - 1] === '$')) return false;
  rule.lastIndex = state.pos;
  const match = rule.exec(state.src);
  if (!match || rule.lastIndex > state.posMax) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.markup = opening;
    token.content = match[1];
  }
  state.pos = rule.lastIndex;
  return true;
});

window.renderMarkdown = text => markdown.render(text);
window.renderMarkdownBlocks = (text, streaming = true) => {
  const environment = {streaming};
  const tokens = markdown.parse(text, environment);
  const blocks: string[] = [];
  let start = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].level !== 0 || tokens[index].nesting === 1) continue;
    const block = markdown.renderer.render(tokens.slice(start, index + 1), markdown.options, environment);
    if (block) blocks.push(block);
    start = index + 1;
  }
  return blocks;
};
