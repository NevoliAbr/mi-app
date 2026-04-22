const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcrypt');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { sql, getPool } = require('./db');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

/* ── Servir archivos HTML estáticos ─────────────── */
const publicDir = path.join(__dirname, '..');
app.use(express.static(publicDir));

/* ── Upload config ──────────────────────────────── */
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

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

app.use('/uploads', express.static(uploadsDir));

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

app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
