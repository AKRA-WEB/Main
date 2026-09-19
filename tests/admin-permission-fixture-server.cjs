// Loopback-only disposable browser fixture: actual Main + auth-api + isolated SQL.
// No operational credentials, remote database, GAS, LINE, or provider requests.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,runtime}=require('../../database/tests/helpers/auth-runtime.cjs');
const root=path.resolve(__dirname,'..');
async function start(port=4185){
    const db=await fixture({userPermissions:true}),r=runtime(db);
    const password=await vm.runInContext("createPasswordHash('fixture-password','user')",r.c);
    await db.query('UPDATE users SET password_hash=$1,password_salt=$2',[password.stored,password.salt]);
    await db.exec(`RESET ROLE;UPDATE app_configs SET url='https://akra-web.github.io/AKRA/';
        INSERT INTO app_configs(app_id,name,allowed_roles,url,icon,is_active) VALUES('app-inactive','Inactive fixture',ARRAY['ADMIN'],'https://akra-web.github.io/AKRA/','box',false);
        INSERT INTO perm_configs(app_id,perm_key,perm_name) VALUES('app-inactive','viewArchive','View archive');
        INSERT INTO role_permissions(app_id,perm_key,role_name) VALUES('app-inactive','viewArchive','ADMIN');SET ROLE service_role;`);
    let mode='normal',writes=0,readFailure=false;
    const counts={};
    const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const server=http.createServer(async(req,res)=>{
        try{
            const url=new URL(req.url,'http://127.0.0.1:'+port);
            if(req.method==='POST'){
                if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:'+port)return json(res,{error:'origin_denied'},403);
                let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw new Error('oversized_fixture_request');}
                const payload=JSON.parse(body);
                if(url.pathname==='/fixture'){
                    if(!['normal','lost-reply','reload-failure','stale-save','stale-target'].includes(payload.mode))return json(res,{error:'invalid_mode'},400);
                    mode=payload.mode;readFailure=false;return json(res,{mode});
                }
                if(url.pathname!=='/api')return json(res,{error:'unknown_route'},404);
                counts[payload.action]=(counts[payload.action]||0)+1;
                if(payload.action==='log')return json(res,{status:'success',fixtureOnly:true});
                if(payload.action==='getAdminData'&&readFailure)return json(res,{status:'error',reason:'fixture_reload_unavailable'},503);
                const save=['saveUserPermissions','saveAuthorizationConfig','saveUser','deleteUser','adminResetPassword'].includes(payload.action);
                if(save&&mode==='stale-target'&&payload.id==='other'){await db.exec("UPDATE users SET auth_session_version=auth_session_version+1 WHERE username='other'");mode='normal';}
                if(save&&mode==='stale-save'){await db.query('UPDATE auth_config_state SET revision=$1',['fixture-stale-'+Date.now()]);mode='normal';}
                const result=await r.handler(new Request('https://fixture.invalid/auth-api',{method:'POST',headers:{Origin:'https://akra-web.github.io','Content-Type':'application/json'},body:JSON.stringify(payload)}));
                const value=await result.json();
                if(save&&value.status==='success'){
                    writes++;
                    if(mode==='lost-reply'){mode='normal';return json(res,{status:'error',reason:'fixture_response_lost'},503);}
                    if(mode==='reload-failure'){readFailure=true;mode='normal';}
                }
                return json(res,value,result.status);
            }
            if(req.method!=='GET')return json(res,{error:'method_denied'},405);
            if(url.pathname==='/fixture')return json(res,{writes,counts,revision:(await db.query('SELECT revision FROM auth_config_state')).rows[0].revision,
                profiles:(await db.query('SELECT username,name,roles,auth_session_version FROM users ORDER BY username')).rows,
                grants:(await db.query("SELECT app_id,perm_key FROM user_permissions p JOIN users u ON p.user_id=u.id WHERE u.username='other' ORDER BY app_id,perm_key")).rows});
            const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
            if(!file.startsWith(root+path.sep)||!['.html','.js','.css','.json','.svg','.png','.ico'].includes(path.extname(file))||!fs.existsSync(file))return json(res,{error:'not_found'},404);
            let content=fs.readFileSync(file);
            if(file===path.join(root,'index.html'))content=content.toString().replace('<head>',`<head><script>
                const fixtureFetch=window.fetch.bind(window);
                window.fetch=(input,options={})=>{
                    const url=new URL(typeof input==='string'?input:input.url,location.href);
                    if(url.hostname.endsWith('.supabase.co')||url.hostname==='script.google.com')return fixtureFetch('/api',options);
                    if(url.origin===location.origin)return fixtureFetch(input,options);
                    return Promise.reject(new Error('Remote fixture fetch denied'));
                };
            </script>`);
            res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(content);
        }catch(error){json(res,{error:'fixture_failure',message:error.message},500);}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    return {server,db};
}
if(require.main===module)start(Number(process.env.FIXTURE_PORT||4185)).then(()=>console.log('Synthetic Main permission fixture on http://127.0.0.1:'+(process.env.FIXTURE_PORT||4185))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={start};
