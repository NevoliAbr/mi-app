'use strict';
require('dotenv').config();

// DB_TYPE: 'mssql' | 'mysql' | auto-detect por DB_PORT (1433→mssql, resto→mysql)
const _envType = (process.env.DB_TYPE || 'auto').toLowerCase();
let ACTIVE_TYPE =
  _envType === 'mssql' || _envType === 'sqlserver' ? 'mssql' :
  _envType === 'mysql'                              ? 'mysql' :
  parseInt(process.env.DB_PORT || '3306') === 1433  ? 'mssql' : 'mysql';

// ── MySQL ─────────────────────────────────────────────────────
let mysqlPool = null;
function getMysqlPool() {
  if (mysqlPool) return mysqlPool;
  const mysql = require('mysql2/promise');
  mysqlPool = mysql.createPool({
    host:               process.env.MYSQL_HOST     || process.env.DB_SERVER || 'localhost',
    port:               parseInt(process.env.MYSQL_PORT || process.env.DB_PORT || '3306'),
    user:               process.env.MYSQL_USER     || process.env.DB_USER   || 'root',
    password:           process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || '',
    database:           process.env.MYSQL_DATABASE || process.env.DB_NAME   || 'mibase',
    waitForConnections: true,
    connectionLimit:    10,
    timezone:           '+00:00',
    ssl:                false,
    connectTimeout:     30000,
  });
  mysqlPool.on('error', err => console.error('⚠ Error pool MySQL:', err.message));
  return mysqlPool;
}

// ── SQL Server ────────────────────────────────────────────────
let mssqlRaw = null;
async function getMssqlRaw() {
  if (mssqlRaw) return mssqlRaw;
  const mssql  = require('mssql');
  const server = (process.env.DB_SERVER || 'localhost').replace(/\\\\/g, '\\');
  const config = {
    user:     process.env.DB_USER     || 'sa',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'mibase',
    options:  { encrypt: false, trustServerCertificate: true },
  };

  // Instancia nombrada: localhost\SQLEXPRESS → server + instanceName (sin port)
  if (server.includes('\\')) {
    const [host, inst] = server.split('\\');
    config.server = host || 'localhost';
    config.options.instanceName = inst;
  } else {
    config.server = server;
    config.port   = parseInt(process.env.DB_PORT || '1433');
  }

  mssqlRaw = await mssql.connect(config);
  return mssqlRaw;
}

// ── Adaptador mssql → interfaz mysql2 ────────────────────────
// Convierte sintaxis MySQL a T-SQL y devuelve [rows] igual que mysql2
function toTSQL(sql) {
  return sql
    .replace(/\bNOW\(\)/gi,       'GETDATE()')
    .replace(/\bCURDATE\(\)/gi,   'CAST(GETDATE() AS DATE)')
    .replace(/\bDATABASE\(\)/gi,  'DB_NAME()')
    .replace(/\bLAST_INSERT_ID\(\)/gi, 'SCOPE_IDENTITY()');
}

async function mssqlExecute(raw, sql, params = []) {
  const mssql = require('mssql');
  let tsql = toTSQL(sql);

  const isInsert = /^\s*INSERT\s+INTO\s/i.test(tsql);
  if (isInsert && !/OUTPUT\s+INSERTED/i.test(tsql)) {
    // Inyectar OUTPUT INSERTED.id antes de VALUES/SELECT para recuperar insertId
    tsql = tsql.replace(/\)\s*(VALUES|SELECT)/i, ') OUTPUT INSERTED.id $1');
  }

  // Reemplazar ? por @p1, @p2, ...
  let idx = 0;
  const paramSql = tsql.replace(/\?/g, () => `@p${++idx}`);

  const req = raw.request();
  for (let i = 0; i < idx; i++) {
    req.input(`p${i + 1}`, params[i] === undefined ? null : params[i]);
  }

  const result = await req.query(paramSql);

  if (isInsert) {
    const insertId = result.recordset?.[0]?.id ?? null;
    return [{ insertId, affectedRows: result.rowsAffected?.[0] ?? 0 }];
  }
  if (/^\s*(UPDATE|DELETE)/i.test(sql)) {
    return [{ affectedRows: result.rowsAffected?.[0] ?? 0 }];
  }
  return [result.recordset || []];
}

function wrapMssql(raw) {
  return {
    execute:       (sql, params) => mssqlExecute(raw, sql, params),
    query:         (sql, params) => mssqlExecute(raw, sql, params),
    getConnection: async () => {
      const conn = { release: () => {} };
      return conn;
    },
  };
}

// ── Pool activo ───────────────────────────────────────────────
let _pool      = null;
let _connected = false;

async function getPool() {
  if (_pool) return _pool;
  if (ACTIVE_TYPE === 'mssql') {
    const raw = await getMssqlRaw();
    _pool = wrapMssql(raw);
  } else {
    _pool = getMysqlPool();
  }
  return _pool;
}

// ── Test de conexión al iniciar ───────────────────────────────
(async () => {
  try {
    const pool = await getPool();
    if (ACTIVE_TYPE === 'mssql') {
      const [rows] = await pool.execute('SELECT DB_NAME() AS db');
      console.log('✔ Conectado a SQL Server -', rows[0]?.db);
    } else {
      const conn = await getMysqlPool().getConnection();
      conn.release();
      console.log('✔ Conectado a MySQL -', process.env.MYSQL_DATABASE || process.env.DB_NAME);
    }
    _connected = true;
  } catch (err) {
    console.error('✘ No se pudo conectar a la base de datos:');
    console.error('  tipo:   ', ACTIVE_TYPE);
    console.error('  mensaje:', err.message);
    if (ACTIVE_TYPE === 'mssql') {
      console.error('  Verifica: SQL Server Browser activo, credenciales y nombre de instancia.');
    }
  }
})();

// ── Exports ───────────────────────────────────────────────────
function getDBType() { return ACTIVE_TYPE; }
function getDBInfo() {
  return { type: ACTIVE_TYPE, label: ACTIVE_TYPE === 'mssql' ? 'SQL Server' : 'MySQL', connected: _connected };
}
async function switchDB(type) {
  const t = (type || '').toLowerCase();
  if (t !== 'mssql' && t !== 'mysql') throw new Error('Usa "mssql" o "mysql"');
  ACTIVE_TYPE = t;
  _pool       = null;
  _connected  = false;
  mssqlRaw    = null;
  mysqlPool   = null;
  return getPool();
}

module.exports = { getPool, getDBType, getDBInfo, switchDB };
