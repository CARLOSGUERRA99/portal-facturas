require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const imap = new Imap({user:process.env.IMAP_USER,password:process.env.IMAP_PASS,host:process.env.IMAP_HOST,port:993,tls:true,tlsOptions:{rejectUnauthorized:false}});
const c=(x,re)=>(x.match(re)||[])[1]||null;
imap.once('ready',()=>{ imap.openBox('INBOX',true,(e)=>{
  imap.search([['SINCE', new Date(Date.now()-3*864e5)]],(er,uids)=>{
    if(!uids||!uids.length){imap.end();return;}
    const f=imap.fetch(uids,{bodies:''}); const tareas=[];
    f.on('message',(m)=>{tareas.push(new Promise(res=>{let b='';
      m.on('body',s=>s.on('data',d=>{b+=d.toString('utf8')}));
      m.once('end',async()=>{try{const mail=await simpleParser(b);
        for(const a of mail.attachments||[]){const t=a.content.toString('utf8');
          if(!/cfdi:Comprobante/i.test(t)) continue;
          if(!/ELSEAN/i.test(t)) continue;
          console.log('─'.repeat(60));
          console.log('De:', (mail.from?.text||'').slice(0,60), '|', mail.date);
          console.log('Asunto:', (mail.subject||'').slice(0,80));
          console.log('  UUID:', c(t,/UUID="([^"]+)"/i));
          console.log('  Total:', c(t,/[\s"]Total="([^"]+)"/), '| Fecha:', c(t,/\sFecha="([^"]+)"/));
          console.log('  Emisor:', c(t,/Emisor[^>]*Rfc="([^"]+)"/), c(t,/Emisor[^>]*Nombre="([^"]+)"/));
          console.log('  RECEPTOR:', c(t,/Receptor[^>]*Rfc="([^"]+)"/), '|', c(t,/Receptor[^>]*Nombre="([^"]+)"/), '| Uso:', c(t,/UsoCFDI="([^"]+)"/));
          console.log('  Serie/Folio:', c(t,/\sSerie="([^"]+)"/), c(t,/\sFolio="([^"]+)"/));
        }}catch(x){} res();});
    }))});
    f.once('end',async()=>{await Promise.all(tareas); imap.end();});
  });});});
imap.once('error',e=>console.error(e.message));
imap.connect();
