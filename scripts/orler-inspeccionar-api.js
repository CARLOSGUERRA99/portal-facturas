require('dotenv').config();
const puppeteer=require('puppeteer');
const dormir=ms=>new Promise(r=>setTimeout(r,ms));
const API='https://apifacturacion.sinaloa.gob.mx';
(async()=>{
 const b=await puppeteer.connect({browserWSEndpoint:`wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`});
 const p=await b.newPage(); let jwt=null;
 p.on('request',r=>{const m=r.url().match(/[?&]authorization=([^&]+)/);if(m&&!jwt)jwt=decodeURIComponent(m[1]);});
 await p.goto('https://facturacion.sinaloa.gob.mx/login',{waitUntil:'load',timeout:30000});
 await p.waitForSelector('input[name="user"]',{timeout:15000});
 await p.click('input[name="user"]');await p.keyboard.type(process.env.ORLER_SINALOA_USER,{delay:20});
 await p.click('input[name="password"]');await p.keyboard.type(process.env.ORLER_SINALOA_PASS,{delay:20});
 const h=await p.evaluateHandle(()=>Array.from(document.querySelectorAll('button')).find(x=>/iniciar sesi/i.test(x.textContent||''))||null);
 const e=h.asElement(); if(e) await e.click();
 for(let i=0;i<15&&!jwt;i++) await dormir(1000);
 await b.close().catch(()=>{});
 if(!jwt){console.log('sin jwt');process.exit(1);}
 const r=await fetch(`${API}/api/facturas/list/0/5?authorization=${encodeURIComponent(jwt)}`);
 const j=await r.json();
 const arr=Array.isArray(j)?j:(j.data||j.facturas||[]);
 console.log('CLAVES de una factura:'); console.log(Object.keys(arr[0]||{}).join(', '));
 console.log('\nPRIMERA factura completa:'); console.log(JSON.stringify(arr[0],null,1).slice(0,1400));
 process.exit(0);
})();
