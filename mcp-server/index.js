const express = require("express");
const mysql   = require("mysql2/promise");
const { McpServer }                    = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// ── Base de datos ──────────────────────────────────────────────────────────────
const db = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  port:     parseInt(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME,
});

// ── API Key de protección ──────────────────────────────────────────────────────
const API_KEY = process.env.MCP_API_KEY;

// ── Servidor MCP ───────────────────────────────────────────────────────────────
function crearMcpServer() {
  const server = new McpServer({
    name:    "portal-facturas-db",
    version: "1.0.0",
  });

  // ── TOOL: estado_sistema ────────────────────────────────────────────────────
  server.tool(
    "estado_sistema",
    "Resumen completo del estado del sistema: tickets por status, atascados, errores recientes y portales pendientes.",
    {},
    async () => {
      const [[conteos]] = await db.query(`
        SELECT
          SUM(status = 'pendiente_confirmacion') AS pendiente_confirmacion,
          SUM(status = 'facturando')             AS facturando,
          SUM(status = 'completado')             AS completado,
          SUM(status = 'error')                  AS error,
          SUM(status = 'procesando_correo')      AS procesando_correo,
          COUNT(*)                               AS total
        FROM tickets
      `);

      const [atascados] = await db.query(`
        SELECT id, comercio, status, creado
        FROM tickets
        WHERE status IN ('procesando_correo','facturando')
          AND creado < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
        ORDER BY creado ASC
      `);

      const [errores] = await db.query(`
        SELECT id, comercio, ocr_json, creado
        FROM tickets
        WHERE status = 'error'
        ORDER BY creado DESC
        LIMIT 5
      `);

      const [portales] = await db.query(`
        SELECT nombre, url, notas, creado FROM portales_pendientes ORDER BY creado DESC
      `);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ conteos, atascados, errores_recientes: errores, portales_pendientes: portales }, null, 2)
        }]
      };
    }
  );

  // ── TOOL: consultar_tickets ─────────────────────────────────────────────────
  server.tool(
    "consultar_tickets",
    "Consulta tickets con filtros opcionales por status, comercio o usuario.",
    {
      status:   z.string().optional().describe("pendiente_confirmacion | facturando | completado | error | procesando_correo"),
      comercio: z.string().optional().describe("Nombre parcial del comercio"),
      limite:   z.number().optional().describe("Máximo de resultados (default 20)"),
    },
    async ({ status, comercio, limite = 20 }) => {
      let where = "WHERE 1=1";
      const params = [];
      if (status)   { where += " AND status = ?";          params.push(status); }
      if (comercio) { where += " AND comercio LIKE ?";     params.push(`%${comercio}%`); }

      const [rows] = await db.query(
        `SELECT id, comercio, status, portal_url, creado, ocr_json FROM tickets ${where} ORDER BY creado DESC LIMIT ?`,
        [...params, limite]
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify(rows, null, 2)
        }]
      };
    }
  );

  // ── TOOL: consultar_portales_pendientes ─────────────────────────────────────
  server.tool(
    "consultar_portales_pendientes",
    "Lista los portales nuevos reportados por usuarios con su cuestionario.",
    {},
    async () => {
      const [rows] = await db.query(
        "SELECT id, nombre, url, notas, creado FROM portales_pendientes ORDER BY creado DESC"
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify(rows, null, 2)
        }]
      };
    }
  );

  // ── TOOL: reprocesar_ticket ─────────────────────────────────────────────────
  server.tool(
    "reprocesar_ticket",
    "Cambia el status de un ticket atascado para que el job de IMAP lo reintente.",
    {
      ticket_id: z.number().describe("ID del ticket a reprocesar"),
    },
    async ({ ticket_id }) => {
      const [[ticket]] = await db.query(
        "SELECT id, status, comercio FROM tickets WHERE id = ?",
        [ticket_id]
      );
      if (!ticket) return { content: [{ type: "text", text: `Ticket #${ticket_id} no encontrado` }] };

      await db.query(
        "UPDATE tickets SET status = 'procesando_correo' WHERE id = ?",
        [ticket_id]
      );
      return {
        content: [{
          type: "text",
          text: `✅ Ticket #${ticket_id} (${ticket.comercio}) encolado para reproceso. Status anterior: ${ticket.status}`
        }]
      };
    }
  );

  return server;
}

// ── Express + Streamable HTTP ──────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "portal-facturas-mcp" }));

// Middleware de autenticación (no aplica a /health)
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: "API key inválida" });
  next();
});

// Endpoint MCP — acepta GET y POST en /mcp
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  const server = crearMcpServer();

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ MCP server corriendo en puerto ${PORT}`);
  console.log(`   HTTP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`   Auth: ${API_KEY ? "API key activa" : "SIN autenticación (configura MCP_API_KEY)"}`);
});
