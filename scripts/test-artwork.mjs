import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createArtworkLibrary } from '../tools/artwork-library.mjs';
import { publishArtwork } from '../admin/lib/artwork-publish.js';
import { uploadArtwork, readArtwork } from '../admin/functions/_lib/artwork-storage.js';
import { onRequestPost as sharedSearch } from '../admin/functions/api/admin/artwork-search.js';
import { createHash } from 'node:crypto';
import { readArtworkRepository } from '../admin/lib/artwork-repository.js';
import { sizes } from '../admin/lib/artwork-sizes.js';
import { companyWorks, searchArtwork } from '../tools/artwork-sources.mjs';
import { deepSeekArtwork, discoverArtwork } from '../tools/artwork-deepseek.mjs';
import { sourceImage, webUrl } from '../tools/artwork-web.mjs';

test('常规项目搜索包含 TapTap 同名游戏并去重，不调用 DeepSeek', async t => {
  const art = {original_url:'https://img-tc.tapimg.com/market/images/1.jpg'};
  const hosts = [];
  t.mock.method(globalThis,'fetch', async address => {
    const url = new URL(address);
    hosts.push(url.hostname);
    if (url.hostname !== 'www.taptap.cn') return Response.json({items:[]});
    assert.equal(url.searchParams.get('kw'),'测试游戏名');
    return Response.json({data:{list:[
      {app:{id:12,title:'测试游戏名',banner:art,cover:art}},
      {app:{id:13,title:'测试游戏名2',banner:{original_url:'https://img-tc.tapimg.com/2.jpg'}}},
    ]}});
  });
  const {candidates} = await searchArtwork('测试游戏名','project');
  assert.ok(!hosts.includes('api.deepseek.com'));
  assert.deepEqual(candidates.map(c=>[c.provider,c.page,c.image]),[['TapTap','https://www.taptap.cn/app/12',art.original_url]]);
});

test('公司批查优先已核实的 Logo，未核实的同名 Steam 游戏留待人工选择', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async address => {
    const url = new URL(address);
    requests.push(url.href);
    if (url.pathname === '/api/storesearch/') return Response.json({items:[
      {id:1234,name:'SUPER NOVA',tiny_image:'https://cdn.steamstatic.com/store/header.jpg'}
    ]});
    if (url.pathname === '/api/appdetails') return Response.json({1234:{data:{developers:['其他工作室']}}});
    return Response.json({data:{list:[]}});
  });
  const company = await searchArtwork('多益','company','多益',true);
  assert.equal(requests.length,0);
  assert.equal(company.candidates[0].provider,'公司标志');
  assert.equal(company.candidates[0].batchMatch,true);
  const project = await searchArtwork('SUPER NOVA','project','乐元素',true);
  assert.ok(project.candidates.some(c => c.provider === 'Steam'));
  assert.ok(!project.candidates.some(c => c.batchMatch));
});

test('DS 直接返回可提交的图片，跳过无法读取的网页，并从过期图片回退到网页主图', async t => {
  assert.throws(()=>deepSeekArtwork('作品','project','工作室',''),e=>e.status===401);
  const page='https://official.example/game', bad='https://other.example/game';
  const raw=await sharp({create:{width:400,height:200,channels:3,background:'#343434'}}).png().toBuffer();
  t.mock.method(globalThis,'fetch', async (url,opts) => {
    assert.equal(url,'https://api.deepseek.com/responses');
    assert.equal(opts.headers.Authorization,'Bearer test-only');
    const input=JSON.parse(opts.body);
    assert.deepEqual(input.tools,[{type:'deepseek_web_search'}]);
    assert.match(input.input,/测试工作室/);
    return Response.json({status:'completed',output:[
      {type:'web_search_call',status:'completed',action:{sources:[{url:bad},{url:page,title:'官方封面',image_url:page+'/expired.png'},{url:'http://127.0.0.1'}]}},
      {type:'message',content:[{annotations:[{type:'url_citation',url:page},{type:'url_citation',url:'https://invented.example/'}]}]},
    ]});
  });
  const load=async (url,type) => {
    if (url===bad || url.endsWith('/expired.png')) throw new Error('来源无法读取');
    if (type==='html') return {url,bytes:Buffer.from('<meta content="/cover.png?x=1&amp;y=2" property="og:image">')};
    assert.equal(url,'https://official.example/cover.png?x=1&y=2'); return {url,bytes:raw};
  };
  const result=await discoverArtwork('作品','project','测试工作室','test-only',s=>sourceImage(s,load));
  assert.deepEqual(Object.keys(result),['candidates']);
  assert.equal(result.candidates.length,1);
  const photo=result.candidates[0];
  assert.equal(photo.provider,'DeepSeek');assert.equal(photo.page,page);
  const packed=await createArtworkLibrary(tmpdir()).prepare({...photo,company:'c_demo',target:'p_demo',x:50,y:50,mode:'cover'},Buffer.from(photo.webp,'base64'));
  assert.ok(packed.files.cover);assert.ok(packed.source);assert.ok(!packed.files.source);assert.equal(packed.saved.image,photo.image);
  assert.equal(webUrl('https://127.0.0.1/'),null);
  assert.equal(webUrl('https://name:pass@example.org/'),null);
});

test('公司简称通过英文别名匹配 Steam 开发者主页，排除其他厂商和游戏封面', async t => {
  const image = 'https://avatars.cdn.queniuqe.com/' + 'a'.repeat(40) + '_full.jpg';
  t.mock.method(globalThis,'fetch',async address => {
    const url = new URL(address);
    if (url.hostname !== 'store.steampowered.com') return Response.json({});
    const title = url.pathname === '/developer/YouthcatGames/' ? 'Youthcat Games' : 'Other Studio';
    return new Response('<meta property="og:title" content="Steam Developer: ' + title + '">' +
      '<meta property="og:image" content="https://example.org/game.jpg"><img class="curator_avatar" src="' + image + '">',
    {headers:{'content-type':'text/html'}});
  });
  const {candidates} = await searchArtwork('柚子猫工作室','company');
  assert.deepEqual(candidates.map(c=>[c.provider,c.page,c.image]),[['Steam','https://store.steampowered.com/developer/YouthcatGames/',image]]);
  assert.deepEqual((await searchArtwork('Unrelated Studio','company')).candidates,[]);
});

test('DeepSeek 公司搜索从署名图注读取标志，跳过分享图和其他公司的标志', async () => {
  const raw = await sharp({create:{width:140,height:120,channels:3,background:'#565656'}}).png().toBuffer();
  const source = {title:'工作室采访',page:'https://press.example/interview',companyNames:['柚子猫','Youthcat Games']};
  let html = '<meta property="og:image" content="/game.jpg"><img alt="其他公司 Logo" src="/wrong.png">';
  const load = async (url,type) => {
    if (type === 'html') return {url,bytes:Buffer.from(html)};
    assert.equal(url,'https://img.example/studio.png');
    return {url,bytes:raw};
  };
  assert.equal(await sourceImage(source,load),null);
  html += '<figure><img data-src="http://img.example/studio.png"><figcaption>柚子猫工作室 <b>Logo</b></figcaption></figure>';
  assert.equal((await sourceImage(source,load)).image,'https://img.example/studio.png');
});

test('公司找图携带实际作品，只采用模型选中、联网查到且页面可核实的 Logo', async t => {
  const page = 'https://store.steampowered.com/developer/fixture/';
  const avatar = 'https://avatars.steamstatic.com/verified.jpg';
  const wrong = 'https://outside.example/guessed.jpg';
  const raw = await sharp({create:{width:184,height:184,channels:3,background:'#548021'}}).png().toBuffer();
  const works = companyWorks('Youthcat Studio','柚子猫',['戴森球计划','目录新增作品']);
  assert.deepEqual(works,['戴森球计划','目录新增作品']);
  assert.deepEqual(companyWorks('陌生工作室','柚子猫',works),[]);
  let hits = [{page,label:'开发者头像',image:wrong},{page:'https://guessed.example/',label:'logo',image:wrong}];
  t.mock.method(globalThis,'fetch',async (url,opts) => {
    assert.equal(url,'https://api.deepseek.com/responses');
    const body=JSON.parse(opts.body), input=JSON.parse(body.input);
    assert.deepEqual(input.已知作品,works);
    assert.equal(input.名称,'柚子猫');
    assert.match(body.instructions,/具体标志图片/);
    return Response.json({output:[
      {type:'web_search_call',action:{sources:[{url:'https://unselected.example/'},{url:page,title:'Steam Developer: Youthcat Games'}]}},
      {type:'message',content:[{type:'output_text',text:JSON.stringify({logos:hits})}]},
    ]});
  });
  const load = async (url,type) => {
    if (type === 'html') {
      assert.equal(url,page);
      return {url,bytes:Buffer.from('<meta property="og:title" content="Steam 開發者：Youthcat Games"><img src="' + avatar + '" class="curator_avatar">')};
    }
    assert.equal(url,avatar);
    return {url,bytes:raw};
  };
  const run = () => discoverArtwork('柚子猫','company','柚子猫','fixture',s=>sourceImage(s,load),works);
  assert.deepEqual((await run()).candidates.map(c=>[c.provider,c.image]),[['DeepSeek',avatar]]);
  hits = [];
  assert.deepEqual((await run()).candidates,[]);
});

test('本机同源页面无需登录即可找图和读取缓存，后台凭证只发往 DeepSeek', async t => {
  const host = '127.0.0.1:8895', path = '/api/local/artwork/deepseek?q=FixtureStudio&kind=company';
  const api = createArtworkLibrary(tmpdir(), {deepSeekKey:'server-fixture'});
  const image = await sharp({create:{width:220,height:160,channels:3,background:'#727272'}}).png().toBuffer();
  let upstreamStatus = 200, calls = 0;
  t.mock.method(globalThis,'fetch',async (address,options) => {
    const url = new URL(address);
    assert.notEqual(url.hostname,'admin.goodcorp.games');
    if (url.hostname === 'api.deepseek.com') {
      calls++;
      assert.equal(options.headers.Authorization,'Bearer server-fixture');
      return Response.json({output:[]},{status:upstreamStatus});
    }
    assert.equal(options.headers?.Authorization,undefined);
    if (url.hostname === 'en.wikipedia.org') return Response.json({query:{pages:[{title:'FixtureStudio',
      thumbnail:{source:'https://upload.wikimedia.org/fixture.png'},fullurl:'https://en.wikipedia.org/wiki/FixtureStudio'}]}});
    if (url.hostname === 'upload.wikimedia.org') return new Response(image,{headers:{'Content-Type':'image/png'}});
    return Response.json({});
  });
  async function post(extra = {}, suffix = '') {
    let status, response;
    const headers = {host,origin:'http://' + host,'x-artwork-save':'1',...extra};
    await api.handle({method:'POST',headers},{writeHead(code){status=code},end(data){response=JSON.parse(data)}},
      new URL(path + suffix,'http://' + host));
    assert.ok(!JSON.stringify(response).includes('server-fixture'));
    return {status,response};
  }
  assert.equal((await post({origin:'https://outside.example'})).status,403);
  assert.equal((await post({'x-artwork-save':''})).status,403);
  assert.equal((await post({host:'outside.example',origin:'http://outside.example'})).status,403);
  assert.equal((await post({'content-length':'32'})).status,400);
  assert.equal((await post({},'&key=client-fixture')).status,400);
  assert.equal(calls,0);
  upstreamStatus = 401;
  assert.equal((await post()).status,503);
  upstreamStatus = 200;
  const result = await post();
  assert.equal(result.status,200);
  const [photo] = result.response.candidates;
  assert.equal(photo.provider,'英文维基百科');
  assert.equal((await sharp(Buffer.from(photo.webp,'base64')).metadata()).format,'webp');
  assert.deepEqual(await post(),result);
  assert.equal(calls,2);
});

test('未配置本机 Key 的协作者用审核台身份共享搜索，返回可解码的图片', async t => {
  const origin = 'https://admin.goodcorp.games';
  const env = {GITHUB_OWNER:'org',GITHUB_REPO:'repo',DEEPSEEK_API_KEY:'cloud-fixture'};
  const photoPage = 'https://official.example/press';
  const raw = await sharp({create:{width:320,height:180,channels:3,background:'#13495c'}}).png().toBuffer();
  let calls = 0;
  t.mock.method(globalThis,'fetch',async (address,options) => {
    const url = new URL(address);
    if (url.origin === origin) {
      assert.equal(options.headers.Authorization,'Bearer reviewer-fixture');
      return sharedSearch({request:new Request(url,options),env});
    }
    if (url.origin === 'https://api.github.com') {
      assert.equal(options.headers.Authorization,'Bearer reviewer-fixture');
      return Response.json(url.pathname === '/user' ? {login:'colleague'} : {permissions:{push:true}});
    }
    assert.equal(url.href,'https://api.deepseek.com/responses');
    assert.equal(options.headers.Authorization,'Bearer cloud-fixture');
    assert.ok(!options.body.includes('reviewer-fixture'));
    calls++;
    return Response.json({output:[{type:'web_search_call',action:{sources:[{url:photoPage,title:'作品'}, {url:'https://official.example/other',title:'其他游戏'}]}},
      {type:'message',content:[{annotations:[{type:'url_citation',url:photoPage}]}]}]});
  });
  const path = origin+'/api/admin/artwork-search?kind=project&name=Fixture';
  assert.equal((await sharedSearch({request:new Request(path,{method:'POST'}),env})).status,401);
  const valid = {method:'POST',headers:{Authorization:'Bearer reviewer-fixture'}};
  assert.equal((await sharedSearch({request:new Request(path+'&model=other',valid),env})).status,400);
  assert.equal((await sharedSearch({request:new Request(path,valid),env:{...env,DEEPSEEK_API_KEY:''}})).status,503);
  assert.equal(calls,0);
  const read = async (url,type) => type === 'html'
    ? {url,bytes:Buffer.from('<meta property="og:image" content="/poster.png">')} : {url,bytes:raw};
  const result = await discoverArtwork('测试作品','project','测试公司','',s => sourceImage(s,read),[],'reviewer-fixture');
  assert.equal(calls,1);
  assert.equal(result.candidates[0].provider,'DeepSeek');
  assert.equal((await sharp(Buffer.from(result.candidates[0].webp,'base64')).metadata()).width,320);
  assert.doesNotMatch(JSON.stringify(result),/reviewer-fixture|cloud-fixture/);
});

test('R2 配图接口在存储未绑定或上传不完整时拒绝提交', async t => {
  const path = ['c_test','studio','1234567890abcdef'];
  const env = {GITHUB_OWNER:'org',GITHUB_REPO:'repo'};
  const url = 'https://admin.example/api/admin/artwork/' + path.join('/');
  const form = new FormData();
  const post = () => new Request(url, {method:'POST', headers:{Authorization:'Bearer test'}, body:form});
  t.mock.method(globalThis,'fetch',async address => Response.json(
    new URL(address).pathname === '/user' ? {login:'reviewer'} : {permissions:{push:true}}
  ));
  assert.equal((await uploadArtwork({env,params:{path},request:new Request(url,{method:'POST'})})).status,401);
  assert.equal((await uploadArtwork({env,params:{path},request:post()})).status,503);
  env.ARTWORK = {put:() => assert.fail('无效请求不应写入任何图片')};
  assert.equal((await uploadArtwork({env,params:{path},request:post()})).status,400);
  for (const name of ['card','banner']) form.append(name,new Blob(['invalid'],{type:'image/webp'}),name+'.webp');
  assert.equal((await uploadArtwork({env,params:{path},request:post()})).status,400);
  form.append('source',new Blob(['invalid'],{type:'image/webp'}),'source.webp');
  assert.equal((await uploadArtwork({env,params:{path},request:post()})).status,400,'多余的 source 档必须被拒绝');
  assert.equal((await readArtwork({env,params:{},request:new Request(url)})).status,404);
});

test('提交将展示图写入对象存储，仓库只更新记录，支持重试与冲突检测', async t => {
  const root = await mkdtemp(join(tmpdir(), 'goodcorp-artwork-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root, 'data/companies'), {recursive:true});
  const company = JSON.stringify({id:'c_test',name:'工作室',projects:[{id:'p_one',name:'作品'}]});
  await writeFile(join(root, 'data/companies/c_test.json'),company);
  const lib = createArtworkLibrary(root);
  const local = await lib.catalog();
  const bytes = await sharp({create:{width:300,height:160,channels:3,background:'#123456'}}).png().toBuffer();
  const blobs = new Map([[local[0].companySha,Buffer.from(company)]]);
  let paths = new Map([['data/companies/c_test.json',local[0].companySha]]), next, updates = 0, failRef = false;
  const client = {
    getRef:async()=>({object:{sha:'head'}}),getCommit:async()=>({tree:{sha:'base'}}),
    getFile:async(_owner,_repo,path)=>paths.has(path) ? {sha:paths.get(path),content:blobs.get(paths.get(path)).toString()} : null,
    createBlob:async(_owner,_repo,content,encoding='utf8')=>{
      const value = Buffer.from(content,encoding);
      const sha = createHash('sha1').update(value).digest('hex'); blobs.set(sha,value); return {sha};
    },
    createTree:async(_owner,_repo,tree)=>{
      next = new Map(paths);
      for (const f of tree.tree) { if (f.sha) next.set(f.path,f.sha); else next.delete(f.path); }
      return {sha:'tree'};
    },
    createCommit:async(_owner,_repo,c)=>{assert.deepEqual(c.parents,['head']);return {sha:'commit'};},
    patchRef:async()=>{if (failRef) throw new Error('分支冲突'); paths=next; updates++;},
  };
  const objects = new Map();
  const network = async url => {
    if (url.startsWith('/api/local/artwork/image')) return new Response(bytes,{headers:{'content-type':'image/png'}});
    if (url.startsWith('/api/artwork/')) return new Response(objects.get(url),{headers:{'content-type':'image/webp'}});
    if (url.includes('git/trees/')) return Response.json({tree:[...paths].map(([path,sha])=>({type:'blob',path,sha}))});
    return new Response(blobs.get(url.split('/').pop()));
  };
  const items = (await readArtworkRepository(local,null,network)).rows;
  assert.ok(items.every(item => !item.thumbnail && !item.remoteSha));
  const config = {owner:'org',publicRepo:'repo',publicBranch:'main'};
  let x = 75;
  const prepare = item => lib.prepare({...item,title:item.name,provider:'DeepSeek',page:'https://fixture.example/page',
    image:'https://fixture.example/original.png',mode:'cover',x,y:50},bytes);
  let failUpload = false;
  const upload = async (item,version,files) => {
    for (const [key,encoded] of Object.entries(files)) {
      objects.set('/api/artwork/' + [item.company,item.target,version,key + '.webp'].join('/'),Buffer.from(encoded,'base64'));
      if (failUpload) throw new Error('上传失败');
    }
  };
  const submit = rows => publishArtwork({client,config,items:rows,prepare,upload});

  const result = await submit(items);
  assert.equal(updates,1);
  assert.equal(result.records.length,2);
  assert.ok(![...objects.keys()].some(key => key.endsWith('/source.webp')),'原图不应写入对象存储');
  assert.deepEqual(await readdir(root),['data']);
  const reopened = await readArtworkRepository([],null,network);
  assert.equal(reopened.rows.length,2);
  for (const entry of reopened.rows) {
    const {saved,file} = await reopened.original(entry);
    assert.ok(entry.thumbnail.endsWith('/' + entry.company + '/' + entry.target + '/' + saved.version + '/card.webp'));
    assert.equal(saved.storage,'r2');
    assert.equal(saved.x,75);
    assert.equal(saved.image,'https://fixture.example/original.png');
    assert.equal((await sharp(Buffer.from(await file.arrayBuffer())).metadata()).format,'png');
    for (const spec of sizes[entry.kind]) {
      const path = '/api/artwork/' + [entry.company,entry.target,saved.version,spec.key + '.webp'].join('/');
      const meta = await sharp(objects.get(path)).metadata();
      assert.deepEqual([meta.width,meta.height],[spec.width,spec.height]);
    }
  }
  await submit(items);
  assert.equal(updates,1,'identical retry does not create a commit');
  x = 20;
  await assert.rejects(submit(items),/仓库版本已变化/);
  failUpload = true;
  await assert.rejects(submit(reopened.rows),/上传失败/);
  assert.equal(updates,1);
  failUpload = false;
  failRef = true;
  const before = new Map(paths);
  await assert.rejects(submit(reopened.rows),/分支冲突/);
  assert.deepEqual(paths,before);
  failRef = false;
  await submit([reopened.rows[0]]);
  assert.equal(updates,2);
  assert.equal(paths.size,before.size);
  assert.ok(![...paths.keys()].some(p => p.endsWith('.webp')));
  assert.deepEqual(await readdir(root),['data']);
  // A checkout may contain both old Git images and newer R2 manifests.
  const entry = items[0];
  const stem = 'site/public/images/catalog/' + entry.company + '/' + entry.target + '/';
  const legacy = await prepare(entry);
  paths.set(stem + 'current.json',(await client.createBlob(null,null,JSON.stringify(legacy.saved))).sha);
  paths.set(stem + legacy.saved.version + '-source.webp',(await client.createBlob(null,null,legacy.source,'base64')).sha);
  paths.set(stem + legacy.saved.version + '-card.webp',(await client.createBlob(null,null,legacy.files.card,'base64')).sha);
  const mixed = await readArtworkRepository([],null,network);
  const old = mixed.rows.find(row=>row.target===entry.target);
  assert.ok(old.thumbnail.endsWith(legacy.saved.version + '-card.webp'));
  const original = await mixed.original(old);
  assert.deepEqual(Buffer.from(await original.file.arrayBuffer()),Buffer.from(legacy.source,'base64'));
  assert.equal((await submit([old])).records[0].saved.storage,'r2');
});

test('模型可跳过模糊匹配或推荐候选，模型离线时保留手动选图', async t => {
  const previous = process.env.GOODCORP_ART_MODEL;
  process.env.GOODCORP_ART_MODEL = 'test-model';
  t.after(() => {
    if (previous === undefined) delete process.env.GOODCORP_ART_MODEL;
    else process.env.GOODCORP_ART_MODEL = previous;
  });
  let response = -1;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:11434/')) {
      assert.equal(JSON.parse(init.body).model, 'test-model');
      if (response === null) throw new Error('offline');
      return Response.json({message:{content:JSON.stringify({index:response})}});
    }
    if (new URL(url).hostname !== 'en.wikipedia.org') return Response.json({});
    return Response.json({query:{pages:[1,2].map(i=>({index:i,title:'条目'+i,
      thumbnail:{source:'https://upload.wikimedia.org/test'+i+'.jpg'},fullurl:'https://en.wikipedia.org/wiki/Test'+i}))}});
  });
  assert.equal((await searchArtwork('Ambiguous Studio','company')).choice,-1);
  response = 1;
  assert.equal((await searchArtwork('Another Studio','company')).candidates[0].title,'条目2');
  response = null;
  const result = await searchArtwork('Alias Studio','company');
  assert.equal(result.candidates.length,2);
  assert.match(result.warnings.join(' '),/AI 不可用/);
});

test('中文百科改用百度词条主图，未配置或接口失败时保留其他来源', async t => {
  const previous = process.env.BAIDU_BAIKE_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.BAIDU_BAIKE_API_KEY;
    else process.env.BAIDU_BAIKE_API_KEY = previous;
  });
  let calls = 0;
  const hosts = [];
  const image = 'https://bkimg.cdn.bcebos.com/pic/test';
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address);
    hosts.push(url.hostname);
    if (url.hostname === 'appbuilder.baidu.com') {
      calls++;
      assert.equal(url.pathname, '/v2/baike/lemma/get_content');
      assert.equal(options.headers.Authorization, 'Bearer demo-key');
      if (url.searchParams.get('search_key') !== '库洛游戏') return new Response('', {status:403});
      assert.equal(url.searchParams.get('search_type'), 'lemmaTitle');
      return Response.json({result:{lemma_title:'库洛游戏', lemma_id:12, pic_url:image}});
    }
    if (url.hostname === 'en.wikipedia.org') return Response.json({query:{pages:[{title:'Studio', fullurl:'https://en.wikipedia.org/wiki/Studio', thumbnail:{source:'https://upload.wikimedia.org/demo.png'}}]}});
    return Response.json({});
  });
  delete process.env.BAIDU_BAIKE_API_KEY;
  assert.equal((await searchArtwork('库洛','company')).baikeConfigured, false);
  assert.equal(calls, 0);
  process.env.BAIDU_BAIKE_API_KEY = 'demo-key';
  const result = await searchArtwork('库洛', 'company');
  assert.deepEqual(result.candidates.find(c => c.provider === '百度百科'), {
    provider:'百度百科', title:'库洛游戏', page:'https://baike.baidu.com/item/' + encodeURIComponent('库洛游戏') + '/12', image,
  });
  const failed = await searchArtwork('Example Studio', 'company');
  assert.match(failed.warnings.join(' '), /百度百科接口请求失败/);
  assert.ok(failed.candidates.some(c => c.provider === '英文维基百科'));
  assert.ok(!hosts.includes('zh.wikipedia.org'));
  assert.equal(calls, 2);
});

test('公司方形 Logo 单档可上传，历史双档仍可上传和读取', async t => {
  const path = ['c_test','studio','1234567890abcdef'];
  const url = 'https://admin.example/api/admin/artwork/' + path.join('/');
  t.mock.method(globalThis,'fetch',async address => Response.json(
    new URL(address).pathname === '/user' ? {login:'reviewer'} : {permissions:{push:true}}
  ));
  const stored = new Map();
  const env = {GITHUB_OWNER:'org',GITHUB_REPO:'repo',ARTWORK:{
    put(key,bytes) { stored.set(key,{body:bytes,size:bytes.length}); return {}; },
    get(key) { return stored.get(key); },
  }};
  const image = await sharp({create:{width:256,height:256,channels:3,background:'#123456'}}).webp().toBuffer();
  const form = new FormData();
  const file = new Blob([image],{type:'image/webp'});
  const post = () => uploadArtwork({env,params:{path},request:new Request(url,{method:'POST',headers:{Authorization:'Bearer test'},body:form})});
  form.append('card',file,'card.webp');
  assert.equal((await post()).status,200);
  form.append('banner',file,'banner.webp');
  assert.equal((await post()).status,200);
  for (const name of ['card.webp','banner.webp']) {
    const response = await readArtwork({env,params:{path:[...path,name]},request:new Request(url)});
    assert.equal(response.status,200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),image);
  }
});
