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
      #app-navbar .anb-user { display:flex; align-items:center; gap:12px; }
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
      userHtml =
        '<li class="anb-user">' +
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
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
