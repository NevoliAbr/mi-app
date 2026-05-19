/* ───────────────────────────────────────────────────────────
   Navbar compartido — se inyecta en todas las páginas internas.
   Uso: <script src="navbar.js"></script>
   ─────────────────────────────────────────────────────────── */
(function () {
  function init() {
    if (document.getElementById('app-navbar')) return;

    /* ── Sesión y roles ── */
    let session = null;
    try { session = JSON.parse(localStorage.getItem('session') || 'null'); } catch {}
    const rol = (session && session.rol) || null;
    const esSuperusuario = rol === 'superusuario';
    const esUsuario      = rol === 'usuario';
    const esRestringido  = rol === 'desarrollolead' || rol === 'operacional';
    const esSinRol       = rol === 'sinrol';
    const segVisible  = !!session && !esUsuario && !esRestringido && !esSinRol;
    const entVisible  = !!session && !esRestringido && !esSinRol;
    const dashVisible = !!session && !esUsuario && !esRestringido && !esSinRol;
    const taskVisible = !!session && !esUsuario && !esSinRol;

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

    /* ── HTML ── */
    const path = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    const act = (href) => path === href.toLowerCase() ? ' class="active"' : '';

    const items = [];
    if (esSuperusuario) {
      items.push(
        '<li class="anb-dropdown">' +
          '<button type="button" class="anb-dropdown-toggle">Creación <span class="anb-caret">&#9662;</span></button>' +
          '<ul class="anb-dropdown-menu">' +
            '<li><a href="projects.html"' + act('projects.html') + '>Cargar projects</a></li>' +
            '<li><a href="avisos.html"' + act('avisos.html') + '>Crear Avisos</a></li>' +
            '<li><a href="entregables.html"' + act('entregables.html') + '>Carga de entregables</a></li>' +
          '</ul>' +
        '</li>'
      );
    }
    if (segVisible || entVisible) {
      let sub = '';
      if (segVisible) sub += '<li><a href="seguimiento.html"' + act('seguimiento.html') + '>Módulo de Seguimiento</a></li>';
      if (entVisible) sub += '<li><a href="modulo-entregables.html"' + act('modulo-entregables.html') + '>Módulo Entregables</a></li>';
      items.push(
        '<li class="anb-dropdown">' +
          '<button type="button" class="anb-dropdown-toggle">Módulos <span class="anb-caret">&#9662;</span></button>' +
          '<ul class="anb-dropdown-menu">' + sub + '</ul>' +
        '</li>'
      );
    }
    if (dashVisible) items.push('<li><a href="analitica.html"' + act('analitica.html') + '>Dashboards</a></li>');
    if (taskVisible) items.push('<li><a href="task.html"' + act('task.html') + '>&#128203; Tasks</a></li>');
    if (esSuperusuario) items.push('<li><a href="admin.html"' + act('admin.html') + '>Administración</a></li>');

    let userHtml = '';
    if (session) {
      const nombre = (session.nombre || 'Perfil').replace(/</g, '&lt;');
      const bellActive = path === 'notificaciones.html' ? ' active' : '';
      const bellHtml =
        '<a href="notificaciones.html" class="anb-bell' + bellActive + '" id="anb-bell" title="Notificaciones">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M6 8a6 6 0 0 1 12 0c0 4.5 1.2 6.5 2.3 7.7.4.5.7 1 .7 1.3 0 .6-.5 1-1 1H4c-.5 0-1-.4-1-1 0-.3.3-.8.7-1.3C4.8 14.5 6 12.5 6 8z" fill="currentColor" fill-opacity=".18"/>' +
            '<path d="M14 19a2 2 0 0 1-4 0"/>' +
          '</svg>' +
          '<span class="anb-bell-badge" id="anb-bell-badge">0</span>' +
        '</a>';
      userHtml =
        '<li class="anb-user">' +
          bellHtml +
          '<a href="perfil.html" class="anb-greeting" title="Ver mi perfil">' + nombre + '</a>' +
          '<button class="anb-logout" id="anb-logout-btn" type="button">Cerrar sesión</button>' +
        '</li>';
    }

    const nav = document.createElement('div');
    nav.id = 'app-navbar';
    nav.setAttribute('role', 'navigation');
    nav.innerHTML =
      '<a href="index.html" class="anb-logo"><img src="logo.png" alt="Logo" onerror="this.style.display=\'none\'" /></a>' +
      '<ul class="anb-menu">' + items.join('') + userHtml + '</ul>';
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
      localStorage.removeItem('session');
      window.location.href = 'index.html';
    });

    /* ── Notificaciones: badge ── */
    if (session && session.id) {
      const API = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
      const badge = document.getElementById('anb-bell-badge');

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
      window.__refreshNotifBadge = refreshBadge;
      refreshBadge();
      setInterval(refreshBadge, 30000);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') refreshBadge();
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
