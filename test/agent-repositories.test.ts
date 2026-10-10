import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildContext } from '../src/context.js';
import { agentClone, agentMirror, agentPulls } from '../src/commands/agent-repositories.js';

test('repository commands preserve proposal source and mirror protocol fields and authentication', async () => {
 const home = mkdtempSync(join(tmpdir(), 'agent-cli-'));
 const calls: { method: string; url: string; body: unknown }[] = [];
 const server = createServer((req,res) => {
  assert.equal(req.headers.authorization, 'Bearer person-key');
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => { calls.push({method: req.method!, url: req.url!, body: body ? JSON.parse(body) : null}); res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true})); });
 });
 await new Promise<void>(done => server.listen(0,'127.0.0.1',done));
 const ctx = {...buildContext({home, node:`http://127.0.0.1:${(server.address() as AddressInfo).port}`, quiet:true}), token:'person-key'};
 try {
  await agentPulls(ctx,'desk',{state:'open'});
  await agentPulls(ctx,'desk',{head:'proposal',headAgent:'fork-reader',title:'Reviewed edit',body:'Details'});
  await agentPulls(ctx,'desk',{number:2,merge:true});
  await agentPulls(ctx,'desk',{number:3,close:true});
  await agentMirror(ctx,'desk',{repo:'https://github.com/owner/repo',folder:'agents/desk',branch:'release'});
  await agentMirror(ctx,'desk',{sync:true});
  await agentMirror(ctx,'desk',{detach:true});
  assert.deepEqual(calls.map(c=>[c.method,c.url]),[
   ['GET','/api/hosted-agents/desk/pulls?state=open'],['POST','/api/hosted-agents/desk/pulls'],['POST','/api/hosted-agents/desk/pulls/2/merge'],['POST','/api/hosted-agents/desk/pulls/3/close'],['PUT','/api/hosted-agents/desk/mirror'],['POST','/api/hosted-agents/desk/mirror/sync'],['DELETE','/api/hosted-agents/desk/mirror']]);
  assert.deepEqual(calls[1].body,{head:'proposal',headAgent:'fork-reader',base:'main',title:'Reviewed edit',body:'Details'});
  assert.deepEqual(calls[4].body,{url:'https://github.com/owner/repo',branch:'release',path:'agents/desk'});
  await assert.rejects(agentPulls(ctx,'../keys'),/agent id/);
  await assert.rejects(agentPulls(ctx,'desk',{merge:true}),/needs --number/);
  await assert.rejects(agentMirror(ctx,'desk',{sync:true,detach:true}),/choose one/);
  assert.equal(calls.length,7);
 } finally {await new Promise<void>(done=>server.close(()=>done()));rmSync(home,{recursive:true,force:true});}
});


test('clone authenticates real Git without writing a token into its remote configuration', async () => {
 const { execFile, spawn } = await import('node:child_process');
 const { promisify } = await import('node:util');
 const run = promisify(execFile);
 const root = mkdtempSync(join(tmpdir(),'agent-clone-'));
 const env = {...process.env, GIT_AUTHOR_NAME:'Test', GIT_AUTHOR_EMAIL:'test@example.com', GIT_COMMITTER_NAME:'Test', GIT_COMMITTER_EMAIL:'test@example.com'};
 const git = (...args: string[]) => run('git',args,{env});
 await git('init','--bare','-b','main',join(root,'desk.git'));
 await git('clone',join(root,'desk.git'),join(root,'seed'));
 writeFileSync(join(root,'seed','prompt.md'),'Reviewed prompt');
 await git('-C',join(root,'seed'),'add','.');await git('-C',join(root,'seed'),'commit','-m','Initial');await git('-C',join(root,'seed'),'push','origin','main');
 const server=createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer person-secret');
  if(req.url==='/api/hosted-agents/desk/refs'){res.setHeader('content-type','application/json');res.end(JSON.stringify({branches:[{name:'main'}]}));return;}
  const url=new URL(req.url!,'http://node');
  const child=spawn('git',['http-backend'],{env:{...env,GIT_PROJECT_ROOT:root,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname.replace(/^\/git/,''),QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']??''}});
  req.pipe(child.stdin);let buffer=Buffer.alloc(0),started=false;
  child.stdout.on('data',(chunk:Buffer)=>{if(started){res.write(chunk);return;}buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const headers:Record<string,string>={};for(const line of buffer.subarray(0,end).toString().split('\r\n')){const at=line.indexOf(':');headers[line.slice(0,at)]=line.slice(at+1).trim();}res.writeHead(200,headers);started=true;res.write(buffer.subarray(end+4));});child.stdout.on('end',()=>res.end());
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const ctx={...buildContext({home:join(root,'home'),node:base,quiet:true}),token:'person-secret'};
 try{
  const result=await agentClone(ctx,'desk',join(root,'clone'));
  assert.equal(readFileSync(join(result.directory,'prompt.md'),'utf8'),'Reviewed prompt');
  const config=readFileSync(join(result.directory,'.git','config'),'utf8');
  assert.ok(config.includes(`${base}/git/desk.git`));assert.doesNotMatch(config,/person-secret|Authorization|extraHeader/);
  await assert.rejects(agentClone(ctx,'--upload-pack=evil'),/agent id/);
 }finally{await new Promise<void>(done=>server.close(()=>done()));rmSync(root,{recursive:true,force:true});}
});
