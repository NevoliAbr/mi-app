require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const XLSX       = require('xlsx');
const nodemailer = require('nodemailer');
const _db = require('./db');
const getPool = _db.getPool;
// Fallbacks por si producción usa una versión vieja de db.js que solo exporta getPool
const getDBType  = _db.getDBType  || (() => 'mysql');
const getDBInfo  = _db.getDBInfo  || (() => ({ type: 'mysql', label: 'MySQL', connected: true }));
const switchDB   = _db.switchDB   || (async () => { throw new Error('switchDB no disponible en esta versión de db.js'); });
const closePool  = _db.closePool  || (async () => {});

/* ── Mailer (Plesk SMTP) ─────────────────────────── */
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// En producción usa los destinatarios reales; en pruebas redirige todo a nevoli
const IS_PROD = process.env.APP_ENV === 'production';
function notifyTo(emails) {
  if (IS_PROD) return emails;
  return 'nevoli.gonzalez@lcg.mx';
}

// Destinatarios principales de notificaciones de seguimiento

// ── Facultades (permisos por área) ──
// Catálogo de áreas. Cada facultad se puede asignar por usuario con Ver y/o Modificar.
// grupo: 'general' o 'administracion' (las admin se agrupan en un desplegable).
const FACULTADES = [
  // Generales
  { clave: 'avisos',             nombre: 'Avisos',                descripcion: 'Crear y gestionar avisos',     grupo: 'general',        orden: 1 },
  { clave: 'carga_entregables',  nombre: 'Carga de entregables',  descripcion: 'Subir actas de entregables',   grupo: 'general',        orden: 2 },
  { clave: 'carga_projects',     nombre: 'Carga de projects',     descripcion: 'Subir archivos de projects',   grupo: 'general',        orden: 3 },
  { clave: 'proyectos',          nombre: 'Proyectos (consulta)',  descripcion: 'Ver el listado de proyectos',  grupo: 'general',        orden: 4 },
  { clave: 'seguimiento',        nombre: 'Módulo de Seguimiento', descripcion: 'Ver el módulo de seguimiento', grupo: 'general',        orden: 5 },
  { clave: 'dashboards',         nombre: 'Dashboards',            descripcion: 'Ver analítica y dashboards',   grupo: 'general',        orden: 6 },
  { clave: 'tasks',              nombre: 'Tasks',                 descripcion: 'Tablero de tareas',            grupo: 'general',        orden: 7 },
  // Módulo Entregables (sub-facultades)
  { clave: 'modulo_entregables', nombre: 'Ver y trabajar',        descripcion: 'Ver y trabajar entregables',            grupo: 'entregables',    orden: 8 },
  { clave: 'eliminar_proyecto',  nombre: 'Eliminar proyecto',     descripcion: 'Eliminar actas/proyectos en el módulo', grupo: 'entregables',    orden: 9 },
  { clave: 'etapa_carpeta',      nombre: 'Carpeta y Dig.',        descripcion: 'Ver y gestionar etapa Carpeta y Digitalización', grupo: 'entregables', orden: 10 },
  { clave: 'etapa_acuse',        nombre: 'Acuse',                 descripcion: 'Ver y gestionar etapa de Acuse',                 grupo: 'entregables', orden: 11 },
  { clave: 'etapa_vobo_final',   nombre: 'VoBo Final',            descripcion: 'Ver y gestionar etapa de VoBo Final',            grupo: 'entregables', orden: 12 },
  { clave: 'vobo_responder',     nombre: 'Responder observaciones', descripcion: 'Responder en el hilo de observaciones de VoBo',  grupo: 'entregables', orden: 13 },
  { clave: 'vobo_decidir',       nombre: 'Aceptar o Rechazar',    descripcion: 'Aceptar o rechazar observaciones de VoBo',       grupo: 'entregables', orden: 14 },
  // Administración (sub-secciones)
  { clave: 'admin_usuarios',     nombre: 'Usuarios',              descripcion: 'Gestión de usuarios',          grupo: 'administracion', orden: 13 },
  { clave: 'admin_proyectos',    nombre: 'Proyectos',             descripcion: 'Administración de proyectos',   grupo: 'administracion', orden: 14 },
  { clave: 'admin_tareas',       nombre: 'Tareas',                descripcion: 'Administración de tareas',      grupo: 'administracion', orden: 15 },
  { clave: 'admin_sistemas',     nombre: 'Sistemas',              descripcion: 'Administración de sistemas',    grupo: 'administracion', orden: 16 },
  { clave: 'admin_facultades',   nombre: 'Facultades',            descripcion: 'Gestión de facultades',         grupo: 'administracion', orden: 17 },
  { clave: 'correos_entregables', nombre: 'Correos Entregables',  descripcion: 'Ver historial y configurar destinatarios de correos', grupo: 'administracion', orden: 18 },
];
// Claves de administración (para visibilidad del menú "Administración")
const FACULTADES_ADMIN = FACULTADES.reduce((acc, f) => {
  if (f.grupo === 'administracion') acc.push(f.clave);
  return acc;
}, []);
// Usuarios con TODAS las facultades siempre (no se pueden quedar bloqueados)
const SUPER_USERS = ['nevoli.gonzalez@lcg.mx', 'elisa.mendez@lcg.mx'];

// Resuelve las facultades efectivas de un usuario: { clave: { ver, mod } }
async function resolverFacultades(pool, userId, email) {
  const out = {};
  const isSuper = SUPER_USERS.includes((email || '').toLowerCase().trim());
  for (const f of FACULTADES) out[f.clave] = { ver: isSuper, mod: isSuper };
  if (isSuper) return out;
  try {
    const [rows] = await pool.execute(
      `SELECT f.clave, uf.puede_ver, uf.puede_modificar
       FROM usuario_facultades uf
       JOIN facultades f ON f.id = uf.facultad_id
       WHERE uf.usuario_id = ?`,
      [userId]
    );
    for (const r of rows) {
      if (out[r.clave] !== undefined) {
        const mod = !!r.puede_modificar;
        out[r.clave] = { ver: mod || !!r.puede_ver, mod }; // modificar implica ver
      }
    }
  } catch (err) { console.warn('⚠ resolverFacultades:', err.message); }
  return out;
}

// Resuelve las facultades del que hace la petición (id en header X-User-Id; email se toma de la DB)
async function callerFacultades(req) {
  const id = parseInt(req.headers['x-user-id']) || null;
  if (!id) return null;
  try {
    const pool = await getPool();
    const [u] = await pool.execute('SELECT email FROM usuarios WHERE id = ? AND activo = 1', [id]);
    if (!u.length) return null;
    return await resolverFacultades(pool, id, u[0].email);
  } catch { return null; }
}

// Emails fijos de notificación
const NOTIF_ELISA  = 'elisa.mendez@lcg.mx';
const NOTIF_EDNA   = 'edna.servin@lcg.mx';
const NOTIF_PACO   = 'francisco.herrera@lcg.mx';
const NOTIF_DANIEL = 'daniel.arias@lcg.mx';

// Obtiene los emails de los responsables de un proyecto (responsables → IDs → emails en DB)
async function getProyRespEmails(proyectoId) {
  if (!proyectoId) return [];
  try {
    const pool  = await getPool();
    const [pr]  = await pool.execute('SELECT responsables FROM proyectos WHERE id = ?', [proyectoId]);
    if (!pr.length) return [];
    const resps = typeof pr[0].responsables === 'string'
      ? JSON.parse(pr[0].responsables) : (pr[0].responsables || []);
    const ids = resps.flatMap(r => r.id ? [r.id] : []);
    if (!ids.length) return [];
    const [ur] = await pool.execute(
      `SELECT email FROM usuarios WHERE id IN (${ids.map(() => '?').join(',')}) AND activo = 1`, ids
    );
    return ur.flatMap(r => r.email ? [r.email] : []);
  } catch { return []; }
}

// Envía notificación de correo por etapa y registra en historial
async function sendNotif(tipo, { meta, item = null, actaId = null }) {
  try {
    const proy   = meta.proyectoNombre || '';
    const mes    = meta.mesNombre || '';
    const prefix = `[${proy}${proy && mes ? ' · ' : ''}${mes}]`;
    const num    = item?.num;
    const nombre = item?.nombre || '';
    const ownerEmail = item?.owner?.email || null;

    const respProy = await getProyRespEmails(meta.proyecto_id || null);

    let to = [], subject = '', html = '';

    switch (tipo) {
      case 'creacion':
        to      = [NOTIF_ELISA, NOTIF_EDNA, ...respProy];
        subject = `${prefix} Elaboración completada – #${num}`;
        html    = `<p>Se completó la elaboración del entregable <strong>#${num} – ${nombre}</strong>, listo para revisión.</p>`;
        break;
      case 'observacion_vobo':
        to      = [ownerEmail, ...respProy].filter(Boolean);
        subject = `${prefix} Observaciones en entregable #${num}`;
        html    = `<p>Se encontraron observaciones en el entregable <strong>#${num} – ${nombre}</strong>.</p>`;
        break;
      case 'vobo':
        to      = [ownerEmail, ...respProy].filter(Boolean);
        subject = `${prefix} VoBo al entregable #${num} – listo para impresión y firmas`;
        html    = `<p>Visto bueno al entregable <strong>#${num} – ${nombre}</strong>, listo para impresión y firmas.</p>`;
        break;
      case 'firma_externa_80pct':
        to      = [NOTIF_DANIEL, NOTIF_ELISA, NOTIF_EDNA];
        subject = `${prefix} Proyecto al 80% – listo para carpeta y digitalización`;
        html    = `<p>El proyecto <strong>${proy}</strong> llegó al 80%. Todos los entregables tienen Firma Externa completada. Listo para <strong>Carpeta y Digitalización</strong>.</p>`;
        break;
      case 'carpeta':
      case 'carpeta_bulk':
        to      = [...respProy, NOTIF_ELISA, NOTIF_EDNA];
        subject = `${prefix} Carpeta y digitalización${num ? ' – #' + num : ''}`;
        html    = num
          ? `<p>El entregable <strong>#${num} – ${nombre}</strong> elaboró carpeta y digitalización. Favor de elaborar oficio.</p>`
          : `<p>Se elaboró carpeta y digitalización del proyecto <strong>${proy || mes}</strong>. Favor de elaborar oficio.</p>`;
        break;
      case 'acuse':
      case 'acuse_pdf':
      case 'acuse_bulk':
        to      = [NOTIF_ELISA, NOTIF_EDNA];
        subject = `${prefix} Acuse${num ? ' #' + num : ''} subido – favor de revisarlo`;
        html    = num
          ? `<p>Acuse <strong>#${num} – ${nombre}</strong> subido, favor de revisarlo.</p>`
          : `<p>Acuse del acta <strong>${proy || mes}</strong> subido, favor de revisarlo.</p>`;
        break;
      case 'vobo_final_bulk':
        to      = [NOTIF_PACO];
        subject = `${prefix} Proyecto liberado al 100%`;
        html    = `<p>Proyecto <strong>${proy}</strong> liberado. Mes <strong>${mes}</strong>.</p>`;
        break;
      default:
        return;
    }

    if (!to.length) return;
    const toUnique = [...new Set(to)].join(', ');
    let enviado = 0;
    try {
      await transporter.sendMail({ from: process.env.SMTP_FROM, to: notifyTo(toUnique), subject, html });
      enviado = 1;
    } catch (se) { console.warn('⚠ correo no enviado:', se.message); }
    const pool = await getPool();
    await pool.execute(
      'INSERT INTO correos_entregables (tipo, acta_id, destinatarios, asunto, html, enviado, fecha_envio) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tipo, actaId || null, toUnique, subject, html, enviado, enviado ? new Date() : null]
    );
  } catch (e) { console.warn('⚠ sendNotif:', e.message); }
}

// Resuelve emails a IDs de usuarios activos
async function emailsAIds(pool, emails) {
  const unique = [...new Set(emails.filter(Boolean))];
  if (!unique.length) return new Set();
  const [rows] = await pool.execute(
    `SELECT id FROM usuarios WHERE email IN (${unique.map(() => '?').join(',')}) AND activo = 1`, unique
  );
  return new Set(rows.map(r => r.id));
}

// Crea notificaciones in-app con los mismos destinatarios que sendNotif
async function sendInApp(tipo, { meta, item = null }) {
  try {
    const pool   = await getPool();
    const proy   = meta.proyectoNombre || '';
    const mes    = meta.mesNombre || '';
    const num    = item?.num;
    const nombre = item?.nombre || '';
    const ownerEmail = item?.owner?.email || null;
    const proyId = meta.proyecto_id || null;

    // IDs de responsables del proyecto (siempre disponibles, se incluyen o no según el tipo)
    const respProyIds = new Set();
    if (proyId) {
      const [pr] = await pool.execute('SELECT responsables FROM proyectos WHERE id = ?', [proyId]);
      if (pr[0]?.responsables) {
        const resps = typeof pr[0].responsables === 'string'
          ? JSON.parse(pr[0].responsables) : (pr[0].responsables || []);
        resps.forEach(r => { if (Number(r.id)) respProyIds.add(Number(r.id)); });
      }
    }

    const linkBase = `modulo-entregables.html?proyecto_id=${encodeURIComponent(proyId || '')}&mes=${encodeURIComponent(meta.mes || '')}`;
    const linkItem = num ? `${linkBase}&item=${encodeURIComponent(num)}` : linkBase;

    let emailsExtra = [], baseIds = new Set(respProyIds);
    let titulo = '', mensaje = '', link_url = linkBase;

    switch (tipo) {
      case 'creacion':
        emailsExtra = [NOTIF_ELISA, NOTIF_EDNA];
        titulo   = `Elaboración completada – #${num}`;
        mensaje  = `${proy} · ${mes} · "${nombre}"`;
        link_url = linkItem;
        break;
      case 'observacion_vobo':
        if (ownerEmail) emailsExtra.push(ownerEmail);
        titulo   = `Entregable #${num} con observaciones`;
        mensaje  = `${proy} · ${mes} · "${nombre}"`;
        link_url = linkItem;
        break;
      case 'vobo':
        if (ownerEmail) emailsExtra.push(ownerEmail);
        titulo   = `VoBo otorgado – #${num}`;
        mensaje  = `${proy} · ${mes} · "${nombre}" – listo para impresión y firmas`;
        link_url = linkItem;
        break;
      case 'firma_externa_80pct':
        emailsExtra = [NOTIF_DANIEL, NOTIF_ELISA, NOTIF_EDNA];
        baseIds  = new Set();
        titulo   = `Proyecto al 80%`;
        mensaje  = `${proy} · ${mes} – Listo para Carpeta y Digitalización`;
        break;
      case 'carpeta':
      case 'carpeta_bulk':
        emailsExtra = [NOTIF_ELISA, NOTIF_EDNA];
        titulo   = `Carpeta y digitalización${num ? ' – #' + num : ''}`;
        mensaje  = `${proy} · ${mes}${nombre ? ' · "' + nombre + '"' : ''} – Favor de elaborar oficio`;
        link_url = num ? linkItem : linkBase;
        break;
      case 'acuse':
      case 'acuse_pdf':
      case 'acuse_bulk':
        emailsExtra = [NOTIF_ELISA, NOTIF_EDNA];
        baseIds  = new Set();
        titulo   = `Acuse${num ? ' #' + num : ''} subido`;
        mensaje  = `${proy} · ${mes}${nombre ? ' · "' + nombre + '"' : ''} – Favor de revisarlo`;
        link_url = num ? linkItem : linkBase;
        break;
      case 'vobo_final_bulk':
        emailsExtra = [NOTIF_PACO];
        baseIds  = new Set();
        titulo   = `Proyecto liberado al 100%`;
        mensaje  = `${proy} · ${mes}`;
        break;
      default:
        return;
    }

    const resolvedIds = await emailsAIds(pool, emailsExtra);
    const allIds = new Set([...baseIds, ...resolvedIds]);
    if (!allIds.size) return;

    const metaPayload = {
      proyecto_id: proyId, proyecto_nombre: proy,
      mes: meta.mes, mes_nombre: mes, año: meta.año,
      ...(num != null ? { item_num: num, item_nombre: nombre, entregable_id: meta.id } : {}),
    };
    await Promise.all([...allIds].map(uid =>
      crearNotificacion({ usuario_id: uid, tipo, titulo, mensaje, link_url, meta: metaPayload })
    ));
  } catch (e) { console.warn('⚠ sendInApp:', e.message); }
}

/* ── Server-Sent Events: tiempo real en módulo entregables ── */
const sseClients = new Set();
function broadcastEntregable(actaId) {
  const payload = `event: entregable_updated\ndata: ${JSON.stringify({ actaId })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// Middleware: exige que el solicitante tenga la facultad (tipo 'mod' por defecto)
function requireFacultad(clave, tipo = 'mod') {
  return async (req, res, next) => {
    const facs = await callerFacultades(req);
    if (!facs) return res.status(401).json({ success: false, error: 'No autenticado.' });
    const f = facs[clave];
    const ok = f && (tipo === 'mod' ? f.mod : f.ver);
    if (!ok) return res.status(403).json({ success: false, error: 'No tienes permiso para esta acción.' });
    next();
  };
}

const app  = express();
const PORT = process.env.PORT || 3001;

// Compresión gzip/brotli (si el paquete está instalado)
try { app.use(require('compression')()); }
catch (e) { console.warn('⚠ compression no instalado (npm i compression):', e.message); }

app.use(cors());
app.use(express.json());

/* ── Servir archivos HTML estáticos ─────────────── */
// Cache: imágenes/fuentes 30d; el resto (HTML/JS/CSS) revalida con ETag.
const staticCache = {
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 días
    } else {
      res.setHeader('Cache-Control', 'no-cache'); // revalida (HTML/JS/CSS)
    }
  }
};
const publicDir = path.join(__dirname, '..');
app.use(express.static(publicDir, staticCache));

/* ── Directorios ────────────────────────────────── */
const uploadsDir     = path.join(__dirname, 'uploads');
const projectsDir    = path.join(__dirname, '..', 'projects');
const entregablesDir  = path.join(__dirname, 'entregables');
const proyectosPdfDir = path.join(__dirname, 'proyectos-pdfs');
if (!fs.existsSync(uploadsDir))        fs.mkdirSync(uploadsDir,        { recursive: true });
if (!fs.existsSync(projectsDir))       fs.mkdirSync(projectsDir,       { recursive: true });
if (!fs.existsSync(entregablesDir))    fs.mkdirSync(entregablesDir,    { recursive: true });
if (!fs.existsSync(proyectosPdfDir))   fs.mkdirSync(proyectosPdfDir,   { recursive: true });

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

app.use('/uploads',        express.static(uploadsDir,     { maxAge: '30d' }));
app.use('/entregables',    express.static(entregablesDir, { maxAge: '30d' }));
app.use('/proyectos-pdfs', express.static(proyectosPdfDir));

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
    res.json({ success: true, driver: 'mariadb@v2', data: rows[0] });
  } catch (err) {
    const socket = process.env.MYSQL_SOCKET || null;
    res.status(500).json({
      success: false, driver: 'mariadb@v2',
      error: err.message,
      cause: err.cause?.message || err.cause || null,
      code: err.code, errno: err.errno,
      usingSocket: !!socket,
      socket: socket,
      host: process.env.MYSQL_HOST || process.env.DB_SERVER,
      port: process.env.MYSQL_PORT || process.env.DB_PORT,
      user: process.env.MYSQL_USER || process.env.DB_USER,
      db:   process.env.MYSQL_DATABASE || process.env.DB_NAME,
    });
  }
});

/* ── Proyectos (público) ───────────────────────── */
app.get('/api/proyectos', async (_req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, orden, nombre, nombre_corto, NombreProyecto, procedimiento, contrato, vigencia_inicio, vigencia_fin, firmantes_cliente, firmantes_interno, responsables, pdf_url FROM proyectos WHERE activo = 1 ORDER BY orden, nombre'
    );
    const proyectos = rows.map(r => ({
      ...r,
      firmantes_cliente: r.firmantes_cliente ? JSON.parse(r.firmantes_cliente) : [],
      firmantes_interno: r.firmantes_interno ? JSON.parse(r.firmantes_interno) : [],
      responsables:      r.responsables      ? JSON.parse(r.responsables)      : [],
    }));
    res.json({ success: true, proyectos });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Proyectos CRUD ─────────────────────── */
app.get('/api/admin/proyectos', async (_req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, orden, nombre, nombre_corto, procedimiento, NombreProyecto, contrato, vigencia_inicio, vigencia_fin, firmantes_cliente, firmantes_interno, responsables, pdf_url, activo FROM proyectos ORDER BY orden, nombre'
    );
    const proyectos = rows.map(r => ({
      ...r,
      firmantes_cliente: r.firmantes_cliente ? JSON.parse(r.firmantes_cliente) : [],
      firmantes_interno: r.firmantes_interno ? JSON.parse(r.firmantes_interno) : [],
      responsables:      r.responsables      ? JSON.parse(r.responsables)      : [],
    }));
    res.json({ success: true, proyectos });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/proyectos', requireFacultad('admin_proyectos'), async (req, res) => {
  const orden              = req.body.orden != null ? parseInt(req.body.orden) || null : null;
  const nombre             = (req.body.nombre          || '').trim();
  const nombre_corto       = (req.body.nombre_corto    || '').trim() || null;
  const procedimiento      = (req.body.procedimiento   || '').trim() || null;
  const NombreProyecto     = (req.body.NombreProyecto  || '').trim() || null;
  const contrato           = (req.body.contrato        || '').trim() || null;
  const vigencia_inicio    = req.body.vigencia_inicio  || null;
  const vigencia_fin       = req.body.vigencia_fin     || null;
  const firmantes_cliente  = req.body.firmantes_cliente?.length  ? JSON.stringify(req.body.firmantes_cliente)  : null;
  const firmantes_interno  = req.body.firmantes_interno?.length  ? JSON.stringify(req.body.firmantes_interno)  : null;
  const responsables       = req.body.responsables?.length       ? JSON.stringify(req.body.responsables)       : null;
  if (!nombre) return res.status(400).json({ success: false, error: 'El nombre es requerido.' });
  const activo = (vigencia_inicio && vigencia_fin) ? 1 : 0;
  try {
    const pool = await getPool();
    const [result] = await pool.execute(
      'INSERT INTO proyectos (orden, nombre, nombre_corto, procedimiento, NombreProyecto, contrato, vigencia_inicio, vigencia_fin, firmantes_cliente, firmantes_interno, responsables, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [orden, nombre, nombre_corto, procedimiento, NombreProyecto, contrato, vigencia_inicio, vigencia_fin, firmantes_cliente, firmantes_interno, responsables, activo]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.patch('/api/admin/proyectos/:id', requireFacultad('admin_proyectos'), async (req, res) => {
  const orden              = req.body.orden != null ? parseInt(req.body.orden) || null : null;
  const nombre             = (req.body.nombre          || '').trim();
  const nombre_corto       = (req.body.nombre_corto    || '').trim() || null;
  const procedimiento      = (req.body.procedimiento   || '').trim() || null;
  const NombreProyecto     = (req.body.NombreProyecto  || '').trim() || null;
  const contrato           = (req.body.contrato        || '').trim() || null;
  const vigencia_inicio    = req.body.vigencia_inicio  || null;
  const vigencia_fin       = req.body.vigencia_fin     || null;
  const firmantes_cliente  = req.body.firmantes_cliente?.length  ? JSON.stringify(req.body.firmantes_cliente)  : null;
  const firmantes_interno  = req.body.firmantes_interno?.length  ? JSON.stringify(req.body.firmantes_interno)  : null;
  const responsables       = req.body.responsables?.length       ? JSON.stringify(req.body.responsables)       : null;
  if (!nombre) return res.status(400).json({ success: false, error: 'El nombre es requerido.' });
  const activo = (vigencia_inicio && vigencia_fin) ? 1 : 0;
  try {
    const pool = await getPool();
    await pool.execute(
      'UPDATE proyectos SET orden = ?, nombre = ?, nombre_corto = ?, procedimiento = ?, NombreProyecto = ?, contrato = ?, vigencia_inicio = ?, vigencia_fin = ?, firmantes_cliente = ?, firmantes_interno = ?, responsables = ?, activo = ? WHERE id = ?',
      [orden, nombre, nombre_corto, procedimiento, NombreProyecto, contrato, vigencia_inicio, vigencia_fin, firmantes_cliente, firmantes_interno, responsables, activo, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.patch('/api/admin/proyectos/:id/activo', requireFacultad('admin_proyectos'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('UPDATE proyectos SET activo = ? WHERE id = ?', [req.body.activo ? 1 : 0, parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/proyectos/:id', requireFacultad('admin_proyectos'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('DELETE FROM proyectos WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

const proyectoPdfUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, proyectosPdfDir),
    filename:    (req,  _file, cb) => cb(null, `proyecto_${req.params.id}_${Date.now()}.pdf`)
  }),
  limits:     { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.pdf');
    cb(ok ? null : new Error('Solo se permiten archivos PDF'), ok);
  }
});

app.post('/api/admin/proyectos/:id/pdf', requireFacultad('admin_proyectos'), proyectoPdfUpload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió archivo.' });
  try {
    const id      = parseInt(req.params.id);
    const pdf_url = `/proyectos-pdfs/${req.file.filename}`;
    const pool    = await getPool();
    await pool.execute('UPDATE proyectos SET pdf_url = ? WHERE id = ?', [pdf_url, id]);
    res.json({ success: true, pdf_url });
  } catch (err) { if (req.file) fs.unlinkSync(req.file.path); res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/proyectos/:id/pdf', requireFacultad('admin_proyectos'), async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const pool = await getPool();
    const [rows] = await pool.execute('SELECT pdf_url FROM proyectos WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Proyecto no encontrado.' });
    const oldUrl = rows[0].pdf_url;
    await pool.execute('UPDATE proyectos SET pdf_url = NULL WHERE id = ?', [id]);
    if (oldUrl) {
      const filePath = path.join(proyectosPdfDir, path.basename(oldUrl));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
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
      'SELECT id, nombre, email, password_hash, color FROM usuarios WHERE email = ? AND activo = 1',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0)
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas.' });

    const user  = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid)
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas.' });

    let color = user.color;
    if (!color) {
      const PRESET_COLORS = ['#3B82F6','#005D97','#10B981','#8B5CF6','#F59E0B','#EF4444','#EC4899','#14B8A6','#F97316','#6366F1','#84CC16','#06B6D4'];
      color = PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
      await pool.execute('UPDATE usuarios SET color = ? WHERE id = ?', [color, user.id]);
    }

    const facultades = await resolverFacultades(pool, user.id, user.email);

    res.json({ success: true, user: { id: user.id, nombre: user.nombre, email: user.email, color, facultades } });
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

    // Proyectos donde el usuario figura como responsable (JSON en columna responsables)
    let responsable_proyectos = [];
    try {
      const [respRows] = await pool.execute(
        'SELECT id, nombre, responsables FROM proyectos WHERE responsables IS NOT NULL ORDER BY nombre'
      );
      responsable_proyectos = respRows.reduce((acc, r) => {
        let esResponsable = false;
        try { esResponsable = JSON.parse(r.responsables).some(x => Number(x.id) === usuarioId); }
        catch { esResponsable = false; }
        if (esResponsable) acc.push({ id: r.id, nombre: r.nombre });
        return acc;
      }, []);
    } catch {}

    res.json({
      success: true,
      info: infoRows[0] || null,
      proyectos: minsRows,
      responsable_proyectos
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
  mids = mids.flatMap(x => { const n = Number(x); return n ? [n] : []; });

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
      'SELECT id, nombre, email, activo, creado_en FROM usuarios ORDER BY creado_en DESC'
    );
    res.json({ success: true, usuarios: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Facultades: catálogo ───────────────────────── */
app.get('/api/facultades', async (_req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, clave, nombre, descripcion, grupo, orden FROM facultades ORDER BY orden, id'
    );
    res.json({ success: true, facultades: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Facultades efectivas de un usuario (para refrescar sesión) ── */
app.get('/api/usuarios/:id/facultades', async (req, res) => {
  try {
    const pool = await getPool();
    const id = parseInt(req.params.id);
    const [u] = await pool.execute('SELECT email FROM usuarios WHERE id = ?', [id]);
    const email = u[0]?.email || '';
    const facultades = await resolverFacultades(pool, id, email);
    res.json({ success: true, facultades, esSuper: SUPER_USERS.includes(email.toLowerCase()) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: facultades asignadas a un usuario (matriz) ── */
app.get('/api/admin/usuarios/:id/facultades', async (req, res) => {
  try {
    const pool = await getPool();
    const id = parseInt(req.params.id);
    const [u] = await pool.execute('SELECT email FROM usuarios WHERE id = ?', [id]);
    const email = (u[0]?.email || '').toLowerCase();
    const esSuper = SUPER_USERS.includes(email);
    const [cat] = await pool.execute('SELECT id, clave, nombre, descripcion, grupo, orden FROM facultades ORDER BY orden, id');
    const [asig] = await pool.execute(
      'SELECT facultad_id, puede_ver, puede_modificar FROM usuario_facultades WHERE usuario_id = ?',
      [id]
    );
    const map = {};
    for (const a of asig) map[a.facultad_id] = a;
    const facultades = cat.map(f => {
      const a = map[f.id];
      const mod = esSuper || !!(a && a.puede_modificar);
      const ver = esSuper || mod || !!(a && a.puede_ver);
      return { ...f, puede_ver: ver ? 1 : 0, puede_modificar: mod ? 1 : 0 };
    });
    res.json({ success: true, facultades, esSuper });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: guardar facultades de un usuario ── */
app.put('/api/admin/usuarios/:id/facultades', requireFacultad('admin_facultades'), async (req, res) => {
  try {
    const pool = await getPool();
    const id   = parseInt(req.params.id);
    const items = Array.isArray(req.body.facultades) ? req.body.facultades : [];

    const [u] = await pool.execute('SELECT email FROM usuarios WHERE id = ?', [id]);
    if (!u.length) return res.status(404).json({ success: false, error: 'Usuario no encontrado.' });
    if (SUPER_USERS.includes((u[0].email || '').toLowerCase()))
      return res.status(400).json({ success: false, error: 'Este usuario siempre tiene todas las facultades.' });

    // Reemplazar todas las asignaciones del usuario
    await pool.execute('DELETE FROM usuario_facultades WHERE usuario_id = ?', [id]);
    for (const it of items) {
      const facultadId = parseInt(it.facultad_id);
      if (!facultadId) continue;
      const mod = it.puede_modificar ? 1 : 0;
      const ver = (it.puede_ver || mod) ? 1 : 0;
      if (!ver && !mod) continue; // no guardar filas vacías
      await pool.execute(
        'INSERT INTO usuario_facultades (usuario_id, facultad_id, puede_ver, puede_modificar) VALUES (?, ?, ?, ?)',
        [id, facultadId, ver, mod]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Resetear contraseña ─────────────────── */
app.patch('/api/admin/usuarios/:id/reset-password', requireFacultad('admin_usuarios'), async (req, res) => {
  try {
    const pool = await getPool();
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
    let newPass = '';
    for (let i = 0; i < 10; i++) newPass += chars[Math.floor(Math.random() * chars.length)];
    const hash = await bcrypt.hash(newPass, 10);
    await pool.execute('UPDATE usuarios SET password_hash = ? WHERE id = ?', [hash, parseInt(req.params.id)]);
    res.json({ success: true, password: newPass });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Activar / desactivar ────────────────── */
app.patch('/api/admin/usuarios/:id/activo', requireFacultad('admin_usuarios'), async (req, res) => {
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
app.delete('/api/admin/usuarios/:id', requireFacultad('admin_usuarios'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('UPDATE usuarios SET activo = 0 WHERE id = ?', [parseInt(req.params.id)]);
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
app.post('/api/avisos', requireFacultad('avisos'), upload.array('imagenes', 10), async (req, res) => {
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

    // Notificar in-app a todos los usuarios activos sobre el nuevo aviso (no bloquea)
    (async () => {
      try {
        const [usuarios] = await pool.execute('SELECT id FROM usuarios WHERE activo = 1');
        await Promise.all(usuarios.map(u => crearNotificacion({
          usuario_id: u.id,
          tipo:       'aviso_nuevo',
          titulo:     'Nuevo aviso publicado',
          mensaje:    titulo.trim(),
          link_url:   'index.html',
          meta:       { aviso_id: avisoId },
        })));
      } catch (err) { console.warn('⚠ Notif aviso nuevo:', err.message); }
    })();

    res.status(201).json({ success: true, avisoId });
  } catch (err) {
    for (const file of (req.files || [])) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Avisos: PUT actualizar ─────────────────────── */
app.put('/api/avisos/:id', requireFacultad('avisos'), upload.array('imagenes', 10), async (req, res) => {
  const avisoId = parseInt(req.params.id);
  const { titulo, texto, fecha_fin, link, imagenes_eliminadas } = req.body;

  if (!titulo || !fecha_fin)
    return res.status(400).json({ success: false, error: 'Título y fecha son requeridos.' });

  try {
    const pool = await getPool();

    await pool.execute(
      'UPDATE avisos SET titulo = ?, texto = ?, fecha_fin = ?, link = ? WHERE id = ?',
      [titulo.trim(), texto || null, fecha_fin, link || null, avisoId]
    );

    // Eliminar imágenes seleccionadas
    let rutasAEliminar = [];
    if (imagenes_eliminadas) {
      try {
        rutasAEliminar = JSON.parse(imagenes_eliminadas);
      } catch { rutasAEliminar = []; }
    }
    for (const ruta of rutasAEliminar) {
      await pool.execute(
        'DELETE FROM aviso_imagenes WHERE aviso_id = ? AND ruta = ?',
        [avisoId, ruta]
      );
      const filePath = path.join(__dirname, ruta);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    // Agregar nuevas imágenes
    for (const file of (req.files || [])) {
      const ruta = `/uploads/${file.filename}`;
      await pool.execute(
        'INSERT INTO aviso_imagenes (aviso_id, ruta) VALUES (?, ?)',
        [avisoId, ruta]
      );
    }

    res.json({ success: true });
  } catch (err) {
    for (const file of (req.files || [])) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Avisos: DELETE ─────────────────────────────── */
app.delete('/api/avisos/:id', requireFacultad('avisos'), async (req, res) => {
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
app.patch('/api/avisos/:id/activo', requireFacultad('avisos'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute(
      'UPDATE avisos SET activo = ? WHERE id = ?',
      [req.body.activo ? 1 : 0, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Notificaciones: helper ─────────────────────── */
async function crearNotificacion({ usuario_id, tipo, titulo, mensaje, link_url, meta }) {
  if (!usuario_id) return;
  try {
    const pool = await getPool();
    await pool.execute(
      'INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, link_url, meta_json) VALUES (?, ?, ?, ?, ?, ?)',
      [usuario_id, tipo, titulo, mensaje || null, link_url || null, meta ? JSON.stringify(meta) : null]
    );
  } catch (err) { console.warn('⚠ crearNotificacion:', err.message); }
}

/* ── Notificaciones: GET lista del usuario ─────── */
app.get('/api/usuarios/:id/notificaciones', async (req, res) => {
  try {
    const pool      = await getPool();
    const usuarioId = parseInt(req.params.id);
    const limit     = Math.min(parseInt(req.query.limit) || 50, 200);
    const soloUnread = req.query.unread === '1';
    const where     = soloUnread ? 'WHERE usuario_id = ? AND leida = 0' : 'WHERE usuario_id = ?';
    const isMysql   = getDBType() === 'mysql';
    const sql       = isMysql
      ? `SELECT id, tipo, titulo, mensaje, link_url, meta_json, leida, leida_en, creada_en
         FROM notificaciones ${where}
         ORDER BY creada_en DESC
         LIMIT ${limit}`
      : `SELECT TOP ${limit} id, tipo, titulo, mensaje, link_url, meta_json, leida, leida_en, creada_en
         FROM notificaciones ${where}
         ORDER BY creada_en DESC`;
    const [rows] = await pool.execute(sql, [usuarioId]);
    for (const r of rows) {
      if (r.meta_json) { try { r.meta = JSON.parse(r.meta_json); } catch { r.meta = null; } }
      delete r.meta_json;
    }
    res.json({ success: true, notificaciones: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Notificaciones: contador no leídas ─────────── */
app.get('/api/usuarios/:id/notificaciones/unread-count', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT COUNT(*) AS n FROM notificaciones WHERE usuario_id = ? AND leida = 0',
      [parseInt(req.params.id)]
    );
    res.json({ success: true, count: Number(rows[0]?.n || 0) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Notificaciones: marcar leída ───────────────── */
app.patch('/api/notificaciones/:id/leida', async (req, res) => {
  try {
    const pool  = await getPool();
    const leida = req.body.leida === false ? 0 : 1;
    await pool.execute(
      'UPDATE notificaciones SET leida = ?, leida_en = CASE WHEN ? = 1 THEN NOW() ELSE NULL END WHERE id = ?',
      [leida, leida, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Notificaciones: marcar todas leídas del usuario ── */
app.patch('/api/usuarios/:id/notificaciones/leer-todas', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute(
      'UPDATE notificaciones SET leida = 1, leida_en = NOW() WHERE usuario_id = ? AND leida = 0',
      [parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Notificaciones: eliminar ───────────────────── */
app.delete('/api/notificaciones/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('DELETE FROM notificaciones WHERE id = ?', [parseInt(req.params.id)]);
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
app.post('/api/projects/upload', requireFacultad('carga_projects'), xlsxUpload.single('archivo'), (req, res) => {
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
app.post('/api/entregables/upload', requireFacultad('carga_entregables'), entregUpload.single('archivo'), async (req, res) => {
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
    for (const f of fs.readdirSync(entregablesDir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(entregablesDir, f), 'utf8'));
        if (m.mes === mes && m.año === año && m.proyecto_id == proyecto_id) {
          const oldXlsx = path.join(entregablesDir, `${m.id}.xlsx`);
          if (fs.existsSync(oldXlsx)) fs.unlinkSync(oldXlsx);
          fs.unlinkSync(path.join(entregablesDir, f));
        }
      } catch {}
    }
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
        num: parseFloat(rows[i][0]) || i,
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

  // Validar: sin duplicados y en orden ascendente
  if (items.length) {
    const nums  = items.map(it => it.num);
    const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
    if (dupes.length) {
      fs.unlinkSync(destPath);
      return res.status(400).json({ success: false,
        error: `Números duplicados en el archivo: ${[...new Set(dupes)].join(', ')}. Corrige el Excel y vuelve a subir.` });
    }
    const outOfOrder = nums.some((n, i) => i > 0 && n <= nums[i - 1]);
    if (outOfOrder) {
      fs.unlinkSync(destPath);
      return res.status(400).json({ success: false,
        error: `Los entregables no están en orden ascendente. Orden encontrado: ${nums.join(', ')}. Corrige el Excel y vuelve a subir.` });
    }
  }

  const meta = { id, mes, mesNombre, año, proyecto_id, proyectoNombre,
                 ruta: `/entregables/${id}.xlsx`,
                 fecha_carga: new Date().toISOString(), items };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  res.json({ success: true, meta });
});

/* ── Entregables: SSE stream ─────────────────────── */
app.get('/api/entregables/events', (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
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
      .flatMap(f => {
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
                meta.items.push({ num: parseFloat(rows[i][0]) || i, nombre, etapas: ETAPA_INIT() });
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
          return [meta];
        } catch { return []; }
      })
      .sort((a, b) => new Date(b.fecha_carga) - new Date(a.fecha_carga));
    res.json({ success: true, entregables });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: guardar campos extra ─────────── */
app.patch('/api/entregables/:id/extra', (req, res) => {
  try {
    const id       = decodeURIComponent(req.params.id);
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const { dictamen, vigencia, fianza_cumplimiento, fianza_anticipo, fianza_vicios, meses_nota } = req.body;
    if (dictamen            !== undefined) meta.dictamen            = String(dictamen).slice(0,10);
    if (vigencia            !== undefined) meta.vigencia            = vigencia || null;
    if (fianza_cumplimiento !== undefined) meta.fianza_cumplimiento = fianza_cumplimiento === null ? null : !!fianza_cumplimiento;
    if (fianza_anticipo     !== undefined) meta.fianza_anticipo     = fianza_anticipo     === null ? null : !!fianza_anticipo;
    if (fianza_vicios       !== undefined) meta.fianza_vicios       = fianza_vicios       === null ? null : !!fianza_vicios;
    if (meses_nota          !== undefined) meta.meses_nota          = { ...(meta.meses_nota || {}), ...meses_nota };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: eliminar ──────────────────────── */
app.delete('/api/entregables/:id', requireFacultad('eliminar_proyecto'), async (req, res) => {
  try {
    const id       = decodeURIComponent(req.params.id);
    const xlsxPath = path.join(entregablesDir, `${id}.xlsx`);
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);

    // Leer meta antes de borrar para el log
    let actaNombre = id, numItems = 0, detalle = null;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        actaNombre = [meta.mesNombre, meta.proyectoNombre].filter(Boolean).join(' · ') || id;
        numItems   = meta.items?.length || 0;
        detalle    = JSON.stringify({ items: meta.items?.map(it => ({ num: it.num, nombre: it.nombre })) });
      } catch {}
    }

    // Registrar en log
    try {
      const pool = await getPool();
      const uid  = parseInt(req.headers['x-user-id']) || null;
      let email  = null;
      if (uid) {
        const [u] = await pool.execute('SELECT email FROM usuarios WHERE id = ?', [uid]);
        if (u.length) email = u[0].email;
      }
      await pool.execute(
        'INSERT INTO log_eliminaciones (usuario_id, usuario_email, tipo, acta_id, acta_nombre, detalle) VALUES (?, ?, ?, ?, ?, ?)',
        [uid, email, 'acta', id, actaNombre, detalle]
      );
    } catch (logErr) { console.warn('⚠ log_eliminaciones:', logErr.message); }

    if (fs.existsSync(xlsxPath)) fs.unlinkSync(xlsxPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: actualizar etapa ─────────────── */
app.patch('/api/entregables/:id/items/:num/etapa', requireFacultad('modulo_entregables'), (req, res) => {
  try {
    const id       = decodeURIComponent(req.params.id);
    const num      = parseFloat(req.params.num);
    const { etapa, completada, en_proceso, usuario_email, usuario_nombre } = req.body;
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const item = meta.items?.find(it => it.num === num);
    if (!item) return res.status(400).json({ success: false, error: 'Inválido.' });

    // Carpeta y Acuse ya no se pueden cambiar item por item — solo vía /etapa-bulk
    if (etapa === 'carpeta' || etapa === 'acuse') {
      return res.status(403).json({ success: false, error: 'Carpeta y Acuse se gestionan a nivel acta. Usa los botones globales (solo Elisa Mendez o Daniel Arias).' });
    }
    // VOBO Final ya no se cambia manualmente — se acopla al estado de Acuse
    if (etapa === 'vobo_final') {
      return res.status(403).json({ success: false, error: 'VOBO Final se marca automáticamente al completar Acuse.' });
    }

    // Migrar etapas faltantes en el item
    if (!item.etapas.creacion)   item.etapas = { creacion: { completada: false, fecha: null }, ...item.etapas };
    if (!item.etapas.vobo_final) item.etapas.vobo_final = { completada: false, fecha: null };
    if (!item.etapas[etapa]) return res.status(400).json({ success: false, error: 'Etapa inválida.' });
    item.etapas[etapa].completada = completada;
    item.etapas[etapa].fecha      = completada ? new Date().toISOString() : null;
    if (completada) {
      item.etapas[etapa].completado_por = usuario_nombre || usuario_email || null;
      item.etapas[etapa].completado_en  = new Date().toISOString();
      // Primer check de creación → esta persona es el owner del entregable
      if (etapa === 'creacion' && !item.owner) {
        item.owner = { nombre: usuario_nombre || usuario_email || null, email: usuario_email || null, fecha: new Date().toISOString() };
      }
    } else {
      item.etapas[etapa].completado_por = null;
      item.etapas[etapa].completado_en  = null;
    }
    if (['creacion', 'revision', 'firma_interna', 'firma_externa'].includes(etapa))
      item.etapas[etapa].en_proceso = (en_proceso === true && !completada);
    if (etapa === 'vobo' && completada) item.etapas.vobo.rechazado = false;
    if (!item.etapas[etapa].fecha_cambio && (completada || en_proceso === true))
      item.etapas[etapa].fecha_cambio = new Date().toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(id);

    // Correo + notificación in-app
    if (completada) {
      sendNotif(etapa, { meta, item, actaId: id });
      sendInApp(etapa, { meta, item });
    }

    // Notificación al 80% del acta: cuando todos los items tienen firma_externa completada
    if (etapa === 'firma_externa') {
      const todosFirmados = meta.items.every(it => it.etapas?.firma_externa?.completada);
      if (todosFirmados && !meta.notif_80_sent) {
        meta.notif_80_sent = true;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        sendNotif('firma_externa_80pct', { meta, actaId: id });
        sendInApp('firma_externa_80pct', { meta });
      } else if (!todosFirmados && meta.notif_80_sent) {
        // Si alguien revierte un firma_externa, reseteamos el flag para que se reenvíe al volver al 100%
        meta.notif_80_sent = false;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: renombrar item ───────────────── */
app.patch('/api/entregables/:id/items/:num/nombre', requireFacultad('modulo_entregables'), (req, res) => {
  try {
    const id       = decodeURIComponent(req.params.id);
    const num      = parseFloat(req.params.num);
    const nombre   = (req.body.nombre || '').trim();
    const newNum    = req.body.newNum !== undefined ? parseFloat(req.body.newNum) : null;
    const oldNombre = (req.body.oldNombre || '').trim();
    if (!nombre) return res.status(400).json({ success: false, error: 'El nombre es requerido.' });
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const item = (oldNombre ? meta.items?.find(it => it.num === num && it.nombre === oldNombre) : null)
              ?? meta.items?.find(it => it.num === num);
    if (!item) return res.status(404).json({ success: false, error: 'Item no encontrado.' });
    item.nombre = nombre;
    if (newNum !== null && !isNaN(newNum) && newNum >= 0 && newNum !== num) {
      // Resolve pre-existing duplicate nums before shifting
      meta.items.sort((a, b) => a.num - b.num);
      for (let i = 1; i < meta.items.length; i++) {
        if (meta.items[i].num <= meta.items[i - 1].num) meta.items[i].num = meta.items[i - 1].num + 1;
      }
      const cur = item.num; // may differ from `num` if dedup changed it
      if (newNum > cur) {
        meta.items.forEach(it => { if (it.num !== cur && it.num > cur && it.num <= newNum) it.num--; });
      } else if (newNum < cur) {
        const others   = meta.items.filter(it => it.num !== cur);
        const minOther = others.length ? Math.min(...others.map(it => it.num)) : Infinity;
        if (newNum < minOther) {
          // Mover por debajo del mínimo: cerrar el hueco que deja en `cur`
          meta.items.forEach(it => { if (it.num !== cur && it.num > cur) it.num--; });
        } else {
          meta.items.forEach(it => { if (it.num !== cur && it.num >= newNum && it.num < cur) it.num++; });
        }
      }
      item.num = newNum;
      meta.items.sort((a, b) => a.num - b.num);
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: eliminar item ────────────────── */
app.delete('/api/entregables/:id/items/:num', requireFacultad('modulo_entregables'), async (req, res) => {
  try {
    const id       = decodeURIComponent(req.params.id);
    const num      = parseFloat(req.params.num);
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const idx  = meta.items?.findIndex(it => it.num === num);
    if (idx === -1 || idx === undefined) return res.status(404).json({ success: false, error: 'Item no encontrado.' });
    const item = meta.items[idx];

    // Registrar en log
    try {
      const pool     = await getPool();
      const uid      = parseInt(req.headers['x-user-id']) || null;
      let email      = null;
      if (uid) {
        const [u] = await pool.execute('SELECT email FROM usuarios WHERE id = ?', [uid]);
        if (u.length) email = u[0].email;
      }
      const actaNombre = [meta.mesNombre, meta.proyectoNombre].filter(Boolean).join(' · ') || id;
      const detalle    = JSON.stringify({ num: item.num, nombre: item.nombre, etapas: item.etapas });
      await pool.execute(
        'INSERT INTO log_eliminaciones (usuario_id, usuario_email, tipo, acta_id, acta_nombre, detalle) VALUES (?, ?, ?, ?, ?, ?)',
        [uid, email, 'item', id, actaNombre, detalle]
      );
    } catch (logErr) { console.warn('⚠ log_eliminaciones:', logErr.message); }

    meta.items.splice(idx, 1);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: agregar item ─────────────────── */
app.post('/api/entregables/:id/items', requireFacultad('modulo_entregables'), (req, res) => {
  try {
    const id     = decodeURIComponent(req.params.id);
    const nombre = (req.body.nombre || '').trim();
    const numReq = req.body.num !== undefined ? parseFloat(req.body.num) : null;
    if (!nombre) return res.status(400).json({ success: false, error: 'El nombre es requerido.' });
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta   = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    let assignedNum;
    if (numReq !== null && !isNaN(numReq) && numReq >= 0) {
      if (meta.items.some(it => it.num === numReq))
        meta.items.forEach(it => { if (it.num >= numReq) it.num++; });
      assignedNum = numReq;
    } else {
      assignedNum = (meta.items.length ? Math.max(...meta.items.map(it => it.num)) : 0) + 1;
    }
    meta.items.push({
      num: assignedNum, nombre,
      etapas: {
        creacion:      { completada: false, fecha: null },
        revision:      { completada: false, fecha: null },
        vobo:          { completada: false, rechazado: false, observaciones: [], fecha: null },
        impresion:     { completada: false, fecha: null },
        firma_interna: { completada: false, fecha: null },
        firma_externa: { completada: false, fecha: null },
        carpeta:       { completada: false, fecha: null },
        acuse:         { completada: false, fecha: null },
        vobo_final:    { completada: false, fecha: null }
      }
    });
    meta.items.sort((a, b) => a.num - b.num);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(id);
    res.status(201).json({ success: true, num: assignedNum });
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

app.post('/api/entregables/:id/items/:num/pdf/:etapa', requireFacultad('modulo_entregables'), pdfUpload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió archivo.' });
  try {
    const id       = decodeURIComponent(req.params.id);
    const num      = parseFloat(req.params.num);
    const etapa    = req.params.etapa;
    // Acuse ya no se sube por item — solo vía /etapa-bulk/acuse
    if (etapa === 'acuse') {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(403).json({ success: false, error: 'El acuse se sube a nivel acta. Usa el botón global (solo Elisa Mendez o Daniel Arias).' });
    }
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
    if (!item.etapas[etapa].fecha_cambio) item.etapas[etapa].fecha_cambio = new Date().toISOString();
    if (etapa === 'revision') item.etapas.vobo.rechazado = false;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(decodeURIComponent(req.params.id));
    if (etapa === 'acuse') {
      sendNotif('acuse_pdf', { meta, item, actaId: req.params.id });
      sendInApp('acuse_pdf', { meta, item });
    }
    res.json({ success: true, pdf: ruta });
  } catch (err) { if (req.file) fs.unlinkSync(req.file.path); res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: Carpeta/Acuse bulk (acta completa) ── */

// Carpeta: marcar en_proceso / completada para TODOS los items del acta
app.patch('/api/entregables/:id/etapa-bulk/carpeta', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const { accion, usuario_email, usuario_nombre } = req.body;
    if (!['en_proceso', 'completada', 'reset'].includes(accion))
      return res.status(400).json({ success: false, error: 'Acción inválida.' });

    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'Acta no encontrada.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!Array.isArray(meta.items) || meta.items.length === 0)
      return res.status(400).json({ success: false, error: 'Acta sin items.' });

    // Validar precondiciones: para completar, todos los items deben tener firma_externa completada
    if (accion === 'completada') {
      const faltantes = meta.items.filter(it => !it.etapas?.firma_externa?.completada);
      if (faltantes.length) {
        return res.status(400).json({
          success: false,
          error: `Hay ${faltantes.length} item(s) sin Firma Externa completada. No se puede marcar Carpeta y Dig.`
        });
      }
    }
    // Para reset, no debe haber acuse completado en ningún item
    if (accion === 'reset') {
      const conAcuse = meta.items.filter(it => it.etapas?.acuse?.completada);
      if (conAcuse.length) {
        return res.status(400).json({
          success: false,
          error: 'Debes revertir Acuse antes de revertir Carpeta y Dig.'
        });
      }
    }

    const now = new Date().toISOString();
    for (const item of meta.items) {
      if (!item.etapas) item.etapas = {};
      if (!item.etapas.carpeta) item.etapas.carpeta = { completada: false, fecha: null };
      const c = item.etapas.carpeta;
      if (accion === 'en_proceso') {
        c.completada = false; c.fecha = null;
        c.en_proceso = true;
        c.fecha_cambio = now;
        c.completado_por = null; c.completado_en = null;
      } else if (accion === 'completada') {
        c.completada = true; c.fecha = now;
        c.en_proceso = false;
        c.completado_por = usuario_nombre || usuario_email;
        c.completado_en  = now;
        c.fecha_cambio   = now;
      } else { // reset
        c.completada = false; c.fecha = null;
        c.en_proceso = false;
        c.completado_por = null; c.completado_en = null;
        c.fecha_cambio = now;
      }
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(id);

    if (accion === 'completada') {
      sendNotif('carpeta_bulk', { meta, actaId: id });
      sendInApp('carpeta_bulk', { meta });
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Acuse: marcar en_proceso (sin PDF), o completar subiendo un PDF compartido para todos
app.patch('/api/entregables/:id/etapa-bulk/acuse', pdfUpload.single('pdf'), (req, res) => {
  try {
    const id     = decodeURIComponent(req.params.id);
    const accion = req.body.accion; // 'en_proceso' | 'completada' | 'reset'
    const usuario_email  = req.body.usuario_email;
    const usuario_nombre = req.body.usuario_nombre;

    const cleanup = () => { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); };

    if (!['en_proceso', 'completada', 'reset'].includes(accion)) { cleanup(); return res.status(400).json({ success: false, error: 'Acción inválida.' }); }

    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) { cleanup(); return res.status(404).json({ success: false, error: 'Acta no encontrada.' }); }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!Array.isArray(meta.items) || meta.items.length === 0) { cleanup(); return res.status(400).json({ success: false, error: 'Acta sin items.' }); }

    // Validar: para completar, todos deben tener carpeta completada y debe venir PDF
    if (accion === 'completada') {
      if (!req.file) return res.status(400).json({ success: false, error: 'PDF de acuse requerido.' });
      const faltantes = meta.items.filter(it => !it.etapas?.carpeta?.completada);
      if (faltantes.length) {
        cleanup();
        return res.status(400).json({ success: false, error: `Hay ${faltantes.length} item(s) sin Carpeta y Dig. completada.` });
      }
    }
    // Reset: no debe haber vobo_final completado
    if (accion === 'reset') {
      const conFinal = meta.items.filter(it => it.etapas?.vobo_final?.completada);
      if (conFinal.length) {
        cleanup();
        return res.status(400).json({ success: false, error: 'Debes revertir VOBO Final antes de revertir Acuse.' });
      }
    }

    const now = new Date().toISOString();
    const pdfRuta = req.file ? `/entregables/pdfs/${req.file.filename}` : null;

    for (const item of meta.items) {
      if (!item.etapas) item.etapas = {};
      if (!item.etapas.acuse) item.etapas.acuse = { completada: false, fecha: null };
      const a = item.etapas.acuse;
      if (accion === 'en_proceso') {
        a.completada = false; a.fecha = null;
        a.en_proceso = true;
        a.fecha_cambio = now;
        a.completado_por = null; a.completado_en = null;
        // No tocamos a.pdf
      } else if (accion === 'completada') {
        // Si el item ya tenía un PDF propio, lo eliminamos para usar el global
        if (a.pdf && a.pdf !== pdfRuta) {
          const old = path.join(__dirname, a.pdf);
          if (fs.existsSync(old)) { try { fs.unlinkSync(old); } catch {} }
        }
        a.pdf = pdfRuta;
        a.completada = true; a.fecha = now;
        a.en_proceso = false;
        a.completado_por = usuario_nombre || usuario_email;
        a.completado_en  = now;
        a.fecha_cambio   = now;
      } else { // reset
        if (a.pdf) {
          const old = path.join(__dirname, a.pdf);
          if (fs.existsSync(old)) { try { fs.unlinkSync(old); } catch {} }
        }
        a.pdf = null;
        a.completada = false; a.fecha = null;
        a.en_proceso = false;
        a.completado_por = null; a.completado_en = null;
        a.fecha_cambio = now;
      }
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(id);

    if (accion === 'completada') {
      sendNotif('acuse_bulk', { meta, actaId: id });
      sendInApp('acuse_bulk', { meta });
    }

    res.json({ success: true, pdf: pdfRuta });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

// VOBO Final: marcar completado a todos los items del acta
app.patch('/api/entregables/:id/etapa-bulk/vobo_final', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const { accion, usuario_email, usuario_nombre } = req.body;
    if (!['en_proceso', 'completada', 'reset'].includes(accion))
      return res.status(400).json({ success: false, error: 'Acción inválida.' });

    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'Acta no encontrada.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!Array.isArray(meta.items) || meta.items.length === 0)
      return res.status(400).json({ success: false, error: 'Acta sin items.' });

    if (accion === 'completada') {
      const faltantes = meta.items.filter(it => !it.etapas?.acuse?.completada);
      if (faltantes.length) {
        return res.status(400).json({
          success: false,
          error: `Hay ${faltantes.length} item(s) sin Acuse completado. No se puede dar VOBO Final.`
        });
      }
    }

    const now = new Date().toISOString();
    for (const item of meta.items) {
      if (!item.etapas) item.etapas = {};
      if (!item.etapas.vobo_final) item.etapas.vobo_final = { completada: false, fecha: null };
      const v = item.etapas.vobo_final;
      if (accion === 'en_proceso') {
        v.completada = false; v.fecha = null;
        v.en_proceso = true;
        v.fecha_cambio = now;
        v.completado_por = null; v.completado_en = null;
      } else if (accion === 'completada') {
        v.completada = true; v.fecha = now;
        v.en_proceso = false;
        v.completado_por = usuario_nombre || usuario_email;
        v.completado_en  = now;
        v.fecha_cambio   = now;
      } else { // reset
        v.completada = false; v.fecha = null;
        v.en_proceso = false;
        v.completado_por = null; v.completado_en = null;
        v.fecha_cambio = now;
      }
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(id);

    if (accion === 'completada') {
      sendNotif('vobo_final_bulk', { meta, actaId: id });
      sendInApp('vobo_final_bulk', { meta });
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
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

async function puedeModFacultad(email, clave) {
  if (SUPER_USERS.includes(email)) return true;
  try {
    const pool = await getPool();
    const [userRows] = await pool.execute('SELECT id FROM usuarios WHERE email = ? AND activo = 1', [email]);
    if (!userRows.length) return false;
    const facs = await resolverFacultades(pool, userRows[0].id, email);
    return !!(facs[clave]?.mod);
  } catch { return false; }
}

app.post('/api/entregables/:id/items/:num/vobo/observacion', obsImgUpload.single('imagen'), async (req, res) => {
  try {
    const id     = decodeURIComponent(req.params.id);
    const num    = parseFloat(req.params.num);
    const texto  = (req.body.texto || '').trim();
    const imagen = req.file ? `/entregables/obs-imgs/${req.file.filename}` : null;
    const usuario_email  = (req.body.usuario_email || '').toLowerCase().trim();
    const usuario_nombre = (req.body.usuario_nombre || '').trim();
    const cleanup = () => { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); };

    if (!(await puedeModFacultad(usuario_email, 'vobo_decidir'))) {
      cleanup();
      return res.status(403).json({ success: false, error: 'Sin permiso para crear observaciones.' });
    }
    if (!texto && !imagen) {
      cleanup();
      return res.status(400).json({ success: false, error: 'Texto o imagen requeridos.' });
    }
    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'No encontrado.' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const item = meta.items?.find(it => it.num === num);
    if (!item) return res.status(404).json({ success: false, error: 'Item no encontrado.' });
    item.etapas.vobo.observaciones.push({
      texto: texto || null,
      imagen,
      fecha: new Date().toISOString(),
      estado: 'pendiente',
      autor: { email: usuario_email, nombre: usuario_nombre || usuario_email },
      replies: []
    });
    item.etapas.vobo.rechazado        = true;
    item.etapas.vobo.completada       = false;
    item.etapas.vobo.fecha            = null;
    item.etapas.revision.completada   = false;
    item.etapas.revision.fecha        = null;
    item.etapas.revision.en_proceso   = false;
    item.etapas.creacion.completada   = false;
    item.etapas.creacion.fecha        = null;
    item.etapas.creacion.en_proceso   = false;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(decodeURIComponent(req.params.id));
    // Notificar sobre nuevas observaciones
    sendNotif('observacion_vobo', { meta, item, actaId: decodeURIComponent(req.params.id) });
    sendInApp('observacion_vobo', { meta, item });
    res.json({ success: true, imagen });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: aceptar / rechazar observación (solo Elisa o Edna) ── */
app.patch('/api/entregables/:id/items/:num/vobo/observacion/:obsIdx', async (req, res) => {
  try {
    const id     = decodeURIComponent(req.params.id);
    const num    = parseFloat(req.params.num);
    const obsIdx = parseInt(req.params.obsIdx);
    const { estado, usuario_nombre } = req.body;
    const usuario_email = (req.body.usuario_email || '').toLowerCase().trim();
    if (!(await puedeModFacultad(usuario_email, 'vobo_decidir')))
      return res.status(403).json({ success: false, error: 'Sin permiso para aceptar o rechazar observaciones.' });
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
    const ahora = new Date().toISOString();
    if (estado === 'aceptada') {
      obs.aceptado_por = usuario_nombre || null;
      obs.aceptado_en  = ahora;
      obs.rechazado_por = null;
      obs.rechazado_en  = null;
    } else {
      obs.aceptado_por = null;
      obs.aceptado_en  = null;
      obs.rechazado_por = usuario_nombre || null;
      obs.rechazado_en  = ahora;
    }
    // Registrar la decisión en el hilo cronológico
    if (!Array.isArray(obs.replies)) obs.replies = [];
    const decisionEntry = {
      tipo:   'decision',
      estado: estado,
      autor:  { email: usuario_email, nombre: usuario_nombre || usuario_email },
      fecha:  ahora,
    };
    obs.replies.push(decisionEntry);
    // Ya NO reseteamos creacion/revision al rechazar — la conversación continúa
    const todasAceptadas = item.etapas.vobo.observaciones.every(o => o.estado === 'aceptada');
    item.etapas.vobo.rechazado = !todasAceptadas;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(decodeURIComponent(req.params.id));
    res.json({ success: true, rechazado: item.etapas.vobo.rechazado, decisionEntry });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Entregables: responder en hilo de observación ── */
// Pueden responder: Elisa, Edna, responsable de entregable (item.owner.email), responsables del proyecto
app.post('/api/entregables/:id/items/:num/vobo/observacion/:obsIdx/reply', obsImgUpload.single('imagen'), async (req, res) => {
  const cleanup = () => { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); };
  try {
    const id     = decodeURIComponent(req.params.id);
    const num    = parseFloat(req.params.num);
    const obsIdx = parseInt(req.params.obsIdx);
    const texto  = (req.body.texto || '').trim();
    const imagen = req.file ? `/entregables/obs-imgs/${req.file.filename}` : null;
    const usuario_email  = (req.body.usuario_email || '').toLowerCase().trim();
    const usuario_nombre = (req.body.usuario_nombre || '').trim();

    if (!usuario_email) { cleanup(); return res.status(400).json({ success: false, error: 'usuario_email requerido.' }); }
    if (!texto && !imagen) { cleanup(); return res.status(400).json({ success: false, error: 'Texto o imagen requeridos.' }); }

    const metaPath = path.join(entregablesDir, `${id}.meta.json`);
    if (!fs.existsSync(metaPath)) { cleanup(); return res.status(404).json({ success: false, error: 'No encontrado.' }); }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const item = meta.items?.find(it => it.num === num);
    if (!item) { cleanup(); return res.status(404).json({ success: false, error: 'Item no encontrado.' }); }
    const obs = item.etapas.vobo.observaciones[obsIdx];
    if (!obs) { cleanup(); return res.status(404).json({ success: false, error: 'Observación no encontrada.' }); }

    // Validar permiso: vobo_responder, vobo_decidir, owner, o responsable de proyecto
    let permitido = await puedeModFacultad(usuario_email, 'vobo_responder') ||
                    await puedeModFacultad(usuario_email, 'vobo_decidir');
    if (!permitido && item.owner?.email && item.owner.email.toLowerCase() === usuario_email) permitido = true;
    if (!permitido && meta.proyecto_id) {
      try {
        const pool = await getPool();
        const [pRows] = await pool.execute(
          'SELECT responsables FROM proyectos WHERE id = ?', [meta.proyecto_id]
        );
        const responsables = pRows[0]?.responsables ? JSON.parse(pRows[0].responsables) : [];
        const [uRows] = await pool.execute(
          'SELECT id FROM usuarios WHERE email = ? AND activo = 1', [usuario_email]
        );
        const uid = uRows[0]?.id;
        if (uid && responsables.some(r => Number(r.id) === Number(uid))) permitido = true;
      } catch {}
    }
    if (!permitido) {
      cleanup();
      return res.status(403).json({ success: false, error: 'No tienes permiso para responder en esta observación.' });
    }

    if (!Array.isArray(obs.replies)) obs.replies = [];
    const reply = {
      texto: texto || null,
      imagen,
      fecha: new Date().toISOString(),
      autor: { email: usuario_email, nombre: usuario_nombre || usuario_email }
    };
    obs.replies.push(reply);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    broadcastEntregable(decodeURIComponent(req.params.id));
    res.json({ success: true, reply });
  } catch (err) { cleanup(); res.status(500).json({ success: false, error: err.message }); }
});

/* ── Tareas: listar por usuario ─────────────────── */
app.get('/api/usuarios/:id/tareas', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      `SELECT t.*, p.nombre AS proyecto_nombre
       FROM tareas t
       LEFT JOIN proyectos p ON p.id = t.proyecto_id
       WHERE t.usuario_id = ? ORDER BY t.creado_en DESC`,
      [parseInt(req.params.id)]
    );
    res.json({ success: true, tareas: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Tareas: crear ──────────────────────────────── */
app.post('/api/usuarios/:id/tareas', requireFacultad('admin_tareas'), async (req, res) => {
  const { tarea, estatus, fecha_inicio, fecha_fin, observaciones, proyecto_id } = req.body;
  if (!tarea?.trim()) return res.status(400).json({ success: false, error: 'La tarea es requerida.' });
  const ESTATUS = ['iniciada','en desarrollo','terminada','en pruebas','liberado'];
  const est = ESTATUS.includes(estatus) ? estatus : 'iniciada';
  try {
    const pool = await getPool();
    const [result] = await pool.execute(
      'INSERT INTO tareas (usuario_id, tarea, estatus, fecha_inicio, fecha_fin, observaciones, proyecto_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [parseInt(req.params.id), tarea.trim(), est,
       fecha_inicio || null, fecha_fin || null, observaciones?.trim() || null,
       proyecto_id ? parseInt(proyecto_id) : null]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Tareas: actualizar estatus ─────────────────── */
app.patch('/api/tareas/:id/estatus', requireFacultad('admin_tareas'), async (req, res) => {
  const ESTATUS = ['iniciada','en desarrollo','terminada','en pruebas','liberado'];
  const { estatus } = req.body;
  if (!ESTATUS.includes(estatus)) return res.status(400).json({ success: false, error: 'Estatus inválido.' });
  try {
    const pool = await getPool();
    await pool.execute('UPDATE tareas SET estatus = ? WHERE id = ?', [estatus, parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Todas las tareas ────────────────────────── */
app.get('/api/admin/tareas', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      `SELECT t.*, u.nombre AS usuario_nombre, p.nombre AS proyecto_nombre
       FROM tareas t
       JOIN usuarios u ON u.id = t.usuario_id
       LEFT JOIN proyectos p ON p.id = t.proyecto_id
       ORDER BY t.creado_en DESC`
    );
    res.json({ success: true, tareas: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Sistema: Info de DB ─────────────────────────────── */
app.get('/api/admin/sistema/db-info', (_req, res) => {
  res.json({ success: true, db: getDBInfo() });
});

/* ── Sistema: Cambiar motor de DB ───────────────────── */
app.post('/api/admin/sistema/db-switch', requireFacultad('admin_sistemas'), async (req, res) => {
  const { type } = req.body;
  try {
    await switchDB(type);
    res.json({ success: true, db: getDBInfo() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/* ── Admin: Log de eliminaciones ────────────────────── */
app.get('/api/admin/log-eliminaciones', requireFacultad('admin_sistemas', 'ver'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, fecha, usuario_email, tipo, acta_nombre, detalle FROM log_eliminaciones ORDER BY fecha DESC LIMIT 500'
    );
    res.json({ success: true, log: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Config destinatarios por etapa ───────────── */
app.get('/api/admin/config-correos-etapas', requireFacultad('correos_entregables', 'ver'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute('SELECT id, etapa, email FROM config_correos_etapas ORDER BY etapa, email');
    res.json({ success: true, config: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/config-correos-etapas', requireFacultad('correos_entregables'), async (req, res) => {
  const etapa = (req.body.etapa || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  if (!etapa || !email) return res.status(400).json({ success: false, error: 'Etapa y email requeridos.' });
  try {
    const pool = await getPool();
    const [exists] = await pool.execute(
      'SELECT id FROM config_correos_etapas WHERE etapa = ? AND email = ?', [etapa, email]
    );
    if (exists.length) return res.json({ success: true, id: exists[0].id });
    const [result] = await pool.execute(
      'INSERT INTO config_correos_etapas (etapa, email) VALUES (?, ?)', [etapa, email]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/config-correos-etapas/:id', requireFacultad('correos_entregables'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('DELETE FROM config_correos_etapas WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Admin: Correos Entregables (historial) ──────────── */
app.get('/api/admin/correos-entregables', requireFacultad('correos_entregables', 'ver'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, fecha, tipo, acta_id, destinatarios, asunto, enviado, fecha_envio FROM correos_entregables ORDER BY fecha DESC LIMIT 500'
    );
    res.json({ success: true, correos: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/correos-entregables/:id/html', requireFacultad('correos_entregables', 'ver'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute('SELECT html FROM correos_entregables WHERE id = ?', [parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'No encontrado.' });
    res.json({ success: true, html: rows[0].html });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/correos-entregables/:id/enviar', requireFacultad('correos_entregables'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute('SELECT * FROM correos_entregables WHERE id = ?', [parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Correo no encontrado.' });
    const c = rows[0];
    if (c.enviado) return res.status(400).json({ success: false, error: 'Este correo ya fue enviado.' });
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to:   notifyTo(c.destinatarios),
      subject: c.asunto,
      html: c.html,
    });
    await pool.execute('UPDATE correos_entregables SET enviado = 1, fecha_envio = NOW() WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/correos-entregables/:id', requireFacultad('correos_entregables'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('DELETE FROM correos_entregables WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Sistema: Probar SMTP ────────────────────────────── */
app.post('/api/admin/sistema/test-smtp', requireFacultad('admin_sistemas'), async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ success: false, error: 'Destinatario requerido.' });
  try {
    await transporter.sendMail({
      from:    process.env.SMTP_FROM,
      to,
      subject: 'Prueba SMTP – Sistema de Entregables',
      html:    '<p style="font-family:Arial">El servicio de correo está funcionando correctamente.</p>',
    });
    res.json({ success: true, to });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Auth: Solicitar recuperación de contraseña ─────── */
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, error: 'Correo requerido.' });
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, nombre FROM usuarios WHERE email = ? AND activo = 1', [email]
    );
    if (!rows.length) return res.json({ success: true }); // no revelar si existe

    const user  = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await pool.execute(
      `INSERT INTO password_reset_tokens (usuario_id, token, expires_at) VALUES (?, ?, ?)`,
      [user.id, token, expires]
    );

    const link = `${process.env.APP_URL}/reset-password.html?token=${token}`;
    await transporter.sendMail({
      from:    process.env.SMTP_FROM,
      to:      email,
      subject: 'Recuperación de contraseña – Sistema de Entregables',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#005D97;padding:24px 32px;border-radius:8px 8px 0 0">
            <h2 style="color:#fff;margin:0;font-size:20px">Recuperación de contraseña</h2>
          </div>
          <div style="background:#f9f9f9;padding:28px 32px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px">
            <p style="margin:0 0 16px">Hola <strong>${user.nombre}</strong>,</p>
            <p style="margin:0 0 24px;color:#555">Recibimos una solicitud para restablecer tu contraseña. Haz clic en el botón para continuar. El enlace expira en <strong>1 hora</strong>.</p>
            <a href="${link}" style="display:inline-block;background:#005D97;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px">Restablecer contraseña</a>
            <p style="margin:24px 0 0;font-size:12px;color:#999">Si no solicitaste este cambio, ignora este correo.</p>
          </div>
        </div>
      `,
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Auth: Restablecer contraseña con token ─────────── */
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ success: false, error: 'Datos incompletos.' });
  if (password.length < 6) return res.status(400).json({ success: false, error: 'Mínimo 6 caracteres.' });
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      `SELECT * FROM password_reset_tokens WHERE token = ? AND usado = 0 AND expires_at > NOW()`,
      [token]
    );
    if (!rows.length) return res.status(400).json({ success: false, error: 'El enlace es inválido o ha expirado.' });

    const { id: tokenId, usuario_id } = rows[0];
    const hash = await bcrypt.hash(password, 10);

    await pool.execute('UPDATE usuarios SET password_hash = ? WHERE id = ?', [hash, usuario_id]);
    await pool.execute('UPDATE password_reset_tokens SET usado = 1 WHERE id = ?', [tokenId]);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Usuarios: listar todos (para selects) ─────────── */
app.get('/api/usuarios', async (_req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT id, nombre, email FROM usuarios WHERE activo = 1 ORDER BY nombre'
    );
    res.json({ success: true, usuarios: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Kanban Tasks ───────────────────────────────────
   DDL MySQL (crear tabla):
   CREATE TABLE kanban_tasks (
     id INT AUTO_INCREMENT PRIMARY KEY,
     titulo VARCHAR(200) NOT NULL,
     descripcion TEXT,
     columna VARCHAR(30) NOT NULL DEFAULT 'backlog',
     prioridad VARCHAR(20) NOT NULL DEFAULT 'media',
     categoria VARCHAR(50) NULL,
     especificacion VARCHAR(500) NULL,
     fecha_categoria DATE NULL,
     fecha DATE NULL,
     asignado_a INT NULL,
     proyecto_id INT NULL,
     fecha_limite DATE NULL,
     etiquetas VARCHAR(500) NULL,
     pdf_url VARCHAR(500) NULL,
     orden INT NOT NULL DEFAULT 0,
     fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
     activo TINYINT NOT NULL DEFAULT 1
   );
   DDL SQL Server (crear tabla):
   CREATE TABLE kanban_tasks (
     id INT IDENTITY(1,1) PRIMARY KEY,
     titulo NVARCHAR(200) NOT NULL,
     descripcion NVARCHAR(MAX),
     columna NVARCHAR(30) NOT NULL DEFAULT 'backlog',
     prioridad NVARCHAR(20) NOT NULL DEFAULT 'media',
     categoria NVARCHAR(50) NULL,
     especificacion NVARCHAR(500) NULL,
     fecha_categoria DATE NULL,
     fecha DATE NULL,
     asignado_a INT NULL,
     proyecto_id INT NULL,
     fecha_limite DATE NULL,
     etiquetas NVARCHAR(500) NULL,
     pdf_url NVARCHAR(500) NULL,
     orden INT NOT NULL DEFAULT 0,
     fecha_creacion DATETIME DEFAULT GETDATE(),
     activo TINYINT NOT NULL DEFAULT 1
   );
   ALTER (si ya tienes la tabla sin estas columnas):
   -- MySQL:
   ALTER TABLE kanban_tasks
     ADD COLUMN categoria VARCHAR(50) NULL,
     ADD COLUMN especificacion VARCHAR(500) NULL,
     ADD COLUMN fecha_categoria DATE NULL,
     ADD COLUMN fecha DATE NULL,
     ADD COLUMN pdf_url VARCHAR(500) NULL;
   -- SQL Server:
   ALTER TABLE kanban_tasks
     ADD categoria NVARCHAR(50) NULL,
         especificacion NVARCHAR(500) NULL,
         fecha_categoria DATE NULL,
         fecha DATE NULL,
         pdf_url NVARCHAR(500) NULL;
──────────────────────────────────────────────────── */
const KANBAN_COLS = ['backlog','en_progreso','en_revision','completado'];
const KANBAN_PRIS = ['baja','media','alta','critica'];

async function syncInvolucrados(pool, taskId, ids) {
  const arrIds = Array.isArray(ids) ? ids : [];
  console.log(`[syncInvolucrados] task=${taskId} ids=${JSON.stringify(arrIds)}`);
  await pool.execute('DELETE FROM kanban_task_involucrados WHERE task_id = ?', [taskId]);
  for (const uid of arrIds) {
    const n = parseInt(uid);
    if (n) {
      await pool.execute(
        'INSERT INTO kanban_task_involucrados (task_id, usuario_id) VALUES (?, ?)', [taskId, n]
      );
      console.log(`[syncInvolucrados] inserted task=${taskId} user=${n}`);
    }
  }
}

app.get('/api/kanban/tasks', async (req, res) => {
  try {
    const pool = await getPool();
    const boardId = req.query.board_id ? parseInt(req.query.board_id) : null;
    const whereExtra = boardId ? ' AND kt.board_id = ?' : '';
    const params = boardId ? [boardId] : [];
    console.log(`[GET tasks] board_id=${boardId}`);

    // Query sin GROUP_CONCAT para compatibilidad con SQL Server y MySQL
    const [rows] = await pool.execute(
      `SELECT kt.*, u.nombre AS asignado_nombre, p.nombre AS proyecto_nombre,
              s.nombre AS stage_nombre, s.color AS stage_color, s.es_final AS stage_es_final
       FROM kanban_tasks kt
       LEFT JOIN usuarios u ON u.id = kt.asignado_a
       LEFT JOIN proyectos p ON p.id = kt.proyecto_id
       LEFT JOIN kanban_stages s ON s.id = kt.stage_id
       WHERE kt.activo = 1${whereExtra}
       ORDER BY kt.orden, kt.id`,
      params
    );

    // Involucrados por separado y se fusionan en Node (compatible con ambas DBs)
    const taskIds = rows.flatMap(r => r.id ? [r.id] : []);
    let invMap = {};
    if (taskIds.length) {
      const placeholders = taskIds.map(() => '?').join(',');
      try {
        const [invRows] = await pool.execute(
          `SELECT ki.task_id, ki.usuario_id, u.nombre
           FROM kanban_task_involucrados ki
           JOIN usuarios u ON u.id = ki.usuario_id
           WHERE ki.task_id IN (${placeholders})`,
          taskIds
        );
        console.log(`[GET tasks] invRows count=${invRows.length}`);
        invRows.forEach(r => {
          const key = String(r.task_id);
          if (!invMap[key]) invMap[key] = { ids: [], nombres: [] };
          invMap[key].ids.push(r.usuario_id);
          invMap[key].nombres.push(r.nombre);
        });
      } catch (e) { console.warn('⚠ involucrados query:', e.message); }
    }

    const tasks = rows.map(r => ({
      ...r,
      involucrados_ids:     (invMap[String(r.id)]?.ids    || []).join(','),
      involucrados_nombres: (invMap[String(r.id)]?.nombres || []).join('||'),
    }));

    console.log(`[GET tasks] ok, count=${tasks.length}`);
    res.json({ success: true, tasks });
  } catch (err) {
    console.error('[GET tasks] ERROR:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/kanban/tasks', async (req, res) => {
  const { titulo, descripcion, board_id, stage_id, prioridad, modulo, categoria, especificacion, fecha_categoria, fecha,
          proyecto_id, fecha_limite, etiquetas, involucrados } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ success: false, error: 'El título es requerido.' });
  const KANBAN_CATS = ['oficio','anexo','sm','ticket','bug'];
  const KANBAN_MODS = ['caja','recaudacion','predio','catastro','control_vehicular','adquisiciones','presupuestos','generales','tramites','nr_web','nr_escritorio','predio_web','obra_publica','tesoreria'];
  const mainUser = Array.isArray(involucrados) && involucrados[0] ? parseInt(involucrados[0]) : null;
  try {
    const pool = await getPool();
    const [result] = await pool.execute(
      `INSERT INTO kanban_tasks (titulo, descripcion, board_id, stage_id, prioridad, modulo, categoria, especificacion, fecha_categoria, fecha,
                                 asignado_a, proyecto_id, fecha_limite, etiquetas, orden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        titulo.trim(),
        descripcion?.trim() || null,
        board_id ? parseInt(board_id) : null,
        stage_id ? parseInt(stage_id) : null,
        KANBAN_PRIS.includes(prioridad) ? prioridad : 'media',
        KANBAN_MODS.includes(modulo) ? modulo : null,
        KANBAN_CATS.includes(categoria) ? categoria : null,
        especificacion?.trim() || null,
        fecha_categoria || null,
        fecha || null,
        mainUser,
        proyecto_id ? parseInt(proyecto_id) : null,
        fecha_limite || null,
        etiquetas?.trim() || null,
      ]
    );
    await syncInvolucrados(pool, result.insertId, involucrados);
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.patch('/api/kanban/tasks/:id', async (req, res) => {
  const { titulo, descripcion, board_id, stage_id, prioridad, modulo, categoria, especificacion, fecha_categoria, fecha,
          proyecto_id, fecha_limite, etiquetas, orden, involucrados } = req.body;
  const KANBAN_CATS = ['oficio','anexo','sm','ticket','bug'];
  const KANBAN_MODS2 = ['caja','recaudacion','predio','catastro','control_vehicular','adquisiciones','presupuestos','generales','tramites','nr_web','nr_escritorio','predio_web','obra_publica','tesoreria'];
  try {
    const pool = await getPool();
    const sets = [], vals = [];
    if (titulo            !== undefined) { sets.push('titulo = ?');            vals.push(titulo.trim()); }
    if (descripcion       !== undefined) { sets.push('descripcion = ?');       vals.push(descripcion?.trim() || null); }
    if (board_id          !== undefined) { sets.push('board_id = ?');          vals.push(board_id ? parseInt(board_id) : null); }
    if (stage_id          !== undefined) { sets.push('stage_id = ?');          vals.push(stage_id ? parseInt(stage_id) : null); }
    if (prioridad         !== undefined) { sets.push('prioridad = ?');         vals.push(KANBAN_PRIS.includes(prioridad) ? prioridad : 'media'); }
    if (modulo            !== undefined) { sets.push('modulo = ?');            vals.push(KANBAN_MODS2.includes(modulo) ? modulo : null); }
    if (categoria         !== undefined) { sets.push('categoria = ?');         vals.push(KANBAN_CATS.includes(categoria) ? categoria : null); }
    if (especificacion    !== undefined) { sets.push('especificacion = ?');    vals.push(especificacion?.trim() || null); }
    if (fecha_categoria   !== undefined) { sets.push('fecha_categoria = ?');   vals.push(fecha_categoria || null); }
    if (fecha             !== undefined) { sets.push('fecha = ?');             vals.push(fecha || null); }
    if (involucrados      !== undefined) { sets.push('asignado_a = ?');        vals.push(Array.isArray(involucrados) && involucrados[0] ? parseInt(involucrados[0]) : null); }
    if (proyecto_id       !== undefined) { sets.push('proyecto_id = ?');       vals.push(proyecto_id ? parseInt(proyecto_id) : null); }
    if (fecha_limite      !== undefined) { sets.push('fecha_limite = ?');      vals.push(fecha_limite || null); }
    if (etiquetas         !== undefined) { sets.push('etiquetas = ?');         vals.push(etiquetas?.trim() || null); }
    if (orden             !== undefined) { sets.push('orden = ?');             vals.push(parseInt(orden) || 0); }
    if (!sets.length && involucrados === undefined) return res.status(400).json({ success: false, error: 'Nada que actualizar.' });
    if (sets.length) {
      vals.push(parseInt(req.params.id));
      await pool.execute(`UPDATE kanban_tasks SET ${sets.join(', ')} WHERE id = ?`, vals);
    }
    if (involucrados !== undefined) await syncInvolucrados(pool, parseInt(req.params.id), involucrados);
    if (stage_id !== undefined && stage_id) {
      const [stRows] = await pool.execute('SELECT es_final FROM kanban_stages WHERE id = ?', [parseInt(stage_id)]);
      const today = new Date().toISOString().split('T')[0];
      if (stRows[0]?.es_final) {
        await pool.execute('UPDATE kanban_tasks SET completado_en = ? WHERE id = ? AND completado_en IS NULL', [today, parseInt(req.params.id)]);
      } else {
        await pool.execute('UPDATE kanban_tasks SET completado_en = NULL WHERE id = ?', [parseInt(req.params.id)]);
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/kanban/tasks/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('UPDATE kanban_tasks SET activo = 0 WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Kanban Boards ─────────────────────────────────────────── */
app.get('/api/kanban/boards', async (req, res) => {
  try {
    const pool   = await getPool();
    const userId = req.query.usuario_id ? parseInt(req.query.usuario_id) : null;
    const verTodo = req.query.verTodo === '1' || req.query.verTodo === 'true';
    const where  = verTodo
      ? 'WHERE activo=1'
      : userId
        ? 'WHERE activo=1 AND (privado=0 OR creado_por=?)'
        : 'WHERE activo=1 AND privado=0';
    const params = verTodo ? [] : userId ? [userId] : [];
    const [rows] = await pool.execute(`SELECT * FROM kanban_boards ${where} ORDER BY id`, params);
    res.json({ success:true, boards:rows });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post('/api/kanban/boards', async (req, res) => {
  const { nombre, descripcion, privado, usuario_id } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ success:false, error:'Nombre requerido.' });
  try {
    const pool = await getPool();
    const [r] = await pool.execute(
      'INSERT INTO kanban_boards (nombre, descripcion, privado, creado_por) VALUES (?,?,?,?)',
      [nombre.trim(), descripcion?.trim()||null, privado ? 1 : 0, usuario_id ? parseInt(usuario_id) : null]);
    const boardId = r.insertId;
    const defaults = [
      ['Backlog','#94A3B8',0,0],['En Progreso','#3B82F6',1,0],['Revisión','#F59E0B',2,0],
      ['Pruebas','#8B5CF6',3,0],['Producción','#10B981',4,0],['Completado','#059669',5,1],
    ];
    for (const [n,c,o,f] of defaults)
      await pool.execute('INSERT INTO kanban_stages (board_id,nombre,color,orden,es_final) VALUES (?,?,?,?,?)',[boardId,n,c,o,f]);
    res.status(201).json({ success:true, id:boardId });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.patch('/api/kanban/boards/:id', async (req, res) => {
  const { nombre, descripcion } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ success:false, error:'Nombre requerido.' });
  try {
    const pool = await getPool();
    await pool.execute('UPDATE kanban_boards SET nombre=?,descripcion=? WHERE id=?',
      [nombre.trim(), descripcion?.trim()||null, parseInt(req.params.id)]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.delete('/api/kanban/boards/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('UPDATE kanban_boards SET activo=0 WHERE id=?',[parseInt(req.params.id)]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

/* ── Kanban Stages ─────────────────────────────────────────── */
app.get('/api/kanban/boards/:id/stages', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT * FROM kanban_stages WHERE board_id=? AND activo=1 ORDER BY orden,id',
      [parseInt(req.params.id)]);
    res.json({ success:true, stages:rows });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post('/api/kanban/boards/:id/stages', async (req, res) => {
  const { nombre, color, es_final } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ success:false, error:'Nombre requerido.' });
  try {
    const pool = await getPool();
    const [[{maxOrden}]] = await pool.execute(
      'SELECT COALESCE(MAX(orden),0) AS maxOrden FROM kanban_stages WHERE board_id=? AND activo=1',
      [parseInt(req.params.id)]);
    const [r] = await pool.execute(
      'INSERT INTO kanban_stages (board_id,nombre,color,orden,es_final) VALUES (?,?,?,?,?)',
      [parseInt(req.params.id), nombre.trim(), color||'#94A3B8', maxOrden+1, es_final?1:0]);
    res.status(201).json({ success:true, id:r.insertId });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.patch('/api/kanban/stages/:id', async (req, res) => {
  const { nombre, color, orden, es_final } = req.body;
  try {
    const pool = await getPool();
    const sets=[], vals=[];
    if (nombre   !== undefined) { sets.push('nombre=?');   vals.push(nombre.trim()); }
    if (color    !== undefined) { sets.push('color=?');    vals.push(color||'#94A3B8'); }
    if (orden    !== undefined) { sets.push('orden=?');    vals.push(parseInt(orden)||0); }
    if (es_final !== undefined) { sets.push('es_final=?'); vals.push(es_final?1:0); }
    if (!sets.length) return res.status(400).json({ success:false, error:'Nada que actualizar.' });
    vals.push(parseInt(req.params.id));
    await pool.execute(`UPDATE kanban_stages SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.delete('/api/kanban/stages/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const [[{cnt}]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM kanban_tasks WHERE stage_id=? AND activo=1',
      [parseInt(req.params.id)]);
    if (cnt > 0) return res.status(400).json({ success:false, error:`No se puede eliminar: ${cnt} tarea(s) usan esta etapa.` });
    await pool.execute('UPDATE kanban_stages SET activo=0 WHERE id=?',[parseInt(req.params.id)]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

/* ── Kanban Modules ─────────────────────────────── */
app.get('/api/kanban/modules', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute('SELECT * FROM kanban_modules ORDER BY orden, id');
    res.json({ success: true, modules: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/kanban/modules', async (req, res) => {
  const { nombre, color } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ success: false, error: 'Nombre requerido.' });
  try {
    const pool  = await getPool();
    const clave = nombre.trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const [[{maxOrden}]] = await pool.execute("SELECT COALESCE(MAX(orden),0) AS maxOrden FROM kanban_modules WHERE activo=1");
    const [r] = await pool.execute(
      'INSERT INTO kanban_modules (clave, nombre, color, orden) VALUES (?,?,?,?)',
      [clave, nombre.trim(), color || '#64748B', maxOrden + 1]);
    res.status(201).json({ success: true, id: r.insertId, clave });
  } catch (err) {
    if (err.message.includes('Duplicate') || err.message.includes('UNIQUE'))
      return res.status(400).json({ success: false, error: 'Ya existe un módulo con ese nombre.' });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/kanban/modules/:id', async (req, res) => {
  const { nombre, color } = req.body;
  try {
    const pool = await getPool();
    const sets = [], vals = [];
    if (nombre !== undefined) { sets.push('nombre=?'); vals.push(nombre.trim()); }
    if (color  !== undefined) { sets.push('color=?');  vals.push(color); }
    if (!sets.length) return res.status(400).json({ success: false, error: 'Nada que actualizar.' });
    vals.push(parseInt(req.params.id));
    await pool.execute(`UPDATE kanban_modules SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/kanban/modules/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.execute('UPDATE kanban_modules SET activo=0 WHERE id=?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Kanban Sessions ────────────────────────────────
   DDL MySQL:
   CREATE TABLE kanban_sessions (
     id INT AUTO_INCREMENT PRIMARY KEY,
     task_id INT NOT NULL,
     numero INT NOT NULL,
     fecha DATE NOT NULL,
     comentario TEXT NOT NULL,
     fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
   );
   DDL SQL Server:
   CREATE TABLE kanban_sessions (
     id INT IDENTITY(1,1) PRIMARY KEY,
     task_id INT NOT NULL,
     numero INT NOT NULL,
     fecha DATE NOT NULL,
     comentario NVARCHAR(MAX) NOT NULL,
     fecha_creacion DATETIME DEFAULT GETDATE()
   );
──────────────────────────────────────────────────── */
app.get('/api/kanban/tasks/:id/sessions', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      `SELECT ks.*, u.nombre AS subido_nombre
       FROM kanban_sessions ks
       LEFT JOIN usuarios u ON u.id = ks.subido_por
       WHERE ks.task_id = ? ORDER BY ks.numero`,
      [parseInt(req.params.id)]
    );
    res.json({ success: true, sessions: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/kanban/tasks/:id/sessions', async (req, res) => {
  const taskId = parseInt(req.params.id);
  const { fecha, comentario, usuario_id } = req.body;
  if (!fecha)             return res.status(400).json({ success: false, error: 'La fecha es requerida.' });
  if (!comentario?.trim()) return res.status(400).json({ success: false, error: 'El comentario es requerido.' });
  try {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT COALESCE(MAX(numero), 0) AS max_num FROM kanban_sessions WHERE task_id = ?',
      [taskId]
    );
    const nextNum = (Number(rows[0].max_num) || 0) + 1;
    const subidoPor = usuario_id ? parseInt(usuario_id) : null;
    const [result] = await pool.execute(
      'INSERT INTO kanban_sessions (task_id, numero, fecha, comentario, subido_por) VALUES (?, ?, ?, ?, ?)',
      [taskId, nextNum, fecha, comentario.trim(), subidoPor]
    );
    res.status(201).json({ success: true, id: result.insertId, numero: nextNum });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Color de usuario ───────────────────────────── */
app.get('/api/usuarios/colores', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute('SELECT id, color FROM usuarios WHERE color IS NOT NULL AND activo = 1');
    res.json({ success: true, colores: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.patch('/api/usuarios/:id/color', async (req, res) => {
  const { color } = req.body;
  if (!color || !/^#[0-9A-Fa-f]{6}$/.test(color))
    return res.status(400).json({ success: false, error: 'Color inválido.' });
  try {
    const pool = await getPool();
    const uid = parseInt(req.params.id);
    const [used] = await pool.execute('SELECT id FROM usuarios WHERE color = ? AND id != ? AND activo = 1', [color, uid]);
    if (used.length) return res.status(409).json({ success: false, error: 'Ese color ya está en uso por otro usuario.' });
    await pool.execute('UPDATE usuarios SET color = ? WHERE id = ?', [color, uid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Informe Kanban por persona ─────────────────── */
app.get('/api/kanban/informe', async (req, res) => {
  try {
    const pool = await getPool();
    const [tasks] = await pool.execute(`
      SELECT kt.id, kt.titulo, kt.modulo, kt.prioridad, kt.fecha_limite, kt.completado_en,
             kt.stage_id, kt.board_id, ks.nombre AS stage_nombre, ks.es_final, ks.orden AS stage_orden
      FROM kanban_tasks kt
      LEFT JOIN kanban_stages ks ON ks.id = kt.stage_id
      WHERE kt.activo = 1
      ORDER BY kt.id DESC`);
    const [users]       = await pool.execute("SELECT id, nombre, color FROM usuarios WHERE activo = 1 ORDER BY nombre");
    const [involucrados]= await pool.execute('SELECT task_id, usuario_id FROM kanban_task_involucrados');
    const [stages]      = await pool.execute('SELECT id, board_id, orden FROM kanban_stages WHERE activo = 1 ORDER BY board_id, orden');
    res.json({ success: true, tasks, users, involucrados, stages });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ── Kanban Tasks: subir PDF ─────────────────────── */
const kanbanPdfDir = path.join(__dirname, 'kanban-pdfs');
if (!fs.existsSync(kanbanPdfDir)) fs.mkdirSync(kanbanPdfDir, { recursive: true });

app.use('/kanban-pdfs', express.static(kanbanPdfDir));

const kanbanPdfUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, kanbanPdfDir),
    filename:    (_req, _file, cb) => cb(null, `ktask_${Date.now()}.pdf`)
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.pdf');
    cb(ok ? null : new Error('Solo se permiten archivos PDF'), ok);
  }
});

app.post('/api/kanban/tasks/:id/pdf', kanbanPdfUpload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió archivo.' });
  try {
    const pool   = await getPool();
    const taskId = parseInt(req.params.id);
    const [rows] = await pool.execute('SELECT pdf_url FROM kanban_tasks WHERE id = ?', [taskId]);
    if (rows.length && rows[0].pdf_url) {
      const old = path.join(kanbanPdfDir, path.basename(rows[0].pdf_url));
      if (fs.existsSync(old)) try { fs.unlinkSync(old); } catch {}
    }
    const pdfUrl = `/kanban-pdfs/${req.file.filename}`;
    await pool.execute('UPDATE kanban_tasks SET pdf_url = ? WHERE id = ?', [pdfUrl, taskId]);
    res.json({ success: true, pdf_url: pdfUrl });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Auto-migración ─────────────────────────────── */
async function ensureColumns() {
  try {
    const pool   = await getPool();
    const dbType = getDBType();

    // pdf_url column
    try { await pool.execute('SELECT pdf_url FROM kanban_tasks WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? 'ALTER TABLE kanban_tasks ADD COLUMN pdf_url VARCHAR(500) NULL'
        : 'ALTER TABLE kanban_tasks ADD pdf_url NVARCHAR(500) NULL';
      await pool.execute(sql, []);
      console.log('✔ Columna pdf_url añadida a kanban_tasks');
    }

    // privado + creado_por en kanban_boards
    try { await pool.execute('SELECT privado FROM kanban_boards WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? 'ALTER TABLE kanban_boards ADD COLUMN privado TINYINT NOT NULL DEFAULT 0, ADD COLUMN creado_por INT NULL'
        : 'ALTER TABLE kanban_boards ADD privado TINYINT NOT NULL DEFAULT 0, creado_por INT NULL';
      await pool.execute(sql, []);
      console.log('✔ Columnas privado/creado_por añadidas a kanban_boards');
    }

    // kanban_task_involucrados table
    try { await pool.execute('SELECT task_id FROM kanban_task_involucrados WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? `CREATE TABLE kanban_task_involucrados (
             id INT AUTO_INCREMENT PRIMARY KEY,
             task_id INT NOT NULL,
             usuario_id INT NOT NULL,
             UNIQUE KEY uq_task_user (task_id, usuario_id)
           )`
        : `CREATE TABLE kanban_task_involucrados (
             id INT IDENTITY(1,1) PRIMARY KEY,
             task_id INT NOT NULL,
             usuario_id INT NOT NULL,
             CONSTRAINT uq_kti UNIQUE (task_id, usuario_id)
           )`;
      await pool.execute(sql, []);
      console.log('✔ Tabla kanban_task_involucrados creada');
    }

    // subido_por en kanban_sessions
    try { await pool.execute('SELECT subido_por FROM kanban_sessions WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? 'ALTER TABLE kanban_sessions ADD COLUMN subido_por INT NULL'
        : 'ALTER TABLE kanban_sessions ADD subido_por INT NULL';
      await pool.execute(sql, []);
      console.log('✔ Columna subido_por añadida a kanban_sessions');
    }

    // color en usuarios
    try { await pool.execute('SELECT color FROM usuarios WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? "ALTER TABLE usuarios ADD COLUMN color VARCHAR(7) NULL DEFAULT '#3B82F6'"
        : "ALTER TABLE usuarios ADD color NVARCHAR(7) NULL DEFAULT '#3B82F6'";
      await pool.execute(sql, []);
      console.log('✔ Columna color añadida a usuarios');
    }

    // completado_en en kanban_tasks
    try { await pool.execute('SELECT completado_en FROM kanban_tasks WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? 'ALTER TABLE kanban_tasks ADD COLUMN completado_en DATE NULL'
        : 'ALTER TABLE kanban_tasks ADD completado_en DATE NULL';
      await pool.execute(sql, []);
      console.log('✔ Columna completado_en añadida a kanban_tasks');
    }

    // kanban_modules table
    try { await pool.execute('SELECT id FROM kanban_modules WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? `CREATE TABLE kanban_modules (
             id INT AUTO_INCREMENT PRIMARY KEY,
             clave VARCHAR(50) NOT NULL UNIQUE,
             nombre VARCHAR(100) NOT NULL,
             color VARCHAR(7) NOT NULL DEFAULT '#64748B',
             orden INT NOT NULL DEFAULT 0,
             activo TINYINT NOT NULL DEFAULT 1
           )`
        : `CREATE TABLE kanban_modules (
             id INT IDENTITY(1,1) PRIMARY KEY,
             clave NVARCHAR(50) NOT NULL,
             nombre NVARCHAR(100) NOT NULL,
             color NVARCHAR(7) NOT NULL DEFAULT '#64748B',
             orden INT NOT NULL DEFAULT 0,
             activo TINYINT NOT NULL DEFAULT 1
           )`;
      await pool.execute(sql, []);
      console.log('✔ Tabla kanban_modules creada');
      const seeds = [
        ['caja','Caja','#0F766E',0],['recaudacion','Recaudación','#0369A1',1],
        ['predio','Predio','#7C3AED',2],['catastro','Catastro','#B45309',3],
        ['control_vehicular','Control Vehicular','#DC2626',4],['adquisiciones','Adquisiciones','#059669',5],
        ['presupuestos','Presupuestos','#1E293B',6],['generales','Generales','#1D4ED8',7],
        ['tramites','Trámites','#6D28D9',8],['nr_web','Nic. Romero Web','#5B21B6',9],
        ['nr_escritorio','Nic. Romero Escritorio','#92400E',10],['predio_web','Predio Web','#0F766E',11],
        ['obra_publica','Obra Pública','#C2410C',12],['tesoreria','Tesorería','#1E40AF',13],
      ];
      for (const [clave, nombre, color, orden] of seeds) {
        try { await pool.execute('INSERT INTO kanban_modules (clave,nombre,color,orden) VALUES (?,?,?,?)',[clave,nombre,color,orden]); }
        catch {}
      }
      console.log('✔ Módulos por defecto insertados');
    }
    // nombre_corto, responsable, firmantes, pdf_url en proyectos
    try { await pool.execute('SELECT nombre_corto FROM proyectos WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? 'ALTER TABLE proyectos ADD COLUMN nombre_corto VARCHAR(100) NULL, ADD COLUMN responsable VARCHAR(200) NULL, ADD COLUMN firmantes_cliente TEXT NULL, ADD COLUMN firmantes_interno TEXT NULL'
        : 'ALTER TABLE proyectos ADD nombre_corto NVARCHAR(100) NULL';
      await pool.execute(sql, []);
      if (dbType !== 'mysql') {
        await pool.execute('ALTER TABLE proyectos ADD responsable NVARCHAR(200) NULL', []);
        await pool.execute('ALTER TABLE proyectos ADD firmantes_cliente NVARCHAR(MAX) NULL', []);
        await pool.execute('ALTER TABLE proyectos ADD firmantes_interno NVARCHAR(MAX) NULL', []);
      }
      console.log('✔ Columnas nombre_corto/responsable/firmantes añadidas a proyectos');
    }
    // pdf_url en proyectos
    try { await pool.execute('SELECT pdf_url FROM proyectos WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? 'ALTER TABLE proyectos ADD COLUMN pdf_url VARCHAR(500) NULL'
        : 'ALTER TABLE proyectos ADD pdf_url NVARCHAR(500) NULL';
      await pool.execute(sql, []);
      console.log('✔ Columna pdf_url añadida a proyectos');
    }
    // responsables en proyectos
    try { await pool.execute('SELECT responsables FROM proyectos WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? 'ALTER TABLE proyectos ADD COLUMN responsables TEXT NULL'
        : 'ALTER TABLE proyectos ADD responsables NVARCHAR(MAX) NULL';
      await pool.execute(sql, []);
      console.log('✔ Columna responsables añadida a proyectos');
    }

    // notificaciones table
    try { await pool.execute('SELECT id FROM notificaciones WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? `CREATE TABLE notificaciones (
             id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
             usuario_id INT NOT NULL,
             tipo VARCHAR(40) NOT NULL,
             titulo VARCHAR(255) NOT NULL,
             mensaje TEXT NULL,
             link_url VARCHAR(500) NULL,
             meta_json TEXT NULL,
             leida TINYINT(1) NOT NULL DEFAULT 0,
             leida_en DATETIME NULL,
             creada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
             INDEX idx_usuario_leida (usuario_id, leida, creada_en)
           )`
        : `CREATE TABLE notificaciones (
             id INT IDENTITY(1,1) PRIMARY KEY,
             usuario_id INT NOT NULL,
             tipo NVARCHAR(40) NOT NULL,
             titulo NVARCHAR(255) NOT NULL,
             mensaje NVARCHAR(MAX) NULL,
             link_url NVARCHAR(500) NULL,
             meta_json NVARCHAR(MAX) NULL,
             leida TINYINT NOT NULL DEFAULT 0,
             leida_en DATETIME NULL,
             creada_en DATETIME NOT NULL DEFAULT SYSDATETIME()
           )`;
      await pool.execute(sql, []);
      console.log('✔ Tabla notificaciones creada');
    }

    // facultades table (catálogo)
    try { await pool.execute('SELECT id FROM facultades WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? `CREATE TABLE facultades (
             id INT AUTO_INCREMENT PRIMARY KEY,
             clave VARCHAR(50) NOT NULL UNIQUE,
             nombre VARCHAR(100) NOT NULL,
             descripcion VARCHAR(255) NULL,
             grupo VARCHAR(30) NOT NULL DEFAULT 'general',
             orden INT NOT NULL DEFAULT 0
           )`
        : `CREATE TABLE facultades (
             id INT IDENTITY(1,1) PRIMARY KEY,
             clave NVARCHAR(50) NOT NULL UNIQUE,
             nombre NVARCHAR(100) NOT NULL,
             descripcion NVARCHAR(255) NULL,
             grupo NVARCHAR(30) NOT NULL DEFAULT 'general',
             orden INT NOT NULL DEFAULT 0
           )`;
      await pool.execute(sql, []);
      console.log('✔ Tabla facultades creada');
    }
    // grupo en facultades (para tablas ya existentes)
    try { await pool.execute('SELECT grupo FROM facultades WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? "ALTER TABLE facultades ADD COLUMN grupo VARCHAR(30) NOT NULL DEFAULT 'general'"
        : "ALTER TABLE facultades ADD grupo NVARCHAR(30) NOT NULL DEFAULT 'general'";
      await pool.execute(sql, []);
      console.log('✔ Columna grupo añadida a facultades');
    }

    // usuario_facultades table (asignaciones)
    try { await pool.execute('SELECT usuario_id FROM usuario_facultades WHERE 1=0', []); }
    catch {
      const sql = dbType === 'mysql'
        ? `CREATE TABLE usuario_facultades (
             usuario_id INT NOT NULL,
             facultad_id INT NOT NULL,
             puede_ver TINYINT(1) NOT NULL DEFAULT 0,
             puede_modificar TINYINT(1) NOT NULL DEFAULT 0,
             PRIMARY KEY (usuario_id, facultad_id)
           )`
        : `CREATE TABLE usuario_facultades (
             usuario_id INT NOT NULL,
             facultad_id INT NOT NULL,
             puede_ver TINYINT NOT NULL DEFAULT 0,
             puede_modificar TINYINT NOT NULL DEFAULT 0,
             PRIMARY KEY (usuario_id, facultad_id)
           )`;
      await pool.execute(sql, []);
      console.log('✔ Tabla usuario_facultades creada');
    }

    // Seed/sincroniza catálogo de facultades desde el código
    for (const f of FACULTADES) {
      try {
        const [ex] = await pool.execute('SELECT id FROM facultades WHERE clave = ?', [f.clave]);
        if (ex.length === 0) {
          await pool.execute(
            'INSERT INTO facultades (clave, nombre, descripcion, grupo, orden) VALUES (?, ?, ?, ?, ?)',
            [f.clave, f.nombre, f.descripcion, f.grupo, f.orden]
          );
        } else {
          await pool.execute(
            'UPDATE facultades SET nombre = ?, descripcion = ?, grupo = ?, orden = ? WHERE clave = ?',
            [f.nombre, f.descripcion, f.grupo, f.orden, f.clave]
          );
        }
      } catch (err) { console.warn('⚠ seed facultad', f.clave, err.message); }
    }
    // Limpia facultades obsoletas (claves que ya no están en el catálogo) + asignaciones huérfanas
    try {
      const claves = FACULTADES.map(f => f.clave);
      const placeholders = claves.map(() => '?').join(',');
      const [obsoletas] = await pool.execute(
        `SELECT id FROM facultades WHERE clave NOT IN (${placeholders})`, claves
      );
      for (const o of obsoletas) {
        await pool.execute('DELETE FROM usuario_facultades WHERE facultad_id = ?', [o.id]);
        await pool.execute('DELETE FROM facultades WHERE id = ?', [o.id]);
      }
      if (obsoletas.length) console.log(`✔ ${obsoletas.length} facultad(es) obsoleta(s) eliminada(s)`);
    } catch (err) { console.warn('⚠ limpieza facultades:', err.message); }

    // rol: ya no se usa (sistema de facultades). Lo hacemos nullable para no romper INSERT.
    try {
      const sql = dbType === 'mysql'
        ? 'ALTER TABLE usuarios MODIFY rol VARCHAR(20) NULL'
        : 'ALTER TABLE usuarios ALTER COLUMN rol NVARCHAR(20) NULL';
      await pool.execute(sql, []);
    } catch {}

  } catch (err) { console.warn('⚠ ensureColumns:', err.message); }
}
let server = null;
ensureColumns().then(() => {
  server = app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
});

// Apagado ordenado: al recibir SIGTERM/SIGINT (deploy/restart en Plesk) deja
// terminar las requests en curso, cierra los streams SSE y libera el pool de
// BD antes de salir — evita que reinicios acumulen pools de conexiones huérfanos.
function shutdown(signal) {
  console.log(`\n${signal} recibido — cerrando servidor de forma ordenada...`);
  for (const client of sseClients) { try { client.end(); } catch {} }
  const finish = () => closePool().finally(() => process.exit(0));
  if (server) server.close(finish); else finish();
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
