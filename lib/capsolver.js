// Resolutor de CAPTCHA de imagen vía CapSolver.
//
// Es el mismo código que ya vive dentro de bots/7elevenmexicosadecv.js, sacado
// aquí para poder reusarlo sin tocar ese bot (que funciona y está verificado en
// vivo). El de 7-Eleven se queda como está a propósito.
//
// ⚠️ ImageToTextTask es SÍNCRONO: createTask ya devuelve status:"ready" con la
// solución. Hacer polling con getTaskResult sobre una tarea síncrona contesta
// ERROR_TASK_NOT_FOUND, que parece un fallo de la key y no lo es. El polling de
// abajo es solo un colchón por si algún día responde "processing".
//
// ⚠️ Esto NO se puede llamar desde la página: la API de CapSolver no manda
// cabeceras CORS y el fetch del navegador muere. Se llama desde Node.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Acepta tanto un data URI ("data:image/png;base64,AAA…") como el base64 pelado.
function soloBase64(img) {
  const s = String(img || "");
  const i = s.indexOf("base64,");
  return i === -1 ? s : s.slice(i + 7);
}

async function resolverCaptchaImagen(img) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error("CAPSOLVER_API_KEY no definida");
  const body = soloBase64(img);
  if (!body || body.length < 50) throw new Error("CapSolver: imagen de captcha vacía");

  const c = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task: { type: "ImageToTextTask", module: "common", body } }),
  }).then((r) => r.json());
  if (c.errorId) throw new Error(`CapSolver create: ${c.errorCode || c.errorDescription}`);

  if (c.status === "ready" && c.solution) {
    const sol = (c.solution.text || (c.solution.answers && c.solution.answers[0]) || "").trim();
    if (!sol) throw new Error("CapSolver sin texto");
    console.log(`🔓 CAPTCHA resuelto: "${sol}" (conf ${c.solution.confidence ?? "?"})`);
    return sol;
  }

  if (!c.taskId) throw new Error("CapSolver: sin solución ni taskId");
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: c.taskId }),
    }).then((r) => r.json());
    if (res.status === "ready") {
      const sol = (res.solution?.text || res.solution?.answers?.[0] || "").trim();
      if (!sol) throw new Error("CapSolver sin texto");
      console.log(`🔓 CAPTCHA resuelto: "${sol}"`);
      return sol;
    }
    if (res.errorId) throw new Error(`CapSolver result: ${res.errorCode || res.errorDescription}`);
  }
  throw new Error("CapSolver: se agotó la espera");
}

module.exports = { resolverCaptchaImagen, soloBase64 };
