const express = require("express");
const mysql   = require("mysql2/promise");
const { McpServer }                    = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

// ── Cliente R2 ─────────────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

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

  // ── TOOL: resetear_ticket ──────────────────────────────────────────────────
  server.tool(
    "resetear_ticket",
    "Resetea un ticket en status error a pendiente_confirmacion para que el auto-processor lo reintente. Borra la fila de facturas asociada si existe.",
    {
      ticket_id: z.number().describe("ID del ticket a resetear"),
    },
    async ({ ticket_id }) => {
      const [[ticket]] = await db.query(
        "SELECT id, status, comercio, error_msg FROM tickets WHERE id = ?",
        [ticket_id]
      );
      if (!ticket) return { content: [{ type: "text", text: `Ticket #${ticket_id} no encontrado` }] };
      if (ticket.status !== 'error') {
        return { content: [{ type: "text", text: `⚠️ Ticket #${ticket_id} tiene status '${ticket.status}', no 'error'. No se resetea.` }] };
      }

      await db.query("DELETE FROM facturas WHERE ticket_id = ?", [ticket_id]);
      await db.query(
        "UPDATE tickets SET status='pendiente_confirmacion', error_msg=NULL, procesando_correo_desde=NULL, reintento_programado=NULL WHERE id=?",
        [ticket_id]
      );
      return {
        content: [{
          type: "text",
          text: `✅ Ticket #${ticket_id} (${ticket.comercio}) reseteado a pendiente_confirmacion.\nError anterior: ${ticket.error_msg || 'n/a'}`
        }]
      };
    }
  );

  // ── TOOL: estado_r2 ────────────────────────────────────────────────────────
  server.tool(
    "estado_r2",
    "Lista archivos recientes en R2. Usa prefijo 'facturas/' para ver XMLs/PDFs generados, 'debug/' para screenshots de bots.",
    {
      prefijo: z.enum(["facturas/", "debug/", ""]).optional().describe("Carpeta a listar: facturas/ | debug/ | '' (todo)"),
      limite:  z.number().optional().describe("Máximo de archivos (default 30)"),
    },
    async ({ prefijo = "facturas/", limite = 30 }) => {
      const cmd = new ListObjectsV2Command({
        Bucket:  process.env.R2_BUCKET,
        Prefix:  prefijo,
        MaxKeys: limite,
      });
      const resp = await s3.send(cmd);
      const archivos = (resp.Contents || []).map(obj => ({
        key:     obj.Key,
        url:     `${process.env.R2_PUBLIC_URL}/${obj.Key}`,
        tamaño:  `${Math.round(obj.Size / 1024)} KB`,
        fecha:   obj.LastModified,
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            prefijo,
            total: archivos.length,
            hayMas: resp.IsTruncated,
            archivos,
          }, null, 2),
        }],
      };
    }
  );

  // ── TOOL: logs_railway ──────────────────────────────────────────────────────
  server.tool(
    "logs_railway",
    "Obtiene los logs recientes del servicio portal-facturas desde la API de Railway. Requiere RAILWAY_TOKEN y RAILWAY_DEPLOYMENT_ID en las variables de entorno.",
    {
      limite: z.number().optional().describe("Número de líneas a traer (default 50)"),
      filtro: z.string().optional().describe("Texto para filtrar líneas (ej: 'error', 'bot', 'OXXO')"),
    },
    async ({ limite = 50, filtro }) => {
      const token        = process.env.RAILWAY_TOKEN;
      const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID;

      if (!token || !deploymentId) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Faltan variables: RAILWAY_TOKEN y/o RAILWAY_DEPLOYMENT_ID",
              instruccion: "Agrega estas vars en Railway → portal-facturas-mcp → Variables",
            }, null, 2),
          }],
        };
      }

      const query = `
        query {
          deploymentLogs(deploymentId: "${deploymentId}", limit: ${limite * 2}) {
            message
            timestamp
            severity
          }
        }
      `;

      const resp = await fetch("https://backboard.railway.app/graphql/v2", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ query }),
      });

      const data = await resp.json();
      if (data.errors) {
        return { content: [{ type: "text", text: JSON.stringify({ error: data.errors }, null, 2) }] };
      }

      let lineas = data.data.deploymentLogs || [];
      if (filtro) {
        lineas = lineas.filter(l => l.message.toLowerCase().includes(filtro.toLowerCase()));
      }
      lineas = lineas.slice(-limite);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ total: lineas.length, filtro: filtro || null, logs: lineas }, null, 2),
        }],
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
