'use strict';
/* Granth Portal server: zero dependencies. Needs Node 18+ (Node 22+ recommended for built-in SQLite). */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),{promisify}=require('util');
const scrypt=promisify(crypto.scrypt);
const PORT=+process.env.PORT||3000,DATA=process.env.DATA_DIR||path.join(__dirname,'data'),PUB=path.join(__dirname,'public');
fs.mkdirSync(DATA,{recursive:true});
/* ---------- secrets ---------- */
let SECRET=process.env.SESSION_SECRET;
if(!SECRET){const f=path.join(DATA,'secret.key');try{SECRET=fs.readFileSync(f,'utf8').trim()}catch(e){SECRET=crypto.randomBytes(48).toString('hex');fs.writeFileSync(f,SECRET,{mode:0o600})}}
/* ---------- storage: SQLite (preferred) or JSON file fallback ---------- */
async function openStore(){
 if(process.env.MONGODB_URI)return await openMongo(process.env.MONGODB_URI);
 let sq=null;try{sq=require('node:sqlite')}catch(e){}
 if(sq){
  const db=new sq.DatabaseSync(path.join(DATA,'granth.db'));
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;
   CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY,col TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,ts INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS docs_col ON docs(col);
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,hash TEXT NOT NULL,salt TEXT NOT NULL,created INTEGER NOT NULL,last INTEGER,disabled INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT);`);
  const q={gd:db.prepare('SELECT data FROM docs WHERE path=?'),sd:db.prepare('INSERT INTO docs(path,col,id,data,ts) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data,ts=excluded.ts'),dd:db.prepare('DELETE FROM docs WHERE path=?'),lc:db.prepare('SELECT id,data FROM docs WHERE col=? ORDER BY id'),cc:db.prepare('SELECT col,COUNT(*) n FROM docs GROUP BY col'),
   ue:db.prepare('SELECT * FROM users WHERE email=?'),ui:db.prepare('SELECT * FROM users WHERE id=?'),ua:db.prepare('SELECT * FROM users ORDER BY created'),ins:db.prepare('INSERT INTO users(id,email,name,role,hash,salt,created,last,disabled) VALUES(?,?,?,?,?,?,?,?,?)'),
   up:db.prepare('UPDATE users SET name=?,role=?,hash=?,salt=?,last=?,disabled=? WHERE id=?'),ud:db.prepare('DELETE FROM users WHERE id=?'),mg:db.prepare('SELECT v FROM meta WHERE k=?'),ms:db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),dl:db.prepare('DELETE FROM docs WHERE col=?')};
  return{kind:'sqlite',
   getDoc:p=>{const r=q.gd.get(p);return r?JSON.parse(r.data):null},setDoc:(p,d)=>{const s=p.split('/');q.sd.run(p,s[0],s[s.length-1],JSON.stringify(d),Date.now())},delDoc:p=>q.dd.run(p),
   list:c=>q.lc.all(c).map(r=>({id:r.id,data:JSON.parse(r.data)})),counts:()=>Object.fromEntries(q.cc.all().map(r=>[r.col,r.n])),
   userByEmail:e=>q.ue.get(e)||null,userById:i=>q.ui.get(i)||null,users:()=>q.ua.all(),addUser:u=>q.ins.run(u.id,u.email,u.name,u.role,u.hash,u.salt,u.created,u.last||null,u.disabled||0),
   saveUser:u=>q.up.run(u.name,u.role,u.hash,u.salt,u.last||null,u.disabled||0,u.id),delUser:i=>q.ud.run(i),getMeta:k=>{const r=q.mg.get(k);return r?r.v:null},setMeta:(k,v)=>q.ms.run(k,v),
   allDocs:()=>db.prepare('SELECT path,data FROM docs').all().map(r=>[r.path,JSON.parse(r.data)]),
   wipe:()=>{db.exec('DELETE FROM docs;DELETE FROM users')},size:()=>{try{return fs.statSync(path.join(DATA,'granth.db')).size}catch(e){return 0}},
   snapshot:dest=>{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');fs.copyFileSync(path.join(DATA,'granth.db'),dest)}}
 }
 /* JSON fallback */
 const f=path.join(DATA,'granth.json');let S={docs:{},users:{},meta:{}};try{S=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
 let t=null;const save=()=>{clearTimeout(t);t=setTimeout(()=>{const tmp=f+'.tmp';fs.writeFileSync(tmp,JSON.stringify(S));fs.renameSync(tmp,f)},150)};
 return{kind:'json',getDoc:p=>S.docs[p]||null,setDoc:(p,d)=>{S.docs[p]=d;save()},delDoc:p=>{delete S.docs[p];save()},
  list:c=>Object.keys(S.docs).filter(k=>k.startsWith(c+'/')&&k.split('/').length==2).sort().map(k=>({id:k.split('/')[1],data:S.docs[k]})),
  counts:()=>{const o={};Object.keys(S.docs).forEach(k=>{const c=k.split('/')[0];o[c]=(o[c]||0)+1});return o},
  userByEmail:e=>Object.values(S.users).find(u=>u.email==e)||null,userById:i=>S.users[i]||null,users:()=>Object.values(S.users).sort((a,b)=>a.created-b.created),addUser:u=>{S.users[u.id]={...u};save()},saveUser:u=>{S.users[u.id]={...u};save()},delUser:i=>{delete S.users[i];save()},
  getMeta:k=>S.meta[k]??null,setMeta:(k,v)=>{S.meta[k]=v;save()},allDocs:()=>Object.entries(S.docs),wipe:()=>{S.docs={};S.users={};save()},size:()=>{try{return fs.statSync(f).size}catch(e){return 0}},
  snapshot:dest=>{fs.writeFileSync(dest,JSON.stringify(S))}}
}

/* ---------- MongoDB backend (used when MONGODB_URI is set) ---------- */
async function openMongo(uri){
 let MongoClient;try{({MongoClient}=require('mongodb'))}catch(e){throw new Error('MONGODB_URI is set but the "mongodb" package is not installed. Run: npm install')}
 const cli=new MongoClient(uri,{serverSelectionTimeoutMS:15000});await cli.connect();const db=cli.db(process.env.MONGODB_DB||'granth');
 const docs=db.collection('docs'),users=db.collection('users'),meta=db.collection('meta');
 await docs.createIndex({col:1});await users.createIndex({email:1},{unique:true});
 const nu=u=>u?{...u,id:u._id}:null;
 return{kind:'mongodb',
  getDoc:async p=>{const r=await docs.findOne({_id:p});return r?r.data:null},
  setDoc:async(p,d)=>{const s=p.split('/');await docs.updateOne({_id:p},{$set:{col:s[0],id:s[s.length-1],data:d,ts:Date.now()}},{upsert:true})},
  delDoc:async p=>{await docs.deleteOne({_id:p})},
  list:async c=>(await docs.find({col:c}).sort({id:1}).toArray()).map(r=>({id:r.id,data:r.data})),
  counts:async()=>{const a=await docs.aggregate([{$group:{_id:'$col',n:{$sum:1}}}]).toArray();return Object.fromEntries(a.map(r=>[r._id,r.n]))},
  userByEmail:async e=>nu(await users.findOne({email:e})),userById:async i=>nu(await users.findOne({_id:i})),
  users:async()=>(await users.find({}).sort({created:1}).toArray()).map(nu),
  addUser:async u=>{const{id,...r}=u;await users.insertOne({_id:id,...r})},
  saveUser:async u=>{const{id,_id,...r}=u;await users.updateOne({_id:id},{$set:r})},delUser:async i=>{await users.deleteOne({_id:i})},
  getMeta:async k=>{const r=await meta.findOne({_id:k});return r?r.v:null},setMeta:async(k,v)=>{await meta.updateOne({_id:k},{$set:{v}},{upsert:true})},
  allDocs:async()=>(await docs.find({}).toArray()).map(r=>[r._id,r.data]),
  wipe:async()=>{await docs.deleteMany({});await users.deleteMany({})},
  size:async()=>{try{const s=await db.stats();return s.dataSize||0}catch(e){return 0}},snapshot:async()=>{}}
}
let ST=null;
/* ---------- helpers ---------- */
const b64=b=>Buffer.from(b).toString('base64url');
const sign=s=>crypto.createHmac('sha256',SECRET).update(s).digest('base64url');
const eq=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length==y.length&&crypto.timingSafeEqual(x,y)};
const uid=()=>'u_'+crypto.randomBytes(9).toString('base64url');
async function hashPw(pw,salt){salt=salt||crypto.randomBytes(16).toString('hex');const h=(await scrypt(pw,salt,64)).toString('hex');return{salt,hash:h}}
async function checkPw(u,pw){const h=(await scrypt(pw,u.salt,64)).toString('hex');return eq(h,u.hash)}
function mkToken(u,remember){const exp=Date.now()+(remember?30*864e5:12*36e5);const p=b64(JSON.stringify({u:u.id,e:exp,v:u.hash.slice(0,10),r:remember?1:0}));return{token:p+'.'+sign(p),exp,remember}}
async function readToken(tok){if(!tok)return null;const[i,s]=tok.split('.');if(!i||!s||!eq(sign(i),s))return null;let p;try{p=JSON.parse(Buffer.from(i,'base64url').toString())}catch(e){return null}if(!p||p.e<Date.now())return null;const u=await ST.userById(p.u);if(!u||u.disabled||u.hash.slice(0,10)!==p.v)return null;return u}
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(/;\s*/).filter(Boolean).map(c=>{const i=c.indexOf('=');return[c.slice(0,i),decodeURIComponent(c.slice(i+1))]}));
const isHttps=req=>process.env.COOKIE_SECURE==='1'||req.headers['x-forwarded-proto']==='https'||req.socket.encrypted;
function setCookie(res,req,val,maxAge){const a=[`gp_session=${val}`,'HttpOnly','SameSite=Lax','Path=/'];if(maxAge!=null)a.push('Max-Age='+maxAge);if(isHttps(req))a.push('Secure');res.setHeader('Set-Cookie',a.join('; '))}
const pubUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,isOwner:u.role==='admin',canEdit:u.role==='admin'});
const cfg=async()=>(await ST.getDoc('config/main'))||{};
const site=async()=>({name:'Granth Portal',approve:true,batches:[],...((await cfg()).site||{})});
const validEmail=e=>/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
/* rate limit */
const fails=new Map();function limited(k){const r=fails.get(k);return r&&r.n>=8&&Date.now()-r.t<6e5}
function fail(k){const r=fails.get(k)||{n:0,t:Date.now()};if(Date.now()-r.t>=6e5){r.n=0}r.n++;r.t=Date.now();fails.set(k,r)}
/* access rules (server-side, never trust the browser) */
const COLS=['config','banks','approvals','attempts','signups','adminreq','audit'];
function can(u,p,op){const s=p.split('/'),adm=u.role==='admin';switch(s[0]){
 case 'config':case 'banks':case 'approvals':return op==='read'||adm;
 case 'attempts':case 'signups':case 'adminreq':return adm||s[1]===u.id;
 case 'audit':return adm;
 case 'data':return s[1]==='users'&&s[2]===u.id;
 default:return false}}
const okPath=p=>typeof p=='string'&&/^[A-Za-z0-9_\-\/]{3,200}$/.test(p)&&!p.includes('//')&&p.split('/').length%2==0&&(COLS.includes(p.split('/')[0])||p.startsWith('data/users/'));
/* ---------- http ---------- */
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
const SEC={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob: https://cdnjs.cloudflare.com; frame-ancestors 'none'"};
const send=(res,code,obj,extra)=>{let b=Buffer.from(JSON.stringify(obj));const h={'Content-Type':'application/json','Cache-Control':'no-store',...SEC,...(extra||{})};if(b.length>2048&&/gzip/.test((res.req&&res.req.headers['accept-encoding'])||'')){b=zlib.gzipSync(b);h['Content-Encoding']='gzip'}h['Content-Length']=b.length;res.writeHead(code,h);res.end(b)};
const err=(res,code,msg)=>send(res,code,{error:msg});
function body(req,max=8e6){return new Promise((ok,no)=>{let n=0;const c=[];req.on('data',d=>{n+=d.length;if(n>max){no(Object.assign(new Error('too_large'),{code:413}));req.destroy()}else c.push(d)});req.on('end',()=>{try{ok(c.length?JSON.parse(Buffer.concat(c).toString()):{})}catch(e){no(Object.assign(new Error('bad_json'),{code:400}))}});req.on('error',no)})}
const gz=new Map();
function serveStatic(req,res,pth){let f=path.join(PUB,pth==='/'?'index.html':pth);if(!f.startsWith(PUB))return err(res,403,'forbidden');
 if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){if(pth.startsWith('/api'))return err(res,404,'not_found');f=path.join(PUB,'index.html')}
 const st=fs.statSync(f),ext=path.extname(f),h={'Content-Type':MIME[ext]||'application/octet-stream',...SEC,'Cache-Control':ext=='.html'?'no-cache':'public, max-age=3600'};
 if(/gzip/.test(req.headers['accept-encoding']||'')&&/\.(html|js|css|json|svg)$/.test(ext)){let c=gz.get(f);if(!c||c.m!==st.mtimeMs){c={m:st.mtimeMs,b:zlib.gzipSync(fs.readFileSync(f))};gz.set(f,c)}h['Content-Encoding']='gzip';h['Content-Length']=c.b.length;res.writeHead(200,h);return res.end(c.b)}
 h['Content-Length']=st.size;res.writeHead(200,h);fs.createReadStream(f).pipe(res)}
async function createUser({name,email,password,role}){email=String(email||'').trim().toLowerCase();name=String(name||'').trim().slice(0,80);
 if(!name)throw Object.assign(new Error('Please enter your name.'),{code:400});if(!validEmail(email))throw Object.assign(new Error('Please enter a valid email address.'),{code:400});
 if(String(password||'').length<8)throw Object.assign(new Error('Password must be at least 8 characters.'),{code:400});if(await ST.userByEmail(email))throw Object.assign(new Error('An account with this email already exists.'),{code:409});
 const{salt,hash}=await hashPw(password);const u={id:uid(),email,name,role,hash,salt,created:Date.now(),last:Date.now(),disabled:0};await ST.addUser(u);return u}
async function login(res,req,u,remember){const t=mkToken(u,remember);setCookie(res,req,t.token,remember?30*86400:null);u.last=Date.now();await ST.saveUser(u)}
async function audit(u,a){await ST.setDoc('audit/a'+Date.now()+crypto.randomBytes(2).toString('hex'),{by:u.id,t:Date.now(),a})}
const CSRF=req=>req.headers['x-requested-with']==='granth'&&(!req.headers.origin||new URL(req.headers.origin).host===req.headers.host);
async function api(req,res,u0){const U=new URL(req.url,'http://x'),p=U.pathname,m=req.method;let u=await readToken(cookies(req).gp_session);
 if(m!=='GET'&&!CSRF(req))return err(res,403,'csrf');
 if(p==='/api/state'&&m==='GET'){const sv=await site();return send(res,200,{setup:(await ST.users()).length===0,site:{name:sv.name,batches:sv.batches,approve:sv.approve},db:ST.kind})}
 if(p==='/api/me'&&m==='GET')return send(res,200,{user:u?pubUser(u):null});
 if(p==='/api/setup'&&m==='POST'){if((await ST.users()).length)return err(res,403,'Setup is already complete.');const b=await body(req);const nu=await createUser({...b,role:'admin'});await login(res,req,nu,true);await ST.setDoc('signups/'+nu.id,{name:nu.name,email:nu.email,roll:'',batch:'',phone:'',t:Date.now()});return send(res,200,{user:pubUser(nu)})}
 if(p==='/api/signup'&&m==='POST'){if(!(await ST.users()).length)return err(res,403,'Create the administrator account first.');const b=await body(req);const nu=await createUser({...b,role:'student'});
  await ST.setDoc('signups/'+nu.id,{name:nu.name,email:nu.email,roll:String(b.roll||'').slice(0,40),batch:String(b.batch||'').slice(0,60),phone:String(b.phone||'').slice(0,20),t:Date.now()});
  if(!(await site()).approve)await ST.setDoc('approvals/'+nu.id,{status:'approved',t:Date.now(),by:'auto'});await login(res,req,nu,!!b.remember);return send(res,200,{user:pubUser(nu)})}
 if(p==='/api/login'&&m==='POST'){const b=await body(req),email=String(b.email||'').trim().toLowerCase(),key=(req.socket.remoteAddress||'')+'|'+email;if(limited(key))return err(res,429,'Too many attempts. Please wait 10 minutes and try again.');
  const nu=await ST.userByEmail(email);if(!nu||nu.disabled||!(await checkPw(nu,String(b.password||'')))){fail(key);return err(res,401,'Incorrect email or password.')}fails.delete(key);await login(res,req,nu,!!b.remember);return send(res,200,{user:pubUser(nu)})}
 if(p==='/api/logout'&&m==='POST'){setCookie(res,req,'',0);return send(res,200,{ok:1})}
 if(!u)return err(res,401,'login_required');
 if(p==='/api/password'&&m==='POST'){const b=await body(req);if(!(await checkPw(u,String(b.old||''))))return err(res,401,'Current password is incorrect.');if(String(b.new||'').length<8)return err(res,400,'New password must be at least 8 characters.');const h=await hashPw(b.new);u.hash=h.hash;u.salt=h.salt;await ST.saveUser(u);await login(res,req,u,true);return send(res,200,{ok:1})}
 if(p==='/api/profile'&&m==='POST'){const b=await body(req);const nm=String(b.name||'').trim().slice(0,80);if(!nm)return err(res,400,'Name is required.');u.name=nm;await ST.saveUser(u);const s=await ST.getDoc('signups/'+u.id)||{t:Date.now(),email:u.email};await ST.setDoc('signups/'+u.id,{...s,name:nm,roll:String(b.roll||'').slice(0,40),batch:String(b.batch||'').slice(0,60),phone:String(b.phone||'').slice(0,20)});return send(res,200,{user:pubUser(u)})}
 if(p==='/api/profiles'&&m==='POST'){const b=await body(req),o={};for(const i of (Array.isArray(b.ids)?b.ids:[]).slice(0,500)){const x=await ST.userById(i);if(x&&(u.role==='admin'||x.id===u.id))o[i]={id:i,name:x.name}}return send(res,200,{profiles:o})}
 if(p==='/api/doc'){const dp=U.searchParams.get('path');if(!okPath(dp))return err(res,400,'bad_path');
  if(m==='GET'){if(!can(u,dp,'read'))return send(res,200,{exists:false});const d=await ST.getDoc(dp);return send(res,200,{exists:!!d,data:d||null})}
  if(m==='PUT'){if(!can(u,dp,'write'))return err(res,403,'forbidden');const b=await body(req);if(!b||typeof b.data!='object'||b.data===null||Array.isArray(b.data))return err(res,400,'bad_data');if(dp.startsWith('approvals/')&&u.role!=='admin')return err(res,403,'forbidden');await ST.setDoc(dp,b.data);return send(res,200,{ok:1})}
  if(m==='DELETE'){if(!can(u,dp,'write'))return err(res,403,'forbidden');await ST.delDoc(dp);return send(res,200,{ok:1})}}
 if(p==='/api/col'&&m==='GET'){const c=U.searchParams.get('c');if(!COLS.includes(c))return err(res,400,'bad_collection');if(!can(u,c+'/x','read')&&u.role!=='admin'&&!['attempts','signups','adminreq'].includes(c))return send(res,200,{docs:[]});
  let l=await ST.list(c);if(u.role!=='admin'&&['attempts','signups','adminreq','audit'].includes(c))l=c=='audit'?[]:l.filter(x=>x.id===u.id);return send(res,200,{docs:l})}
 /* ---- admin only ---- */
 if(p.startsWith('/api/admin/')){if(u.role!=='admin')return err(res,403,'admin_only');
  if(p==='/api/admin/users'&&m==='GET')return send(res,200,{users:(await ST.users()).map(x=>({id:x.id,email:x.email,name:x.name,role:x.role,created:x.created,last:x.last,disabled:!!x.disabled}))});
  if(p==='/api/admin/role'&&m==='POST'){const b=await body(req),t=await ST.userById(b.id);if(!t)return err(res,404,'not_found');if(!['admin','student'].includes(b.role))return err(res,400,'bad_role');if(t.id===u.id&&b.role!=='admin')return err(res,400,'You cannot remove your own admin role.');t.role=b.role;await ST.saveUser(t);await audit(u,(b.role=='admin'?'Made admin: ':'Removed admin: ')+t.email);return send(res,200,{ok:1})}
  if(p==='/api/admin/password'&&m==='POST'){const b=await body(req),t=await ST.userById(b.id);if(!t)return err(res,404,'not_found');if(String(b.password||'').length<8)return err(res,400,'Password must be at least 8 characters.');const h=await hashPw(b.password);t.hash=h.hash;t.salt=h.salt;await ST.saveUser(t);await audit(u,'Reset password for '+t.email);return send(res,200,{ok:1})}
  if(p==='/api/admin/disable'&&m==='POST'){const b=await body(req),t=await ST.userById(b.id);if(!t)return err(res,404,'not_found');if(t.id===u.id)return err(res,400,'You cannot disable yourself.');t.disabled=b.disabled?1:0;await ST.saveUser(t);await audit(u,(t.disabled?'Disabled ':'Enabled ')+t.email);return send(res,200,{ok:1})}
  if(p==='/api/admin/user'&&m==='DELETE'){const id=U.searchParams.get('id'),t=await ST.userById(id);if(!t)return err(res,404,'not_found');if(t.id===u.id)return err(res,400,'You cannot delete yourself.');for(const c of ['signups','approvals','attempts','adminreq'])await ST.delDoc(c+'/'+id);await ST.delDoc('data/users/'+id+'/prog');await ST.delUser(id);await audit(u,'Deleted account '+t.email);return send(res,200,{ok:1})}
  if(p==='/api/admin/stats'&&m==='GET'){const c=await ST.counts(),us=await ST.users();return send(res,200,{engine:ST.kind,bytes:await ST.size(),counts:{users:us.length,admins:us.filter(x=>x.role=='admin').length,signups:c.signups||0,approvals:c.approvals||0,attempts:c.attempts||0,banks:c.banks||0,adminreq:c.adminreq||0,audit:c.audit||0,config:c.config||0,progress:c.data||0},backups:ST.kind!=='mongodb'&&fs.existsSync(path.join(DATA,'backups'))?fs.readdirSync(path.join(DATA,'backups')).sort().reverse().slice(0,7):[]})}
  if(p==='/api/admin/backup'&&m==='GET'){const out={v:2,t:Date.now(),docs:Object.fromEntries(await ST.allDocs()),users:await ST.users()};await audit(u,'Downloaded backup');res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="granth-backup-'+new Date().toISOString().slice(0,10)+'.json"',...SEC});return res.end(JSON.stringify(out))}
  if(p==='/api/admin/restore'&&m==='POST'){const b=await body(req,6e7);if(!b||typeof b.docs!='object'||!Array.isArray(b.users))return err(res,400,'Not a Granth backup file.');if(!b.users.some(x=>x.role==='admin'))return err(res,400,'The backup has no admin account; refusing to restore.');
   await ST.wipe();let n=0;for(const[k,v]of Object.entries(b.docs)){if(okPath(k)){await ST.setDoc(k,v);n++}}for(const x of b.users){if(x&&x.id&&x.email&&x.hash)await ST.addUser(x)}await ST.setDoc('audit/a'+Date.now(),{by:u.id,t:Date.now(),a:'Restored backup ('+n+' records, '+b.users.length+' accounts)'});return send(res,200,{ok:1,docs:n,users:b.users.length})}}
 return err(res,404,'not_found')}
const server=http.createServer(async(req,res)=>{try{const p=new URL(req.url,'http://x').pathname;
 if(p==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('ok')}
 if(p.startsWith('/api/'))return await api(req,res);
 if(req.method!=='GET'&&req.method!=='HEAD')return err(res,405,'method');return serveStatic(req,res,decodeURIComponent(p))}
 catch(e){if(!res.headersSent)err(res,e.code&&e.code<600?e.code:500,e.code&&e.code<600?e.message:'server_error');else res.end();if(!e.code||e.code>=500)console.error(e)}});
/* ---------- start ---------- */
function dailyBackup(){if(ST.kind==='mongodb')return;try{const d=path.join(DATA,'backups');fs.mkdirSync(d,{recursive:true});const f=path.join(d,'granth-'+new Date().toISOString().slice(0,10)+(ST.kind=='sqlite'?'.db':'.json'));if(!fs.existsSync(f))ST.snapshot(f);fs.readdirSync(d).sort().reverse().slice(7).forEach(x=>fs.unlinkSync(path.join(d,x)))}catch(e){console.error('backup failed',e.message)}}
(async()=>{
 try{ST=await openStore()}catch(e){console.error('Could not open the database:',e.message);process.exit(1)}
 if(!(await ST.users()).length&&process.env.ADMIN_EMAIL&&process.env.ADMIN_PASSWORD){try{const a=await createUser({name:process.env.ADMIN_NAME||'Administrator',email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD,role:'admin'});await ST.setDoc('signups/'+a.id,{name:a.name,email:a.email,roll:'',batch:'',phone:'',t:Date.now()});console.log('Admin account created for',a.email)}catch(e){console.error('ADMIN_EMAIL setup failed:',e.message)}}
 setTimeout(dailyBackup,5000);setInterval(dailyBackup,6*36e5);
 server.listen(PORT,()=>console.log(`Granth Portal running on http://localhost:${PORT} (database: ${ST.kind})`));
})();
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
