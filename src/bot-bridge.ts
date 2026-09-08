/** Account-scoped BotHub service grants and bounded Agent execution inside the current DSH Host. */
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { Database } from './db.js';
import type { AuthService } from './auth.js';
import type { Context } from '@deepseek-ai/cordis';
import type { AuthenticatedPrincipal } from './principal.js';
import type { ManagedUserWorkspaceProvider } from './managed-workspace.js';

interface Grant { id:string; hash:string; ownerId:number; botId:string; workspaceId:string; workspacePath:string; revoked:boolean; createdAt:string; }
interface Login { ownerId:number; version:number; expires:number; }
interface Gateway {
 invoke(request:{namespace:string;method:string;args:Record<string,unknown>;principal:AuthenticatedPrincipal;signal?:AbortSignal}):Promise<unknown>;
 stream(request:{namespace:string;method:string;args:Record<string,unknown>;principal:AuthenticatedPrincipal;signal:AbortSignal}):Promise<AsyncIterable<unknown>>;
}
interface Workspace {id:string;path:string;attachSession(id:string):Promise<void>;}
interface Registry {create(path:string,title:string):Promise<Workspace>; get(id:string):Workspace|undefined;}
interface Frame {type:string;cursor?:number;records?:Frame[];event?:{type:string;data:any;seq:number};}
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
class BridgeError extends Error {constructor(readonly status:number,message:string){super(message);}}
function text(value:unknown,name:string,max=200){if(typeof value!=='string'||!value.trim()||value.length>max)throw new BridgeError(400,`${name} 无效`);return value;}
function isWithin(root:string,candidate:string){const relative=path.relative(root,candidate);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));}

/** Create the optional HTTP application. No account or model calls occur until an authenticated request arrives. */
export function createBotBridge(ctx:Context,db:Database,auth:AuthService){
 const app=express();app.disable('x-powered-by');app.use(express.json({limit:'256kb'}));
 const logins=new Map<string,Login>(),active=new Map<string,AbortController>();
 const services=ctx.root as unknown as {get(name:string):unknown};
 const requireService=<T>(name:string):T=>{const service=services.get(name);if(!service)throw new BridgeError(503,`DSH 服务 ${name} 尚未就绪`);return service as T;};
 function user(ownerId:number){const u=db.getUserById(ownerId);if(!u)throw new BridgeError(403,'账号已删除');if(u.role!=='admin'&&(db.getPermissions(u.id)?.banned??true))throw new BridgeError(403,'账号已封禁或未配置权限');return u;}
 function principal(ownerId:number):AuthenticatedPrincipal{const u=user(ownerId);return {source:'dsh-passwords',id:String(u.id),username:u.username,role:u.role};}
 const publicPrincipal=(p:AuthenticatedPrincipal)=>({id:p.id,username:p.username,role:p.role});
 function bearer(req:express.Request){const value=req.get('Authorization');if(!value?.startsWith('Bearer '))throw new BridgeError(401,'缺少服务授权');return text(value.slice(7),'授权',300);}
 function login(req:express.Request){const key=sha(bearer(req)),s=logins.get(key);if(!s||s.expires<Date.now())throw new BridgeError(401,'DSH 登录已失效');const u=user(s.ownerId);if(u.credential_version!==s.version)throw new BridgeError(401,'账号凭证已变更');return principal(s.ownerId);}
 function readGrant(id:string):Grant {const raw=db.getSetting(`bot_grant:${id}`);if(!raw)throw new BridgeError(403,'机器人授权不存在');return JSON.parse(raw) as Grant;}
 function grantFor(req:express.Request){const token=bearer(req),[id]=token.split('.');const grant=readGrant(id);if(grant.revoked||sha(token)!==grant.hash)throw new BridgeError(403,'机器人授权已撤销或无效');if(user(grant.ownerId).role!=='user')throw new BridgeError(403,'机器人绑定账号必须保持普通账号角色');return grant;}
 const safe=(fn:(req:express.Request,res:express.Response)=>Promise<unknown>|unknown):express.RequestHandler=>(req,res,next)=>{Promise.resolve().then(()=>fn(req,res)).catch(next);};
 app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});next();});
 app.get('/health',(_req,res)=>res.json({ok:true,protocol:1}));
 app.post('/login',safe(async(req,res)=>{
  if(req.headers.origin)throw new BridgeError(403,'该接口仅供服务端使用');
  const username=text(req.body.username,'用户名',64),password=text(req.body.password,'密码',128);
  await auth.login({username,password},{ip:req.socket.remoteAddress,userAgent:'BotHub'});
  const u=db.getUserByUsername(username);if(!u)throw new BridgeError(401,'登录失败');const p=principal(u.id);
  const now=Date.now();for(const [key,value]of logins)if(value.expires<now)logins.delete(key);
  if(logins.size>=10000)throw new BridgeError(429,'登录会话过多，请稍后重试');
  const token=randomBytes(32).toString('base64url');logins.set(sha(token),{ownerId:u.id,version:u.credential_version,expires:now+12*3600000});res.json({token,principal:publicPrincipal(p)});
 }));
 app.get('/me',safe((req,res)=>res.json(publicPrincipal(login(req)))));
 app.get('/accounts',safe((req,res)=>{const p=login(req);res.json((p.role==='admin'?db.listUsers():[user(Number(p.id))]).map(u=>({id:String(u.id),username:u.username,role:u.role})));}));
 app.post('/grants',safe(async(req,res)=>{
  const caller=login(req),botId=text(req.body.botId,'botId',36);if(!/^[a-zA-Z0-9-]+$/.test(botId))throw new BridgeError(400,'botId 无效');
  const ownerId=Number(text(req.body.ownerId,'ownerId',30));if(!Number.isSafeInteger(ownerId)||ownerId<1||(caller.role!=='admin'&&caller.id!==String(ownerId)))throw new BridgeError(403,'无权为该账号授权');
  const p=principal(ownerId);if(p.role==='admin')throw new BridgeError(400,'机器人必须绑定普通子账号，请先创建专用账号');
  const workspaceProvider=requireService<ManagedUserWorkspaceProvider>('managedUserWorkspace'),root=await workspaceProvider.resolve(p);if(!root)throw new BridgeError(403,'账号尚未分配托管工作空间');
  const directory=path.join(root,'bots',botId);await mkdir(directory,{recursive:true,mode:0o700});const canonical=await realpath(directory);if(!isWithin(await realpath(root),canonical))throw new BridgeError(403,'机器人目录超出账号工作空间');
  const registry=requireService<Registry>('workspaceRegistry'),workspace=await registry.create(canonical,`企微机器人 ${botId.slice(0,8)}`);
  const access=requireService<{resolve(p:AuthenticatedPrincipal,s:{workspaceIds:string[]}):Promise<{readableWorkspaceIds:Set<string>}>}>('principalAccess');
  if(!(await access.resolve(p,{workspaceIds:[workspace.id]})).readableWorkspaceIds.has(workspace.id))throw new BridgeError(403,'账号无权访问机器人工作空间');
  const id=randomUUID(),token=`${id}.${randomBytes(32).toString('base64url')}`;
  const grant:Grant={id,hash:sha(token),ownerId,botId,workspaceId:workspace.id,workspacePath:canonical,revoked:false,createdAt:new Date().toISOString()};db.setSetting(`bot_grant:${id}`,JSON.stringify(grant));db.audit('bot_grant_created',{username:caller.username,detail:`grant=${id};owner=${ownerId};bot=${botId}`});
  res.status(201).json({grantId:id,token,owner:publicPrincipal(p),workspaceId:workspace.id,workspacePath:canonical});
 }));
 app.post('/revoke',safe((req,res)=>{const p=login(req),g=readGrant(text(req.body.grantId,'grantId',36));if(p.role!=='admin'&&p.id!==String(g.ownerId))throw new BridgeError(403,'无权撤销该授权');g.revoked=true;db.setSetting(`bot_grant:${g.id}`,JSON.stringify(g));for(const [key,controller]of active)if(key.startsWith(g.id+':'))controller.abort();db.audit('bot_grant_revoked',{username:p.username,detail:g.id});res.json({ok:true});}));
 app.post('/run',safe(async(req,res)=>{
  const grant=grantFor(req),p=principal(grant.ownerId),runId=text(req.body.runId,'runId',100),prompt=text(req.body.prompt,'prompt',150000);
  const conversation=req.body.conversationId===undefined?`run:${runId}`:`chat:${text(req.body.conversationId,'conversationId',300)}`;
  const sessionId=`session-bot-${sha(`${grant.id}:${conversation}`).slice(0,48)}`,key=`${grant.id}:${sessionId}`;
  if(active.has(key))throw new BridgeError(409,'该会话正在执行其他任务');if(active.size>=8)throw new BridgeError(429,'DSH 机器人并发任务已满');
  const runKey=`bot_run:${grant.id}:${sha(runId)}`,saved=db.getSetting(runKey);
  if(saved){const record=JSON.parse(saved);if(record.status==='completed'){res.json(record.result);return;}throw new BridgeError(409,'该请求已执行或结果未知，请核对 DSH 会话后发起新的任务');}
  const gateway=requireService<Gateway>('typertGateway');
  db.setSetting(runKey,JSON.stringify({status:'running',sessionId}));
  const controller=new AbortController();active.set(key,controller);const timer=setTimeout(()=>controller.abort(),280000);
  const disconnected=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnected);
  let prompted=false;
  const invoke=(method:string,request:Record<string,unknown>)=>gateway.invoke({namespace:'session',method,args:{request},principal:p,signal:controller.signal});
  const refresh=setInterval(()=>{try{const current=readGrant(grant.id);if(current.revoked||user(grant.ownerId).role!=='user')controller.abort();}catch{controller.abort();}},1000);
  try{
   const root=await requireService<ManagedUserWorkspaceProvider>('managedUserWorkspace').resolve(p);const canonical=await realpath(grant.workspacePath);if(!root||canonical!==grant.workspacePath||!isWithin(await realpath(root),canonical))throw new BridgeError(403,'机器人工作空间已变更');
   const registry=requireService<Registry>('workspaceRegistry');const workspace=registry.get(grant.workspaceId)??await registry.create(canonical,`企微机器人 ${grant.botId.slice(0,8)}`);if(workspace.path!==canonical)throw new BridgeError(403,'工作空间归属不一致');
   const access=requireService<{resolve(p:AuthenticatedPrincipal,s:{workspaceIds:string[];sessionIds?:string[]}):Promise<{readableWorkspaceIds:Set<string>;readableSessionIds:Set<string>}>}>('principalAccess');
   if(!(await access.resolve(p,{workspaceIds:[workspace.id]})).readableWorkspaceIds.has(workspace.id))throw new BridgeError(403,'工作空间权限已撤销');
   const existing=db.getSessionOwner(sessionId);if(existing!==null&&existing!==grant.ownerId)throw new BridgeError(403,'会话归属冲突');
   const allowed=db.getPermissions(grant.ownerId)?.allowed_agent_presets;
   if(Array.isArray(allowed)&&!allowed.length)throw new BridgeError(403,'该账号尚未获准使用任何 Agent preset');
   const preset=process.env.DSH_BOT_AGENT_PRESET??allowed?.[0];
   if(preset&&Array.isArray(allowed)&&!allowed.includes(preset))throw new BridgeError(403,'账号无权使用机器人 Agent preset');
   const created=await invoke('create',{workspaceId:workspace.id,sessionId,...(preset?{agentPreset:preset}:{})}) as {agentPreset?:string};
   if(Array.isArray(allowed)&&(!created.agentPreset||!allowed.includes(created.agentPreset)))throw new BridgeError(403,'会话 Agent preset 权限已撤销');
   if(db.claimSessionOwner(sessionId,grant.ownerId)!==grant.ownerId)throw new BridgeError(403,'会话归属冲突');
   if(!(await access.resolve(p,{workspaceIds:[workspace.id],sessionIds:[sessionId]})).readableSessionIds.has(sessionId))throw new BridgeError(403,'会话权限已撤销');
   db.setSetting(runKey,JSON.stringify({status:'running',sessionId}));
   const source=await gateway.stream({namespace:'session',method:'follow',args:{request:{address:{kind:'session',sessionId},maxMessages:10}},principal:p,signal:controller.signal});
   const iterator=source[Symbol.asyncIterator]();let output='',turn:number|undefined,matchedTurn:number|undefined;
   try{
    await iterator.next(); // Subscribe before admission; the opening snapshot contains earlier turns only.
    await invoke('prompt',{sessionId,requestId:`bot-${sha(runId)}`,mode:'queue',clientTimeZone:'Asia/Shanghai',content:[{type:'text',text:prompt}]});prompted=true;
    while(true){const next=await iterator.next();if(next.done)throw new BridgeError(502,'DSH 会话流提前结束');const frame=next.value as Frame;if(frame.type!=='event'||!frame.event)continue;const e=frame.event;
     if(e.type==='turn/start')turn=e.data.turn;
     if(e.type==='user/message'&&e.data.source?.rpcId===`bot-${sha(runId)}`)matchedTurn=turn;
     if(e.type==='assistant/message'&&matchedTurn!==undefined&&e.data.turn===matchedTurn&&!e.data.interrupted){output=(e.data.message?.content??[]).filter((part:any)=>part.type==='text').map((part:any)=>part.text??'').join('');if(output.length>100000)throw new BridgeError(502,'DSH 输出超过报告限制');}
     if(e.type==='turn/end'&&e.data.turn===turn&&matchedTurn===undefined&&e.data.reason?.kind!=='completed')throw new BridgeError(502,'DSH 执行被权限、额度或审批中断');
     if(e.type==='turn/end'&&matchedTurn!==undefined&&e.data.turn===matchedTurn){if(!output||e.data.reason?.kind!=='completed')throw new BridgeError(502,'DSH 未完成回复，可能被额度、工具审批或执行错误中断');break;}
    }
   }finally{controller.abort();await iterator.return?.();}
   // Revalidate revocation before returning an artifact to the caller.
   if(readGrant(grant.id).revoked)throw new BridgeError(403,'机器人授权已撤销');if(user(grant.ownerId).role!=='user')throw new BridgeError(403,'机器人账号角色已变更');
   const result={sessionId,text:output};db.setSetting(runKey,JSON.stringify({status:'completed',result}));res.json(result);
  }catch(e){
   if(prompted)await gateway.invoke({namespace:'session',method:'cancel',args:{request:{sessionId}},principal:p}).catch(()=>undefined);
   db.setSetting(runKey,JSON.stringify({status:'failed',sessionId}));throw e;
  }finally{clearInterval(refresh);clearTimeout(timer);res.off('close',disconnected);active.delete(key);}
 }));
 app.use((_req,res)=>{res.status(404).json({error:'接口不存在'});});
 app.use((e:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(res.headersSent)return;res.status(e instanceof BridgeError?e.status:typeof e.status==='number'?e.status:500).json({error:e instanceof BridgeError?e.message:e.code==='INVALID_CREDENTIALS'?'用户名或密码不正确':'DSH 桥接请求失败，请检查账号权限、额度和运行日志'});});
 return {app,close:()=>{for(const controller of active.values())controller.abort();logins.clear();}};
}
/** Mount an opt-in bridge server beside the current DSH Host without changing its account or model configuration. */
export function registerBotBridge(ctx:Context,db:Database,auth:AuthService):void{
 const port=Number(process.env.DSH_BOT_BRIDGE_PORT??0);if(!port)return;if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('DSH_BOT_BRIDGE_PORT 必须为 1024–65535');
 ctx.inject(['typertGateway','workspaceRegistry','managedUserWorkspace','principalAccess'],scope=>{
  const bridge=createBotBridge(scope,db,auth);const server:Server=createServer(bridge.app);
  server.on('error',()=>console.error('[dsh-passwords] BotHub bridge could not listen; check DSH_BOT_BRIDGE_PORT'));
  server.listen(port,'127.0.0.1',()=>console.log(`[dsh-passwords] BotHub bridge: http://127.0.0.1:${port}`));
  return ()=>{bridge.close();server.close();server.closeAllConnections();};
 });
}
