// Exploración EN VIVO del paso 2 de Little Caesars (Validar RFC).
// Corre el paso 1 completo (ticket + CapSolver) contra el portal real y, al
// caer en la pantalla de datos fiscales, vuelca su HTML/selectores a
// /tmp/lc_paso2.html y una captura local. NO envía el paso 2.
//
// Uso:  node scripts/explorar-lc-paso2.js
// Requiere: BROWSERLESS_TOKEN y CAPSOLVER_API_KEY en el entorno.
const puppeteer = require("puppeteer");
const fs = require("fs");

const BASE = "https://cfdi.analytix360.cloud/cafrema/lc";
const SITEKEY = "6Lft1l8UAAAAAE08IIf97xe4Gam2xRRAJAS1_qpa";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ticket #218 (real, pendiente): tienda 04123-00053, ticket 1099376
const DATOS = {
  tienda: "04123-00053",
  ticket: "1099376",
  fecha: "2026-08-04",
  total: "875.00",
  rfc: "GPR110128QD8",
};

async function resolverRecaptchaV2(websiteURL, websiteKey) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  const c = await fetch("https://api.capsolver.com/createTask", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task: { type: "ReCaptchaV2TaskProxyLess", websiteURL, websiteKey } }),
  }).then((r) => r.json());
  if (c.errorId) throw new Error(`create: ${c.errorCode || c.errorDescription}`);
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: c.taskId }),
    }).then((r) => r.json());
    if (res.status === "ready") return res.solution.gRecaptchaResponse;
    if (res.errorId) throw new Error(`result: ${res.errorCode || res.errorDescription}`);
  }
  throw new Error("timeout 120s");
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 950 });
  page.on("dialog", async (d) => { console.log("🔔 dialog:", d.message()); await d.accept().catch(() => {}); });

  await page.goto(`${BASE}/crear/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#ticket_cv_store", { timeout: 20000 });
  await sleep(1500);

  // Tienda
  const tiendaOk = await page.evaluate((clave) => {
    const s = document.querySelector("#ticket_cv_store");
    const o = Array.from(s.options).find((x) => x.textContent.trim() === clave || x.value === clave);
    if (o) { s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return o.textContent.trim(); }
    return null;
  }, DATOS.tienda);
  console.log("tienda:", tiendaOk);

  const poner = (sel, v) => page.evaluate((s, val) => {
    const e = document.querySelector(s);
    e.value = val;
    ["input", "change", "keyup", "blur"].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
  }, sel, v);
  await poner("#ticket_cv_ticket", DATOS.ticket);
  await poner("#ticket_cv_fecha", DATOS.fecha);
  await poner("#ticket_cv_total", DATOS.total);
  await poner("#ticket_cv_rfc", DATOS.rfc);

  // Captcha
  console.log("resolviendo reCAPTCHA con CapSolver...");
  const t0 = Date.now();
  const tok = await resolverRecaptchaV2(`${BASE}/crear/`, SITEKEY);
  console.log(`token recibido en ${Math.round((Date.now() - t0) / 1000)}s`);
  await page.evaluate((t) => {
    document.querySelectorAll("textarea[name='g-recaptcha-response'], #g-recaptcha-response")
      .forEach((a) => { a.value = t; a.innerHTML = t; });
  }, tok);

  // Enviar paso 1
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button, input[type=submit]"))
      .find((x) => /enviar/i.test(x.textContent || x.value || "") && x.offsetParent);
    if (b) b.click();
  });
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
  await sleep(4000);

  console.log("URL tras enviar:", page.url());
  const html = await page.content();
  fs.writeFileSync("/tmp/lc_paso2.html", html);
  await page.screenshot({ path: "/tmp/lc_paso2.png", fullPage: true });

  const resumen = await page.evaluate(() => ({
    titulo: document.title,
    forms: Array.from(document.querySelectorAll("form")).map((f) => ({ action: f.action, method: f.method, id: f.id })),
    campos: Array.from(document.querySelectorAll("input, select, textarea")).map((e) => ({
      tag: e.tagName, type: e.type, id: e.id, name: e.name, ph: e.placeholder,
      opciones: e.tagName === "SELECT" ? Array.from(e.options).slice(0, 8).map((o) => `${o.value}=${o.textContent.trim()}`) : undefined,
    })),
    botones: Array.from(document.querySelectorAll("button, input[type=submit], a.btn")).map((b) => (b.textContent || b.value || "").trim()).filter(Boolean),
    texto: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 500),
  }));
  console.log(JSON.stringify(resumen, null, 2));

  await browser.close();
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
