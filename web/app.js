import * as pdfjs from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
import { Graphviz } from 'https://cdn.jsdelivr.net/npm/@hpcc-js/wasm-graphviz@1.28.0/dist/index.js';
import { analyzeHerd, herdToDot, plainPositions, itemsToLines, parseSnapshot, formatDate } from './kotrad.js';
import { browserStore, supabaseStore, emptyHerd } from './storage.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

let store = browserStore;
let herd = emptyHerd();
let supabase = null;
let cy = null;
let data = null;
let selectedId = null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- Saving: every change is written straight away ---

let saveTimer = null;
function changed() {
  showStatus('Sparar…', '#4d6b3c');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await store.save(herd);
      showStatus(`Sparat i ${store.name}`, '#1e6b30');
    } catch (e) {
      showStatus('Kunde inte spara: ' + e.message, '#c0392b');
    }
  }, 400);
}

function showStatus(text, color) {
  const el = $('save-status');
  el.textContent = text;
  el.style.color = color;
}

// --- Reading PDFs ---

async function pdfLines(file) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    lines.push(...itemsToLines(content.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))));
  }
  return lines;
}

async function readPdfs(files) {
  const messages = [];
  for (const file of files) {
    try {
      const snap = parseSnapshot(await pdfLines(file), file.name);
      if (!snap.date || !snap.animals.length) {
        messages.push(`${file.name}: hittade inget djurinnehav.`);
        continue;
      }
      herd.snapshots = herd.snapshots.filter(s => s.date !== snap.date);
      herd.snapshots.push({ date: snap.date, file: file.name, animals: snap.animals });
      messages.push(`${file.name}: ${snap.animals.length} djur (${snap.date}).`);
    } catch (e) {
      messages.push(`${file.name}: kunde inte läsas (${e.message}).`);
    }
  }
  herd.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  changed();
  await render();
  if (messages.some(m => !/djur \(/.test(m))) alert(messages.join('\n'));
}

$('pdf-input').addEventListener('change', e => {
  readPdfs([...e.target.files]);
  e.target.value = '';
});
for (const ev of ['dragover', 'dragenter']) {
  document.body.addEventListener(ev, e => { e.preventDefault(); $('welcome').classList.add('dragover'); });
}
document.body.addEventListener('dragleave', () => $('welcome').classList.remove('dragover'));
document.body.addEventListener('drop', e => {
  e.preventDefault();
  $('welcome').classList.remove('dragover');
  const pdfs = [...e.dataTransfer.files].filter(f => /\.pdf$/i.test(f.name));
  if (pdfs.length) readPdfs(pdfs);
});

// --- Name days (api.dryg.net), cached with the herd ---

async function fetchNamedays(dates) {
  const missing = dates.filter(d => !(d in herd.namedays));
  if (!missing.length) return;
  await Promise.all(missing.map(async d => {
    try {
      const r = await fetch(`https://api.dryg.net/dagar/v2.1/${d.replace(/-/g, '/')}`);
      const j = await r.json();
      herd.namedays[d] = (j.dagar && j.dagar[0] && j.dagar[0].namnsdag) || [];
    } catch { /* offline: try again next time */ }
  }));
  changed();
}

// --- Drawing ---

// Tree direction: years top to bottom (TB) or left to right (LR). "auto" picks LR
// when the drawing area is taller than wide, as on a phone held upright.
const DIRECTION_KEY = 'kotradet.direction';
let directionSetting = 'auto';
try { directionSetting = localStorage.getItem(DIRECTION_KEY) || 'auto'; } catch { /* storage blocked */ }
let drawnDirection = null;

function direction() {
  if (directionSetting !== 'auto') return directionSetting;
  const wrap = $('graph-wrap');
  return wrap.clientHeight > wrap.clientWidth ? 'LR' : 'TB';
}

$('flip-button').addEventListener('click', () => {
  directionSetting = direction() === 'TB' ? 'LR' : 'TB';
  try { localStorage.setItem(DIRECTION_KEY, directionSetting); } catch { /* storage blocked */ }
  render();
});

new ResizeObserver(() => {
  if (data && drawnDirection && direction() !== drawnDirection) render();
}).observe($('graph-wrap'));

let graphviz = null;
async function layout(d) {
  graphviz ??= await Graphviz.load();
  drawnDirection = direction();
  return plainPositions(graphviz.layout(herdToDot(d, drawnDirection), 'plain', 'dot'));
}

function svgData(svg) {
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
const CROSS_IMG = svgData('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><line x1="4" y1="4" x2="24" y2="24" stroke="red" stroke-width="4" stroke-linecap="round"/><line x1="24" y1="4" x2="4" y2="24" stroke="red" stroke-width="4" stroke-linecap="round"/></svg>');
const SELL_IMG = svgData('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><text x="4" y="23" font-family="sans-serif" font-size="24" font-weight="bold" fill="#2980b9">$</text></svg>');

// Swedish cattle wear a yellow ear tag in each ear; one tag per missing one.
const TAG_SHAPE = 'd="M7 1h8a3 3 0 0 1 3 3v6l3 4v11a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V14l3-4V4a3 3 0 0 1 3-3z" fill="#f4d03f" stroke="#9a7d0a" stroke-width="1.5"';
const TAG_HOLE = 'r="2" fill="#fff" stroke="#9a7d0a" stroke-width="1"';
const TAG_IMG = {
  1: svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="22" height="28"><path ${TAG_SHAPE}/><circle cx="11" cy="6" ${TAG_HOLE}/></svg>`),
  2: svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="36" height="28"><path ${TAG_SHAPE}/><circle cx="11" cy="6" ${TAG_HOLE}/><path transform="translate(14 0)" ${TAG_SHAPE}/><circle cx="25" cy="6" ${TAG_HOLE}/></svg>`),
};

// One black cross per missed calving, in a row.
function missedImg(count) {
  const crosses = Array.from({ length: count }, (_, i) => {
    const x = i * 20;
    return `<path d="M${x + 4} 4L${x + 16} 16M${x + 16} 4L${x + 4} 16" stroke="#111" stroke-width="3" stroke-linecap="round"/>`;
  }).join('');
  return svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="${count * 20}" height="20">${crosses}</svg>`);
}

// The name on a small white label with a thin frame.
function nameImg(name) {
  const w = name.length * 9 + 14;
  return svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22"><rect x="1" y="1" width="${w - 2}" height="20" rx="4" fill="#fff" stroke="#888" stroke-width="1"/><text x="${w / 2}" y="16" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">${esc(name)}</text></svg>`);
}

// Coat colours. Every animal has a white face. Each is drawn as a small cow in
// the top left corner, and served females get a calf of their own colour.
const COLORS = {
  svart: { label: 'Svart', coat: '#1b1b1b' },
  gra: { label: 'Grå', coat: '#8e8e8e' },
  ljusbrun: { label: 'Ljusbrun', coat: '#c8955c' },
  hereford: { label: 'Hereford-röd', coat: '#9b3412' },
};

function cowImg(c) {
  return svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="28" viewBox="0 0 40 28">`
    + `<path d="M33 3.6 Q33.2 1.2 31.6 0.8" fill="none" stroke="#eee" stroke-width="1.2" stroke-linecap="round"/>`
    + `<g fill="${c.coat}" stroke="#222" stroke-width="0.8" stroke-linejoin="round">`
    + `<path d="M7.5 9 Q4.5 13 5 19" fill="none" stroke="${c.coat}" stroke-width="1.4" stroke-linecap="round"/>`
    + `<rect x="9" y="17" width="2.8" height="9" rx="1.2"/><rect x="13" y="17" width="2.8" height="9" rx="1.2"/>`
    + `<rect x="25" y="17" width="2.8" height="9" rx="1.2"/><rect x="29" y="17" width="2.8" height="9" rx="1.2"/>`
    + `<path d="M7 10 Q7 6 11 6 L28 6 Q30 6 31 5 L32 3.5 Q34.5 2 37.5 3.5 L39 7.5 Q39.5 10 37 10.5 L34 10.5 Q32.5 12 32 15 Q31.5 20 27 20 L11 20 Q7 20 7 16 Z"/>`
    + `<path d="M33.5 4.5 Q30.5 3 29.8 5 Q31.8 6.4 33.5 5.8 Z"/></g>`
    + `<ellipse cx="21" cy="20.6" rx="2.6" ry="1.6" fill="#e9a3a3" stroke="#222" stroke-width="0.6"/>`
    + `<path d="M34.4 3.4 Q36.6 2.6 37.6 4 L38.6 7.8 Q38.9 9.8 37 10 L35.4 10 Q34 7 34.4 3.4 Z" fill="#fff"/>`
    + `<circle cx="35.8" cy="5.6" r="0.8" fill="#222"/></svg>`);
}

function calfImg(c) {
  return svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24" viewBox="0 0 32 24">`
    + `<g fill="${c.coat}" stroke="#222" stroke-width="0.8" stroke-linejoin="round">`
    + `<path d="M6 10 Q4 13 4.5 16" fill="none" stroke="${c.coat}" stroke-width="1.2" stroke-linecap="round"/>`
    + `<rect x="9" y="15" width="2.2" height="7.5" rx="1"/><rect x="12.5" y="15" width="2.2" height="7.5" rx="1"/>`
    + `<rect x="18" y="15" width="2.2" height="7.5" rx="1"/><rect x="21.5" y="15" width="2.2" height="7.5" rx="1"/>`
    + `<path d="M8 11 Q8 8 11 8 L21 8 Q23 8 24 6 L25 4 Q27 2.5 29.5 4 L30.5 7 Q31 9 29 9.5 L26.5 9.5 Q25 11 24.5 13 Q24 16.5 21 16.5 L11 16.5 Q8 16.5 8 13 Z"/>`
    + `<path d="M25.6 4.6 Q22.6 3 21.8 5 Q23.8 6.4 25.6 5.8 Z"/></g>`
    + `<path d="M26.6 4 Q28.6 3 29.6 4.4 L30.4 7 Q30.7 8.7 29.2 9 L27.6 9 Q26.4 6.5 26.6 4 Z" fill="#fff"/>`
    + `<circle cx="27.6" cy="5.6" r="0.7" fill="#222"/></svg>`);
}
const COW_IMG = Object.fromEntries(Object.entries(COLORS).map(([key, c]) => [key, cowImg(c)]));
const CALF_IMG = Object.fromEntries(Object.entries(COLORS).map(([key, c]) => [key, calfImg(c)]));
// Animals without a chosen colour are Hereford red; only other colours are stored.
const DEFAULT_COLOR = 'hereford';

// Corner markers: yellow tag = missing ear tag (top right), calf = served (bottom
// right) with black crosses for missed calvings to its left, coat colour cow (top
// left) with the slaughter cross or $ = sell drawn over it, name label at the
// bottom left.
function markerStyle(a, note) {
  const marks = [];
  const corner = (img, x, ox) => marks.push({ img, w: '28px', h: '28px', x, y: '0%', ox, oy: '-6px' });
  const color = COLORS[note.color] ? note.color : DEFAULT_COLOR;
  if (a.served) marks.push({ img: CALF_IMG[color], w: '32px', h: '24px', x: '100%', y: '100%', ox: '6px', oy: '6px' });
  marks.push({ img: COW_IMG[color], w: '40px', h: '28px', x: '0%', y: '0%', ox: '-8px', oy: '-10px' });
  if (note.slaughter) corner(CROSS_IMG, '0%', '-6px');
  if (note.sell) corner(SELL_IMG, '0%', '-6px');
  const missed = a.missed_calvings.length;
  if (missed) marks.push({ img: missedImg(missed), w: `${missed * 20}px`, h: '20px', x: '100%', y: '100%', ox: '-26px', oy: '4px' });
  const tags = note.tags_missing;
  if (tags) marks.push({ img: TAG_IMG[tags], w: tags === 2 ? '36px' : '22px', h: '28px', x: '100%', y: '0%', ox: '6px', oy: '-6px' });
  if (note.name) marks.push({ img: nameImg(note.name), w: 'auto', h: '22px', x: '0%', y: '100%', ox: '-4px', oy: '8px' });
  if (!marks.length) return { 'background-image': 'none' };
  return {
    'background-image': marks.map(m => m.img),
    'background-width': marks.map(m => m.w),
    'background-height': marks.map(m => m.h),
    'background-position-x': marks.map(m => m.x),
    'background-position-y': marks.map(m => m.y),
    'background-offset-x': marks.map(m => m.ox),
    'background-offset-y': marks.map(m => m.oy),
    'background-image-containment': marks.map(() => 'over'),
    'background-clip': marks.map(() => 'none'),
    'bounds-expansion': '26px',
  };
}

function nodeColors(a) {
  if (a.removed) return { bg: a.sex === 'K' ? '#e0e0e0' : '#f0e0e0', border: '#999' };
  let c;
  if (a.sex === 'K') c = a.age_months >= 14 ? { bg: '#87CEFA', border: '#4682B4' } : { bg: '#F0F8FF', border: '#a0c4e8' };
  else c = a.age_months >= 6 ? { bg: '#FFB6C1', border: '#DB7093' } : { bg: '#FFE4E1', border: '#e8b0b0' };
  if (a.conventional) c.border = '#c0392b';
  return c;
}

async function render() {
  const today = formatDate(new Date());
  $('welcome').style.display = herd.snapshots.length ? 'none' : '';
  if (cy) { cy.destroy(); cy = null; }
  if (!herd.snapshots.length) {
    data = null;
    $('title').textContent = 'Koträd';
    $('stats').innerHTML = '';
    showEmptyPanel();
    return;
  }

  data = analyzeHerd(herd.snapshots, herd.config, today);
  const pos = await layout(data);
  const maxY = Math.max(...data.animals.map(a => pos[a.id]?.y ?? 0));
  const s = data.summary;
  $('title').textContent = `Koträd ${data.date}`;
  $('stats').innerHTML = [`Tjurar: ${s.tjurar}`, `Kor: ${s.kor}`, `Kvigor: ${s.kvigor}`, `Betäckta: ${s.betackta}`, `Totalt: ${s.totalt}`]
    .map(t => `<span class="stat">${t}</span>`).join('');

  const elements = data.animals.map(a => {
    const c = nodeColors(a);
    return {
      group: 'nodes',
      data: {
        id: a.id,
        label: `${a.short_id}  ${a.age_str}\n${a.birth}`,
        bg: c.bg,
        border: c.border,
        borderWidth: a.conventional ? 4 : 1.5,
        borderStyle: a.removed ? 'dashed' : 'solid',
        textOpacity: a.removed ? 0.5 : 1,
      },
      position: { x: pos[a.id]?.x ?? 0, y: maxY - (pos[a.id]?.y ?? 0) },
      style: markerStyle(a, herd.notes[a.id] || {}),
    };
  });
  for (const e of data.edges) elements.push({ group: 'edges', data: { source: e.from, target: e.to } });

  cy = cytoscape({
    container: $('graph'),
    elements,
    style: [
      {
        selector: 'node',
        style: {
          'label': 'data(label)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center',
          'font-family': '"SF Mono", "Cascadia Code", "Fira Code", monospace', 'font-size': '24px', 'font-weight': 'bold',
          'background-color': 'data(bg)', 'border-color': 'data(border)', 'border-width': 'data(borderWidth)',
          'border-style': 'data(borderStyle)', 'text-opacity': 'data(textOpacity)', 'shape': 'round-rectangle',
          'width': 'label', 'height': 'label', 'padding': '6px', 'color': '#222',
        },
      },
      { selector: 'node:selected', style: { 'border-color': '#DAA520', 'border-width': 3, 'background-color': '#FFD700', 'z-index': 10 } },
      { selector: 'node:active', style: { 'overlay-opacity': 0.08 } },
      {
        selector: 'edge',
        style: {
          'width': 2, 'line-color': '#666', 'target-arrow-color': '#666', 'target-arrow-shape': 'triangle',
          'target-arrow-fill': 'filled', 'arrow-scale': 1.5, 'curve-style': 'straight',
        },
      },
    ],
    layout: { name: 'preset', fit: true, padding: 30 },
    wheelSensitivity: 0.8,
    minZoom: 0.15,
    maxZoom: 3,
  });
  cy.on('tap', 'node', evt => showAnimal(evt.target.id()));
  cy.on('tap', evt => { if (evt.target === cy) showEmptyPanel(); });
  window.kotradCy = cy; // for debugging in the console

  if (selectedId && data.animals.some(a => a.id === selectedId)) {
    cy.getElementById(selectedId).select();
    showAnimal(selectedId);
  } else {
    showEmptyPanel();
  }
  fetchNamedays([...new Set(data.animals.map(a => a.birth))]);
}

// --- Side panel ---

function showEmptyPanel() {
  selectedId = null;
  $('panel').className = 'empty';
  $('panel').innerHTML = '<span>Klicka på ett djur för mer info</span>';
}

function selectAnimal(id) {
  cy.$(':selected').unselect();
  const node = cy.getElementById(id);
  if (node.length) {
    node.select();
    cy.animate({ center: { eles: node }, zoom: 1.5 }, { duration: 400 });
  }
  showAnimal(id);
}

function animalList(title, list) {
  if (!list.length) return '';
  return `
    <div class="field">
      <div class="field-label">${title} (${list.length})</div>
      <ul class="calves-list">
        ${list.map(c => `<li data-id="${c.id}">${c.short_id} - ${c.birth} (${c.sex})${c.removed ? ' [borta]' : ''}</li>`).join('')}
      </ul>
    </div>`;
}

function field(label, value) {
  return `<div class="field"><div class="field-label">${label}</div><div class="field-value">${value}</div></div>`;
}

// When she was at the pasture with a bull, and when a calf can be expected.
function servingText(s) {
  const from = s.fromKnown ? s.from : `${s.from} eller tidigare`;
  const period = s.until ? `${from} – ${s.until}` : `sedan ${from}`;
  const earlier = s.earlier ? `<br>Var också med tjur från ${s.earlier} utan att kalva efter det.` : '';
  return `Med tjur på bete ${period}.${earlier}<br><span style="color:#4d6b3c;">Kalvning tidigast ca ${s.calving}.</span>`;
}

function showAnimal(id) {
  const animals = data.animals;
  const byId = Object.fromEntries(animals.map(a => [a.id, a]));
  const a = byId[id];
  if (!a) return;
  selectedId = id;

  const calves = animals.filter(c => c.mother === id).sort((x, y) => x.birth.localeCompare(y.birth));
  const siblings = a.mother ? animals.filter(c => c.mother === a.mother && c.id !== id) : [];
  const note = herd.notes[id] || {};
  const names = herd.namedays[a.birth] || [];

  let tags = a.sex === 'T' ? '<span class="tag tag-bull">Tjur</span>'
    : calves.length ? '<span class="tag tag-cow">Ko</span>' : '<span class="tag tag-heifer">Kviga</span>';
  if (a.served) tags += '<span class="tag tag-covered">Betäckt</span>';
  if (a.failed) tags += '<span class="tag tag-failed">Ej kalvat</span>';
  if (a.conventional) tags += '<span class="tag tag-conventional">Konventionell</span>';
  if (a.removed) tags += '<span class="tag tag-removed">Borta</span>';
  if (note.slaughter) tags += '<span class="tag tag-slaughter">Slakt</span>';
  if (note.sell) tags += '<span class="tag tag-sell">Sälj</span>';
  if (note.tags_missing) tags += `<span class="tag tag-eartag">Saknar ${note.tags_missing === 2 ? 'båda öronmärkena' : 'ett öronmärke'}</span>`;

  const panel = $('panel');
  panel.className = '';
  panel.innerHTML = `
    <button id="panel-close" title="Stäng">&times;</button>
    <h2>${a.id.replace(/^SE/, 'SE ')}</h2>
    <div style="margin-bottom:12px">${tags}</div>
    ${field('Kort ID', a.short_id)}
    ${field('Födelsedatum', a.birth + (names.length ? ` <span style="color:#4d6b3c; font-style:italic;">(${esc(names.join(', '))})</span>` : ''))}
    ${field('Ålder', `${a.age_str} (${a.age_months} månader)`)}
    ${field('Kön', a.sex === 'K' ? 'Kviga/Ko' : 'Tjur')}
    ${field('Ras', a.breed)}
    ${field('Mor', a.mother
      ? `<span class="mother-link" data-id="${a.mother}">${byId[a.mother] ? byId[a.mother].short_id : a.mother}</span>`
      : '<em>Okänd / ej i databas</em>')}
    ${a.serving ? field('Betäckt', servingText(a.serving)) : ''}
    ${a.missed_calvings.length ? field('Ej kalvat', a.missed_calvings.map(m => `Med tjur ${m.from} – ${m.until}, ingen kalv till ${m.due}.`).join('<br>')) : ''}
    ${a.organic_from ? field('Ekologisk', `Konventionell, blir ekologisk ${a.organic_from}.`) : ''}
    ${a.purchase_date ? field('Köpdatum', a.purchase_date + (a.purchase_from ? ` (från ${a.purchase_from})` : '')) : ''}
    ${animalList('Kalvar', calves)}
    ${animalList('Syskon', siblings)}
    <div class="notes-section">
      <h3>Anteckningar</h3>
      <div class="note-field">
        <label for="note-name">Namn</label>
        <input type="text" id="note-name" value="${esc(note.name)}" placeholder="T.ex. Blenda">
      </div>
      <div class="note-field">
        <div class="checkbox-row">
          <input type="checkbox" id="note-slaughter" ${note.slaughter ? 'checked' : ''}>
          <label for="note-slaughter">Skall slaktas</label>
        </div>
      </div>
      <div class="note-field">
        <div class="checkbox-row">
          <input type="checkbox" id="note-sell" ${note.sell ? 'checked' : ''}>
          <label for="note-sell">Skall säljas</label>
        </div>
      </div>
      <div class="note-field">
        <label for="note-color">Färg</label>
        <select id="note-color">
          ${Object.entries(COLORS).map(([key, c]) => `<option value="${key}" ${(note.color || DEFAULT_COLOR) === key ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select>
      </div>
      <div class="note-field">
        <label for="note-tags">Öronmärken</label>
        <select id="note-tags">
          <option value="0">Båda sitter i</option>
          <option value="1" ${note.tags_missing === 1 ? 'selected' : ''}>Ett saknas</option>
          <option value="2" ${note.tags_missing === 2 ? 'selected' : ''}>Båda saknas</option>
        </select>
      </div>
      <div class="note-field">
        <label for="note-comment">Kommentar</label>
        <textarea id="note-comment" placeholder="Fritext...">${esc(note.comment)}</textarea>
      </div>
    </div>
  `;

  function saveNote() {
    const n = {
      name: $('note-name').value.trim(),
      slaughter: $('note-slaughter').checked,
      sell: $('note-sell').checked,
      comment: $('note-comment').value.trim(),
    };
    if ($('note-color').value !== DEFAULT_COLOR) n.color = $('note-color').value;
    const tagsMissing = Number($('note-tags').value);
    if (tagsMissing) n.tags_missing = tagsMissing;
    if (!n.name && !n.slaughter && !n.sell && !n.comment && !n.tags_missing && !n.color) delete herd.notes[id];
    else herd.notes[id] = n;
    cy.getElementById(id).style(markerStyle(a, n));
    changed();
  }
  $('note-name').addEventListener('input', saveNote);
  $('note-comment').addEventListener('input', saveNote);
  $('note-slaughter').addEventListener('change', saveNote);
  $('note-sell').addEventListener('change', saveNote);
  $('note-color').addEventListener('change', saveNote);
  $('note-tags').addEventListener('change', () => { saveNote(); showAnimal(id); });
  $('panel-close').addEventListener('click', () => {
    cy.$(':selected').unselect();
    showEmptyPanel();
  });
  panel.querySelectorAll('[data-id]').forEach(el => el.addEventListener('click', () => selectAnimal(el.dataset.id)));
}

// --- Settings ---

function fillSnapshotList() {
  const list = $('snapshot-list');
  list.innerHTML = herd.snapshots.length
    ? herd.snapshots.map(s => `<li><span>${s.date} · ${s.animals.length} djur</span><button type="button" data-date="${s.date}">Ta bort</button></li>`).join('')
    : '<li><em>Inga utdrag inlästa</em></li>';
  list.querySelectorAll('[data-date]').forEach(b => b.addEventListener('click', () => {
    herd.snapshots = herd.snapshots.filter(s => s.date !== b.dataset.date);
    changed();
    fillSnapshotList();
    render();
  }));
}

$('settings-button').addEventListener('click', () => {
  $('cfg-pasture').value = herd.config.summer_pasture || '';
  $('cfg-eco').value = herd.config.eco_date || '';
  $('storage-hint').textContent = `Allt sparas automatiskt i ${store.name}.`;
  fillSnapshotList();
  $('settings').showModal();
});

$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  herd.config = {
    summer_pasture: $('cfg-pasture').value.trim() || undefined,
    eco_date: $('cfg-eco').value || undefined,
  };
  changed();
  render();
});

function download(name, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

$('notes-export').addEventListener('click', () => download('notes.json', herd.notes));

$('export-all').addEventListener('click', () => {
  download(`kotradet-${formatDate(new Date())}.json`, herd);
});

$('import-all').addEventListener('click', () => $('all-input').click());
$('all-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const doc = JSON.parse(await file.text());
    if (!Array.isArray(doc.snapshots)) throw new Error('inte en export från Koträdet');
    if (!confirm(`Ersätta allt med innehållet i ${file.name} (${doc.snapshots.length} utdrag)?`)) return;
    herd = { ...emptyHerd(), ...doc };
    changed();
    $('settings').close();
    render();
  } catch (err) {
    alert('Kunde inte läsa filen: ' + err.message);
  }
});

$('notes-import').addEventListener('click', () => $('notes-input').click());
$('notes-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const notes = JSON.parse(await file.text());
    const count = Object.keys(notes).length;
    if (!confirm(`Importera anteckningar för ${count} djur? Befintliga anteckningar för samma djur skrivs över.`)) return;
    Object.assign(herd.notes, notes);
    changed();
    render();
  } catch (err) {
    alert('Kunde inte läsa filen: ' + err.message);
  }
});

$('clear-all').addEventListener('click', () => {
  if (!confirm('Ta bort alla inlästa utdrag, anteckningar och inställningar?')) return;
  herd = emptyHerd();
  changed();
  $('settings').close();
  render();
});

// --- Login (only when a Supabase project is configured) ---

function showLogin(message) {
  $('login').hidden = false;
  document.body.classList.add('logged-out');
  $('welcome').style.display = 'none';
  $('login-message').textContent = message || '';
}

async function useStore(next) {
  store = next;
  try {
    herd = await store.load();
  } catch (e) {
    herd = emptyHerd();
    showStatus('Kunde inte hämta data: ' + e.message, '#c0392b');
  }
  $('login').hidden = true;
  document.body.classList.remove('logged-out');
  render();
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('login-email').value.trim();
  if (!email) return;
  $('login-send').disabled = true;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true },
  });
  $('login-send').disabled = false;
  $('login-message').textContent = error
    ? 'Det gick inte att skicka länken: ' + error.message
    : `Klart! Öppna länken i mejlet till ${email} i den här webbläsaren.`;
});

$('logout').addEventListener('click', async () => {
  await supabase.auth.signOut();
});

async function start() {
  if (!SUPABASE_KEY) {
    await useStore(browserStore);
    return;
  }
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/+esm');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  let currentUser = null;
  supabase.auth.onAuthStateChange((event, session) => {
    const user = session?.user ?? null;
    if (user?.id === currentUser?.id) return;
    currentUser = user;
    $('account').hidden = !user;
    $('account-email').textContent = user?.email ?? '';
    if (user) {
      // Defer: Supabase calls must not run inside this callback.
      setTimeout(() => useStore(supabaseStore(supabase, user)), 0);
    } else {
      store = browserStore;
      herd = emptyHerd();
      render();
      showLogin();
    }
  });
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) showLogin();
}

start();
