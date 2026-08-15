const puppeteer = require("puppeteer");
(async () => {
  const browser = await puppeteer.launch({ headless: "new", executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  page.on("requestfailed", r => console.log("REQ FAIL:", r.url().slice(0, 90), r.failure()?.errorText));
  await page.goto("https://cfdi.analytix360.cloud/cafrema/lc/crear/", { waitUntil: "networkidle2", timeout: 60000 });

  // Esperar a que Google renderice el widget (textarea + iframe)
  const ok = await page.waitForFunction(() =>
    !!document.querySelector("textarea#g-recaptcha-response, iframe[src*='recaptcha']"),
    { timeout: 25000 }).then(() => true).catch(() => false);
  console.log("widget renderizado:", ok);

  const dummy = "03AFcWeA4dummy_" + "x".repeat(300);
  const r = await page.evaluate((t) => {
    const areas = document.querySelectorAll("textarea[name='g-recaptcha-response'], #g-recaptcha-response");
    areas.forEach((a) => { a.value = t; a.innerHTML = t; });
    let resp = null;
    try { resp = window.grecaptcha && window.grecaptcha.getResponse(); } catch (e) { resp = "err " + e.message; }
    const pasaria = !(window.grecaptcha === undefined || window.grecaptcha.getResponse() === "");
    return { areas: areas.length, grecaptchaDefinido: typeof window.grecaptcha,
             largoGetResponse: String(resp || "").length, pasariaElSubmit: pasaria };
  }, dummy);
  console.log("INYECCIÓN:", JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error("💥", e.message); process.exit(1); });
