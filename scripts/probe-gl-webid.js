/**
 * ¿Se puede recuperar el WebId del ticket #379 a partir de la Transacción (73727)
 * o de la Venta (74818)? Sonda de solo lectura contra gl-operacion.com.mx.
 * No emite nada.
 */
require('dotenv').config();
const puppeteer = require('puppeteer');

const BASE = 'https://www.gl-operacion.com.mx';
const TIPO = '2';        // Pemex
const EST = '11595';
const TRANSACCION = '73727';
const VENTA = '74818';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.goto(BASE + '/index.php', { waitUntil: 'networkidle2', timeout: 45000 });

  const probar = async (url, params) => page.evaluate(async (u, p) => {
    const qs = new URLSearchParams(p).toString();
    try {
      const res = await fetch(u + '?' + qs, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const t = await res.text();
      return { url: u, status: res.status, len: t.length, body: t.replace(/\s+/g, ' ').trim().slice(0, 600) };
    } catch (e) { return { url: u, error: e.message }; }
  }, url, params);

  const casos = [
    ['valida_transaccion.php', { num_franquicia: EST, tipo_estacion: TIPO, id_transaccion: TRANSACCION }],
    ['valida_transaccion.php', { num_franquicia: EST, tipo_estacion: TIPO, id_transaccion: VENTA }],
    ['cargar_ventas.php', { num_franquicia: EST, tipo_estacion: TIPO }],
  ];

  for (const [u, p] of casos) {
    console.log('\n>>>', u, JSON.stringify(p));
    console.log(JSON.stringify(await probar(u, p), null, 1));
  }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
