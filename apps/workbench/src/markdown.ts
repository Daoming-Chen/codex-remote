import {Marked, Renderer} from 'marked';
import {ParseError, renderToString} from 'katex';

declare global {
  interface Window {
    renderMarkdown: (text: string) => string;
    renderMarkdownBlocks: (text: string, streaming?: boolean) => string[];
  }
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const han = /\p{Script=Han}/u;
const cjkStrong = /^\*\*([^\s*](?:[^*\n]|\*(?!\*))*?[\p{Pe}\p{Pf}。！？：；，、])\*\*(?=\p{Script=Han})/u;
const inlineEquations = [
  /^\\\[((?:[^\\]|\\(?!\[|\])[\s\S])+)\\\]/,
  /^\\\(((?:[^\\]|\\(?!\))[\s\S])+)\\\)/,
  /^\$\$(?!\$)((?:[^$\\]|\\[\s\S]|\$(?!\$))+)\$\$(?!\$)/,
  /^\$(?![\s$])((?:[^$\\\n]|\\.)*?[^$\s\\])\$(?![\d$])/,
];
const blockEquations = [
  /^ {0,3}\\\[((?:[^\\]|\\(?!\[|\])[\s\S])+)\\\][ \t]*(?:\n|$)/,
  /^ {0,3}\$\$(?!\$)((?:[^$\\]|\\[\s\S]|\$(?!\$))+)\$\$(?!\$)[ \t]*(?:\n|$)/,
];

function safeHref(href: string) {
  // Set attributes using escaped text, and resolve using the browser's URL rules.
  // Drive paths arriving from a Windows host stay relative to the receiver.
  if (href.includes('&')) {
    const decoder=document.createElement('textarea');
    decoder.innerHTML=href.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    href=decoder.value;
  }
  if (/^[a-z]:[\\/]/i.test(href)) href='/'+href.replace(/\\/g,'/');
  try {
    const target=new URL(href,'https://receiver.invalid/');
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(target.protocol) ? href : null;
  } catch { return null }
}

function createRenderer(streaming: boolean) {
  function equation(source: string, displayMode: boolean) {
    try {
      return renderToString(source, {displayMode, throwOnError:streaming, trust:false, maxSize:20});
    } catch (error) {
      if (streaming && error instanceof ParseError) return '';
      throw error;
    }
  }
  return new Marked({
    breaks:true, gfm:true,
    extensions:[
      {
        name:'equationBlock', level:'block',
        start(src) { return src.search(/(?:^|\n) {0,3}(?:\\\[|\$\$)/) },
        tokenizer(src) {
          for (const pattern of blockEquations) {
            const match=pattern.exec(src);
            if (match) return {type:'equationBlock',raw:match[0],text:match[1].trim()};
          }
        },
        renderer(token) { return equation(token.text,true) }
      },
      {
        name:'equationInline', level:'inline',
        start(src) { return src.search(/\\[[(]|\$/) },
        tokenizer(src) {
          for (const pattern of inlineEquations) {
            const match=pattern.exec(src);
            if (match) return {type:'equationInline',raw:match[0],text:match[1]};
          }
        },
        renderer(token) { return equation(token.text,false) }
      }
    ],
    tokenizer:{
      emStrong(src,maskedSrc) {
        // CommonMark cannot close punctuation-delimited emphasis immediately before Han text.
        // Use the lexer's mask to avoid recognizing markers inside escapes, links or code.
        const match=cjkStrong.exec(maskedSrc.slice(-src.length));
        if (!match) return false;
        const raw=src.slice(0,match[0].length),text=raw.slice(2,-2);
        return {type:'strong',raw,text,tokens:this.lexer.inlineTokens(text)};
      },
      del(src) { return src.startsWith('~~') ? false : undefined }
    },
    renderer:{
      html({text}) { return escapeHtml(text) },
      text(token) {
        if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
        return token.text.replace(/</g,'&lt;').replace(/>/g,'&gt;');
      },
      image({raw,href,text}) {
        const path=safeHref(href);
        if(path&&/^https?:\/\//i.test(path))return '<a href="'+escapeHtml(path)+'">'+escapeHtml(text||'查看图片')+'</a>';
        if(!path||/^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(path))return escapeHtml(raw);
        const label=text||path.split(/[\\/]/).pop()||'图片';
        return '<a data-project-image href="'+escapeHtml(path)+'">'+escapeHtml(label)+'</a>';
      },
      link({href,title,tokens}) {
        const label=this.parser.parseInline(tokens),safe=safeHref(href);
        if (safe===null) return label;
        return '<a href="'+escapeHtml(safe)+'"'+(title?' title="'+escapeHtml(title)+'"':'')+'>'+label+'</a>';
      },
      paragraph({text,tokens}) {
        const marker=han.test(text)?' data-markdown-han-text="true"':'';
        return '<p'+marker+'>'+this.parser.parseInline(tokens)+'</p>\n';
      },
      listitem(item) {
        const html=Renderer.prototype.listitem.call(this,item);
        return item.task ? html.replace('<li>','<li class="task-list-item">') : html;
      },
      code({text,lang}) {
        if (lang?.trim().split(/\s+/,1)[0]==='math') return equation(text,true);
        return false;
      },
    },
  });
}

const completeRenderer=createRenderer(false);
const liveRenderer=createRenderer(true);
function renderBlocks(text: string, streaming: boolean) {
  const renderer=streaming?liveRenderer:completeRenderer;
  const blocks=renderer.lexer(text);
  return blocks.filter(token=>token.type!=='space').map(token=>renderer.parser([token])).filter(Boolean);
}
window.renderMarkdown=text=>renderBlocks(text,false).join('');
window.renderMarkdownBlocks=(text,streaming=true)=>renderBlocks(text,streaming);
