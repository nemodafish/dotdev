// DOTDEV · kundeportalen: CSV-filer og en enkel ZIP-fil (uten komprimering) for nedlastingen.
// Laget her med Node sine egne verktøy, så serverfunksjonen ikke trenger pakker.

// ── CSV (RFC 4180) ──
// Tekst står i anførselstegn med doble anførselstegn inni. Tekst som starter med = + - @ (eller
// tab/linjeskift) får en ' foran, så Excel og lignende ikke kjører den som en formel: sidenavn,
// kilder og egenskaper kan sendes inn av hvem som helst (CSV-injeksjon).
export function csvFelt(v) {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    let s = String(v);
    if (/^[=+\-@\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
}

export const lagCsv = (rader) => rader.map((r) => r.map(csvFelt).join(',')).join('\r\n') + '\r\n';

// ── CRC-32 (samme som i ZIP og PNG, polynom 0xEDB88320) ──
const TABELL = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = TABELL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// ── ZIP med lagrede (ukomprimerte) filer: lokale hoder + filene, så katalogen til slutt ──
// filer: [{ navn, data: Buffer }]. Filnavnene merkes som UTF-8 (flagg 0x0800).
export function lagZip(filer, tid = new Date()) {
    const dosTid = (tid.getUTCHours() << 11) | (tid.getUTCMinutes() << 5) | (tid.getUTCSeconds() >> 1);
    const dosDato = ((tid.getUTCFullYear() - 1980) << 9) | ((tid.getUTCMonth() + 1) << 5) | tid.getUTCDate();
    const deler = [];
    const katalog = [];
    let plass = 0;
    for (const f of filer) {
        const navn = Buffer.from(f.navn, 'utf8');
        const crc = crc32(f.data);
        const lokal = Buffer.alloc(30);
        lokal.writeUInt32LE(0x04034b50, 0);
        lokal.writeUInt16LE(20, 4);                 // versjon som trengs: 2.0
        lokal.writeUInt16LE(0x0800, 6);             // UTF-8-navn
        lokal.writeUInt16LE(0, 8);                  // metode 0 = lagret
        lokal.writeUInt16LE(dosTid, 10);
        lokal.writeUInt16LE(dosDato, 12);
        lokal.writeUInt32LE(crc, 14);
        lokal.writeUInt32LE(f.data.length, 18);
        lokal.writeUInt32LE(f.data.length, 22);
        lokal.writeUInt16LE(navn.length, 26);
        lokal.writeUInt16LE(0, 28);
        deler.push(lokal, navn, f.data);

        const sentral = Buffer.alloc(46);
        sentral.writeUInt32LE(0x02014b50, 0);
        sentral.writeUInt16LE(20, 4);               // laget av versjon 2.0
        sentral.writeUInt16LE(20, 6);
        sentral.writeUInt16LE(0x0800, 8);
        sentral.writeUInt16LE(0, 10);
        sentral.writeUInt16LE(dosTid, 12);
        sentral.writeUInt16LE(dosDato, 14);
        sentral.writeUInt32LE(crc, 16);
        sentral.writeUInt32LE(f.data.length, 20);
        sentral.writeUInt32LE(f.data.length, 24);
        sentral.writeUInt16LE(navn.length, 28);
        // ekstra felt, kommentar, disk, interne og eksterne attributter er 0
        sentral.writeUInt32LE(plass, 42);
        katalog.push(sentral, navn);
        plass += lokal.length + navn.length + f.data.length;
    }
    const katalogBuf = Buffer.concat(katalog);
    const slutt = Buffer.alloc(22);
    slutt.writeUInt32LE(0x06054b50, 0);
    slutt.writeUInt16LE(filer.length, 8);
    slutt.writeUInt16LE(filer.length, 10);
    slutt.writeUInt32LE(katalogBuf.length, 12);
    slutt.writeUInt32LE(plass, 16);
    return Buffer.concat([...deler, katalogBuf, slutt]);
}
