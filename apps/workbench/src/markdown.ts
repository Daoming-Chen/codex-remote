import MarkdownIt from 'markdown-it';
import {tasklist} from '@mdit/plugin-tasklist';
import {tex} from '@mdit/plugin-tex';
import {renderToString} from 'katex';

declare global {
  interface Window {
    renderMarkdown: (text: string) => string;
    renderMarkdownBlocks: (text: string) => string[];
  }
}
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.disable('image');
markdown.use(tasklist, {label:false});
markdown.use(tex, {
  delimiters: 'all',
  mathFence: true,
  render(source: string, displayMode: boolean) {
    return renderToString(source, {displayMode, throwOnError:false, trust:false, maxSize:20});
  },
});

window.renderMarkdown = text => markdown.render(text);
window.renderMarkdownBlocks = text => {
  const environment = {};
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
