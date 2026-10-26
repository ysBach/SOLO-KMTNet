const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const planningRoot = path.resolve(__dirname, '..');
const htmlPath = path.join(planningRoot, 'kmtnet-scconv-standalone.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const soloSet = fs.readFileSync(path.join(planningRoot, 'solo_scripts/SOLO.set'), 'utf8');
const timingHeader = 'tile_id,altitude_window_start_ut,altitude_window_end_ut\n';

function makeApp() {
  const elements = new Map();
  function makeElement(attributes = '') {
    const classes = new Set();
    return {
      value: (attributes.match(/\bvalue="([^"]*)"/) || [])[1] || '',
      textContent: '', style: {}, disabled: /\bdisabled\b/.test(attributes), children: [],
      classList: {
        add(value) { classes.add(value); }, remove(value) { classes.delete(value); },
        toggle(value) { classes.has(value) ? classes.delete(value) : classes.add(value); },
        contains(value) { return classes.has(value); },
      },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children; },
      files: [], onchange: (attributes.match(/\bonchange="([^"]*)"/) || [])[1],
    };
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    elements.set(match[3], makeElement(match[2]));
  }
  for (const match of html.matchAll(/<textarea\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi)) {
    elements.get(match[1]).value = match[2];
  }
  const readers = [], downloads = [], copies = [];
  const context = vm.createContext({
    window: { addEventListener() {} },
    TextEncoder: require('node:util').TextEncoder,
    document: {
      createElement() { return makeElement(); },
      getElementById(id) {
        assert.ok(elements.has(id), 'Missing HTML control: ' + id);
        return elements.get(id);
      },
    },
    navigator: { clipboard: { writeText(value) { copies.push(value); } } },
    FileReader: class {
      readAsText(file) { this.file = file; readers.push(this); }
    },
  });
  vm.runInContext(script, context, { filename: htmlPath });
  context.renderSkyMap = () => {};
  context.renderCatTable = () => {};
  context.downloadText = (text, name, type) => downloads.push({ text, name, type });
  elements.get('set-text').value = soloSet;
  elements.get('cat-text').value = 'A 12:00:00.12 -30:00:00.4 # tile-A\nB 13:00:00 -31:00:00 # tile-B\n';
  elements.get('cat-name').value = 'test.cat';
  context.compileScript();
  return { context, elements, readers, downloads, copies };
}

function exposureRows(app) {
  return app.elements.get('out-text').textContent.split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => ({ text: line, columns: line.split('#')[0].trim().split(/\s+/) }));
}

function startFileRead(app, text, name = 'windows.csv') {
  const input = app.elements.get('timing-file');
  input.files = [{ name }];
  vm.runInContext('(function () { ' + input.onchange + ' }).call(document.getElementById("timing-file"))', app.context);
  const reader = app.readers.at(-1);
  reader.result = text;
  return reader;
}

const windows = timingHeader +
  'tile-A,2026-10-27T00:00:00.125,2026-10-27T03:00:00.999\n' +
  'tile-B,2026-10-27T01:00:00,2026-10-27T02:00:00\n';

test('loading a timing file fills each row while retaining catalog data and order', () => {
  const app = makeApp();
  const originalCatalog = app.elements.get('cat-text').value;
  const originalSetting = app.elements.get('set-text').value;
  const before = exposureRows(app).map(row => row.columns.slice(0, 9));
  const reader = startFileRead(app, windows);
  assert.equal(app.elements.get('download-script').disabled, true);
  reader.onload();
  const rows = exposureRows(app);
  assert.deepEqual(rows.map(row => row.columns.slice(0, 9)), before);
  assert.deepEqual(rows.map(row => row.columns.slice(9)), [
    ['2026-10-27T00:00:01', '10799'],
    ['2026-10-27T01:00:00', '3600'],
  ]);
  assert.match(rows[0].text, /window_end=2026-10-27T03:00:00 UTC/);
  assert.equal(app.elements.get('cat-text').value, originalCatalog);
  assert.equal(app.elements.get('set-text').value, originalSetting);
  assert.match(app.elements.get('timing-status').textContent, /2\/2/);
  assert.equal(app.elements.get('download-script').disabled, false);
  app.context.downloadOutput();
  app.context.copyOutput();
  assert.equal(app.downloads.length, 1);
  assert.equal(app.copies[0], app.elements.get('out-text').textContent);
});

test('clearing timing restores the original script exactly', () => {
  const app = makeApp();
  const original = app.elements.get('out-text').textContent;
  app.context.importWindowTiming(windows, 'windows.csv');
  app.context.resetWindowTiming();
  app.context.compileScript();
  assert.equal(app.elements.get('out-text').textContent, original);
  assert.equal(app.elements.get('clear-timing').disabled, true);
});

test('native timestamp columns and the global setting tolerance work without a timing CSV', () => {
  const app = makeApp();
  const lines = soloSet.trimEnd().split('\n');
  lines[11] = '4';
  lines[12] = '42';
  app.elements.get('set-text').value = lines.join('\n');
  app.elements.get('cat-text').value = 'A 12:00:00 -30:00:00 2026-10-27T01:02:03\n';
  app.context.compileScript();
  assert.deepEqual(exposureRows(app)[0].columns.slice(9), ['2026-10-27T01:02:03', '42']);
});

test('CSV parsing handles quoted commas, quotes, newlines, BOM, and CRLF', () => {
  const app = makeApp();
  const csv = '\uFEFF' + timingHeader.trimEnd() + ',notes\r\n' +
    'tile-A,2026-10-27T23:30:00Z,2026-10-28T00:30:00Z,"A, ""quoted""\nline"\r\n';
  const parsed = app.context.parseTimingCsv(csv);
  assert.equal(parsed.get('tile-A').tolerance, 3600);
  assert.equal(parsed.get('tile-A').startUtc, '2026-10-27T23:30:00');
});

test('UTC parsing is explicit and handles offsets and leap dates', () => {
  const { context } = makeApp();
  assert.equal(context.parseWindowUtc('2026-10-27T01:00:00'), Date.parse('2026-10-27T01:00:00Z'));
  assert.equal(context.parseWindowUtc('2026-10-27T10:00:00+09:00'), Date.parse('2026-10-27T01:00:00Z'));
  assert.equal(context.parseWindowUtc('2024-02-29T00:00:00Z'), Date.parse('2024-02-29T00:00:00Z'));
});

test('invalid or unrepresentable timing records fail explicitly', async t => {
  const cases = [
    ['missing column', 'tile_id,start,end\nA,x,y\n', /altitude_window_start_ut/],
    ['duplicate column', timingHeader.trimEnd() + ',tile_id\nA,x,y,A\n', /exactly one tile_id/],
    ['header only', timingHeader, /at least one field/],
    ['missing ID', timingHeader + ',2026-01-01T00:00:00,2026-01-01T01:00:00\n', /no tile_id/],
    ['wrong width', timingHeader + 'A,2026-01-01T00:00:00\n', /column count/],
    ['invalid date', timingHeader + 'A,2026-02-30T00:00:00,2026-03-02T00:00:00\n', /invalid date/],
    ['invalid time', timingHeader + 'A,2026-01-01T24:00:00,2026-01-03T00:00:00\n', /invalid date or time/],
    ['invalid offset', timingHeader + 'A,2026-01-01T00:00:00+00:60,2026-01-02T00:00:00\n', /invalid UTC offset/],
    ['missing seconds', timingHeader + 'A,2026-01-01T00:00,2026-01-02T00:00:00\n', /with seconds/],
    ['reversed window', timingHeader + 'A,2026-01-02T00:00:00,2026-01-01T00:00:00\n', /positive UTTOL/],
    ['zero width', timingHeader + 'A,2026-01-01T00:00:00,2026-01-01T00:00:00\n', /positive UTTOL/],
    ['subsecond width', timingHeader + 'A,2026-01-01T00:00:00.100,2026-01-01T00:00:00.900\n', /positive UTTOL/],
    ['unclosed quote', timingHeader + '"A,2026-01-01T00:00:00,2026-01-01T01:00:00', /unclosed quote/],
    ['trailing quoted text', timingHeader + '"A"bad,x,y\n', /after a quoted/],
    ['duplicate ID', windows + 'tile-A,2026-10-27T00:00:00,2026-10-27T01:00:00\n', /Duplicate tile_id/],
  ];
  for (const [name, csv, message] of cases) {
    await t.test(name, () => assert.throws(() => makeApp().context.parseTimingCsv(csv), message));
  }
});

test('missing or conflicting matches block download and copying without stale output', () => {
  const app = makeApp();
  app.context.importWindowTiming(timingHeader + 'tile-A,2026-10-27T00:00:00,2026-10-27T03:00:00\n', 'partial.csv');
  assert.match(app.elements.get('out-text').textContent, /No timing match for B/);
  app.context.downloadOutput();
  app.context.copyOutput();
  assert.equal(app.downloads.length, 0);
  assert.equal(app.copies.length, 0);
  assert.equal(app.elements.get('copy-script').disabled, true);
  app.elements.get('cat-text').value = 'A 12:00:00 -30:00:00 # tile-A\n';
  app.context.compileScript();
  assert.equal(app.elements.get('download-script').disabled, false);
  app.elements.get('cat-text').value = 'tile-A 12:00:00 -30:00:00 # tile-B\n';
  app.context.importWindowTiming(windows, 'windows.csv');
  assert.match(app.elements.get('out-text').textContent, /Conflicting timing matches/);
});

test('a field ID can match the catalog label directly', () => {
  const app = makeApp();
  app.elements.get('cat-text').value = 'tile-A 12:00:00 -30:00:00\n';
  app.context.importWindowTiming(windows, 'windows.csv');
  assert.equal(exposureRows(app)[0].columns[10], '10799');
});

test('a window must accommodate the complete filter sequence', () => {
  const app = makeApp();
  app.elements.get('cat-text').value = 'tile-A 12:00:00 -30:00:00\n';
  app.elements.get('set-text').value = soloSet.replace(/\n1 +# Filter sequence[^\n]*\nR 60[^\n]*/, '\n3\nB 60\nV 60\nI 60');
  app.context.importWindowTiming(timingHeader + 'tile-A,2026-10-27T00:00:00,2026-10-27T00:01:30\n', 'short.csv');
  assert.match(app.elements.get('out-text').textContent, /sequence cannot fit/);
  assert.equal(app.elements.get('download-script').disabled, true);
});

test('read errors block output and clearing restores normal conversion', () => {
  const app = makeApp();
  const original = app.elements.get('out-text').textContent;
  const reader = startFileRead(app, windows);
  reader.onerror();
  assert.match(app.elements.get('timing-status').textContent, /Cannot read timing CSV/);
  assert.equal(app.elements.get('download-script').disabled, true);
  app.context.resetWindowTiming();
  app.context.compileScript();
  assert.equal(app.elements.get('out-text').textContent, original);
});

test('a preset change discards a pending timing import', () => {
  const app = makeApp();
  const reader = startFileRead(app, windows);
  app.context.loadPreset('solo');
  const original = app.elements.get('out-text').textContent;
  reader.onload();
  assert.equal(app.elements.get('out-text').textContent, original);
  assert.equal(app.elements.get('timing-status').textContent, 'No timing CSV loaded.');
});

test('only the latest asynchronous timing file read takes effect', () => {
  const app = makeApp();
  const older = startFileRead(app, 'invalid CSV');
  const newer = startFileRead(app, windows);
  newer.onload();
  const output = app.elements.get('out-text').textContent;
  older.onload();
  assert.equal(app.elements.get('out-text').textContent, output);
  assert.equal(app.elements.get('download-script').disabled, false);
});

test('all supplied catalogs retain every field and receive their own CSV windows', () => {
  const csv = fs.readFileSync(path.join(planningRoot, 'fields_observing_order.csv'), 'utf8');
  const catalogDir = path.join(planningRoot, 'solo_scripts');
  for (const name of fs.readdirSync(catalogDir).filter(name => name.endsWith('.cat'))) {
    const app = makeApp();
    const originalCatalog = fs.readFileSync(path.join(catalogDir, name), 'utf8');
    app.elements.get('cat-text').value = originalCatalog;
    app.context.compileScript();
    const before = exposureRows(app).map(row => row.columns.slice(0, 9));
    const expected = originalCatalog.split('\n').filter(line => line.trim() && !line.startsWith('#'))
      .map(line => line.split('#')[1].trim().split(/\s+/)[0]);
    app.context.importWindowTiming(csv, 'fields_observing_order.csv');
    const windowsById = app.context.buildNightlyScripts(csv).timings;
    const after = exposureRows(app);
    assert.equal(app.elements.get('download-script').disabled, false, name);
    assert.deepEqual(after.map(row => row.columns.slice(0, 9)), before, name);
    assert.equal(after.length, expected.length, name);
    after.forEach((row, index) => {
      const timing = windowsById.get(expected[index]);
      assert.equal(row.columns[9], timing.startUtc, name);
      assert.equal(row.columns[10], String(timing.tolerance), name);
    });
    assert.equal(app.elements.get('cat-text').value, originalCatalog, name);
  }
});

const originalReference = path.resolve(planningRoot, '..', 'scconv_original');
test('ordinary conversion matches the supplied original scConv output exactly', {
  skip: !fs.existsSync(path.join(originalReference, 'scKSP3_07_12h.cat')),
}, () => {
  const app = makeApp();
  app.elements.get('set-text').value = fs.readFileSync(path.join(originalReference, 'KSP.set'), 'utf8');
  app.elements.get('cat-text').value = fs.readFileSync(path.join(originalReference, 'KSP3_07_12h.cat'), 'utf8');
  app.context.compileScript();
  assert.equal(app.elements.get('out-text').textContent,
    fs.readFileSync(path.join(originalReference, 'scKSP3_07_12h.cat'), 'utf8'));
});

const planningCsv = fs.readFileSync(path.join(planningRoot, 'fields_observing_order.csv'), 'utf8');

function csvText(rows) {
  return rows.map(row => Array.from(row, value => /[",\r\n]/.test(value)
    ? '"' + value.replace(/"/g, '""') + '"' : value).join(',')).join('\n') + '\n';
}

function startPlanningRead(app, text, name = 'fields_observing_order.csv') {
  const input = app.elements.get('planning-file');
  input.files = [{ name }];
  vm.runInContext('(function () { ' + input.onchange + ' }).call(document.getElementById("planning-file"))', app.context);
  const reader = app.readers.at(-1);
  reader.result = text;
  return reader;
}

test('one planning CSV generates all nightly scripts without loading nightly catalogs', () => {
  const app = makeApp();
  const before = ['set-text', 'cat-text', 'out-text'].map(id => app.elements.get(id).value || app.elements.get(id).textContent);
  const reader = startPlanningRead(app, planningCsv);
  assert.equal(app.elements.get('download-batch').disabled, true);
  reader.onload();
  const list = app.elements.get('batch-file-list');
  const names = fs.readdirSync(path.join(planningRoot, 'solo_scripts')).filter(name => name.endsWith('.cat')).sort();
  assert.equal(list.children.length, names.length);
  assert.match(app.elements.get('batch-status').textContent, /15 scripts\. 292 fields/);
  assert.equal(app.elements.get('download-batch').disabled, false);
  assert.equal(app.elements.get('batch-modal').classList.contains('open'), true);
  assert.equal(app.elements.get('batch-preview-name').textContent, 'sc' + names[0]);
  list.children.at(-1).children[0].onclick();
  assert.equal(app.elements.get('batch-preview-name').textContent, 'sc' + names.at(-1));
  list.children[0].children[1].onclick();
  assert.equal(app.downloads[0].name, 'sc' + names[0]);
  app.context.downloadBatchZip();
  assert.equal(app.downloads.at(-1).name, 'SOLO_observing_scripts.zip');
  assert.equal(app.downloads.at(-1).type, 'application/zip');
  assert.equal(Buffer.from(app.downloads.at(-1).text).readUInt32LE(0), 0x04034b50);
  assert.deepEqual(['set-text', 'cat-text', 'out-text'].map(id => app.elements.get(id).value || app.elements.get(id).textContent), before);
});

test('batch grouping, labels, coordinates, order, and comments match the Python-generated catalogs', () => {
  const { context } = makeApp();
  const result = context.buildNightlyScripts(planningCsv);
  const names = fs.readdirSync(path.join(planningRoot, 'solo_scripts')).filter(name => name.endsWith('.cat')).sort();
  assert.equal(JSON.stringify(Array.from(result.files, file => file.name)), JSON.stringify(names.map(name => 'sc' + name)));
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every(message => message.includes('minute-resolution plot')));
  const cfg = context.parseSet(soloSet);
  const timings = result.timings;
  let total = 0;
  for (const file of result.files) {
    const catalog = fs.readFileSync(path.join(planningRoot, 'solo_scripts', file.name.slice(2)), 'utf8');
    assert.equal(file.catalogText, catalog, file.name);
    assert.equal(file.text, context.compileCatalogRows(cfg, catalog, timings).text, file.name);
    total += file.fieldCount;
  }
  assert.equal(total, timings.size);
});

test('batch row order follows order_in_night even when CSV rows are reversed', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  const reversed = csvText([rows[0], ...Array.from(rows.slice(1)).reverse()]);
  const expected = context.buildNightlyScripts(planningCsv);
  const actual = context.buildNightlyScripts(reversed);
  assert.equal(JSON.stringify(Array.from(actual.files, file => file.text)), JSON.stringify(Array.from(expected.files, file => file.text)));
});

test('local mean midnight grouping preserves UTC dates and the noon boundary', () => {
  const { context } = makeApp();
  assert.equal(context.planningNightDate('2026-10-26T23:00:00', 'CTIO'), '2026-10-27');
  assert.equal(context.planningNightDate('2026-10-27T03:00:00', 'CTIO'), '2026-10-27');
  assert.equal(context.planningNightDate('2026-10-26T15:00:00', 'SSO'), '2026-10-26');
  assert.equal(context.planningNightDate('2026-10-27T02:03:44.639', 'SSO'), '2026-10-26');
  assert.equal(context.planningNightDate('2026-10-27T02:03:44.640', 'SSO'), '2026-10-27');
});

test('computed night dates override conflicting CSV labels with a visible warning', () => {
  const app = makeApp();
  const rows = app.context.parseCsvRows(planningCsv);
  const row = Array.from(rows[1]);
  row[rows[0].indexOf('night_ut')] = '1900-01-01';
  app.context.importPlanningCsv(csvText([rows[0], row]), 'different-night.csv');
  assert.match(app.elements.get('batch-warnings').textContent, /CSV night 1900-01-01 uses computed night 2026-10-27/);
  assert.equal(app.elements.get('batch-preview-name').textContent, 'scSOLO_CTIO_2026-10-27.cat');
});

test('invalid planning rows block the entire new batch and remove stale downloads', async t => {
  const cases = [
    ['unknown site', 'site', 'UNKNOWN', /Unknown site/],
    ['unsupported session', 'session', 'opposition', /Unsupported session/],
    ['missing order', 'order_in_night', '', /must be numeric/],
    ['invalid RA', 'ra_hms', '25:00:00', /sexagesimal/],
    ['invalid Dec', 'dec_dms', '-90:00:01', /sexagesimal/],
    ['invalid ID', 'tile_id', 'no-index', /numeric tile index/],
    ['inconsistent window', 'altitude_window_end_ut', '2026-10-27T00:26:40', /does not match/],
  ];
  for (const [name, column, value, message] of cases) {
    await t.test(name, () => {
      const app = makeApp();
      app.context.importPlanningCsv(planningCsv, 'valid.csv');
      const rows = app.context.parseCsvRows(planningCsv);
      const row = Array.from(rows[1]);
      row[rows[0].indexOf(column)] = value;
      app.context.importPlanningCsv(csvText([rows[0], row]), 'invalid.csv');
      assert.match(app.elements.get('batch-status').textContent, message);
      assert.equal(app.elements.get('download-batch').disabled, true);
      assert.equal(app.elements.get('batch-file-list').children.length, 0);
      assert.equal(app.elements.get('batch-preview').textContent, '');
      app.context.downloadBatchZip();
      assert.equal(app.downloads.length, 0);
    });
  }
});

test('duplicate short labels cannot silently combine different fields', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  const first = Array.from(rows[1]), second = Array.from(rows[1]);
  second[rows[0].indexOf('tile_id')] = 'another-field_03';
  assert.throws(() => context.buildNightlyScripts(csvText([rows[0], first, second])), /Duplicate label/);
});

test('a cancelled or superseded CSV import cannot restore older batch files', () => {
  const app = makeApp();
  const older = startPlanningRead(app, 'invalid');
  const newer = startPlanningRead(app, planningCsv);
  newer.onload();
  older.onload();
  assert.equal(app.elements.get('batch-file-list').children.length, 15);
  const cancelled = startPlanningRead(app, planningCsv);
  app.context.closeBatchModal();
  cancelled.onload();
  assert.equal(app.elements.get('batch-file-list').children.length, 0);
  assert.equal(app.elements.get('download-batch').disabled, true);
});

test('planning file read errors leave no downloadable batch', () => {
  const app = makeApp();
  const reader = startPlanningRead(app, planningCsv);
  reader.onerror();
  assert.match(app.elements.get('batch-status').textContent, /Cannot read planning CSV/);
  assert.equal(app.elements.get('download-batch').disabled, true);
});

test('ZIP output contains correct stored data, UTF-8 names, CRC, and central directory offsets', () => {
  const { context } = makeApp();
  const bytes = Buffer.from(context.createScriptZip([{ name: '검사.cat', text: '123456789' }]));
  const name = Buffer.from('검사.cat');
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.readUInt16LE(6), 0x800);
  assert.equal(bytes.readUInt16LE(8), 0);
  assert.equal(bytes.readUInt32LE(14), 0xcbf43926);
  assert.equal(bytes.readUInt32LE(18), 9);
  assert.equal(bytes.subarray(30, 30 + name.length).toString(), '검사.cat');
  assert.equal(bytes.subarray(30 + name.length, 39 + name.length).toString(), '123456789');
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 10), 1);
  const central = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt32LE(central), 0x02014b50);
  assert.equal(bytes.readUInt32LE(central + 16), 0xcbf43926);
  assert.equal(bytes.readUInt32LE(central + 42), 0);
});

test('the CSV workflow preserves the selected loop restart row for every script', () => {
  const app = makeApp();
  app.elements.get('loop-n').value = '1';
  startPlanningRead(app, planningCsv).onload();
  assert.equal(app.elements.get('batch-loop-status').textContent, 'Loop restart row: 1.');
  const files = app.context.buildNightlyScripts(planningCsv, 1).files;
  for (const file of files) assert.match(file.text, /\n\+ostart 1\n$/);
  assert.match(app.elements.get('batch-preview').textContent, /\n\+ostart 1\n$/);
});

test('all batch timing timestamps use whole seconds without changing coordinate precision', () => {
  const { context } = makeApp();
  for (const file of context.buildNightlyScripts(planningCsv).files) {
    for (const line of file.text.split('\n').filter(line => line.trim() && !line.startsWith('#'))) {
      const columns = line.split('#')[0].trim().split(/\s+/);
      assert.match(columns[9], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      assert.match(line, /window_end=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} UTC/);
    }
  }
  const app = makeApp();
  app.context.importWindowTiming(windows, 'windows.csv');
  const first = exposureRows(app)[0].columns;
  assert.equal(first[2], '12:00:00.12');
  assert.equal(first[3], '-30:00:00.4');
  assert.equal(first[10], '10799');
});

test('whole-second timing stays inside every original CSV visibility window', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  const headers = rows[0];
  const timings = context.parseTimingCsv(planningCsv);
  for (const row of rows.slice(1)) {
    const id = row[headers.indexOf('tile_id')];
    const sourceStart = context.parseWindowUtc(row[headers.indexOf('altitude_window_start_ut')]);
    const sourceEnd = context.parseWindowUtc(row[headers.indexOf('altitude_window_end_ut')]);
    const timing = timings.get(id);
    const exportedStart = Date.parse(timing.startUtc + 'Z');
    const exportedEnd = Date.parse(timing.endUtc + 'Z');
    assert.ok(exportedStart >= sourceStart, id);
    assert.ok(exportedEnd <= sourceEnd, id);
    assert.equal(exportedStart % 1000, 0);
    assert.equal(exportedEnd % 1000, 0);
    assert.equal(timing.tolerance, (exportedEnd - exportedStart) / 1000);
  }
});

test('a setting field continues past the artificial dusk/dawn split', () => {
  const { context } = makeApp();
  const file = context.buildNightlyScripts(planningCsv).files.find(file => file.name === 'scSOLO_CTIO_2026-10-27.cat');
  const line = file.text.split('\n').find(line => line.includes('tile_id=CTIO_2026-10-27_dusk_09 '));
  assert.match(line, /window_end=2026-10-27T05:51:55 UTC/);
  assert.equal(line.split('#')[0].trim().split(/\s+/)[10], '19525');
});

test('every exported field uses rise/set intersected with the full observing night', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  const source = new Map(rows.slice(1).map(values => {
    const row = Object.fromEntries(rows[0].map((name, index) => [name, values[index]]));
    return [row.tile_id, row];
  }));
  let checked = 0, extended = 0, nightLimited = 0;
  for (const file of context.buildNightlyScripts(planningCsv).files) {
    for (const line of file.text.split('\n').filter(line => line.includes('tile_id='))) {
      const id = line.match(/tile_id=(\S+)/)[1];
      const row = source.get(id);
      const timestamp = name => Date.parse(row[name] + 'Z');
      const start = Math.ceil(Math.max(timestamp('rise_time_ut'), timestamp('night_start_ut')) / 1000) * 1000;
      const end = Math.floor(Math.min(timestamp('set_time_ut'), timestamp('night_end_ut')) / 1000) * 1000;
      const columns = line.split('#')[0].trim().split(/\s+/);
      assert.equal(Date.parse(columns[9] + 'Z'), start, id);
      assert.equal(Number(columns[10]), (end - start) / 1000, id);
      assert.equal(Date.parse(line.match(/window_end=(\S+)/)[1] + 'Z'), end, id);
      if (end > Math.floor(timestamp('altitude_window_end_ut') / 1000) * 1000) extended++;
      if (timestamp('set_time_ut') > timestamp('night_end_ut')) nightLimited++;
      checked++;
    }
  }
  assert.equal(checked, source.size);
  assert.ok(extended > 0);
  assert.ok(nightLimited > 1, 'multiple fields legitimately share the night-end cutoff');
});

test('the approved plot limits cover nights with no dawn fields', () => {
  const { context } = makeApp();
  const result = context.buildNightlyScripts(planningCsv);
  for (const [site, end] of [['SAAO', '2026-10-31T02:10:00'], ['SSO', '2026-10-30T17:41:00']]) {
    const file = result.files.find(file => file.site === site && file.night === '2026-10-30');
    assert.equal(file.nightEndUtc, end);
    assert.ok(result.warnings.some(message => message.includes(site + ' 2026-10-30') && message.includes(end)));
  }
});

test('contiguous dusk and dawn sessions supply night bounds when metadata is absent', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  const siteColumn = rows[0].indexOf('site'), nightColumn = rows[0].indexOf('night_ut');
  const indices = rows[0].map((name, index) => name.startsWith('night_') && name !== 'night_ut' ? -1 : index)
    .filter(index => index >= 0);
  const selected = [rows[0], ...rows.slice(1).filter(row => row[siteColumn] === 'CTIO' && row[nightColumn] === '2026-10-27')];
  const withoutMetadata = csvText(selected.map(row => indices.map(index => row[index])));
  const result = context.buildNightlyScripts(withoutMetadata);
  const expected = context.buildNightlyScripts(planningCsv).files.find(file => file.name === result.files[0].name);
  assert.equal(result.files[0].text, expected.text);
});

test('a single-session night needs explicit full-night boundaries', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  const row = Array.from(rows[1]);
  row[rows[0].indexOf('night_start_ut')] = '';
  row[rows[0].indexOf('night_end_ut')] = '';
  assert.throws(() => context.buildNightlyScripts(csvText([rows[0], row])), /single-session night needs/);
});

test('conflicting night metadata and gaps between sessions block export', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  const source = rows.slice(1).filter(row => row[rows[0].indexOf('site')] === 'CTIO' && row[rows[0].indexOf('night_ut')] === '2026-10-27');
  const conflict = source.map(row => Array.from(row));
  conflict[0][rows[0].indexOf('night_end_ut')] = '2026-10-27T08:28:00';
  assert.throws(() => context.buildNightlyScripts(csvText([rows[0], ...conflict])), /conflicting full-night/);
  const gap = source.map(row => Array.from(row));
  for (const row of gap) {
    if (row[rows[0].indexOf('session')] === 'dawn') {
      row[rows[0].indexOf('session_start_ut')] = '2026-10-27T05:00:00';
    }
  }
  assert.throws(() => context.buildNightlyScripts(csvText([rows[0], ...gap])), /sessions contain a gap/);
});

test('missing or reversed rise/set times block export without guessing UTC dates', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  for (const [name, value, message] of [
    ['rise_time_ut', '', /rise_time_ut/],
    ['set_time_ut', rows[1][rows[0].indexOf('rise_time_ut')], /setting must follow rising/],
  ]) {
    const row = Array.from(rows[1]);
    row[rows[0].indexOf(name)] = value;
    assert.throws(() => context.buildNightlyScripts(csvText([rows[0], row])), message);
  }
});

test('night metadata must include both boundaries and contain the allocated sessions', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  for (const [name, value, message] of [
    ['night_end_ut', '', /Provide both/],
    ['night_end_ut', '2026-10-27T03:00:00', /sessions extend outside/],
  ]) {
    const row = Array.from(rows[1]);
    row[rows[0].indexOf(name)] = value;
    assert.throws(() => context.buildNightlyScripts(csvText([rows[0], row])), message);
  }
});

test('a physically consistent visibility window must fit the full exposure', () => {
  const { context } = makeApp();
  const rows = context.parseCsvRows(planningCsv);
  const row = Array.from(rows[1]);
  row[rows[0].indexOf('set_time_ut')] = '2026-10-27T00:26:40';
  row[rows[0].indexOf('altitude_window_end_ut')] = '2026-10-27T00:26:40';
  assert.throws(() => context.buildNightlyScripts(csvText([rows[0], row])), /cannot fit/);
});
