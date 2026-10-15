// Herd logic for Koträdet: turns text lines from CDB "Djurinnehav" extracts into
// the data the tree page draws. Pure functions, no DOM, so it runs in Node too.

// --- Dates (plain YYYY-MM-DD strings, compared as UTC calendar days) ---

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

export function formatDate(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function dayNumber(s) {
  const { y, m, d } = parseDate(s);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function daysBetween(from, to) {
  return dayNumber(to) - dayNumber(from);
}

export function addDays(s, days) {
  const { y, m, d } = parseDate(s);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The same day n months later, or the month's last day if it is shorter.
function addMonths(s, n) {
  const { y, m, d } = parseDate(s);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = total % 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, daysInMonth(ny, nm))).padStart(2, '0')}`;
}

// Month difference ignoring the day of month.
function calendarMonths(from, to) {
  const a = parseDate(from), b = parseDate(to);
  return (b.y - a.y) * 12 + (b.m - a.m);
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Whole months from `from` to `to`, like dateutil's relativedelta: adding the
// months to `from` (day clamped to month end) must not pass `to`.
export function wholeMonths(from, to) {
  const a = parseDate(from), b = parseDate(to);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  const total = a.y * 12 + (a.m - 1) + months;
  const y = Math.floor(total / 12), m = total % 12 + 1;
  const d = Math.min(a.d, daysInMonth(y, m));
  if (Date.UTC(y, m - 1, d) > Date.UTC(b.y, b.m - 1, b.d)) months--;
  return months;
}

export function ageString(months) {
  return months < 24 ? `${months}m` : `${Math.floor(months / 12)}y`;
}

// --- Parsing ---

// One animal row: number, id, birth, sex, breed, then optional mother,
// "Tillfälligt ute på" site (6 digits right after the mother), purchase date
// and seller's SE number.
const ROW = new RegExp(
  '^\\d+\\s(SE\\s\\d{6}\\s\\d{4}\\s\\d)\\s(\\d{4}-\\d{2}-\\d{2})\\s([KT])\\s(\\d{2})' +
  '(?:\\s(SE\\s\\d{6}\\s\\d{4}\\s\\d))?' +
  '(?:\\s(\\d{6})(?!\\d))?' +
  '(?:\\s(\\d{4}-\\d{2}-\\d{2}))?' +
  '(?:\\s(\\d{6}))?'
);

export function parseAnimalLine(line) {
  const m = ROW.exec(line);
  if (!m) return null;
  return {
    id: m[1].replace(/ /g, ''),
    birth: m[2],
    sex: m[3],
    breed: m[4],
    mother: m[5] ? m[5].replace(/ /g, '') : null,
    location: m[6] || null,
    purchase_date: m[7] || null,
    purchase_from: m[8] || null,
  };
}

// The extract's date: "Djurinnehav: YYYY-MM-DD" in the header, else the
// YYYYMMDD at the end of the file name.
export function snapshotDate(lines, filename) {
  for (const line of lines) {
    const m = /^Djurinnehav:\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (m) return m[1];
  }
  const f = /(\d{4})(\d{2})(\d{2})\.pdf$/i.exec(filename || '');
  return f ? `${f[1]}-${f[2]}-${f[3]}` : null;
}

// Builds text lines from positioned text items ({str, x, y}), the way a PDF
// text extractor would: items on the same baseline, left to right.
export function itemsToLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.y);
    const key = [...rows.keys()].find(k => Math.abs(k - y) <= 2) ?? y;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(it);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map(it => it.str.trim()).join(' '));
}

export function parseSnapshot(lines, filename) {
  return {
    date: snapshotDate(lines, filename),
    file: filename || null,
    animals: lines.map(parseAnimalLine).filter(Boolean),
  };
}

// --- Herd analysis ---

// snapshots: [{date, animals}], config: {summer_pasture, eco_date}, today: YYYY-MM-DD.
// Heifers can come into heat, and be served, from about 9 months. They are only
// meant to be served at around 14 months, so a younger heifer with a bull is the
// one to watch.
const HEIFER_FERTILE_MONTHS = 9;
// From this age she is meant to be served, so no calf afterwards counts as a miss.
const BREEDING_MONTHS = 14;

export function analyzeHerd(snapshots, config, today) {
  const snaps = snapshots.filter(s => s.date).slice().sort((a, b) => a.date.localeCompare(b.date));
  const summerPasture = config.summer_pasture || null;
  const ecoDate = config.eco_date || null;

  // Latest info per animal, keeping a purchase date seen in an earlier extract.
  const animals = new Map();
  for (const snap of snaps) {
    for (const src of snap.animals) {
      const a = { ...src };
      const prev = animals.get(a.id);
      if (prev && prev.purchase_date && !a.purchase_date) {
        a.purchase_date = prev.purchase_date;
        if (prev.purchase_from && !a.purchase_from) a.purchase_from = prev.purchase_from;
      }
      animals.set(a.id, a);
    }
  }

  // Animals missing from a later extract are gone (sold, slaughtered, dead).
  const removed = new Set();
  for (let i = 0; i < snaps.length - 1; i++) {
    const next = new Set(snaps[i + 1].animals.map(a => a.id));
    for (const a of snaps[i].animals) if (!next.has(a.id)) removed.add(a.id);
  }

  const calvesByMother = new Map();
  for (const a of animals.values()) {
    if (!a.mother) continue;
    if (!calvesByMother.has(a.mother)) calvesByMother.set(a.mother, []);
    calvesByMother.get(a.mother).push(a.birth);
  }
  const calvesOf = id => calvesByMother.get(id) || [];

  // Served: in some extract a female >= 9 months was at the summer pasture
  // together with a bull >= 6 months. She stays served until she calves.
  const served = new Set();
  const servedDates = new Map();
  // The bulls >= 6 months at the pasture, per extract date.
  const bullsAt = new Map();
  if (summerPasture) {
    for (const snap of snaps) {
      const atPasture = snap.animals.filter(a => a.location === summerPasture);
      const bulls = atPasture.filter(a => a.sex === 'T' && calendarMonths(a.birth, snap.date) >= 6);
      if (!bulls.length) continue;
      bullsAt.set(snap.date, bulls.map(a => a.id));
      for (const a of atPasture) {
        if (a.sex === 'K' && calendarMonths(a.birth, snap.date) >= HEIFER_FERTILE_MONTHS) {
          if (!servedDates.has(a.id)) servedDates.set(a.id, []);
          servedDates.get(a.id).push(snap.date);
          served.add(a.id);
        }
      }
    }
  }
  for (const id of [...served]) {
    const last = servedDates.get(id).reduce((x, y) => (y > x ? y : x));
    if (calvesOf(id).some(c => c > last)) served.delete(id);
  }
  for (const id of removed) served.delete(id);

  // Failed to calve: 10-11 months after the latest serving without a calf.
  // After 11 months the serving has expired: neither served nor failed.
  const failed = new Set();
  const expired = new Set();
  for (const [id, dates] of servedDates) {
    const latest = dates.slice().sort().reverse().find(d => !calvesOf(id).some(c => c > d));
    if (!latest) continue;
    const elapsed = calendarMonths(latest, today);
    if (elapsed >= 11) expired.add(id);
    // Only a female old enough to be meant for breeding has failed.
    else if (elapsed >= 10 && calendarMonths(animals.get(id).birth, latest) >= BREEDING_MONTHS) failed.add(id);
  }
  for (const id of expired) served.delete(id);

  // When the current serving happened, for served and failed females. Extracts are
  // taken whenever something changes, so the first extract after her latest calf with
  // her and a bull at the pasture is the day they came together, and the next extract
  // without that is the day they were parted. In the very first extract the start is
  // unknown (it may have been earlier).
  const servingPeriod = new Map();
  const snapDates = snaps.map(s => s.date);
  for (const id of new Set([...served, ...failed])) {
    const calves = calvesOf(id);
    const dates = new Set(servedDates.get(id).filter(d => !calves.some(c => c > d)));
    if (!dates.size) continue;
    // The latest unbroken run of extracts with her and a bull at the pasture.
    let end = snapDates.length - 1;
    while (!dates.has(snapDates[end])) end--;
    let start = end;
    while (start > 0 && dates.has(snapDates[start - 1])) start--;
    const from = snapDates[start];
    const earlier = [...dates].filter(d => d < from).sort();
    const bulls = new Set();
    for (let i = start; i <= end; i++) for (const bull of bullsAt.get(snapDates[i])) bulls.add(bull);
    servingPeriod.set(id, {
      from,
      // The bulls she was with, so the coming calf's possible fathers.
      bulls: [...bulls],
      fromKnown: start > 0,
      until: snapDates[end + 1] ?? null,
      // Cows carry about 283 days.
      calving: addDays(from, 283),
      // An earlier time with a bull that gave no calf, if any.
      earlier: earlier[0] ?? null,
    });
  }

  // Missed calvings: each unbroken run of extracts with her and a bull at the
  // pasture is one chance. The extract after the run is the last day she can have
  // been served; with no calf within 10 months of that, the chance was missed.
  // The run must have ended (a later extract exists).
  const lastSeen = new Map();
  for (const snap of snaps) for (const a of snap.animals) lastSeen.set(a.id, snap.date);
  const missedCalvings = new Map();
  for (const [id, list] of servedDates) {
    const dates = new Set(list);
    const calves = calvesOf(id);
    const missed = [];
    for (let i = 0; i < snapDates.length; i++) {
      if (!dates.has(snapDates[i]) || dates.has(snapDates[i - 1])) continue;
      let end = i;
      while (dates.has(snapDates[end + 1])) end++;
      const until = snapDates[end + 1];
      if (!until) break;
      if (calendarMonths(animals.get(id).birth, snapDates[end]) < BREEDING_MONTHS) continue;
      const due = addMonths(until, 10);
      // Gone from the herd before the due date: we cannot know.
      if (removed.has(id) && lastSeen.get(id) < due) continue;
      if (due < today && !calves.some(c => c > snapDates[i] && c <= due)) {
        missed.push({ from: snapDates[i], until, due });
      }
    }
    if (missed.length) missedCalvings.set(id, missed);
  }

  // Fathers: a calf is conceived about 283 days before birth. The bulls at the
  // pasture during the mother's run of extracts with a bull that covers that day
  // (give or take 15 days) are the possible fathers, if they were on the farm by
  // then (bought before it). A run that starts in the very first extract may have
  // started earlier, but not before the start of that summer's grazing.
  const runsOf = id => {
    const dates = new Set(servedDates.get(id) || []);
    const runs = [];
    for (let i = 0; i < snapDates.length; i++) {
      if (!dates.has(snapDates[i]) || dates.has(snapDates[i - 1])) continue;
      let end = i;
      while (dates.has(snapDates[end + 1])) end++;
      runs.push({ start: i, end });
    }
    return runs;
  };
  const fathers = new Map();
  for (const a of animals.values()) {
    if (!a.mother || !servedDates.has(a.mother)) continue;
    const conceived = addDays(a.birth, -283);
    const early = addDays(conceived, -15), late = addDays(conceived, 15);
    const candidates = new Set();
    for (const { start, end } of runsOf(a.mother)) {
      const from = start > 0 ? snapDates[start] : addMonths(snapDates[0], -3);
      const until = snapDates[end + 1] ?? today;
      if (from > late || until < early) continue;
      for (let i = start; i <= end; i++) {
        for (const bull of bullsAt.get(snapDates[i])) {
          const bought = animals.get(bull).purchase_date;
          if (!bought || bought <= late) candidates.add(bull);
        }
      }
    }
    if (candidates.size) fathers.set(a.id, [...candidates]);
  }

  // Organic conversion: born after the conversion date (or purchase date for
  // bought animals) is organic; older animals need max(12 months, 3/4 of their
  // age at conversion) on the farm.
  const conventional = new Set();
  // The day each conventional animal becomes organic.
  const organicFrom = new Map();
  if (ecoDate) {
    for (const a of animals.values()) {
      const conv = a.purchase_date || ecoDate;
      if (a.birth > conv) continue;
      const required = Math.max(365, daysBetween(a.birth, conv) * 3 / 4);
      if (daysBetween(conv, today) < required && !removed.has(a.id)) {
        conventional.add(a.id);
        organicFrom.set(a.id, addDays(conv, Math.ceil(required)));
      }
    }
  }

  const mothers = new Set([...animals.values()].map(a => a.mother).filter(Boolean));
  const living = [...animals.values()].filter(a => !removed.has(a.id));
  const summary = {
    tjurar: living.filter(a => a.sex === 'T').length,
    kor: living.filter(a => a.sex === 'K' && mothers.has(a.id)).length,
    kvigor: living.filter(a => a.sex === 'K' && !mothers.has(a.id)).length,
    betackta: living.filter(a => served.has(a.id)).length,
  };
  summary.totalt = summary.tjurar + summary.kor + summary.kvigor;

  const list = [...animals.values()].map(a => {
    const ageMonths = wholeMonths(a.birth, today);
    return {
      id: a.id,
      short_id: a.id.slice(-5, -1) + '-' + a.id.slice(-1),
      birth: a.birth,
      year: parseDate(a.birth).y,
      sex: a.sex,
      breed: a.breed,
      mother: a.mother,
      fathers: fathers.get(a.id) ?? [],
      age_months: ageMonths,
      age_str: ageString(ageMonths),
      removed: removed.has(a.id),
      served: served.has(a.id),
      failed: failed.has(a.id),
      conventional: conventional.has(a.id),
      serving: servingPeriod.get(a.id) ?? null,
      organic_from: organicFrom.get(a.id) ?? null,
      missed_calvings: missedCalvings.get(a.id) ?? [],
      purchase_date: a.purchase_date,
      purchase_from: a.purchase_from,
    };
  });
  const ids = new Set(animals.keys());
  const edges = list.filter(a => a.mother && ids.has(a.mother)).map(a => ({ from: a.mother, to: a.id }));

  return {
    animals: list,
    edges,
    min_year: Math.min(...list.map(a => a.year)),
    date: today,
    summary,
  };
}

// --- Layout ---

function dotString(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Graphviz source for the tree: one rank per birth year, oldest first (at the top
// for direction TB, to the left for LR), mother -> calf edges. Graphviz in the
// browser has no font metrics, so node sizes are given explicitly to fit the drawn
// label (24px monospace, two lines).
export function herdToDot(data, direction = 'TB') {
  const byYear = new Map();
  for (const a of data.animals) {
    if (!byYear.has(a.year)) byYear.set(a.year, []);
    byYear.get(a.year).push(a);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const out = ['digraph {', `  rankdir=${direction === 'LR' ? 'LR' : 'TB'}`];
  for (const year of years) {
    out.push(`  dummy_${year} [label="" shape=point width=0.01 height=0.01 style=invisible]`);
    out.push('  {', '    rank=same', `    dummy_${year}`);
    for (const a of byYear.get(year)) {
      const first = `${a.short_id} ${a.age_str}`;
      const label = a.removed
        ? `<<s>${first}<br/>${a.birth}</s>>`
        : `"${first}\\n${a.birth}"`;
      const width = (Math.max(first.length + 1, a.birth.length) * 14.4 + 16) / 96;
      out.push(`    ${dotString(a.id)} [label=${label} width=${width.toFixed(2)} height=0.75 shape=${a.served ? 'note' : 'box'}]`);
    }
    out.push('  }');
  }
  for (let i = 0; i < years.length - 1; i++) {
    out.push(`  dummy_${years[i]} -> dummy_${years[i + 1]} [style=invisible weight=100]`);
  }
  for (const e of data.edges) out.push(`  ${dotString(e.from)} -> ${dotString(e.to)}`);
  out.push('}');
  return out.join('\n');
}

// Node positions in pixels from Graphviz "plain" output.
export function plainPositions(plain) {
  const pos = {};
  for (const line of plain.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== 'node') continue;
    const id = parts[1].replace(/^"|"$/g, '');
    pos[id] = { x: parseFloat(parts[2]) * 96, y: parseFloat(parts[3]) * 96 };
  }
  return pos;
}
