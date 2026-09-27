// The example website of the screenshots (help pages and store pictures): a made-up local news site,
// "The Harbor Times" / "Gazeta do Porto", rich enough to look like a real page. Everything on it is
// ours: the texts are invented and the photos are drawn here as SVG illustrations, so no picture
// shows a third party's content.
//
// It has what PageKeep deals with on real news sites:
// - a layout in CSS grid with custom properties, gradients, pseudo-elements, a background image
//   in the stylesheet and a web-safe font stack;
// - photos in several sizes (srcset), one of them from a second site (the "CDN");
// - a photo-gallery carousel ("Next item" / "Previous item") that renders one photo at a time;
// - "Latest" / "Most read" tabs and a collapsible "live updates" box (aria-expanded);
// - a downloadable PDF report;
// - an ad slot with a tracking ping and a <link rel="compression-dictionary">, which a saved copy
//   must drop so it never goes online.
// /archive is the same page with one photo the site has lost (HTTP 404).
//
// startSite(lang) serves it on 127.0.0.1; the browser reaches it as http://SITE/ and the second
// site as http://CDN/ through --host-resolver-rules (see screenshots.mjs).
import http from 'node:http';

export const SITE = 'harbortimes.example';
export const CDN = 'cdn.harbortimes.example';

export const TEXTS = {
  en: {
    paper: 'The Harbor Times',
    tagline: 'Local news since 1921',
    date: 'Saturday, 27 September 2026',
    sections: ['Home', 'City', 'Politics', 'Business', 'Sport', 'Culture', 'Weather'],
    ticker: ['Rail line to the coast reopens on Monday', 'Harbour festival draws record crowds', 'Warm, dry weekend ahead'],
    lead: {
      kicker: 'City',
      title: 'Riverside park opens after three years of work',
      standfirst: 'Twelve hectares of gardens, a lido and a cycle path now line the old docks, turning a car park into the city’s largest green space.',
      byline: 'By Marta Silva · 8 min read',
    },
    stories: [
      ['Business', 'Farmers’ market moves into the old station hall', '4 min read'],
      ['Sport', 'Harbor FC win the regional final on penalties', '3 min read'],
      ['Culture', 'Lighthouse museum reopens with a new wing', '5 min read'],
      ['Politics', 'Council approves a new bus network', '6 min read'],
    ],
    tabs: ['Latest', 'Most read'],
    latest: ['Ferry timetable changes from October', 'School orchestra wins national prize', 'New bike lanes on Harbour Road'],
    popular: ['Riverside park: what to see first', 'The best seafood stalls at the market', 'How the lido keeps its water warm'],
    live: 'Live: harbour festival updates',
    liveItems: ['21:40 · Fireworks start in twenty minutes', '21:05 · Night market extended until midnight', '20:30 · Tall ships lit up along the quay'],
    gallery: 'Photo gallery: the festival of lights',
    photos: ['Lanterns over the quay', 'The tall ships at dusk', 'Crowds on the swing bridge', 'Fireworks over the harbour', 'Night market stalls', 'Last boat home'],
    report: 'Festival programme (PDF)',
    reportFile: 'festival-programme.pdf',
    ad: 'Advertisement',
    footer: 'The Harbor Times is a made-up newspaper for this example.',
  },
  'pt-BR': {
    paper: 'Gazeta do Porto',
    tagline: 'Notícias da cidade desde 1921',
    date: 'Sábado, 27 de setembro de 2026',
    sections: ['Início', 'Cidade', 'Política', 'Economia', 'Esporte', 'Cultura', 'Tempo'],
    ticker: ['Linha de trem até o litoral volta a funcionar na segunda', 'Festival do porto bate recorde de público', 'Fim de semana quente e seco'],
    lead: {
      kicker: 'Cidade',
      title: 'Parque à beira-rio abre depois de três anos de obras',
      standfirst: 'Doze hectares de jardins, uma piscina pública e uma ciclovia ocupam agora as antigas docas, que eram um estacionamento.',
      byline: 'Por Marta Silva · 8 min de leitura',
    },
    stories: [
      ['Economia', 'Feira de produtores muda para o galpão da antiga estação', '4 min de leitura'],
      ['Esporte', 'Porto FC vence a final regional nos pênaltis', '3 min de leitura'],
      ['Cultura', 'Museu do farol reabre com uma ala nova', '5 min de leitura'],
      ['Política', 'Câmara aprova nova rede de ônibus', '6 min de leitura'],
    ],
    tabs: ['Últimas', 'Mais lidas'],
    latest: ['Horário das balsas muda em outubro', 'Orquestra escolar ganha prêmio nacional', 'Novas ciclofaixas na Avenida do Porto'],
    popular: ['Parque à beira-rio: o que ver primeiro', 'As melhores barracas de frutos do mar', 'Como a piscina pública mantém a água quente'],
    live: 'Ao vivo: novidades do festival do porto',
    liveItems: ['21h40 · Fogos começam em vinte minutos', '21h05 · Feira noturna vai até a meia-noite', '20h30 · Veleiros iluminados no cais'],
    gallery: 'Galeria de fotos: o festival das luzes',
    photos: ['Lanternas sobre o cais', 'Os veleiros ao entardecer', 'Multidão na ponte giratória', 'Fogos sobre o porto', 'Barracas da feira noturna', 'O último barco para casa'],
    report: 'Programação do festival (PDF)',
    reportFile: 'programacao-do-festival.pdf',
    ad: 'Publicidade',
    footer: 'A Gazeta do Porto é um jornal inventado para este exemplo.',
  },
};

// ---- illustrations -----------------------------------------------------------------------------
// Each "photo" is a small scene drawn in SVG: a sky gradient, the sun or moon, and a subject.

const SCENES = {
  park: (w, h) => `<linearGradient id="s" x2="0" y2="1"><stop offset="0" stop-color="#8ec5f0"/><stop offset="1" stop-color="#dff0fb"/></linearGradient>
    <rect width="${w}" height="${h}" fill="url(#s)"/><circle cx="${w * 0.8}" cy="${h * 0.22}" r="${h * 0.1}" fill="#fff4c2"/>
    <path d="M0 ${h * 0.62} Q${w * 0.3} ${h * 0.45} ${w * 0.6} ${h * 0.6} T${w} ${h * 0.55} V${h} H0Z" fill="#7cb66b"/>
    <path d="M0 ${h * 0.75} Q${w * 0.4} ${h * 0.62} ${w} ${h * 0.72} V${h} H0Z" fill="#5a9a4c"/>
    <rect y="${h * 0.84}" width="${w}" height="${h * 0.16}" fill="#6fb3d9"/>
    ${[0.12, 0.26, 0.44, 0.68, 0.86].map((x, i) => `<rect x="${w * x - 4}" y="${h * (0.5 + (i % 2) * 0.06)}" width="8" height="${h * 0.14}" fill="#6b4b2e"/><circle cx="${w * x}" cy="${h * (0.48 + (i % 2) * 0.06)}" r="${h * 0.08}" fill="#3f7f3a"/>`).join('')}`,
  market: (w, h) => `<rect width="${w}" height="${h}" fill="#f3e2c7"/><rect y="${h * 0.12}" width="${w}" height="${h * 0.1}" fill="#8a5a3b"/>
    ${[0, 1, 2, 3].map((i) => `<g transform="translate(${w * (0.04 + i * 0.24)} ${h * 0.3})">${Array.from({ length: 6 }, (_, k) => `<rect x="${k * w * 0.034}" width="${w * 0.034}" height="${h * 0.12}" fill="${k % 2 ? '#fff' : ['#d9534f', '#2e86ab', '#e8a33a', '#4a9d5b'][i]}"/>`).join('')}
    <rect y="${h * 0.12}" width="${w * 0.2}" height="${h * 0.34}" fill="#c89b6d"/>${[0, 1, 2].map((k) => `<circle cx="${w * (0.04 + k * 0.06)}" cy="${h * 0.24}" r="${h * 0.035}" fill="${['#e4572e', '#f3a712', '#76b041'][k]}"/>`).join('')}</g>`).join('')}
    <rect y="${h * 0.8}" width="${w}" height="${h * 0.2}" fill="#a88b6a"/>`,
  sport: (w, h) => `<rect width="${w}" height="${h}" fill="#1f3b5c"/><rect y="${h * 0.55}" width="${w}" height="${h * 0.45}" fill="#3f9b4a"/>
    <path d="M0 ${h * 0.55} L${w * 0.15} ${h * 0.2} H${w * 0.85} L${w} ${h * 0.55}Z" fill="#2c4f78"/>
    ${Array.from({ length: 40 }, (_, k) => `<circle cx="${w * (0.17 + (k % 20) * 0.034)}" cy="${h * (0.3 + Math.floor(k / 20) * 0.1)}" r="${h * 0.018}" fill="${['#f2c14e', '#fff', '#e4572e'][k % 3]}"/>`).join('')}
    <rect x="${w * 0.1}" y="${h * 0.05}" width="6" height="${h * 0.2}" fill="#ccc"/><circle cx="${w * 0.1 + 3}" cy="${h * 0.05}" r="${h * 0.05}" fill="#fffbe0"/>
    <rect x="${w * 0.9 - 6}" y="${h * 0.05}" width="6" height="${h * 0.2}" fill="#ccc"/><circle cx="${w * 0.9 - 3}" cy="${h * 0.05}" r="${h * 0.05}" fill="#fffbe0"/>
    <path d="M${w * 0.5} ${h * 0.55} V${h}" stroke="#fff" stroke-width="3"/><circle cx="${w * 0.5}" cy="${h * 0.78}" r="${h * 0.1}" fill="none" stroke="#fff" stroke-width="3"/>`,
  lighthouse: (w, h) => `<linearGradient id="s" x2="0" y2="1"><stop offset="0" stop-color="#f7b267"/><stop offset="1" stop-color="#f4845f"/></linearGradient>
    <rect width="${w}" height="${h}" fill="url(#s)"/><circle cx="${w * 0.25}" cy="${h * 0.55}" r="${h * 0.14}" fill="#ffe29a"/>
    <rect y="${h * 0.6}" width="${w}" height="${h * 0.4}" fill="#3d5a80"/><path d="M${w * 0.58} ${h * 0.6} L${w * 0.62} ${h * 0.15} H${w * 0.7} L${w * 0.74} ${h * 0.6}Z" fill="#fff"/>
    ${[0.25, 0.4, 0.52].map((y) => `<rect x="${w * 0.6}" y="${h * y}" width="${w * 0.12}" height="${h * 0.05}" fill="#d62828"/>`).join('')}
    <rect x="${w * 0.61}" y="${h * 0.08}" width="${w * 0.1}" height="${h * 0.08}" fill="#ffd166"/><path d="M${w * 0.5} ${h * 0.62} H${w * 0.82} L${w * 0.86} ${h * 0.66} H${w * 0.46}Z" fill="#6c584c"/>`,
  bus: (w, h) => `<rect width="${w}" height="${h}" fill="#dfe7ef"/>${[0.05, 0.22, 0.4, 0.62, 0.8].map((x, i) => `<rect x="${w * x}" y="${h * (0.1 + (i % 3) * 0.05)}" width="${w * 0.15}" height="${h * 0.6}" fill="${['#b8c4d6', '#9aa9c0', '#c9d3e1'][i % 3]}"/>`).join('')}
    <rect y="${h * 0.7}" width="${w}" height="${h * 0.3}" fill="#6c757d"/><rect x="${w * 0.2}" y="${h * 0.48}" width="${w * 0.55}" height="${h * 0.3}" rx="14" fill="#e63946"/>
    ${[0, 1, 2, 3, 4].map((k) => `<rect x="${w * (0.23 + k * 0.1)}" y="${h * 0.52}" width="${w * 0.08}" height="${h * 0.1}" fill="#cfe8ff"/>`).join('')}
    <circle cx="${w * 0.3}" cy="${h * 0.79}" r="${h * 0.05}" fill="#222"/><circle cx="${w * 0.65}" cy="${h * 0.79}" r="${h * 0.05}" fill="#222"/>`,
  // The gallery: the harbour at night, a different light in each photo.
  night: (w, h, k) => `<linearGradient id="s" x2="0" y2="1"><stop offset="0" stop-color="${['#0b132b', '#3a0ca3', '#1b263b', '#10002b', '#240046', '#03045e'][k]}"/><stop offset="1" stop-color="${['#3a506b', '#f72585', '#415a77', '#5a189a', '#ff9e00', '#0077b6'][k]}"/></linearGradient>
    <rect width="${w}" height="${h}" fill="url(#s)"/><circle cx="${w * (0.15 + k * 0.13)}" cy="${h * 0.2}" r="${h * 0.06}" fill="#f1faee"/>
    <rect y="${h * 0.66}" width="${w}" height="${h * 0.34}" fill="#0d1b2a"/>
    ${Array.from({ length: 9 }, (_, i) => `<circle cx="${w * (0.08 + i * 0.105)}" cy="${h * (0.4 + ((i + k) % 3) * 0.06)}" r="${h * 0.035}" fill="${['#ffd166', '#ef476f', '#06d6a0', '#f4a261'][(i + k) % 4]}"/>`).join('')}
    <path d="M${w * 0.1} ${h * 0.66} H${w * 0.4} L${w * 0.36} ${h * 0.74} H${w * 0.14}Z M${w * 0.55} ${h * 0.66} H${w * 0.9} L${w * 0.86} ${h * 0.75} H${w * 0.6}Z" fill="#1d3557"/>
    <path d="M${w * 0.25} ${h * 0.66} V${h * 0.35} M${w * 0.72} ${h * 0.66} V${h * 0.3}" stroke="#a8dadc" stroke-width="3"/>`,
};

const photo = (scene, width, k = 0) => {
  const w = 800;
  const h = 450;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(width * h / w)}" viewBox="0 0 ${w} ${h}">${SCENES[scene](w, h, k)}</svg>`;
};

// ---- the page ----------------------------------------------------------------------------------

const STORY_SCENES = ['market', 'sport', 'lighthouse', 'bus'];

function page(t, broken) {
  const img = (path, alt, cls = '') => `<img ${cls ? `class="${cls}" ` : ''}src="${path}-800.svg" srcset="${path}-400.svg 400w, ${path}-800.svg 800w" sizes="(max-width: 700px) 100vw, 50vw" alt="${alt}">`;
  const card = (i) => `<figure class="shot"><img src="/photos/night-${i}-800.svg" alt=""><figcaption>${t.photos[i]}<span>${i + 1} / ${t.photos.length}</span></figcaption></figure>`;
  return `<!doctype html><html lang="${t === TEXTS.en ? 'en' : 'pt-BR'}"><head><meta charset="utf-8"><title>${t.paper}</title>
<link rel="stylesheet" href="/css/site.css"><link rel="icon" href="/favicon.svg"><link rel="canonical" href="http://${SITE}/">
<link rel="compression-dictionary" href="http://${CDN}/ads/dict"><link rel="preconnect" href="http://${CDN}"></head>
<body>
<div class="topbar"><span>${t.date}</span><span>${t.tagline}</span></div>
<header class="masthead"><h1>${t.paper}</h1></header>
<nav class="sections">${t.sections.map((s, i) => `<a href="#"${i === 0 ? ' class="on"' : ''}>${s}</a>`).join('')}</nav>
<div class="ticker"><b>●</b> ${t.ticker.join(' <i>/</i> ')}</div>
<main class="grid">
  <article class="lead">
    ${img('/photos/park', '')}
    <p class="kicker">${t.lead.kicker}</p><h2>${t.lead.title}</h2><p class="standfirst">${t.lead.standfirst}</p><p class="byline">${t.lead.byline}</p>
  </article>
  <aside class="side">
    <div class="tabs" role="tablist"><button role="tab" aria-selected="true" aria-controls="t1" id="b1">${t.tabs[0]}</button><button role="tab" aria-selected="false" aria-controls="t2" id="b2">${t.tabs[1]}</button></div>
    <ol id="t1" role="tabpanel">${t.latest.map((x) => `<li>${x}</li>`).join('')}</ol>
    <ol id="t2" role="tabpanel" hidden>${t.popular.map((x) => `<li>${x}</li>`).join('')}</ol>
    <div class="live"><button aria-expanded="false" aria-controls="live-list" id="live-btn">${t.live}</button><ul id="live-list" hidden>${t.liveItems.map((x) => `<li>${x}</li>`).join('')}</ul></div>
    <div class="ad"><small>${t.ad}</small><a href="http://${CDN}/ads/click" ping="http://${CDN}/ads/ping"><img src="http://${CDN}/ads/banner.svg" alt=""></a></div>
  </aside>
  ${t.stories.map(([kicker, title, time], i) => `<article class="card">${img(`/photos/${STORY_SCENES[i]}`, '')}<p class="kicker">${kicker}</p><h3>${title}</h3><p class="byline">${time}</p></article>`).join('')}
  <section class="gallery">
    <h2>${t.gallery}</h2>
    <div id="item">${card(0)}</div>
    <nav class="pager"><button aria-label="Previous item" id="prev" disabled>‹</button><button aria-label="Next item" id="next">›</button></nav>
    <p class="files"><a href="/files/${t.reportFile}" download>${t.report}</a></p>
  </section>
  ${broken ? `<article class="card"><img src="/photos/archive-lost.jpg" alt=""><h3>${t.stories[0][1]}</h3></article>` : ''}
</main>
<footer><img src="http://${CDN}/brand/seal.svg" alt="" width="36" height="36"><span>${t.footer}</span></footer>
<script>
const photos = ${JSON.stringify(t.photos)}; let i = 0;
const card = (k) => '<figure class="shot"><img src="/photos/night-' + k + '-800.svg" alt=""><figcaption>' + photos[k] + '<span>' + (k + 1) + ' / ' + photos.length + '</span></figcaption></figure>';
function show() { prev.disabled = i === 0; next.disabled = i === photos.length - 1; setTimeout(() => { item.innerHTML = card(i); }, 120); }
next.onclick = () => { i++; show(); }; prev.onclick = () => { i--; show(); };
for (const [b, p, o, q] of [[b1, t1, b2, t2], [b2, t2, b1, t1]]) b.onclick = () => { b.setAttribute('aria-selected', 'true'); o.setAttribute('aria-selected', 'false'); p.hidden = false; q.hidden = true; };
document.getElementById('live-btn').onclick = (e) => { const open = e.target.getAttribute('aria-expanded') !== 'true'; e.target.setAttribute('aria-expanded', String(open)); document.getElementById('live-list').hidden = !open; };
</script></body></html>`;
}

const CSS = `:root{--ink:#16202a;--muted:#5c6b7a;--rule:#d9dee4;--accent:#b3261e;--paper:#fbfaf7;--serif:Georgia,"Times New Roman",serif;--sans:"Helvetica Neue",Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--paper) url(/img/paper-texture.svg);color:var(--ink);font:16px/1.5 var(--sans)}
.topbar{display:flex;justify-content:space-between;padding:6px 32px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--rule);text-transform:uppercase;letter-spacing:.08em}
.masthead{text-align:center;padding:18px 0 10px}.masthead h1{margin:0;font:700 52px/1 var(--serif);letter-spacing:-.02em}
.masthead h1::after{content:"";display:block;width:120px;height:3px;margin:12px auto 0;background:linear-gradient(90deg,transparent,var(--accent),transparent)}
.sections{display:flex;justify-content:center;gap:26px;padding:10px;border-top:3px double var(--ink);border-bottom:1px solid var(--rule);font-size:14px;font-weight:600}
.sections a{color:var(--ink);text-decoration:none}.sections a.on{color:var(--accent);box-shadow:inset 0 -2px var(--accent)}
.ticker{padding:8px 32px;background:linear-gradient(90deg,#16202a,#2b3a4a);color:#fff;font-size:13px;white-space:nowrap;overflow:hidden}.ticker b{color:#ff6b5f;margin-right:6px}.ticker i{opacity:.5;margin:0 8px;font-style:normal}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:22px;padding:22px 32px;max-width:1240px;margin:0 auto}
.lead{grid-column:span 3}.lead img{width:100%;border-radius:4px;display:block}.lead h2{font:700 34px/1.12 var(--serif);margin:6px 0}
.standfirst{font:19px/1.45 var(--serif);color:#34414f;margin:0 0 8px}.kicker{margin:10px 0 0;color:var(--accent);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em}
.byline{color:var(--muted);font-size:13px;margin:4px 0 0}.side{grid-row:span 2;border-left:1px solid var(--rule);padding-left:20px;font-size:14px}
.tabs{display:flex;gap:4px;border-bottom:2px solid var(--ink)}.tabs button{border:0;background:none;padding:6px 10px;font:600 13px var(--sans);cursor:pointer;color:var(--muted)}
.tabs button[aria-selected=true]{color:#fff;background:var(--ink);border-radius:4px 4px 0 0}.side ol{padding-left:22px}.side li{margin:8px 0;font-family:var(--serif)}
.live{border:1px solid var(--rule);border-radius:6px;background:#fff;margin:14px 0}.live button{width:100%;text-align:left;border:0;background:none;padding:10px;font:600 13px var(--sans);cursor:pointer}
.live button::before{content:"● ";color:var(--accent)}.live ul{margin:0;padding:0 12px 10px 28px;font-size:13px}
.ad{text-align:center;color:var(--muted);border:1px dashed var(--rule);padding:8px}.ad img{width:100%}
.card img{width:100%;border-radius:4px;display:block}.card h3{font:700 18px/1.25 var(--serif);margin:4px 0}
.gallery{grid-column:1/-1;background:#0f1620;color:#e8edf2;border-radius:8px;padding:18px 22px}.gallery h2{font:700 22px var(--serif);margin:0 0 12px}
.shot{margin:0}.shot img{width:100%;max-width:760px;display:block;margin:0 auto;border-radius:4px}.shot figcaption{display:flex;justify-content:space-between;max-width:760px;margin:8px auto 0;font-size:14px}.shot span{opacity:.6}
.pager{display:flex;justify-content:center;gap:12px;margin-top:10px}.pager button{width:38px;height:38px;border-radius:50%;border:1px solid #445;background:#1c2733;color:#fff;font-size:20px;cursor:pointer}.pager button:disabled{opacity:.3}
.files{text-align:center;margin:12px 0 0}.files a{color:#9fd3ff}
footer{display:flex;align-items:center;justify-content:center;gap:10px;padding:18px;color:var(--muted);font-size:13px;border-top:1px solid var(--rule)}
@media (max-width:800px){.grid{grid-template-columns:1fr 1fr}.lead,.side{grid-column:1/-1}}`;

const TEXTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#fbfaf7"/><circle cx="2" cy="2" r=".6" fill="#efebe2"/></svg>`;
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#16202a"/><text x="16" y="23" font-family="Georgia" font-size="20" fill="#fff" text-anchor="middle">H</text></svg>`;
const BANNER = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="250" viewBox="0 0 300 250"><rect width="300" height="250" fill="#ffe8a3"/><circle cx="230" cy="70" r="40" fill="#ffb703"/><text x="24" y="150" font-family="Arial" font-size="30" font-weight="700" fill="#023047">Harbour</text><text x="24" y="186" font-family="Arial" font-size="30" font-weight="700" fill="#023047">Ferries</text></svg>`;
const SEAL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="#5c6b7a" stroke-width="2"/><path d="M8 22 Q18 12 28 22" stroke="#5c6b7a" stroke-width="2" fill="none"/></svg>`;
// A downloadable file of a realistic size (about 0.4 MB), so the popup's totals look like a real page's.
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 400_000 }, (_, i) => (i * 7919) % 251))]);

export function startSite(lang) {
  const t = TEXTS[lang];
  const send = (res, type, body) => { res.setHeader('content-type', type); res.end(body); };
  const server = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const { pathname } = new URL(req.url, 'http://x');
    if (host === CDN) { // the second site: the ad (whose ping and dictionary must never be used) and a seal
      if (pathname === '/ads/banner.svg') return send(res, 'image/svg+xml', BANNER);
      if (pathname === '/brand/seal.svg') return send(res, 'image/svg+xml', SEAL);
      res.statusCode = 404;
      return res.end();
    }
    if (pathname === '/' || pathname === '/archive') return send(res, 'text/html; charset=utf-8', page(t, pathname === '/archive'));
    if (pathname === '/css/site.css') return send(res, 'text/css', CSS);
    if (pathname === '/img/paper-texture.svg') return send(res, 'image/svg+xml', TEXTURE);
    if (pathname === '/favicon.svg') return send(res, 'image/svg+xml', FAVICON);
    const m = pathname.match(/^\/photos\/([a-z]+)(?:-(\d))?-(400|800)\.svg$/);
    if (m && SCENES[m[1]]) return send(res, 'image/svg+xml', photo(m[1], Number(m[3]), Number(m[2] || 0)));
    if (pathname.startsWith('/files/')) return send(res, 'application/pdf', PDF);
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, origin: `http://${SITE}`, texts: t })));
}
