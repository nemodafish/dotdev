// Lager kunde-kart.json (verdenskartet i kundeportalen) fra world-atlas countries-110m.json.
// Bruk: last ned countries-110m.json og LICENSE fra https://cdn.jsdelivr.net/npm/world-atlas@2/ til denne mappa
// (LICENSE lagres som LICENSE.txt), kjør `node verktoy/lag-kart.mjs`, og flytt kunde-kart.json til rotmappa.
// TopoJSON dekodes uten avhengigheter, projiseres med Equal Earth og gis ISO alpha-2-koder (som Plausible bruker).
import fs from 'node:fs';
const topo = JSON.parse(fs.readFileSync(new URL('./countries-110m.json', import.meta.url)));
const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;

// Buer: delta-kodede heltall → lengde/bredde
const buer = topo.arcs.map((bue) => { let x = 0, y = 0; return bue.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; }); });
const ring = (idx) => {
    const pts = [];
    for (const i of idx) {
        const b = i >= 0 ? buer[i] : buer[~i].slice().reverse();
        pts.push(...(pts.length ? b.slice(1) : b));
    }
    // Ringer som krysser datolinja (Russlands østspiss, Fiji) hopper fra +180 til −180 og ville gitt en strek tvers
    // over kartet. Legg alle punktene på samme side; det som stikker utenfor, skjæres bort av kartkanten.
    if (pts.some((p, j) => j && Math.abs(p[0] - pts[j - 1][0]) > 180)) {
        const ost = pts.reduce((s, p) => s + p[0], 0) / pts.length > 0;
        return pts.map(([x, y]) => [ost && x < 0 ? x + 360 : !ost && x > 0 ? x - 360 : x, y]);
    }
    return pts;
};

// Equal Earth (Šavrič, Patterson, Jenny 2018)
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
const proj = ([lon, lat]) => {
    const l = lon * Math.PI / 180, p = lat * Math.PI / 180;
    const t = Math.asin(M * Math.sin(p)), t2 = t * t, t6 = t2 * t2 * t2;
    return [l * Math.cos(t) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))), t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))];
};

// Navn i Natural Earth → ISO alpha-2. Først automatisk via Intl, så rettelser for forkortede navn.
const engelsk = new Intl.DisplayNames(['en'], { type: 'region' });
const navnTilKode = new Map();
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const k = String.fromCharCode(a, b);
    // Første (alfabetisk) kode vinner, så reserverte koder som UK og FX ikke overstyrer GB og FR
    try { const n = engelsk.of(k)?.toLowerCase(); if (n && n !== k.toLowerCase() && !navnTilKode.has(n)) navnTilKode.set(n, k); } catch {}
}
const RETT = {
    'United States of America': 'US', 'Dem. Rep. Congo': 'CD', 'Congo': 'CG', 'Central African Rep.': 'CF', 'S. Sudan': 'SS',
    'Dominican Rep.': 'DO', 'Bosnia and Herz.': 'BA', 'Czechia': 'CZ', 'eSwatini': 'SZ', 'Eq. Guinea': 'GQ', "Côte d'Ivoire": 'CI',
    'Solomon Is.': 'SB', 'Falkland Is.': 'FK', 'Fr. S. Antarctic Lands': 'TF', 'N. Cyprus': 'CY', 'Somaliland': 'SO',
    'W. Sahara': 'EH', 'Kosovo': 'XK', 'North Macedonia': 'MK', 'Macedonia': 'MK', 'Timor-Leste': 'TL', 'Myanmar': 'MM',
    'Russia': 'RU', 'Vietnam': 'VN', 'Laos': 'LA', 'Brunei': 'BN', 'Syria': 'SY', 'Iran': 'IR', 'South Korea': 'KR',
    'North Korea': 'KP', 'Korea': 'KR', 'Dem. Rep. Korea': 'KP', 'Taiwan': 'TW', 'Palestine': 'PS', 'Moldova': 'MD',
    'Tanzania': 'TZ', 'Venezuela': 'VE', 'Bolivia': 'BO', 'Puerto Rico': 'PR', 'Greenland': 'GL', 'New Caledonia': 'NC',
    'Vanuatu': 'VU', 'Fiji': 'FJ', 'The Bahamas': 'BS', 'Bahamas': 'BS', 'Gambia': 'GM', 'Guinea-Bissau': 'GW',
    'Turkey': 'TR', 'Trinidad and Tobago': 'TT', 'Türkiye': 'TR', 'Cabo Verde': 'CV', 'Antarctica': 'AQ',
};
const kodeFor = (navn) => RETT[navn] || navnTilKode.get(navn.toLowerCase()) || null;

const land = new Map(), mangler = [];
for (const g of topo.objects.countries.geometries) {
    const navn = g.properties?.name || '';
    const kode = kodeFor(navn);
    if (!kode) { mangler.push(`${g.id} ${navn}`); continue; }
    if (kode === 'AQ') continue; // Antarktis tar mye plass og har ingen besøkende
    const poly = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
    for (const p of poly) {
        // Natural Earth legger Krym under Russland (faktisk kontroll). Vi følger de internasjonalt anerkjente grensene.
        const ytre = ring(p[0]);
        const krym = kode === 'RU' && ytre.every(([x, y]) => x > 32 && x < 37 && y > 44 && y < 46.5);
        const k = krym ? 'UA' : kode;
        for (const r of p) (land.get(k) || land.set(k, []).get(k)).push(ring(r).map(proj));
    }
}

// Tilpass til viewBox med bredde 1000
// Bredden er hele kloden (±180° ved ekvator), høyden det landene faktisk dekker
const x0 = proj([-180, 0])[0], x1 = proj([180, 0])[0];
let y0 = Infinity, y1 = -Infinity;
for (const ringer of land.values()) for (const r of ringer) for (const [, y] of r) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
const B = 1000, s = B / (x1 - x0), H = Math.ceil((y1 - y0) * s);
const sti = (r) => {
    let d = '', fx = null, fy = null;
    for (const [x, y] of r) {
        const px = Math.round((x - x0) * s * 10) / 10, py = Math.round((y1 - y) * s * 10) / 10;
        if (px === fx && py === fy) continue;
        d += (d ? 'L' : 'M') + px + ' ' + py; fx = px; fy = py;
    }
    return d + 'z';
};
// ISC-lisensen krever at merknaden følger med kopier, så den ligger i selve fila
const lisens = fs.readFileSync(new URL('./LICENSE.txt', import.meta.url), 'utf8').replace(/\r/g, '').trim();
const ut = { viewBox: `0 0 ${B} ${H}`, kilde: 'Kartdata: Natural Earth (fritt, public domain), via world-atlas 2 av Mike Bostock (ISC-lisens, se lisens).', lisens, land: {} };
for (const [kode, ringer] of [...land].sort()) ut.land[kode] = ringer.map(sti).join('');
const fil = new URL('./kunde-kart.json', import.meta.url);
fs.writeFileSync(fil, JSON.stringify(ut));
console.log(`${Object.keys(ut.land).length} land, viewBox ${ut.viewBox}, ${fs.statSync(fil).size} byte`);
console.log('Uten kode:', mangler.join(' | ') || 'ingen');
const dobbel = topo.objects.countries.geometries.map((g) => kodeFor(g.properties?.name || '')).filter((k, i, a) => k && a.indexOf(k) !== i);
console.log('Slått sammen (samme kode):', [...new Set(dobbel)].join(', ') || 'ingen');
