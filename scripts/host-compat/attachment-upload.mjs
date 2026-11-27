import {open, mkdir, mkdtemp, unlink, rmdir, lstat, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const maxFile = 64 * 1024 * 1024;
const maxChunk = 128 * 1024;
const uploads = new Map();

function validName(name) {
  return typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 180 &&
    !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) && !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name);
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino;
}

async function verifyPath(entry) {
  const [folder, file] = await Promise.all([lstat(entry.folder,{bigint:true}), lstat(entry.path,{bigint:true})]);
  if (!folder.isDirectory() || !file.isFile() || file.nlink !== 1n ||
      !sameFile(entry.folderStat, folder) || !sameFile(entry.fileStat, file) ||
      await realpath(entry.folder) !== entry.folder || await realpath(entry.path) !== entry.path) {
    throw Error('The attachment staging location changed.');
  }
}

async function createDestination(root, {id, name, total}) {
  const folder = join(root, '.codex-upload-' + id);
  await mkdir(folder, {mode:0o700});
  const folderStat = await lstat(folder,{bigint:true});
  if (!folderStat.isDirectory() || await realpath(folder) !== folder) throw Error('Invalid staging directory.');
  const path = join(folder, name);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const entry = {folder, path, root, name, total, size:0, folderStat, fileStat:await handle.stat({bigint:true}), handle};
    await verifyPath(entry);
    return entry;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function createUpload(root,{name,total}) {
  const scratch=await mkdtemp(join(tmpdir(),'codex-attachment-'));
  const path=join(scratch,'partial');
  let handle;
  try {
    handle=await open(path,'wx+',0o600);
    // The bytes are owned by the open handle, including after a peer
    // disconnect. The OS releases them if the plugin process terminates.
    await unlink(path);
    return {root,name,total,size:0,handle};
  } catch(error) {
    await handle?.close();
    throw error;
  } finally {
    await rmdir(scratch).catch(()=>{});
  }
}

async function publishUpload(entry,args) {
  const destination=await createDestination(entry.root,args);
  try {
    const buffer=Buffer.allocUnsafe(Math.min(entry.total,maxChunk));
    for(let offset=0;offset<entry.total;){
      const length=Math.min(buffer.length,entry.total-offset);
      const {bytesRead}=await entry.handle.read(buffer,0,length,offset);
      if(!bytesRead)throw Error('Incomplete staged attachment.');
      let written=0;
      while(written<bytesRead){
        const part=await destination.handle.write(buffer,written,bytesRead-written,offset+written);
        if(!part.bytesWritten)throw Error('Attachment write did not advance.');
        written+=part.bytesWritten;
      }
      offset+=bytesRead;
    }
    await destination.handle.sync();
    await verifyPath(destination);
    const previous=entry.handle;
    Object.assign(entry,destination,{size:entry.total,complete:true});
    await previous.close();
  } catch(error) {
    // Only shrink the object created by this request; never reopen a
    // possibly replaced pathname to dispose of a failed publication.
    if((await destination.handle.stat()).nlink===1)await destination.handle.truncate(0);
    await destination.handle.close();
    throw error;
  }
}

export async function uploadAttachment(peer, authorizedRoot, args) {
  const {id, name, total, offset, data} = args;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || !validName(name) ||
      !Number.isSafeInteger(total) || total < 0 || total > maxFile ||
      !Number.isSafeInteger(offset) || offset < 0 || typeof data !== 'string' || data.length > Math.ceil(maxChunk/3)*4) {
    throw Error('Invalid attachment chunk.');
  }
  const bytes = Buffer.from(data,'base64');
  if (bytes.toString('base64') !== data || bytes.length > maxChunk || offset+bytes.length > total ||
      (!bytes.length && total !== 0)) throw Error('Invalid attachment content.');
  const root = await realpath(resolve(authorizedRoot));
  const key = JSON.stringify([peer,id]);
  let slot = uploads.get(key);
  if (!slot) {
    if (offset !== 0 || uploads.size >= 512) throw Error('Start a new upload from the first chunk.');
    slot = {pending:false};
    uploads.set(key,slot);
  }
  if (slot.pending) throw Error('Another chunk for this attachment is in progress.');
  slot.pending = true;
  clearTimeout(slot.timeout);
  try {
    slot.entry ??= await createUpload(root,args);
    const entry = slot.entry;
    if (entry.root !== root || entry.name !== name || entry.total !== total || offset > entry.size) {
      throw Error('Attachment scope or offset mismatch.');
    }
    if(entry.complete)await verifyPath(entry);
    if (entry.complete || offset < entry.size) {
      if (offset+bytes.length > entry.size) throw Error('Overlapping attachment chunk.');
      const existing = Buffer.alloc(bytes.length);
      const read = await entry.handle.read(existing,0,existing.length,offset);
      if (read.bytesRead !== bytes.length || !bytes.equals(existing)) throw Error('Conflicting attachment retry.');
    } else {
      let written=0;
      while(written<bytes.length){
        const next=await entry.handle.write(bytes,written,bytes.length-written,offset+written);
        if(!next.bytesWritten)throw Error('Attachment write did not advance.');
        written+=next.bytesWritten;
      }
      entry.size += written;

    }
    if(!entry.complete&&entry.size===total)await publishUpload(entry,args);
    return entry.complete ? {complete:true, offset:entry.size, path:entry.path, root:entry.root, name, size:total} :
                            {complete:false, offset:entry.size};
  } finally {
    slot.pending=false;
    if (!slot.entry) uploads.delete(key);
    else {
      slot.timeout=setTimeout(()=>{
        uploads.delete(key);
        void slot.entry.handle.close().catch(()=>{});
      }, 15*60*1000);
      slot.timeout.unref();
    }
  }
}
