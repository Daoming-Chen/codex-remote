import MarkdownIt from 'markdown-it';

declare global {
  interface Window {
    renderMarkdown: (text: string) => string;
    renderMarkdownBlocks: (text: string) => string[];
  }
}
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.disable('image');

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
