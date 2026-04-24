const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcrypt');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const XLSX    = require('xlsx');
const { sql, getPool } = require('./db');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

/* ── Servir archivos HTML estáticos ─────────────── */
const publicDir = path.join(__dirname, '..');
app.use(express.static(publicDir));

/* ── Directorios ────────────────────────────────── */
const uploadsDir     = path.join(__dirname, 'uploads');
const projectsDir    = path.join(__dirname, '..', 'projects');
const entregablesDir = path.join(__dirname, 'entregables');
if (!fs.existsSync(uploadsDir))     fs.mkdirSync(uploadsDir,     { recursive: true });
if (!fs.existsSync(projectsDir))    fs.mkdirSync(projectsDir,    { recursive: true });
if (!fs.existsSync(entregablesDir)) fs.mkdirSync(entregablesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `user_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith('image/')
      ? cb(null, true)
      : cb(new Error('Solo se permiten imágenes.'))
});

app.use('/uploads',     express.static(uploadsDir));
app.use('/entregables', express.static(entregablesDir));

/* ── Multer: xlsx projects ──────────────────────── */
const xlsxStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, projectsDir),
  filename:    (_req, _file, cb) => cb(null, `_tmp_${Date.now()}.xlsx`)
});
const xlsxUpload = multer({
  storage: xlsxStorage,
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.xlsx');
    cb(ok ? null : new Error('Solo se permiten archivos .xlsx'), ok);
  }
});

/* ── Helpers xlsx ───────────────────────────────── */
function excelSerial(s) {
  if (!s || typeof s !== 'number') return null;
  return new Date(Math.round((s - 25569) * 864e5)).toISOString().split('T')[0];
}

function parseProjectXLSX(filepath) {
  const wb   = XLSX.readFile(filepath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const tasks = [];
  let projectRow = null;

  for (let i = 5; i < rows.length; i++) {
    const r   = rows[i];
    const edt = String(r[1] || '').trim();
    if (!edt) continue;

    const nombre = [r[2],r[3],r[4],r[5],r[6],r[7]]
      .map(v => String(v || '').trim()).find(v => v) || '';
    if (!nombre) continue;

    const tipo  = String(r[27] || '').trim();
    const nivel = typeof r[29] === 'number' ? r[29] : 1;

    const t = {
      edt, nombre, tipo, nivel,
      inicio:     excelSerial(r[10]),
      fin:        excelSerial(r[11]),
      progreso:   typeof r[13] === 'number' ? Math.round(r[13]) : 0,
      duracion:   typeof r[14] === 'number' ? r[14] : 0,
      estado:     String(r[17] || '').trim(),
      prioridad:  String(r[18] || '').trim(),
      asignadoA:  String(r[9]  || '').trim(),
      predecesor: String(r[20] || '').trim(),
    };

    if (tipo === 'proyecto') projectRow = t;
    tasks.push(t);
  }

  return { projectRow, tasks };
}

/* ── Utilidades ─────────────────────────────────── */
app.get('/api/test', async (_req, res) => {
  try {
    const pool   = await getPool();
    const result = await pool.request().query('SELECT 1 AS connected, DB_NAME() AS database_name');
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Proyectos ─────────────────────────────────── */
app.get('/api/proyectos', async (_req, res) => {
  try {
    const pool   = await getPool();
    const result = await pool.request().query(
      'SELECT id, nombre FROM proyectos WHERE activo = 1 ORDER BY nombre'
    );
    res.json({ success: true, proyectos: result.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Auth: Registro ─────────────────────────────── */
app.post('/api/auth/register', async (req, res) => {
  const { nombre, email, password } = req.body;

  if (!nombre || !email || !password)
    return res.status(400).json({ success: false, error: 'Todos los campos son requeridos.' });
  if (password.length < 6)
    return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres.' });

  try {
    const pool     = await getPool();
    const existing = await pool.request()
      .input('email', sql.NVarChar(150), email.toLowerCase().trim())
      .query('SELECT id FROM usuarios WHERE email = @email');

    if (existing.recordset.length > 0)
      return res.status(409).json({ success: false, error: 'Este correo ya está registrado.' });

    const hash   = await bcrypt.hash(password, 10);
    const result = await pool.request()
      .input('nombre',        sql.NVarChar(100), nombre.trim())
      .input('email',         sql.NVarChar(150), email.toLowerCase().trim())
      .input('password_hash', sql.NVarChar(255), hash)
      .query('INSERT INTO usuarios (nombre, email, password_hash) OUTPUT INSERTED.id VALUES (@nombre, @email, @password_hash)');

    res.status(201).json({ success: true, message: 'Cuenta creada correctamente.', userId: result.recordset[0].id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Auth: Login ────────────────────────────────── */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ success: false, error: 'Correo y contraseña son requeridos.' });

  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input('email', sql.NVarChar(150), email.toLowerCase().trim())
      .query('SELECT id, nombre, email, password_hash, rol FROM usuarios WHERE email = @email AND activo = 1');

    if (result.recordset.length === 0)
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas.' });

    const user  = result.recordset[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid)
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas.' });

    res.json({ success: true, user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Usuario info: GET ──────────────────────────── */
app.get('/api/usuarios/:id/info', async (req, res) => {
  try {
    const pool      = await getPool();
    const usuarioId = parseInt(req.params.id);

    const infoRes = await pool.request()
      .input('usuario_id', sql.Int, usuarioId)
      .query('SELECT * FROM usuario_info WHERE usuario_id = @usuario_id');

    const minsRes = await pool.request()
      .input('usuario_id', sql.Int, usuarioId)
      .query(`SELECT m.id, m.nombre FROM proyectos m
              INNER JOIN usuario_proyectos um ON um.proyecto_id = m.id
              WHERE um.usuario_id = @usuario_id ORDER BY m.nombre`);

    res.json({
      success: true,
      info: infoRes.recordset[0] || null,
      proyectos: minsRes.recordset
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Usuario info: POST (upsert) ────────────────── */
app.post('/api/usuarios/:id/info', upload.single('foto'), async (req, res) => {
  const usuarioId = parseInt(req.params.id);
  const { fecha_nacimiento, direccion, estado_civil, proyecto_ids } = req.body;
  const fotoNueva = req.file ? `/uploads/${req.file.filename}` : null;

  // Parsear IDs de proyectos (vienen como JSON string o array)
  let mids = [];
  try { mids = JSON.parse(proyecto_ids || '[]'); } catch { mids = []; }
  mids = mids.map(Number).filter(Boolean);

  try {
    const pool     = await getPool();
    const existing = await pool.request()
      .input('usuario_id', sql.Int, usuarioId)
      .query('SELECT id, foto FROM usuario_info WHERE usuario_id = @usuario_id');

    if (existing.recordset.length > 0) {
      if (fotoNueva && existing.recordset[0].foto) {
        const oldPath = path.join(__dirname, existing.recordset[0].foto);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      const fotoFinal = fotoNueva || existing.recordset[0].foto;
      await pool.request()
        .input('usuario_id',       sql.Int,          usuarioId)
        .input('fecha_nacimiento', sql.Date,          fecha_nacimiento || null)
        .input('direccion',        sql.NVarChar(500), direccion        || null)
        .input('estado_civil',     sql.NVarChar(50),  estado_civil     || null)
        .input('foto',             sql.NVarChar(500), fotoFinal)
        .query(`UPDATE usuario_info SET
          fecha_nacimiento = @fecha_nacimiento,
          direccion        = @direccion,
          estado_civil     = @estado_civil,
          foto             = @foto,
          actualizado_en   = SYSDATETIME()
          WHERE usuario_id = @usuario_id`);
    } else {
      await pool.request()
        .input('usuario_id',       sql.Int,          usuarioId)
        .input('fecha_nacimiento', sql.Date,          fecha_nacimiento || null)
        .input('direccion',        sql.NVarChar(500), direccion        || null)
        .input('estado_civil',     sql.NVarChar(50),  estado_civil     || null)
        .input('foto',             sql.NVarChar(500), fotoNueva)
        .query(`INSERT INTO usuario_info (usuario_id, fecha_nacimiento, direccion, estado_civil, foto)
          VALUES (@usuario_id, @fecha_nacimiento, @direccion, @estado_civil, @foto)`);
    }

    // Reemplazar proyectos (delete + insert)
    await pool.request()
      .input('usuario_id', sql.Int, usuarioId)
      .query('DELETE FROM usuario_proyectos WHERE usuario_id = @usuario_id');

    for (const mid of mids) {
      await pool.request()
        .input('usuario_id', sql.Int, usuarioId)
        .input('proyecto_id', sql.Int, mid)
        .query('INSERT INTO usuario_proyectos (usuario_id, proyecto_id) VALUES (@usuario_id, @proyecto_id)');
    }

    res.json({ success: true });
  } catch (err) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Admin: Listar usuarios ─────────────────────── */
app.get('/api/admin/usuarios', async (_req, res) => {
  try {
    const pool   = await getPool();
    const result = await pool.request().query(
      'SELECT id, nombre, email, rol, activo, creado_en FROM usuarios ORDER BY creado_en DESC'
    );
    res.json({ success: true, usuarios: result.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Promover a superusuario (solo ascenso) ── */
app.patch('/api/admin/usuarios/:id/rol', async (req, res) => {
  const { rol } = req.body;
  if (rol !== 'superusuario')
    return res.status(403).json({ success: false, error: 'Solo se puede promover a superusuario.' });
  try {
    const pool = await getPool();
    // Verificar que el usuario actual NO sea ya superusuario (no degradar)
    const current = await pool.request()
      .input('id', sql.Int, parseInt(req.params.id))
      .query('SELECT rol FROM usuarios WHERE id = @id');
    if (current.recordset[0]?.rol === 'superusuario')
      return res.status(409).json({ success: false, error: 'El usuario ya es superusuario.' });
    await pool.request()
      .input('id',  sql.Int,          parseInt(req.params.id))
      .input('rol', sql.NVarChar(20), 'superusuario')
      .query('UPDATE usuarios SET rol = @rol WHERE id = @id');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Activar / desactivar ────────────────── */
app.patch('/api/admin/usuarios/:id/activo', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id',     sql.Int, parseInt(req.params.id))
      .input('activo', sql.Bit, req.body.activo ? 1 : 0)
      .query('UPDATE usuarios SET activo = @activo WHERE id = @id');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Eliminar usuario ────────────────────── */
app.delete('/api/admin/usuarios/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, parseInt(req.params.id))
      .query('DELETE FROM usuarios WHERE id = @id');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Avisos: GET activos (homepage reel) ────────── */
app.get('/api/avisos', async (_req, res) => {
  try {
    const pool = await getPool();
    const avisosRes = await pool.request().query(
      `SELECT id, titulo, texto, fecha_fin, link
       FROM avisos
       WHERE activo = 1 AND fecha_fin >= CAST(GETDATE() AS DATE)
       ORDER BY creado_en DESC`
    );
    const avisos = avisosRes.recordset;

    for (const a of avisos) {
      const imgsRes = await pool.request()
        .input('aviso_id', sql.Int, a.id)
        .query('SELECT ruta FROM aviso_imagenes WHERE aviso_id = @aviso_id ORDER BY id');
      a.imagenes = imgsRes.recordset.map(r => r.ruta);
    }

    res.json({ success: true, avisos });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Avisos: GET todos (admin) ──────────────────── */
app.get('/api/admin/avisos', async (_req, res) => {
  try {
    const pool = await getPool();
    const avisosRes = await pool.request().query(
      'SELECT id, titulo, texto, fecha_fin, link, activo, creado_en FROM avisos ORDER BY creado_en DESC'
    );
    const avisos = avisosRes.recordset;

    for (const a of avisos) {
      const imgsRes = await pool.request()
        .input('aviso_id', sql.Int, a.id)
        .query('SELECT ruta FROM aviso_imagenes WHERE aviso_id = @aviso_id ORDER BY id');
      a.imagenes = imgsRes.recordset.map(r => r.ruta);
    }

    res.json({ success: true, avisos });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Avisos: POST crear ──────────────────────────── */
app.post('/api/avisos', upload.array('imagenes', 10), async (req, res) => {
  const { titulo, texto, fecha_fin, link } = req.body;

  if (!titulo || !fecha_fin)
    return res.status(400).json({ success: false, error: 'Título y fecha son requeridos.' });

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('titulo',    sql.NVarChar(200), titulo.trim())
      .input('texto',     sql.NVarChar(sql.MAX), texto || null)
      .input('fecha_fin', sql.Date,          fecha_fin)
      .input('link',      sql.NVarChar(500), link || null)
      .query(`INSERT INTO avisos (titulo, texto, fecha_fin, link)
              OUTPUT INSERTED.id
              VALUES (@titulo, @texto, @fecha_fin, @link)`);

    const avisoId = result.recordset[0].id;

    for (const file of (req.files || [])) {
      const ruta = `/uploads/${file.filename}`;
      await pool.request()
        .input('aviso_id', sql.Int, avisoId)
        .input('ruta',     sql.NVarChar(500), ruta)
        .query('INSERT INTO aviso_imagenes (aviso_id, ruta) VALUES (@aviso_id, @ruta)');
    }

    res.status(201).json({ success: true, avisoId });
  } catch (err) {
    for (const file of (req.files || [])) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Avisos: DELETE ─────────────────────────────── */
app.delete('/api/avisos/:id', async (req, res) => {
  try {
    const pool    = await getPool();
    const avisoId = parseInt(req.params.id);

    const imgsRes = await pool.request()
      .input('aviso_id', sql.Int, avisoId)
      .query('SELECT ruta FROM aviso_imagenes WHERE aviso_id = @aviso_id');

    for (const img of imgsRes.recordset) {
      const filePath = path.join(__dirname, img.ruta);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await pool.request()
      .input('aviso_id', sql.Int, avisoId)
      .query('DELETE FROM aviso_imagenes WHERE aviso_id = @aviso_id');

    await pool.request()
      .input('id', sql.Int, avisoId)
      .query('DELETE FROM avisos WHERE id = @id');

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Avisos: PATCH activo ───────────────────────── */
app.patch('/api/avisos/:id/activo', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id',     sql.Int, parseInt(req.params.id))
      .input('activo', sql.Bit, req.body.activo ? 1 : 0)
      .query('UPDATE avisos SET activo = @activo WHERE id = @id');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Projects: listar ───────────────────────────── */
app.get('/api/projects', (_req, res) => {
  try {
    const files    = fs.existsSync(projectsDir)
      ? fs.readdirSync(projectsDir).filter(f => f.toLowerCase().endsWith('.xlsx'))
      : [];
    const projects = [];

    for (const file of files) {
      try {
        const baseName  = file.replace(/\.xlsx$/i, '');
        const metaFile  = path.join(projectsDir, `${baseName}.meta.json`);
        let   metaYear  = null;
        try { metaYear = JSON.parse(fs.readFileSync(metaFile, 'utf8')).year || null; } catch {}

        const { projectRow } = parseProjectXLSX(path.join(projectsDir, file));
        const year = metaYear || new Date().getFullYear();

        projects.push({
          id:       encodeURIComponent(baseName),
          nombre:   projectRow?.nombre || baseName,
          year,
          inicio:   projectRow?.inicio   || null,
          fin:      projectRow?.fin      || null,
          progreso: projectRow?.progreso || 0,
        });
      } catch { /* skip archivos corruptos */ }
    }

    res.json({ success: true, projects });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Projects: tareas ───────────────────────────── */
app.get('/api/projects/:id/tasks', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.id) + '.xlsx';
    const filepath = path.join(projectsDir, filename);
    if (!fs.existsSync(filepath))
      return res.status(404).json({ success: false, error: 'Proyecto no encontrado.' });

    const { projectRow, tasks } = parseProjectXLSX(filepath);
    res.json({ success: true, projectRow, tasks });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Projects: subir xlsx ───────────────────────── */
app.post('/api/projects/upload', xlsxUpload.single('archivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió archivo.' });

  const nombre = (req.body.nombre || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!nombre) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: 'El nombre del proyecto es requerido.' });
  }

  const destPath  = path.join(projectsDir, `${nombre}.xlsx`);
  const metaPath  = path.join(projectsDir, `${nombre}.meta.json`);
  if (fs.existsSync(destPath)) {
    fs.unlinkSync(req.file.path);
    return res.status(409).json({ success: false, error: 'Ya existe un proyecto con ese nombre.' });
  }

  const año = parseInt(req.body.año) || new Date().getFullYear();
  fs.renameSync(req.file.path, destPath);
  fs.writeFileSync(metaPath, JSON.stringify({ year: año }));
  res.json({ success: true, filename: `${nombre}.xlsx` });
});

/* ── Projects: eliminar ─────────────────────────── */
app.delete('/api/projects/:id', (req, res) => {
  try {
    const baseName = decodeURIComponent(req.params.id);
    const filepath = path.join(projectsDir, baseName + '.xlsx');
    if (!fs.existsSync(filepath))
      return res.status(404).json({ success: false, error: 'Proyecto no encontrado.' });
    fs.unlinkSync(filepath);
    const metaPath = path.join(projectsDir, baseName + '.meta.json');
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: multer ────────────────────────── */
const entregStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, entregablesDir),
  filename:    (_req, _file, cb) => cb(null, `_tmp_${Date.now()}.xlsx`)
});
const entregUpload = multer({
  storage: entregStorage,
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.xlsx');
    cb(ok ? null : new Error('Solo se permiten archivos .xlsx'), ok);
  }
});

const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

/* ── Entregables: subir ─────────────────────────── */
app.post('/api/entregables/upload', entregUpload.single('archivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió archivo.' });

  const mes = parseInt(req.body.mes);
  const año = parseInt(req.body.año) || new Date().getFullYear();

  if (!mes || mes < 1 || mes > 12) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: 'Selecciona un mes válido.' });
  }

  const mesNombre = MESES[mes - 1];

  // Eliminar carga previa del mismo mes+año si existe
  try {
    fs.readdirSync(entregablesDir).filter(f => f.endsWith('.meta.json')).forEach(f => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(entregablesDir, f), 'utf8'));
        if (m.mes === mes && m.año === año) {
          const oldXlsx = path.join(entregablesDir, `${m.id}.xlsx`);
          if (fs.existsSync(oldXlsx)) fs.unlinkSync(oldXlsx);
          fs.unlinkSync(path.join(entregablesDir, f));
        }
      } catch {}
    });
  } catch {}

  const id        = `${mesNombre}_${año}_${Date.now()}`;
  const destPath  = path.join(entregablesDir, `${id}.xlsx`);
  const metaPath  = path.join(entregablesDir, `${id}.meta.json`);

  fs.renameSync(req.file.path, destPath);

  // Leer xlsx y extraer items (Num + Nombre del entregable)
  let items = [];
  try {
    const wb   = XLSX.readFile(destPath);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    for (let i = 1; i < rows.length; i++) {
      const nombre = String(rows[i][1] || '').trim();
      if (!nombre) continue;
      items.push({
        num: parseInt(rows[i][0]) || i,
        nombre,
        etapas: {
          revision:      { completada: false, pdf: null,  fecha: null },
          vobo:          { completada: false, rechazado: false, observaciones: [], fecha: null },
          impresion:     { completada: false, fecha: null },
          firma_interna: { completada: false, fecha: null },
          firma_externa: { completada: false, fecha: null },
          carpeta:       { completada: false, fecha: null },
          acuse:         { completada: false, pdf: null,  fecha: null }
        }
      });
    }
  } catch {}

  const meta = { id, mes, mesNombre, año, ruta: `/entregables/${id}.xlsx`,
                 fecha_carga: new Date().toISOString(), items };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  res.json({ success: true, meta });
});

/* ── Entregables: listar ────────────────────────── */
app.get('/api/entregables', (_req, res) => {
  try {
    const files = fs.existsSync(entregablesDir)
      ? fs.readdirSync(entregablesDir).filter(f => f.endsWith('.meta.json'))
      : [];
    const ETAPA_INIT = () => ({
      revision:      { completada: false, pdf: null,  fecha: null },
      vobo:          { completada: false, rechazado: false, observaciones: [], fecha: null },
      impresion:     { completada: false, fecha: null },
      firma_interna: { completada: false, fecha: null },
      firma_externa: { completada: false, fecha: null },
      carpeta:       { completada: false, fecha: null },
      acuse:         { completada: false, pdf: null,  fecha: null }
    });
    const entregables = files
      .map(f => {
        try {
          const metaPath = path.join(entregablesDir, f);
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          // Migrar archivos sin items: re-parsear el xlsx
          if (!meta.items || !meta.items.length) {
            const xlsxPath = path.join(entregablesDir, `${meta.id}.xlsx`);
            if (fs.existsSync(xlsxPath)) {
              const wb   = XLSX.readFile(xlsxPath);
              const ws   = wb.Sheets[wb.SheetNames[0]];
              const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
              meta.items = [];
              for (let i = 1; i < rows.length; i++) {
                const nombre = String(rows[i][1] || '').trim();
                if (!nombre) continue;
                meta.items.push({ num: parseInt(rows[i][0]) || i, nombre, etapas: ETAPA_INIT() });
              }
              fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            }
          }
          return meta;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.fecha_carga) - new Date(a.fecha_carga));
    res.json({ success: true, entregables });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: eliminar ──────────────────────── */
app.delete('/api/entregables/:id', (req, res) => {
  try {
    const id       = decodeURIComponent(req.params.id);
    const xlsxPath = path.join(entregablesDir, `${id}.xlsx`);
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (fs.existsSync(xlsxPath)) fs.unlinkSync(xlsxPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: actualizar etapa ─────────────── */
app.patch('/api/entregables/:id/items/:num/etapa', (req, res) => {
  try {
    const id       = decodeURIComponent(req.params.id);
    const num      = parseInt(req.params.num);
    const { etapa, completada } = req.body;
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const item = meta.items?.find(it => it.num === num);
    if (!item || !item.etapas[etapa]) return res.status(400).json({ success: false, error: 'Inválido.' });
    item.etapas[etapa].completada = completada;
    item.etapas[etapa].fecha      = completada ? new Date().toISOString() : null;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: PDF de etapa ─────────────────── */
const pdfDir = path.join(entregablesDir, 'pdfs');
if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

const pdfStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, pdfDir),
  filename:    (_req, _file, cb) => cb(null, `pdf_${Date.now()}.pdf`)
});
const pdfUpload = multer({
  storage: pdfStorage,
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.pdf');
    cb(ok ? null : new Error('Solo se permiten archivos PDF'), ok);
  }
});

app.post('/api/entregables/:id/items/:num/pdf/:etapa', pdfUpload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió archivo.' });
  try {
    const id       = decodeURIComponent(req.params.id);
    const num      = parseInt(req.params.num);
    const etapa    = req.params.etapa;
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) { fs.unlinkSync(req.file.path); return res.status(404).json({ success: false, error: 'No encontrado.' }); }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const item = meta.items?.find(it => it.num === num);
    if (!item || !item.etapas[etapa]) { fs.unlinkSync(req.file.path); return res.status(400).json({ success: false, error: 'Inválido.' }); }
    if (item.etapas[etapa].pdf) {
      const old = path.join(__dirname, item.etapas[etapa].pdf);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    const ruta = `/entregables/pdfs/${req.file.filename}`;
    item.etapas[etapa].pdf        = ruta;
    item.etapas[etapa].completada = true;
    item.etapas[etapa].fecha      = new Date().toISOString();
    if (etapa === 'revision') item.etapas.vobo.rechazado = false;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ success: true, pdf: ruta });
  } catch (err) { if (req.file) fs.unlinkSync(req.file.path); res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: observación VOBO ─────────────── */
app.post('/api/entregables/:id/items/:num/vobo/observacion', (req, res) => {
  try {
    const id       = decodeURIComponent(req.params.id);
    const num      = parseInt(req.params.num);
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ success: false, error: 'Texto requerido.' });
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const item = meta.items?.find(it => it.num === num);
    if (!item) return res.status(404).json({ success: false, error: 'Item no encontrado.' });
    item.etapas.vobo.observaciones.push({ texto, fecha: new Date().toISOString() });
    item.etapas.vobo.rechazado    = true;
    item.etapas.vobo.completada   = false;
    item.etapas.vobo.fecha        = null;
    item.etapas.revision.completada = false;
    item.etapas.revision.fecha      = null;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
