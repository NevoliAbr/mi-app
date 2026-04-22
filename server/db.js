const sql = require('mssql');

const config = {
  user: 'sa',
  password: 'nevoli123',
  server: 'localhost',
  port: 1433,
  database: 'mibase',
  options: {
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool = null;

async function connect(intentos = 5, espera = 3000) {
  for (let i = 1; i <= intentos; i++) {
    try {
      pool = await sql.connect(config);
      console.log('✔ Conectado a SQL Server -', config.database);
      pool.on('error', async err => {
        console.error('⚠ Error en el pool, reconectando...', err.message);
        pool = null;
        setTimeout(() => connect(), 5000);
      });
      return pool;
    } catch (err) {
      console.error(`✘ Intento ${i}/${intentos} fallido: ${err.message}`);
      if (i < intentos) {
        console.log(`  Reintentando en ${espera / 1000}s...`);
        await new Promise(r => setTimeout(r, espera));
      } else {
        console.error('  No se pudo conectar a SQL Server. Verifica que el servicio esté activo.');
      }
    }
  }
}

async function getPool() {
  if (!pool) await connect(3, 2000);
  if (!pool) throw new Error('No se pudo conectar a la base de datos. Verifica que SQL Server esté activo.');
  return pool;
}

// Conectar al iniciar
connect();

module.exports = { sql, getPool };
