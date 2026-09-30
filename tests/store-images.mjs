// Builds the Chrome Web Store pictures in ../store/images/<language>/: five 1280×800 screenshots,
// one per feature (a headline, three points and the real screen), the 440×280 small promo tile and
// the 1400×560 marquee promo tile (optional; the store only shows it when it features the item).
// The pictures come from the extension's own screenshots (images/screenshots/<en|pt_BR>/, made by
// screenshots.mjs), so run `npm run screenshots` first if the popup changed.
// Usage: node store-images.mjs   (then look at every picture before uploading it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const extension = path.join(root, 'page-snapshot-extension');
const storeDir = path.join(root, 'store');

const SLIDES = {
  en: {
    tagline: 'Save any page as ZIP or .wsnp',
    marquee: 'Saves the page you see, carousels included, as a ZIP or .wsnp file that opens offline',
    slides: [
      ['popup-done.png', 'Saves the page exactly as you see it', [
        'What scripts put on the screen, what you typed in forms',
        'Its styles, images and fonts, in one file',
        'Save as .zip, or as a signed .wsnp',
      ]],
      ['popup-running.png', 'Every item of every carousel', [
        'Steps through each carousel, item by item',
        'Puts your page back where it was',
        'Next and Previous still work in the saved copy',
      ]],
      ['snapshot-offline.png', 'Opens offline, as it looked', [
        'Unzip it and open index.html (a .wsnp: rename it to .zip)',
        'Sections, tabs and carousels keep working',
        'Opening it makes no request at all',
      ]],
      ['popup-failed.png', 'Nothing left pointing online', [
        'Lists anything that could not be saved',
        'Its reference is removed from the copy',
        'So the saved page never contacts a website',
      ]],
      ['popup-help.png', 'Save as .zip or .wsnp', [
        '.zip: a plain ZIP that any unzip tool opens',
        '.wsnp: one signed file, every file listed with its SHA-256',
        'Runs in the background; help built in; no telemetry',
      ]],
    ],
  },
  pt_BR: {
    tagline: 'Salve páginas em ZIP ou .wsnp',
    marquee: 'Salva a página que você vê, com carrosséis, num ZIP ou .wsnp que abre offline',
    slides: [
      ['popup-done.png', 'Salva a página do jeito que você vê', [
        'O que os scripts mostram e o que você digitou',
        'Estilos, imagens e fontes, num único arquivo',
        'Salve como .zip ou como .wsnp assinado',
      ]],
      ['popup-running.png', 'Todos os itens de cada carrossel', [
        'Percorre cada carrossel, item por item',
        'Devolve a página ao item em que estava',
        'Próximo e Anterior funcionam na cópia salva',
      ]],
      ['snapshot-offline.png', 'Abre offline, como era', [
        'Descompacte e abra o index.html (um .wsnp: renomeie para .zip)',
        'Seções, abas e carrosséis continuam funcionando',
        'Abrir a cópia não faz nenhuma requisição',
      ]],
      ['popup-failed.png', 'Nada fica apontando para a internet', [
        'Lista o que não pôde ser salvo',
        'A referência é removida da cópia',
        'A página salva nunca acessa um site',
      ]],
      ['popup-help.png', 'Salve como .zip ou .wsnp', [
        '.zip: um ZIP comum que qualquer programa abre',
        '.wsnp: um arquivo assinado, cada arquivo com seu SHA-256',
        'Roda em segundo plano; ajuda incluída; sem telemetria',
      ]],
    ],
  },
};

const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
const escape = (text) => text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = dataUri(path.join(extension, 'icons/icon128.png'));

const STYLE = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: "Noto Sans", "Adwaita Sans", Cantarell, system-ui, sans-serif; color: #1d1d1f; }
  .slide { width: 1280px; height: 800px; display: flex; align-items: center; gap: 56px; padding: 0 80px;
    background: linear-gradient(135deg, #e8f0fe 0%, #fafafa 55%, #eef4ff 100%); }
  .text { flex: 1; min-width: 0; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 36px; font-size: 22px; font-weight: 700; color: #1d4ed8; }
  .brand img { width: 44px; height: 44px; border-radius: 10px; }
  h1 { font-size: 48px; line-height: 1.12; letter-spacing: -0.01em; margin-bottom: 32px; }
  ul { list-style: none; padding: 0; }
  li { position: relative; padding-left: 32px; margin-bottom: 18px; font-size: 24px; line-height: 1.35; color: #3a3a40; }
  li::before { content: ""; position: absolute; left: 0; top: 11px; width: 12px; height: 12px; border-radius: 50%; background: #2563eb; }
  .shots { display: flex; gap: 24px; align-items: center; flex: none; }
  .shots img { border-radius: 14px; box-shadow: 0 2px 6px rgba(0,0,0,.08), 0 18px 48px rgba(30,64,140,.18); background: #fafafa; }
  .tile { width: 440px; height: 280px; display: flex; flex-direction: column; justify-content: center; gap: 16px; padding: 0 34px;
    background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #fff; }
  .tile .row { display: flex; align-items: center; gap: 16px; }
  .tile img { width: 76px; height: 76px; border-radius: 16px; background: #fff; padding: 6px; }
  .tile b { font-size: 38px; line-height: 1.1; }
  .tile p { font-size: 22px; line-height: 1.3; opacity: .95; }
  .marquee { width: 1400px; height: 560px; display: flex; align-items: center; gap: 56px; padding: 0 80px;
    background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 60%, #1e40af 100%); color: #fff; overflow: hidden; }
  .marquee .text { flex: 1; }
  .marquee .row { display: flex; align-items: center; gap: 22px; margin-bottom: 30px; }
  .marquee .row img { width: 96px; height: 96px; border-radius: 22px; background: #fff; padding: 8px; }
  .marquee b { font-size: 56px; line-height: 1.05; }
  .marquee p { font-size: 34px; line-height: 1.25; opacity: .95; }
  .marquee .shots img { box-shadow: 0 20px 50px rgba(0,0,0,.35); }
`;

// A screenshot at most maxWidth × maxHeight CSS pixels (the files are 2x, so they stay sharp).
function picture(file, maxWidth, maxHeight) {
  const header = fs.readFileSync(file).subarray(16, 24); // a PNG's IHDR: width and height
  const [w, h] = [header.readUInt32BE(0) / 2, header.readUInt32BE(4) / 2];
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  return `<img src="${dataUri(file)}" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" alt="">`;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [language, { tagline, marquee, slides }] of Object.entries(SLIDES)) {
    const shots = path.join(extension, 'images/screenshots', language);
    const out = path.join(storeDir, 'images', language);
    fs.mkdirSync(out, { recursive: true });

    for (const [index, [file, headline, points]] of slides.entries()) {
      // The saved page is a wide browser view; the popup pictures are narrow and tall.
      const wide = file.startsWith('snapshot');
      const image = picture(path.join(shots, file), wide ? 620 : 400, wide ? 560 : 700);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.setContent(`<style>${STYLE}</style><div class="slide"><div class="text">
        <div class="brand"><img src="${icon}" alt="">PageKeep</div>
        <h1>${escape(headline)}</h1><ul>${points.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>
        </div><div class="shots">${image}</div></div>`);
      const name = `screenshot-${index + 1}.jpg`;
      await page.screenshot({ path: path.join(out, name), type: 'jpeg', quality: 95 });
      console.log(`wrote store/images/${language}/${name}`);
    }

    await page.setViewportSize({ width: 440, height: 280 });
    await page.setContent(`<style>${STYLE}</style><div class="tile"><div class="row"><img src="${icon}" alt="">
      <b>PageKeep</b></div><p>${escape(tagline)}</p></div>`);
    await page.screenshot({ path: path.join(out, 'small-promo-tile.jpg'), type: 'jpeg', quality: 95 });
    console.log(`wrote store/images/${language}/small-promo-tile.jpg`);

    await page.setViewportSize({ width: 1400, height: 560 });
    const pair = ['popup-running.png', 'popup-done.png'].map((f) => picture(path.join(shots, f), 300, 470)).join('');
    await page.setContent(`<style>${STYLE}</style><div class="marquee"><div class="text">
      <div class="row"><img src="${icon}" alt=""><b>PageKeep</b></div>
      <p>${escape(marquee)}</p></div><div class="shots">${pair}</div></div>`);
    await page.screenshot({ path: path.join(out, 'marquee-promo-tile.jpg'), type: 'jpeg', quality: 95 });
    console.log(`wrote store/images/${language}/marquee-promo-tile.jpg`);
  }
} finally {
  await browser.close();
}
