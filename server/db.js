const mysql = require('mysql2/promise');

const config = {
  host:             process.env.DB_SERVER   || 'localhost',
  port:             parseInt(process.env.DB_PORT || '3306'),
  user:             process.env.DB_USER     || 'Nevoli',
  password:         process.env.DB_PASSWORD || 'm@i0~cvRbT7H6vyx',
  database:         process.env.DB_NAME     || 'mibase',
  waitForConnections: true,
  connectionLimit:  10,
  queueLimit:       0,
  timezone:         '+00:00',
};

let pool = null;

function createPool() {
  pool = mysql.createPool(config);
  pool.on('error', err => {
    console.error('⚠ Error en el pool MySQL:', err.message);
  });
  return pool;
}

async function getPool() {
  if (!pool) createPool();
  return pool;
}

// Conectar al iniciar y verificar
(async () => {
  try {
    const p    = createPool();
    const conn = await p.getConnection();
    conn.release();
    console.log('✔ Conectado a MySQL -', config.database);
  } catch (err) {
    console.error('✘ No se pudo conectar a MySQL:', err.message);
    console.error('  Verifica que el servicio MySQL esté activo y las credenciales sean correctas.');
  }
})();

module.exports = { getPool };
