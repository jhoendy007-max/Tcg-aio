import http from 'http'; import WebSocket from 'ws'; import fs from 'fs'
const list=await new Promise(r=>http.get('http://127.0.0.1:9341/json/list',res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>r(JSON.parse(d)))}))
const ws=new WebSocket(list.find(x=>x.type==='page').webSocketDebuggerUrl,{maxPayload:3e8}); await new Promise(r=>ws.on('open',r))
let n=0; const send=(m,p={})=>new Promise(r=>{const id=++n;ws.send(JSON.stringify({id,method:m,params:p}));const h=e=>{const d=JSON.parse(e);if(d.id===id){ws.off('message',h);r(d.result)}};ws.on('message',h)})
const wait=ms=>new Promise(r=>setTimeout(r,ms)); const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result?.value
const shot=async(name)=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('/workspace/shots-0.2.46/'+name,Buffer.from(r.data,'base64'))}
await send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false})
await send('Page.navigate',{url:'http://127.0.0.1:8742/index.html'}); await wait(2500)
await send('Page.navigate',{url:'about:blank'});await wait(300);await send('Page.navigate',{url:'http://127.0.0.1:8742/index.html#settings/discord'}); await wait(2500)
console.log('eastern', (await ev('document.body.innerText')).includes('Eastern Time'), 'atlantic', /Atlantic|Puerto/.test(await ev('document.body.innerText')))
await send('Emulation.setDeviceMetricsOverride',{width:1400,height:4600,deviceScaleFactor:1,mobile:false}); await wait(800)
await shot('drops-eastern-time.png')
await send('Page.navigate',{url:'about:blank'});await wait(300);await send('Page.navigate',{url:'http://127.0.0.1:8742/index.html#settings/logs'}); await wait(2500)
await shot('logs-dry-run-cart-warning.png')
console.log((await ev('document.body.innerText')).includes('Heads up'))
process.exit(0)
