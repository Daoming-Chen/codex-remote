const rewrite=require('regexpu-core');
const fs=require('node:fs');
const text=fs.readFileSync(0,'utf8');
const output=text.replace(/\/(\[\^\\p\{L\}\\p\{N\}\.\_\-\])\/gu/g,(_,pat)=>'/'+rewrite(pat,'u',{unicodePropertyEscapes:'transform'})+'/gu')
.replace(/`([^`\n]*\\\\p\{[^`\n]*)`/g,(_,body)=>JSON.stringify(rewrite(body.replaceAll('\\\\','\\'),'u',{unicodePropertyEscapes:'transform'})));
if(output===text||output.includes('\\p{'))throw Error('Unicode expression not transformed');
process.stdout.write(output);
