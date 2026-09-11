require('dotenv').config();
const db = require('../lib/db');

(async () => {
  console.log('=== DIAGNOSTICO DE TICKETS ===\n');

  const [captchaRows] = await db.query(
    `SELECT id, comercio, status, error_msg, ocr_json
     FROM tickets
     WHERE status IN ('error','pendiente')
       AND (error_msg LIKE '%captcha%' OR error_msg LIKE '%CAPTCHA%')
     ORDER BY id`
  );
  console.log('TICKETS CON CAPTCHA:', captchaRows.length);
  captchaRows.forEach(r => {
    let j = {}; try { j = JSON.parse(r.ocr_json || '{}'); } catch(e) {}
    console.log('  #' + r.id + ' | ' + (r.comercio || '?').slice(0,30) + ' | portal=' + (j.portal || '?') + ' | ' + r.status);
    console.log('      error: ' + (r.error_msg || '').slice(0,100));
  });

  const [recentRows] = await db.query(
    `SELECT id, comercio, status, error_msg, ocr_json
     FROM tickets
     WHERE status = 'error'
     ORDER BY id DESC
     LIMIT 60`
  );
  console.log('\nTICKETS EN ERROR (ultimos 60):');
  recentRows.forEach(r => {
    let j = {}; try { j = JSON.parse(r.ocr_json || '{}'); } catch(e) {}
    const portal = j.portal || '?';
    const msg = (r.error_msg || '').slice(0,50);
    console.log('  #' + r.id + ' | ' + (r.comercio||'?').slice(0,25).padEnd(25) + ' | ' + portal.padEnd(10) + ' | ' + msg);
  });

  const [pendRows] = await db.query(
    `SELECT id, comercio, status, error_msg, ocr_json
     FROM tickets
     WHERE status = 'pendiente_confirmacion'
     ORDER BY id DESC
     LIMIT 30`
  );
  console.log('\nTICKETS PENDIENTES DE CONFIRMACION:', pendRows.length);
  pendRows.forEach(r => {
    let j = {}; try { j = JSON.parse(r.ocr_json || '{}'); } catch(e) {}
    console.log('  #' + r.id + ' | ' + (r.comercio||'?').slice(0,30) + ' | ' + (j.portal||'?'));
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
