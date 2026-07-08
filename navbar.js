/* ───────────────────────────────────────────────────────────
   Navbar compartido — se inyecta en todas las páginas internas.
   Uso: <script src="navbar.js"></script>
   ─────────────────────────────────────────────────────────── */
(function () {
  /* ── Wrapper de fetch: adjunta identidad del usuario en peticiones a /api/ ──
     Permite que el backend valide facultades por usuario. */
  (function patchFetch() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem('session:v1') || 'null'); } catch {}
    if (!s || !s.id || window.__fetchPatched) return;
    window.__fetchPatched = true;
    const _fetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/') !== -1) {
          init = init || {};
          const h = new Headers(init.headers || (typeof input === 'object' && input && input.headers) || {});
          if (!h.has('X-User-Id'))    h.set('X-User-Id', String(s.id));
          if (!h.has('X-User-Email')) h.set('X-User-Email', s.email || '');
          init.headers = h;
        }
      } catch {}
      return _fetch.call(this, input, init);
    };
  })();

  async function init() {
    if (document.getElementById('app-navbar')) return;

    /* ── Sesión y roles ── */
    let session = null;
    try { session = JSON.parse(localStorage.getItem('session:v1') || 'null'); } catch {}

    /* ── Refrescar facultades desde el server (sin re-login) ── */
    if (session && session.id) {
      try {
        const _API = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
        const _r = await fetch(_API + '/api/usuarios/' + session.id + '/facultades', { cache: 'no-store' });
        const _d = await _r.json();
        if (_d && _d.success && _d.facultades) {
          session.facultades = _d.facultades;
          try { localStorage.setItem('session:v1', JSON.stringify(session)); } catch {}
        }
      } catch {}
    }

    /* ── Facultades ── */
    const facultades = (session && session.facultades) || {};
    function fac(clave, tipo) {
      const f = facultades[clave];
      return !!(f && (tipo === 'mod' ? f.mod : f.ver));
    }
    const facAvisos      = !!session && fac('avisos', 'ver');
    const facCargaEnt    = !!session && fac('carga_entregables', 'ver');
    const facCargaProj   = !!session && fac('carga_projects', 'ver');
    const facCreacion    = facAvisos || facCargaEnt || facCargaProj;
    const segVisible     = !!session && fac('seguimiento', 'ver');
    const entVisible     = !!session && fac('modulo_entregables', 'ver');
    const dashVisible    = !!session && fac('dashboards', 'ver');
    const taskVisible    = !!session && fac('tasks', 'ver');
    const proyVisible    = !!session && fac('proyectos', 'ver');
    const ADMIN_PAGES = [
      ['admin_usuarios',   'admin.html'],
      ['admin_proyectos',  'proyectos-admin.html'],
      ['admin_tareas',     'tareas-admin.html'],
      ['admin_sistemas',   'sistemas-admin.html'],
      ['admin_facultades', 'facultades-admin.html'],
    ];
    const adminFirst   = ADMIN_PAGES.find(([c]) => fac(c, 'ver'));
    const adminVisible = !!session && !!adminFirst;

    /* ── CSS (todo scopeado a #app-navbar) ── */
    const css = `
      #app-navbar {
        background: linear-gradient(90deg, #003f6b 0%, #005D97 55%, #006aae 100%);
        padding: 0 40px; height: 64px;
        display: flex; align-items: center; justify-content: space-between;
        box-shadow: 0 2px 14px rgba(0,0,0,.3);
        border-bottom: 1px solid rgba(255,255,255,.07);
        position: sticky; top: 0; z-index: 1000;
        font-family: 'Montserrat', sans-serif;
      }
      #app-navbar *, #app-navbar *::before, #app-navbar *::after { box-sizing: border-box; }
      #app-navbar .anb-logo { display:flex; align-items:center; gap:10px; text-decoration:none; flex-shrink:0; }
      #app-navbar .anb-logo img { height:42px; width:42px; object-fit:contain; border-radius:10px; background:#fff; padding:4px; display:block; }
      #app-navbar .anb-menu { list-style:none; display:flex; align-items:center; gap:2px; margin:0; padding:0; }
      #app-navbar .anb-menu > li { display:flex; }
      #app-navbar .anb-menu > li > a, #app-navbar .anb-dropdown-toggle {
        color: rgba(255,255,255,.82); text-decoration:none;
        font-size:11px; font-weight:700; letter-spacing:.9px; text-transform:uppercase;
        padding:7px 13px; border-radius:6px;
        transition: background .15s, color .15s;
        background:none; border:none; cursor:pointer; font-family:inherit;
        display:flex; align-items:center; gap:5px; line-height:1;
      }
      #app-navbar .anb-menu > li > a:hover,
      #app-navbar .anb-dropdown-toggle:hover,
      #app-navbar .anb-dropdown.open .anb-dropdown-toggle { background: rgba(255,255,255,.13); color:#fff; }
      #app-navbar .anb-menu > li > a.active { background: rgba(255,255,255,.2); color:#fff; }
      #app-navbar .anb-dropdown { position:relative; }
      #app-navbar .anb-caret { font-size:9px; transition:transform .15s; }
      #app-navbar .anb-dropdown.open .anb-caret { transform:rotate(180deg); }
      #app-navbar .anb-dropdown-menu {
        list-style:none; position:absolute; top:calc(100% + 8px); left:0; margin:0;
        background:#004f80; border-radius:10px; padding:6px;
        min-width:210px; display:none; flex-direction:column; gap:2px;
        box-shadow:0 12px 32px rgba(0,0,0,.4); border:1px solid rgba(255,255,255,.1); z-index:1200;
      }
      #app-navbar .anb-dropdown.open .anb-dropdown-menu { display:flex; }
      #app-navbar .anb-dropdown-menu li { display:block; }
      #app-navbar .anb-dropdown-menu li a {
        display:block; white-space:nowrap; text-decoration:none;
        color: rgba(255,255,255,.82);
        font-size:11px; font-weight:700; letter-spacing:.9px; text-transform:uppercase;
        padding:7px 13px; border-radius:6px; transition: background .15s, color .15s;
      }
      #app-navbar .anb-dropdown-menu li a:hover,
      #app-navbar .anb-dropdown-menu li a.active { background: rgba(255,255,255,.13); color:#fff; }
      #app-navbar .anb-user { display:flex; align-items:center; gap:14px; }
      #app-navbar .anb-bell {
        position:relative; display:inline-flex; align-items:center; justify-content:center;
        width:42px; height:42px;
        background: transparent;
        color: rgba(255,255,255,.88); text-decoration:none;
        transition: transform .18s ease, color .18s ease;
      }
      #app-navbar .anb-bell:hover { color:#fff; transform: translateY(-1px); }
      #app-navbar .anb-bell:hover svg { animation: anbBellShake .55s ease-in-out; }
      #app-navbar .anb-bell.active { color:#00AEEF; }
      #app-navbar .anb-bell svg {
        width:26px; height:26px;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,.4));
        position:relative; z-index:1;
        transition: filter .18s ease;
      }
      #app-navbar .anb-bell:hover svg { filter: drop-shadow(0 3px 6px rgba(0,174,239,.55)); }
      #app-navbar .anb-bell-badge {
        position:absolute; top:-5px; right:-5px; min-width:22px; height:22px; padding:0 6px;
        background: linear-gradient(145deg, #FB7185 0%, #DC2626 100%);
        color:#fff; font-size:11px; font-weight:900; letter-spacing:.2px;
        border-radius:11px; display:none; align-items:center; justify-content:center;
        border:2px solid #005D97; line-height:1;
        box-shadow: 0 2px 6px rgba(220,38,38,.55), 0 0 0 1px rgba(255,255,255,.15);
        z-index:2;
      }
      #app-navbar .anb-bell-badge.show {
        display:flex;
        animation: anbBadgePop .35s cubic-bezier(.34,1.56,.64,1);
      }
      #app-navbar .anb-bell-badge::before {
        content:''; position:absolute; inset:-4px; border-radius:50%;
        border:2px solid rgba(248,113,113,.55);
        animation: anbBadgePulse 1.8s ease-out infinite;
      }
      @keyframes anbBadgePop {
        0%   { transform: scale(0); }
        60%  { transform: scale(1.25); }
        100% { transform: scale(1); }
      }
      @keyframes anbBadgePulse {
        0%   { transform: scale(.8); opacity:.9; }
        80%  { transform: scale(1.6); opacity:0; }
        100% { transform: scale(1.6); opacity:0; }
      }
      @keyframes anbBellShake {
        0%, 100% { transform: rotate(0); }
        20% { transform: rotate(-12deg); }
        40% { transform: rotate(10deg); }
        60% { transform: rotate(-6deg); }
        80% { transform: rotate(4deg); }
      }
      /* ── Lado izquierdo (logo + avisos) ── */
      #app-navbar .anb-left { display:flex; align-items:center; gap:14px; }
      /* ── Avisos activos (botón visible junto al logo) ── */
      #app-navbar .anb-avisos {
        position:relative; display:inline-flex; align-items:center; gap:8px;
        padding:8px 16px 8px 13px; border-radius:24px;
        background:linear-gradient(145deg, rgba(56,189,248,.30) 0%, rgba(2,132,199,.30) 100%);
        border:1.5px solid rgba(56,189,248,.55);
        color:#fff; text-decoration:none;
        box-shadow:0 2px 10px rgba(2,132,199,.25);
        transition:transform .18s ease, background .18s ease, box-shadow .18s ease;
      }
      #app-navbar .anb-avisos:hover {
        background:linear-gradient(145deg, rgba(56,189,248,.5) 0%, rgba(2,132,199,.5) 100%);
        box-shadow:0 4px 16px rgba(2,132,199,.45);
        transform:translateY(-1px);
      }
      #app-navbar .anb-avisos:hover svg { animation:anbBellShake .55s ease-in-out; }
      #app-navbar .anb-avisos svg {
        width:22px; height:22px;
        filter:drop-shadow(0 1px 2px rgba(0,0,0,.3));
        flex-shrink:0;
      }
      #app-navbar .anb-avisos-label {
        font-size:12px; font-weight:800; letter-spacing:.6px; text-transform:uppercase;
        white-space:nowrap;
      }
      #app-navbar .anb-avisos-badge {
        min-width:21px; height:21px; padding:0 6px;
        background:#fff; color:#0284C7;
        font-size:11px; font-weight:900; letter-spacing:.2px;
        border-radius:11px; display:none; align-items:center; justify-content:center;
        line-height:1; box-shadow:0 1px 4px rgba(0,0,0,.25);
      }
      #app-navbar .anb-avisos-badge.show { display:flex; animation:anbBadgePop .35s cubic-bezier(.34,1.56,.64,1); }
      @media (max-width:760px) {
        #app-navbar .anb-avisos-label { display:none; }
        #app-navbar .anb-avisos { padding:8px 12px; }
      }
      #app-navbar .anb-greeting {
        color:#fff; font-size:12px; font-weight:700; letter-spacing:.4px;
        text-decoration:none; padding:6px 16px; border-radius:30px;
        background: rgba(255,255,255,.12); transition: background .15s;
      }
      #app-navbar .anb-greeting:hover { background: rgba(255,255,255,.22); }
      #app-navbar .anb-logout {
        background:transparent; border:2px solid rgba(255,255,255,.55); color:#fff;
        padding:6px 16px; border-radius:30px; font-family:inherit;
        font-size:12px; font-weight:700; letter-spacing:.4px; cursor:pointer;
        transition: border-color .15s, background .15s;
      }
      #app-navbar .anb-logout:hover { border-color:#fff; background: rgba(255,255,255,.12); }
      @media (max-width:760px) {
        #app-navbar { padding:10px 16px; height:auto; flex-wrap:wrap; gap:8px; }
        #app-navbar .anb-menu { gap:2px; flex-wrap:wrap; justify-content:flex-end; }
        #app-navbar .anb-menu > li > a, #app-navbar .anb-dropdown-toggle { font-size:10px; padding:6px 10px; letter-spacing:.6px; }
      }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    /* ── DOM: navbar construido con nodos reales (sin innerHTML dinámico) ── */
    const path = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

    function navLink(href, label) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      if (path === href.toLowerCase()) a.className = 'active';
      li.appendChild(a);
      return li;
    }

    function dropdown(label, childLis) {
      const li = document.createElement('li');
      li.className = 'anb-dropdown';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'anb-dropdown-toggle';
      btn.append(label + ' ');
      const caret = document.createElement('span');
      caret.className = 'anb-caret';
      caret.textContent = '▾';
      btn.appendChild(caret);
      const ul = document.createElement('ul');
      ul.className = 'anb-dropdown-menu';
      childLis.forEach(function (childLi) { ul.appendChild(childLi); });
      li.appendChild(btn);
      li.appendChild(ul);
      return li;
    }

    const items = [];
    if (facCreacion) {
      const subC = [];
      if (facCargaProj) subC.push(navLink('projects.html', 'Cargar projects'));
      if (facAvisos)    subC.push(navLink('avisos.html', 'Crear Avisos'));
      if (facCargaEnt)  subC.push(navLink('entregables.html', 'Carga de entregables'));
      items.push(dropdown('Creación', subC));
    }
    if (segVisible || entVisible) {
      const sub = [];
      if (segVisible) sub.push(navLink('seguimiento.html', 'Módulo de Seguimiento'));
      if (entVisible) sub.push(navLink('modulo-entregables.html', 'Módulo Entregables'));
      items.push(dropdown('Módulos', sub));
    }
    if (proyVisible) items.push(navLink('proyectos.html', 'Proyectos'));
    if (dashVisible) items.push(navLink('analitica.html', 'Dashboards'));
    if (taskVisible) items.push(navLink('task.html', '📋 Tasks'));
    if (adminVisible) items.push(navLink(adminFirst[1], 'Administración'));

    let userLi = null;
    if (session) {
      userLi = document.createElement('li');
      userLi.className = 'anb-user';

      const bellA = document.createElement('a');
      bellA.href = 'notificaciones.html';
      bellA.id = 'anb-bell';
      bellA.className = 'anb-bell' + (path === 'notificaciones.html' ? ' active' : '');
      bellA.title = 'Notificaciones';
      bellA.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 4.5 1.2 6.5 2.3 7.7.4.5.7 1 .7 1.3 0 .6-.5 1-1 1H4c-.5 0-1-.4-1-1 0-.3.3-.8.7-1.3C4.8 14.5 6 12.5 6 8z" fill="currentColor" fill-opacity=".18"/><path d="M14 19a2 2 0 0 1-4 0"/></svg><span class="anb-bell-badge" id="anb-bell-badge">0</span>`;

      const greetingA = document.createElement('a');
      greetingA.href = 'perfil.html';
      greetingA.className = 'anb-greeting';
      greetingA.id = 'anb-greeting';
      greetingA.title = 'Ver mi perfil';
      greetingA.textContent = session.nombre || 'Perfil';

      const logoutBtnEl = document.createElement('button');
      logoutBtnEl.className = 'anb-logout';
      logoutBtnEl.id = 'anb-logout-btn';
      logoutBtnEl.type = 'button';
      logoutBtnEl.textContent = 'Cerrar sesión';

      userLi.appendChild(bellA);
      userLi.appendChild(greetingA);
      userLi.appendChild(logoutBtnEl);
    }

    // Botón de avisos activos (lado izquierdo, junto al logo) — solo con sesión
    let avisosLeftA = null;
    if (session) {
      avisosLeftA = document.createElement('a');
      avisosLeftA.href = 'index.html';
      avisosLeftA.className = 'anb-avisos';
      avisosLeftA.id = 'anb-avisos';
      avisosLeftA.title = 'Ver avisos activos';
      avisosLeftA.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5v3a1 1 0 0 0 1 1h2.5L11 18V6L6.5 10.5H4a1 1 0 0 0-1 0z" fill="currentColor" fill-opacity=".25"/><path d="M15 8.5a4 4 0 0 1 0 7"/><path d="M17.5 6a7 7 0 0 1 0 12"/></svg><span class="anb-avisos-label">Avisos</span><span class="anb-avisos-badge" id="anb-avisos-badge">0</span>`;
    }

    const nav = document.createElement('div');
    nav.id = 'app-navbar';
    nav.setAttribute('role', 'navigation');

    const leftDiv = document.createElement('div');
    leftDiv.className = 'anb-left';
    const logoA = document.createElement('a');
    logoA.href = 'index.html';
    logoA.className = 'anb-logo';
    const logoImg = document.createElement('img');
    logoImg.src = 'logo.png';
    logoImg.alt = 'Logo';
    logoImg.addEventListener('error', function () { logoImg.style.display = 'none'; });
    logoA.appendChild(logoImg);
    leftDiv.appendChild(logoA);
    if (avisosLeftA) leftDiv.appendChild(avisosLeftA);

    const menuUl = document.createElement('ul');
    menuUl.className = 'anb-menu';
    items.forEach(function (li) { menuUl.appendChild(li); });
    if (userLi) menuUl.appendChild(userLi);

    nav.appendChild(leftDiv);
    nav.appendChild(menuUl);
    document.body.insertBefore(nav, document.body.firstChild);

    /* ── Dropdowns ── */
    const drops = nav.querySelectorAll('.anb-dropdown');
    drops.forEach(function (drop) {
      drop.querySelector('.anb-dropdown-toggle').addEventListener('click', function (e) {
        e.stopPropagation();
        drops.forEach(function (d) { if (d !== drop) d.classList.remove('open'); });
        drop.classList.toggle('open');
      });
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.anb-dropdown')) drops.forEach(function (d) { d.classList.remove('open'); });
    });

    /* ── Logout ── */
    const logoutBtn = document.getElementById('anb-logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', function () {
      localStorage.removeItem('session:v1');
      window.location.href = 'index.html';
    });

    /* ── Notificaciones + Avisos: badges ── */
    if (session && session.id) {
      const API = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
      const badge       = document.getElementById('anb-bell-badge');
      const avisosBadge = document.getElementById('anb-avisos-badge');

      async function refreshBadge() {
        if (!badge) return;
        try {
          const resp = await fetch(API + '/api/usuarios/' + session.id + '/notificaciones/unread-count', { cache: 'no-store' });
          const data = await resp.json();
          if (!data.success) return;
          const n = Number(data.count) || 0;
          if (n > 0) {
            badge.textContent = n > 99 ? '99+' : String(n);
            badge.classList.add('show');
          } else {
            badge.classList.remove('show');
          }
        } catch {}
      }
      async function refreshAvisos() {
        if (!avisosBadge) return;
        try {
          const resp = await fetch(API + '/api/avisos', { cache: 'no-store' });
          const data = await resp.json();
          if (!data.success) return;
          const n = (data.avisos || []).length;
          if (n > 0) {
            avisosBadge.textContent = n > 99 ? '99+' : String(n);
            avisosBadge.classList.add('show');
          } else {
            avisosBadge.classList.remove('show');
          }
        } catch {}
      }
      window.__refreshNotifBadge = refreshBadge;
      refreshBadge();
      refreshAvisos();
      setInterval(refreshBadge, 30000);
      setInterval(refreshAvisos, 60000);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') { refreshBadge(); refreshAvisos(); }
      });
    }

    /* ── Ocultar pestañas de Administración sin facultad ── */
    const ADMIN_TAB_FAC = {
      'admin.html':                'admin_usuarios',
      'proyectos-admin.html':      'admin_proyectos',
      'tareas-admin.html':         'admin_tareas',
      'sistemas-admin.html':       'admin_sistemas',
      'facultades-admin.html':     'admin_facultades',
      'correos-entregables.html':  'correos_entregables',
    };
    document.querySelectorAll('.admin-tabs a.btn-nav-tab').forEach(function (a) {
      const href = (a.getAttribute('href') || '').toLowerCase();
      const clave = ADMIN_TAB_FAC[href];
      if (clave && !fac(clave, 'ver')) a.style.display = 'none';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
