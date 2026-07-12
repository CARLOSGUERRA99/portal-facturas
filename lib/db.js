// Pool MySQL compartido entre el servidor web (server.js) y el worker (worker.js).
// Ambos procesos crean su propio pool a partir de las mismas variables de entorno.
require("dotenv").config();
const mysql = require("mysql2/promise");

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
});

module.exports = db;
