import {isUtf8} from 'node:buffer';
import {extname} from 'node:path';

export const filePreviewLimit = 4 * 1024 * 1024;
export const fileDownloadLimit = 64 * 1024 * 1024;
const chunkBytes = 512 * 1024;

interface FileInfo { bytes:number; version:string; source:string }
interface FileChunk extends FileInfo { offset:number; data:string | Uint8Array; eof:boolean }
export type RangeReader = (offset:number, length:number) => Promise<FileChunk>;

export async function* fileChunks(info:FileInfo, read:RangeReader) {
  let offset=0;
  do {
    const length = Math.min(chunkBytes, info.bytes-offset);
    const chunk = await read(offset, length || 1);
    if (chunk.version!==info.version || chunk.bytes!==info.bytes) throw Error('读取期间文件发生了变化，请重新打开');
    const data = typeof chunk.data==='string' ? Buffer.from(chunk.data,'base64') : Buffer.from(chunk.data);
    if (data.length!==length || chunk.offset!==offset || chunk.eof!==(offset+length===info.bytes) ||
        (typeof chunk.data==='string' && data.toString('base64')!==chunk.data)) throw Error('主机返回的文件分段不完整');
    yield data;
    offset += length;
  } while (offset<info.bytes);
}

export function fileMime(path:string, bytes:Buffer) {
  const prefix = bytes.subarray(0,12).toString('latin1');
  if (prefix.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  if (prefix.startsWith('GIF89a') || prefix.startsWith('GIF87a')) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.slice(8)==='WEBP') return 'image/webp';
  if (prefix.startsWith('BM') && bytes.length>=26 && [12,40,52,56,64,108,124].includes(bytes.readUInt32LE(14))) return 'image/bmp';
  if (prefix.slice(4,8)==='ftyp') {
    const size=bytes.readUInt32BE(0);
    for (let i=8; size>=16 && i+4<=Math.min(size,bytes.length); i+=4) {
      if (i!==12 && ['avif','avis'].includes(bytes.toString('ascii',i,i+4))) return 'image/avif';
    }
  }
  if (prefix.startsWith('%PDF-')) return 'application/pdf';
  if (prefix.startsWith('PK\x03\x04') || prefix.startsWith('PK\x05\x06')) {
    const office:Record<string,string> = {
      '.docx':'wordprocessingml.document', '.pptx':'presentationml.presentation', '.xlsx':'spreadsheetml.sheet'
    };
    const extension=extname(path).toLowerCase();
    if(extension==='.apk')return 'application/vnd.android.package-archive';
    const kind=office[extension];
    return kind?'application/vnd.openxmlformats-officedocument.'+kind:'application/zip';
  }
  return 'application/octet-stream';
}

export async function filePreview(path:string, info:FileInfo, read:RangeReader) {
  const parts:Buffer[] = [];
  for await (const chunk of fileChunks(info,read)) {
    parts.push(chunk);
    if (info.bytes>filePreviewLimit) break;
  }
  const data=Buffer.concat(parts), mime=fileMime(path,data);
  const textLimit=info.source==='git-index'?256*1024:512*1024;
  if (mime==='application/octet-stream' && info.bytes<=textLimit && !data.includes(0) && isUtf8(data))
    return {...info,mime:'text/plain',text:data.toString('utf8').replace(/^\uFEFF/,'')};
  return {...info,mime,...(mime.startsWith('image/')&&info.bytes<=filePreviewLimit?{data:data.toString('base64')}:{})};
}
