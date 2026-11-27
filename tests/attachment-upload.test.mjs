import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,access,readFile,link,unlink,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {uploadAttachment} from '../scripts/host-compat/attachment-upload.mjs';

test('native staging preserves binary chunks, empty files and acknowledged replays',async()=>{
  const root=await mkdtemp(join(tmpdir(),'attachment-'));
  try{
    const bytes=randomBytes(170000),id=randomUUID();
    const chunk=(offset,data)=>uploadAttachment('peer',root,{id,name:'示例.pdf',total:bytes.length,offset,data:data.toString('base64')});
    const first=bytes.subarray(0,131072);
    assert.deepEqual(await chunk(0,first),{complete:false,offset:first.length});
    assert.deepEqual(await chunk(0,first),{complete:false,offset:first.length});
    await assert.rejects(chunk(0,Buffer.from('conflict')),/Conflicting/);
    await assert.rejects(chunk(first.length+1,Buffer.from('gap')),/offset/);
    const final=await chunk(first.length,bytes.subarray(first.length));
    assert.equal(final.complete,true);
    assert.equal(final.size,bytes.length);
    assert.deepEqual(await readFile(final.path),bytes);
    assert.deepEqual(await chunk(first.length,bytes.subarray(first.length)),final);
    const empty=await uploadAttachment('peer',root,{id:randomUUID(),name:'empty.zip',offset:0,total:0,data:''});
    assert.equal(empty.size,0);assert.equal((await readFile(empty.path)).length,0);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('native staging rejects changed destinations, cross-peer retries and unsafe names',async()=>{
  const root=await mkdtemp(join(tmpdir(),'attachment-')),outside=join(root,'unrelated.txt');
  try{
    const id=randomUUID(),args={id,name:'payload.bin',total:2,offset:0,data:'QQ=='};
    for(const name of ['../private.txt','a/b','a\\b','LPT1.pdf','suffix.','nul','C:unsafe','bad\0name']){
      await assert.rejects(uploadAttachment('peer',root,{...args,name}),/Invalid/);
    }
    await uploadAttachment('peer',root,args);
    const folder=join(root,'.codex-upload-'+id);
    await assert.rejects(access(folder),{code:'ENOENT'});
    // A hostile pre-existing directory and file are never adopted.
    await mkdir(folder);
    const location=join(folder,args.name);
    await writeFile(location,'existing');
    await assert.rejects(uploadAttachment('peer',root,{...args,offset:1}),{code:'EEXIST'});
    assert.equal(await readFile(location,'utf8'),'existing');
    await rm(folder,{recursive:true,force:true});
    await uploadAttachment('peer',root,{...args,offset:1});
    await assert.rejects(uploadAttachment('other-peer',root,{...args,offset:1}));

    await writeFile(outside,'unchanged');
    await unlink(location);
    await link(outside,location);
    await assert.rejects(uploadAttachment('peer',root,{...args,offset:1}),/changed/);
    assert.equal(await readFile(outside,'utf8'),'unchanged');
  }finally{await rm(root,{recursive:true,force:true})}
});
