/* Shared top navigation bar for the Lot Tracking site.
   Include with <script src="/nav.js"></script> as the first thing inside <body>.
   Relies on the --navy CSS variable already defined by each page's :root. */
(function () {
  var LINKS = [
    { href: '/', label: 'New Shipment' },
    { href: '/browse.html', label: 'Browse Data' },
    { href: '/compare.html', label: 'Lot Comparison' },
    { href: '/inventory.html', label: 'Inventory & Reordering' },
    { href: '/catalog-admin.html', label: 'Catalog Admin' },
    { href: '/tea-admin.html', label: 'TEa Admin' }
  ];

  var path = window.location.pathname;
  if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/index.html') path = '/';

  var linksHtml = LINKS.map(function (l) {
    var active = (l.href === path) ? ' active' : '';
    return '<a href="' + l.href + '" class="site-nav__link' + active + '">' + l.label + '</a>';
  }).join('');

  var navHtml =
    '<nav class="site-nav">' +
      '<div class="site-nav__inner">' +
        '<a href="/" class="site-nav__brand">Altru Diagnostics <small>Lot Tracking</small></a>' +
        '<button type="button" class="site-nav__toggle" id="siteNavToggle" aria-label="Toggle navigation" aria-expanded="false">&#9776;</button>' +
        '<div class="site-nav__links" id="siteNavLinks">' + linksHtml + '</div>' +
      '</div>' +
    '</nav>';

  var style = document.createElement('style');
  style.textContent =
    '.site-nav{background:var(--navy);position:sticky;top:0;z-index:90;box-shadow:0 2px 8px rgba(0,0,0,.12);}' +
    '.site-nav__inner{max-width:1700px;margin:0 auto;padding:10px 18px;display:flex;align-items:center;justify-content:space-between;gap:14px;position:relative;}' +
    '.site-nav__brand{color:#fff;font-weight:700;font-size:14px;text-decoration:none;white-space:nowrap;display:flex;align-items:baseline;gap:6px;}' +
    '.site-nav__brand small{font-weight:500;font-size:11px;color:#9fb7cf;}' +
    '.site-nav__links{display:flex;flex-wrap:wrap;gap:2px;}' +
    '.site-nav__link{color:#cfe0f0;text-decoration:none;font-size:12.5px;font-weight:600;padding:8px 11px;border-radius:6px;white-space:nowrap;}' +
    '.site-nav__link:hover{background:rgba(255,255,255,.1);color:#fff;}' +
    '.site-nav__link.active{background:rgba(255,255,255,.16);color:#fff;}' +
    '.site-nav__toggle{display:none;background:none;border:none;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px;}' +
    '.site-nav__toggle:hover{background:rgba(255,255,255,.1);}' +
    '@media (max-width:780px){' +
      '.site-nav__toggle{display:block;}' +
      '.site-nav__links{display:none;position:absolute;top:100%;left:0;right:0;background:var(--navy);flex-direction:column;padding:6px;box-shadow:0 8px 16px rgba(0,0,0,.25);border-radius:0 0 10px 10px;}' +
      '.site-nav__links.open{display:flex;}' +
      '.site-nav__link{padding:11px 12px;}' +
    '}' +
    '@media print{.site-nav{display:none;}}';
  document.head.appendChild(style);

  document.body.insertAdjacentHTML('afterbegin', navHtml);

  var toggle = document.getElementById('siteNavToggle');
  var linksEl = document.getElementById('siteNavLinks');
  toggle.addEventListener('click', function () {
    var isOpen = linksEl.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
})();
