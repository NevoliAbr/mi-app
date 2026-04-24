require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcrypt');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const XLSX    = require('xlsx');
const { getPool } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

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

/* ── Test conexión ──────────────────────────────── */
app.get('/api/test', async (_req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute('SELECT 1 AS connected, DATABASE() AS database_name');
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Proyectos (público) ───────────────────────── */
app.get('/api/proyectos', async (_req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, nombre, NombreProyecto, procedimiento FROM proyectos WHERE activo = 1 ORDER BY nombre'
    );
    res.json({ success: true, proyectos: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Proyectos CRUD ─────────────────────── */
app.get('/api/admin/proyectos', async (_req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute('SELECT id, nombre, procedimiento, NombreProyecto, activo FROM proyectos ORDER BY nombre');
    res.json({ success: true, proyectos: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/proyectos', async (req, res) => {
  const nombre          = (req.body.nombre          || '').trim();
  const procedimiento   = (req.body.procedimiento   || '').trim() || null;
  const NombreProyecto  = (req.body.NombreProyecto  || '').trim() || null;
  if (!nombre) return res.status(400).json({ success: false, error: 'El nombre es requerido.' });
  try {
    const pool = await getPool();
    const [result] = await pool.execute(
      'INSERT INTO proyectos (nombre, procedimiento, NombreProyecto, activo) VALUES (?, ?, ?, 1)',
      [nombre, procedimiento, NombreProyecto]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.patch('/api/admin/proyectos/:id', async (req, res) => {
  const nombre          = (req.body.nombre          || '').trim();
  const procedimiento   = (req.body.procedimiento   || '').trim() || null;
  const NombreProyecto  = (req.body.NombreProyecto  || '').trim() || null;
  if (!nombre) return res.status(400).json({ success: false, error: 'El nombre es requerido.' });
  try {
    const pool = await getPool();
    await pool.execute(
      'UPDATE proyectos SET nombre = ?, procedimiento = ?, NombreProyecto = ? WHERE id = ?',
      [nombre, procedimiento, NombreProyecto, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.patch('/api/admin/proyectos/:id/activo', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('UPDATE proyectos SET activo = ? WHERE id = ?', [req.body.activo ? 1 : 0, parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/proyectos/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('DELETE FROM proyectos WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true });
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
    const pool = await getPool();
    const [existing] = await pool.execute(
      'SELECT id FROM usuarios WHERE email = ?',
      [email.toLowerCase().trim()]
    );

    if (existing.length > 0)
      return res.status(409).json({ success: false, error: 'Este correo ya está registrado.' });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO usuarios (nombre, email, password_hash) VALUES (?, ?, ?)',
      [nombre.trim(), email.toLowerCase().trim(), hash]
    );

    res.status(201).json({ success: true, message: 'Cuenta creada correctamente.', userId: result.insertId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Auth: Login ────────────────────────────────── */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ success: false, error: 'Correo y contraseña son requeridos.' });

  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, nombre, email, password_hash, rol FROM usuarios WHERE email = ? AND activo = 1',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0)
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas.' });

    const user  = rows[0];
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

    const [infoRows] = await pool.execute(
      'SELECT * FROM usuario_info WHERE usuario_id = ?',
      [usuarioId]
    );

    const [minsRows] = await pool.execute(
      `SELECT m.id, m.nombre FROM proyectos m
       INNER JOIN usuario_proyectos um ON um.proyecto_id = m.id
       WHERE um.usuario_id = ? ORDER BY m.nombre`,
      [usuarioId]
    );

    res.json({
      success: true,
      info: infoRows[0] || null,
      proyectos: minsRows
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Usuario info: POST (upsert) ────────────────── */
app.post('/api/usuarios/:id/info', upload.single('foto'), async (req, res) => {
  const usuarioId = parseInt(req.params.id);
  const { fecha_nacimiento, direccion, estado_civil, proyecto_ids } = req.body;
  const fotoNueva = req.file ? `/uploads/${req.file.filename}` : null;

  let mids = [];
  try { mids = JSON.parse(proyecto_ids || '[]'); } catch { mids = []; }
  mids = mids.map(Number).filter(Boolean);

  try {
    const pool = await getPool();
    const [existing] = await pool.execute(
      'SELECT id, foto FROM usuario_info WHERE usuario_id = ?',
      [usuarioId]
    );

    if (existing.length > 0) {
      if (fotoNueva && existing[0].foto) {
        const oldPath = path.join(__dirname, existing[0].foto);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      const fotoFinal = fotoNueva || existing[0].foto;
      await pool.execute(
        `UPDATE usuario_info SET
          fecha_nacimiento = ?,
          direccion        = ?,
          estado_civil     = ?,
          foto             = ?,
          actualizado_en   = NOW()
         WHERE usuario_id = ?`,
        [fecha_nacimiento || null, direccion || null, estado_civil || null, fotoFinal, usuarioId]
      );
    } else {
      await pool.execute(
        `INSERT INTO usuario_info (usuario_id, fecha_nacimiento, direccion, estado_civil, foto)
         VALUES (?, ?, ?, ?, ?)`,
        [usuarioId, fecha_nacimiento || null, direccion || null, estado_civil || null, fotoNueva]
      );
    }

    await pool.execute('DELETE FROM usuario_proyectos WHERE usuario_id = ?', [usuarioId]);

    for (const mid of mids) {
      await pool.execute(
        'INSERT INTO usuario_proyectos (usuario_id, proyecto_id) VALUES (?, ?)',
        [usuarioId, mid]
      );
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
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, nombre, email, rol, activo, creado_en FROM usuarios ORDER BY creado_en DESC'
    );
    res.json({ success: true, usuarios: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Cambiar rol (solo superusuarios) ── */
app.patch('/api/admin/usuarios/:id/rol', async (req, res) => {
  const ROLES_VALIDOS = ['superusuario', 'usuario', 'pmo', 'administracion'];
  const { rol } = req.body;
  if (!ROLES_VALIDOS.includes(rol))
    return res.status(400).json({ success: false, error: 'Rol no válido.' });
  try {
    const pool = await getPool();
    await pool.execute(
      'UPDATE usuarios SET rol = ? WHERE id = ?',
      [rol, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Activar / desactivar ────────────────── */
app.patch('/api/admin/usuarios/:id/activo', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute(
      'UPDATE usuarios SET activo = ? WHERE id = ?',
      [req.body.activo ? 1 : 0, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Eliminar usuario ────────────────────── */
app.delete('/api/admin/usuarios/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('DELETE FROM usuarios WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Avisos: GET activos (homepage reel) ────────── */
app.get('/api/avisos', async (_req, res) => {
  try {
    const pool = await getPool();
    const [avisos] = await pool.execute(
      `SELECT id, titulo, texto, fecha_fin, link
       FROM avisos
       WHERE activo = 1 AND fecha_fin >= CURDATE()
       ORDER BY creado_en DESC`
    );

    for (const a of avisos) {
      const [imgs] = await pool.execute(
        'SELECT ruta FROM aviso_imagenes WHERE aviso_id = ? ORDER BY id',
        [a.id]
      );
      a.imagenes = imgs.map(r => r.ruta);
    }

    res.json({ success: true, avisos });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Avisos: GET todos (admin) ──────────────────── */
app.get('/api/admin/avisos', async (_req, res) => {
  try {
    const pool = await getPool();
    const [avisos] = await pool.execute(
      'SELECT id, titulo, texto, fecha_fin, link, activo, creado_en FROM avisos ORDER BY creado_en DESC'
    );

    for (const a of avisos) {
      const [imgs] = await pool.execute(
        'SELECT ruta FROM aviso_imagenes WHERE aviso_id = ? ORDER BY id',
        [a.id]
      );
      a.imagenes = imgs.map(r => r.ruta);
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
    const [result] = await pool.execute(
      'INSERT INTO avisos (titulo, texto, fecha_fin, link) VALUES (?, ?, ?, ?)',
      [titulo.trim(), texto || null, fecha_fin, link || null]
    );

    const avisoId = result.insertId;

    for (const file of (req.files || [])) {
      const ruta = `/uploads/${file.filename}`;
      await pool.execute(
        'INSERT INTO aviso_imagenes (aviso_id, ruta) VALUES (?, ?)',
        [avisoId, ruta]
      );
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

    const [imgs] = await pool.execute(
      'SELECT ruta FROM aviso_imagenes WHERE aviso_id = ?',
      [avisoId]
    );

    for (const img of imgs) {
      const filePath = path.join(__dirname, img.ruta);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await pool.execute('DELETE FROM aviso_imagenes WHERE aviso_id = ?', [avisoId]);
    await pool.execute('DELETE FROM avisos WHERE id = ?', [avisoId]);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Avisos: PATCH activo ───────────────────────── */
app.patch('/api/avisos/:id/activo', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute(
      'UPDATE avisos SET activo = ? WHERE id = ?',
      [req.body.activo ? 1 : 0, parseInt(req.params.id)]
    );
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
app.post('/api/entregables/upload', entregUpload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió archivo.' });

  const mes         = parseInt(req.body.mes);
  const año         = parseInt(req.body.año) || new Date().getFullYear();
  const proyecto_id = parseInt(req.body.proyecto_id);

  if (!mes || mes < 1 || mes > 12) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: 'Selecciona un mes válido.' });
  }
  if (!proyecto_id) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: 'Selecciona un proyecto.' });
  }

  let proyectoNombre = '';
  try {
    const pool = await getPool();
    const [rows] = await pool.execute('SELECT nombre FROM proyectos WHERE id = ?', [proyecto_id]);
    if (!rows.length) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'Proyecto no encontrado.' });
    }
    proyectoNombre = rows[0].nombre;
  } catch (err) {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ success: false, error: err.message });
  }

  const mesNombre  = MESES[mes - 1];
  const safeNombre = proyectoNombre.replace(/[^a-zA-Z0-9À-ɏ]/g, '_');

  // Eliminar carga previa del mismo proyecto+mes+año si existe
  try {
    fs.readdirSync(entregablesDir).filter(f => f.endsWith('.meta.json')).forEach(f => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(entregablesDir, f), 'utf8'));
        if (m.mes === mes && m.año === año && m.proyecto_id == proyecto_id) {
          const oldXlsx = path.join(entregablesDir, `${m.id}.xlsx`);
          if (fs.existsSync(oldXlsx)) fs.unlinkSync(oldXlsx);
          fs.unlinkSync(path.join(entregablesDir, f));
        }
      } catch {}
    });
  } catch {}

  const id        = `${safeNombre}_${mesNombre}_${año}_${Date.now()}`;
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
          creacion:      { completada: false, fecha: null },
          revision:      { completada: false, fecha: null },
          vobo:          { completada: false, rechazado: false, observaciones: [], fecha: null },
          impresion:     { completada: false, fecha: null },
          firma_interna: { completada: false, fecha: null },
          firma_externa: { completada: false, fecha: null },
          carpeta:       { completada: false, fecha: null },
          acuse:         { completada: false, pdf: null,  fecha: null },
          vobo_final:    { completada: false, fecha: null }
        }
      });
    }
  } catch {}

  const meta = { id, mes, mesNombre, año, proyecto_id, proyectoNombre,
                 ruta: `/entregables/${id}.xlsx`,
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
      creacion:      { completada: false, fecha: null },
      revision:      { completada: false, fecha: null },
      vobo:          { completada: false, rechazado: false, observaciones: [], fecha: null },
      impresion:     { completada: false, fecha: null },
      firma_interna: { completada: false, fecha: null },
      firma_externa: { completada: false, fecha: null },
      carpeta:       { completada: false, fecha: null },
      acuse:         { completada: false, pdf: null,  fecha: null },
      vobo_final:    { completada: false, fecha: null }
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
          // Migrar etapas faltantes en items existentes
          let migrated = false;
          (meta.items || []).forEach(it => {
            if (!it.etapas) return;
            if (!it.etapas.creacion)   { it.etapas = { creacion: { completada: false, fecha: null }, ...it.etapas }; migrated = true; }
            if (!it.etapas.vobo_final) { it.etapas.vobo_final = { completada: false, fecha: null }; migrated = true; }
            if (it.etapas.revision?.pdf !== undefined) { delete it.etapas.revision.pdf; migrated = true; }
          });
          if (migrated) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
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
    if (!item) return res.status(400).json({ success: false, error: 'Inválido.' });
    // Migrar etapas faltantes en el item
    if (!item.etapas.creacion)   item.etapas = { creacion: { completada: false, fecha: null }, ...item.etapas };
    if (!item.etapas.vobo_final) item.etapas.vobo_final = { completada: false, fecha: null };
    if (!item.etapas[etapa]) return res.status(400).json({ success: false, error: 'Etapa inválida.' });
    item.etapas[etapa].completada = completada;
    item.etapas[etapa].fecha      = completada ? new Date().toISOString() : null;
    if (etapa === 'vobo' && completada) item.etapas.vobo.rechazado = false;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: PDF de etapa ─────────────────── */
const pdfDir    = path.join(entregablesDir, 'pdfs');
const obsImgDir = path.join(entregablesDir, 'obs-imgs');
if (!fs.existsSync(pdfDir))    fs.mkdirSync(pdfDir,    { recursive: true });
if (!fs.existsSync(obsImgDir)) fs.mkdirSync(obsImgDir, { recursive: true });

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
    if (!item) { fs.unlinkSync(req.file.path); return res.status(400).json({ success: false, error: 'Inválido.' }); }
    if (!item.etapas.creacion)   item.etapas = { creacion: { completada: false, fecha: null }, ...item.etapas };
    if (!item.etapas.vobo_final) item.etapas.vobo_final = { completada: false, fecha: null };
    if (!item.etapas[etapa]) { fs.unlinkSync(req.file.path); return res.status(400).json({ success: false, error: 'Etapa inválida.' }); }
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
const obsImgStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, obsImgDir),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `obs_${Date.now()}${ext}`);
  }
});
const obsImgUpload = multer({
  storage: obsImgStorage,
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

app.post('/api/entregables/:id/items/:num/vobo/observacion', obsImgUpload.single('imagen'), (req, res) => {
  try {
    const id     = decodeURIComponent(req.params.id);
    const num    = parseInt(req.params.num);
    const texto  = (req.body.texto || '').trim();
    const imagen = req.file ? `/entregables/obs-imgs/${req.file.filename}` : null;
    if (!texto && !imagen) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'Texto o imagen requeridos.' });
    }
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const item = meta.items?.find(it => it.num === num);
    if (!item) return res.status(404).json({ success: false, error: 'Item no encontrado.' });
    item.etapas.vobo.observaciones.push({ texto: texto || null, imagen, fecha: new Date().toISOString(), estado: 'pendiente' });
    item.etapas.vobo.rechazado        = true;
    item.etapas.vobo.completada       = false;
    item.etapas.vobo.fecha            = null;
    item.etapas.revision.completada   = false;
    item.etapas.revision.fecha        = null;
    item.etapas.creacion.completada   = false;
    item.etapas.creacion.fecha        = null;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ success: true, imagen });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: aceptar / rechazar observación ── */
app.patch('/api/entregables/:id/items/:num/vobo/observacion/:obsIdx', (req, res) => {
  try {
    const id     = decodeURIComponent(req.params.id);
    const num    = parseInt(req.params.num);
    const obsIdx = parseInt(req.params.obsIdx);
    const { estado } = req.body;
    if (!['aceptada', 'rechazada'].includes(estado))
      return res.status(400).json({ success: false, error: 'Estado inválido.' });
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const item = meta.items?.find(it => it.num === num);
    if (!item) return res.status(404).json({ success: false, error: 'Item no encontrado.' });
    const obs = item.etapas.vobo.observaciones[obsIdx];
    if (!obs) return res.status(404).json({ success: false, error: 'Observación no encontrada.' });
    obs.estado = estado;
    if (estado === 'rechazada') {
      item.etapas.creacion.completada = false;
      item.etapas.creacion.fecha      = null;
    }
    const todasAceptadas = item.etapas.vobo.observaciones.every(o => o.estado === 'aceptada');
    item.etapas.vobo.rechazado = !todasAceptadas;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ success: true, rechazado: item.etapas.vobo.rechazado });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
