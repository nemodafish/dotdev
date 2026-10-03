// DOTDEV · kundeportalen (dotdev.no/kunde): innlogging og statistikk.
//
// Netlify kjører filen som en serverfunksjon på /api/kunde/*. Siden kunde.html
// snakker bare med denne funksjonen, aldri direkte med Plausible.
//
//   POST /api/kunde/logginn   { epost, passord } → setter innloggingscookien
//   POST /api/kunde/loggut                       → sletter den
//   GET  /api/kunde/meg                          → hvem som er logget inn
//   GET  /api/kunde/tall?periode=30d             → tallene (idag | 7d | 30d | 12m)
//
// SIKKERHET
//   • Plausible-nøkkelen og passordene ligger bare i miljøvariabler på Netlify,
//     aldri i nettleseren og aldri i GitHub (repoet er offentlig).
//   • Hvilket nettsted som spørres, bestemmes her ut fra innloggingen. Nettleseren
//     sender bare perioden, så en kunde kan aldri se en annen kundes tall.
//   • Passordene lagres som scrypt-hasher. Innloggingen er en signert cookie
//     (HttpOnly, Secure, SameSite=Strict) som varer i OKT_DAGER dager. Den sendes
//     bare til /api/kunde, og den inneholder verken e-post eller navn.
//   • Netlify stopper en IP som sender mer enn 30 forespørsler i minuttet (config nederst).
//
// MILJØVARIABLER (Netlify → Project configuration → Environment variables, bare for
// Production-konteksten, se LES-MEG.md)
//   PLAUSIBLE_API_KEY  Stats API-nøkkel fra Plausible (Account settings → API Keys)
//   PORTAL_NOKKEL      Hemmelig nøkkel som signerer innloggingen. Lag den med
//                      «node lag-kunde.mjs --nokkel». Bytt den for å logge ut alle.
//   KUNDE_…            Én per innlogging. Lag den med «node lag-kunde.mjs …».
//                      Slett variabelen for å stenge tilgangen.
// Endringer i variablene virker først etter ny publisering
// (Deploys → Trigger deploy → Deploy project).

import { createHash, createHmac, scrypt, timingSafeEqual } from 'node:crypto';

const OKT_DAGER = 14;                     // så lenge kunden er innlogget på en enhet
const COOKIE = '__Secure-dd_kunde';
const COOKIE_STI = '/api/kunde';           // cookien sendes bare hit, ikke til resten av nettsiden
const TIDSSONE = 'Europe/Oslo';           // «i dag» og datoene regnes i norsk tid
const LAGER_MS = 5 * 60 * 1000;           // tallene mellomlagres i 5 minutter
const MAKS_FORSOK = 8;                    // feilede innlogginger per IP …
const SPERRE_MS = 15 * 60 * 1000;         // … per kvarter
const PLAUSIBLE = 'https://plausible.io/api/v2/query';

// Periodene kunden kan velge. Alt annet avvises.
const PERIODER = {
    idag: { dager: 1, inndeling: 'time:hour', sammenlign: false },
    '7d': { dager: 7, inndeling: 'time:day' },
    '30d': { dager: 30, inndeling: 'time:day' },
    '12m': { maneder: 12, inndeling: 'time:month' },
};
const NOKKELTALL = ['visitors', 'visits', 'pageviews', 'bounce_rate', 'visit_duration'];

// Brukes når e-posten ikke finnes, så svaret tar like lang tid som et feil passord.
const DUMMY = 'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// ── Svar ────────────────────────────────────────────────────────────────────
// Netlify legger ikke headerne fra _headers på svar fra funksjoner, så de settes her.

function svar(status, data, ekstra = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-Robots-Tag': 'noindex',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            ...ekstra,
        },
    });
}

const feil = (status, melding, ekstra) => svar(status, { feil: melding }, ekstra);

// ── Kunder ──────────────────────────────────────────────────────────────────
// Hver KUNDE_…-variabel er JSON: {"epost":"…","nettsted":"…","navn":"…","passord":"scrypt$…"}

function kunder() {
    const liste = [];
    for (const [navn, verdi] of Object.entries(process.env)) {
        if (!navn.startsWith('KUNDE_') || !verdi) continue;
        try {
            const k = JSON.parse(verdi);
            if (typeof k.epost !== 'string' || typeof k.nettsted !== 'string' || typeof k.passord !== 'string' || !k.passord.startsWith('scrypt$')) throw new Error();
            liste.push({
                epost: k.epost.trim().toLowerCase(),
                nettsted: k.nettsted.trim(),
                navn: typeof k.navn === 'string' && k.navn.trim() ? k.navn.trim() : k.nettsted.trim(),
                passord: k.passord,
            });
        } catch {
            console.warn(`Miljøvariabelen ${navn} er ikke gyldig JSON fra lag-kunde.mjs og blir hoppet over.`);
        }
    }
    return liste;
}

// ── Passord (scrypt) ────────────────────────────────────────────────────────
// Format: scrypt$N$r$p$salt$hash (salt og hash i base64url). Samme som lag-kunde.mjs.

function scryptAsync(passord, salt, lengde, valg) {
    return new Promise((ok, avvis) => scrypt(passord, salt, lengde, valg, (e, nokkel) => (e ? avvis(e) : ok(nokkel))));
}

async function riktigPassord(passord, lagret) {
    const [type, N, r, p, salt, hash] = lagret.split('$');
    const n = Number(N), rr = Number(r), pp = Number(p);
    const fasit = Buffer.from(hash || '', 'base64url');
    // Grenser, så en feilskrevet variabel ikke kan bruke opp minnet
    if (type !== 'scrypt' || !(n >= 16384 && n <= 262144) || !(rr >= 1 && rr <= 16) || !(pp >= 1 && pp <= 4) || fasit.length < 16) return false;
    try {
        const beregnet = await scryptAsync(passord.normalize('NFKC'), Buffer.from(salt || '', 'base64url'), fasit.length,
            { N: n, r: rr, p: pp, maxmem: 512 * 1024 * 1024 });
        return timingSafeEqual(beregnet, fasit);
    } catch {
        return false;
    }
}

// ── Innloggingscookie ───────────────────────────────────────────────────────
// Innhold: et fingeravtrykk av kundens passord-hash (f) og utløpstid (e), signert med
// PORTAL_NOKKEL. Fingeravtrykket er unikt per kunde (hver hash har tilfeldig salt) og sier
// ingenting om hvem kunden er. Nytt passord eller slettet kunde → gamle innlogginger slutter å virke.

const fingeravtrykk = (k) => createHash('sha256').update(k.passord).digest('base64url').slice(0, 16);
const signatur = (data, nokkel) => createHmac('sha256', nokkel).update('dd-kunde-v1.' + data).digest();

function lagCookie(k, nokkel) {
    const data = Buffer.from(JSON.stringify({ f: fingeravtrykk(k), e: Math.floor(Date.now() / 1000) + OKT_DAGER * 86400 })).toString('base64url');
    const verdi = data + '.' + signatur(data, nokkel).toString('base64url');
    return `${COOKIE}=${verdi}; Path=${COOKIE_STI}; Max-Age=${OKT_DAGER * 86400}; HttpOnly; Secure; SameSite=Strict`;
}

const slettCookie = () => `${COOKIE}=; Path=${COOKIE_STI}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

function lesCookie(req) {
    for (const del of (req.headers.get('cookie') || '').split(';')) {
        const i = del.indexOf('=');
        if (i > 0 && del.slice(0, i).trim() === COOKIE) return del.slice(i + 1).trim();
    }
    return '';
}

function innloggetKunde(req, nokkel) {
    const [data, sig, ...rest] = lesCookie(req).split('.');
    if (!data || !sig || rest.length) return null;
    const faktisk = Buffer.from(sig, 'base64url');
    const forventet = signatur(data, nokkel);
    if (faktisk.length !== forventet.length || !timingSafeEqual(faktisk, forventet)) return null;
    let innhold;
    try { innhold = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
    if (!innhold || typeof innhold.e !== 'number' || typeof innhold.f !== 'string' || innhold.e * 1000 < Date.now()) return null;
    return kunder().find((x) => fingeravtrykk(x) === innhold.f) || null;
}

// ── Forsøk per IP ───────────────────────────────────────────────────────────
// Holdes i minnet til den ene serverinstansen, så det er en brems, ikke en mur.
// Passordene fra lag-kunde.mjs er lange og tilfeldige, og det er de som er muren.

const forsok = new Map();

function sperret(ip) {
    const f = forsok.get(ip);
    return Boolean(f && f.til > Date.now() && f.antall >= MAKS_FORSOK);
}

function feiletForsok(ip) {
    const naa = Date.now();
    const f = forsok.get(ip);
    if (!f || f.til <= naa) forsok.set(ip, { antall: 1, til: naa + SPERRE_MS });
    else f.antall++;
    if (forsok.size > 5000) forsok.clear();
}

// Avviser forespørsler fra andre nettsteder (CSRF). SameSite=Strict er første lås, dette er den andre.
function fraOssSelv(req) {
    const site = req.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin') return false;
    const origin = req.headers.get('origin');
    if (!origin) return true;
    try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

// ── Datoer ──────────────────────────────────────────────────────────────────

const iso = (d) => d.toISOString().slice(0, 10);

function idag() {
    // en-CA gir ÅÅÅÅ-MM-DD
    const dato = new Intl.DateTimeFormat('en-CA', { timeZone: TIDSSONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return new Date(dato + 'T00:00:00Z');
}

function naaTime() {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: TIDSSONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const del = (t) => d.find((x) => x.type === t).value;
    return `${del('year')}-${del('month')}-${del('day')} ${del('hour')}`;
}

function plussDager(d, n) {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() + n);
    return x;
}

function plussManeder(d, n) {
    // 31. mars minus én måned blir 28./29. februar, ikke 3. mars
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    const sisteDag = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
    x.setUTCDate(Math.min(d.getUTCDate(), sisteDag));
    return x;
}

// «I dag» er dagen så langt. 7 og 30 dager er hele dager som slutter i går (som «Last 7 days»
// i Plausible), så de sammenlignes med like mange hele dager før. 12 måneder går til i dag.
function datoer(p) {
    if (p.maneder) {
        const til = idag();
        const fra = new Date(Date.UTC(til.getUTCFullYear(), til.getUTCMonth() - (p.maneder - 1), 1));
        return { fra, til, forrigeFra: plussManeder(fra, -12), forrigeTil: plussManeder(til, -12) };
    }
    const til = p.dager === 1 ? idag() : plussDager(idag(), -1);
    const fra = plussDager(til, -(p.dager - 1));
    return { fra, til, forrigeFra: plussDager(fra, -p.dager), forrigeTil: plussDager(til, -p.dager) };
}

// ── Plausible ───────────────────────────────────────────────────────────────

async function sporPlausible(apiNokkel, sporring) {
    const res = await fetch(PLAUSIBLE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiNokkel}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(sporring),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
        const tekst = (await res.text().catch(() => '')).slice(0, 300);
        const e = new Error(`Plausible svarte ${res.status}: ${tekst}`);
        e.status = res.status;
        throw e;
    }
    return res.json();
}

const rader = (svar) => (svar && Array.isArray(svar.results) ? svar.results : []);
const tall = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function nokkeltall(svar) {
    const m = rader(svar)[0]?.metrics || [];
    return Object.fromEntries(NOKKELTALL.map((navn, i) => [navn, tall(m[i])]));
}

// Tidsetikettene kommer som «2026-10-04», «2026-10-04 13:00:00» eller «2026-10-01».
// Nøkkelen kuttes til dag, time eller måned, så tomme perioder blir 0 i stedet for å mangle.
// Timene i «I dag» lages her (00–23): dagene da klokka stilles, har 23 eller 25 timer, og da
// legges de to 02-timene sammen i stedet for at en time forsvinner eller en ekstra dukker opp.
function graf(svar, inndeling, dato) {
    const lengde = inndeling === 'time:hour' ? 13 : inndeling === 'time:month' ? 7 : 10;
    const verdier = new Map();
    for (const r of rader(svar)) {
        const t = String(r.dimensions[0]).slice(0, lengde);
        const forrige = verdier.get(t);
        verdier.set(t, forrige ? [tall(forrige[0]) + tall(r.metrics[0]), tall(forrige[1]) + tall(r.metrics[1])] : r.metrics);
    }
    const etiketter = lengde === 13
        ? Array.from({ length: 24 }, (_, h) => dato + ' ' + String(h).padStart(2, '0'))
        : Array.isArray(svar?.meta?.time_labels) ? svar.meta.time_labels.map((t) => String(t).slice(0, lengde)) : [...verdier.keys()];
    const naa = naaTime();
    return etiketter.map((t) => {
        const m = verdier.get(t) || [];
        const punkt = { t, besokende: tall(m[0]), visninger: tall(m[1]) };
        if (lengde === 13 && t > naa) punkt.senere = true;     // timer som ikke har vært ennå i dag
        return punkt;
    });
}

const liste = (svar, felt) => rader(svar).map((r) => Object.fromEntries([['navn', String(r.dimensions[0] ?? '')], ...felt.map((f, i) => [f, tall(r.metrics[i])])]));

async function hentTall(apiNokkel, nettsted, periodeNavn) {
    const p = PERIODER[periodeNavn];
    const d = datoer(p);
    const periode = [iso(d.fra), iso(d.til)];
    const q = (sporring) => sporPlausible(apiNokkel, { site_id: nettsted, date_range: periode, ...sporring });

    const [naa, forrige, tid, kilder, sider, land, enheter, mal] = await Promise.all([
        q({ metrics: NOKKELTALL }),
        p.sammenlign === false ? null : q({ metrics: NOKKELTALL, date_range: [iso(d.forrigeFra), iso(d.forrigeTil)] }),
        q({ metrics: ['visitors', 'pageviews'], dimensions: [p.inndeling], include: { time_labels: true } }),
        q({ metrics: ['visitors'], dimensions: ['visit:source'], pagination: { limit: 6 } }),
        q({ metrics: ['visitors', 'pageviews'], dimensions: ['event:page'], order_by: [['visitors', 'desc']], pagination: { limit: 6 } }),
        q({ metrics: ['visitors'], dimensions: ['visit:country'], pagination: { limit: 6 } }),
        q({ metrics: ['visitors'], dimensions: ['visit:device'] }),
        q({ metrics: ['visitors', 'events'], dimensions: ['event:goal'] }),
    ]);

    return {
        nettsted,
        periode: periodeNavn,
        fra: periode[0],
        til: periode[1],
        forrigeFra: forrige ? iso(d.forrigeFra) : null,
        forrigeTil: forrige ? iso(d.forrigeTil) : null,
        oppdatert: new Date().toISOString(),
        tall: nokkeltall(naa),
        forrige: forrige ? nokkeltall(forrige) : null,
        graf: graf(tid, p.inndeling, periode[0]),
        inndeling: p.inndeling.slice(5),
        kilder: liste(kilder, ['besokende']),
        sider: liste(sider, ['besokende', 'visninger']),
        land: liste(land, ['besokende']),
        enheter: liste(enheter, ['besokende']),
        mal: liste(mal, ['besokende', 'antall']),
    };
}

// Samme tall til alle innlogginger på samme nettsted i LAGER_MS, så Plausible-grensen
// (600 spørringer i timen per nøkkel) holder godt.
const lager = new Map();

async function tallMedLager(apiNokkel, nettsted, periode) {
    const nokkel = `${nettsted}|${periode}`;
    const treff = lager.get(nokkel);
    if (treff && treff.til > Date.now()) return treff.data;
    const data = await hentTall(apiNokkel, nettsted, periode);
    lager.set(nokkel, { data, til: Date.now() + LAGER_MS });
    if (lager.size > 200) lager.delete(lager.keys().next().value);
    return data;
}

// ── Rutene ──────────────────────────────────────────────────────────────────

async function loggInn(req, ip, nokkel) {
    if (sperret(ip)) return feil(429, 'For mange forsøk. Vent et kvarter og prøv igjen.');
    if (!(req.headers.get('content-type') || '').startsWith('application/json')) return feil(415, 'Ugyldig forespørsel.');
    const tekst = await req.text();
    if (tekst.length > 2048) return feil(413, 'Ugyldig forespørsel.');
    let inn;
    try { inn = JSON.parse(tekst); } catch { return feil(400, 'Ugyldig forespørsel.'); }
    const epost = typeof inn?.epost === 'string' ? inn.epost.trim().toLowerCase() : '';
    const passord = typeof inn?.passord === 'string' ? inn.passord : '';
    if (!epost || !passord || epost.length > 254 || passord.length > 200) return feil(400, 'Skriv inn e-post og passord.');

    const k = kunder().find((x) => x.epost === epost);
    const ok = await riktigPassord(passord, k ? k.passord : DUMMY);
    if (!k || !ok) {
        feiletForsok(ip);
        return feil(401, 'Feil e-post eller passord.');
    }
    return svar(200, { navn: k.navn, nettsted: k.nettsted, epost: k.epost }, { 'Set-Cookie': lagCookie(k, nokkel) });
}

async function statistikk(req, k) {
    const periode = new URL(req.url).searchParams.get('periode') || '30d';
    if (!Object.hasOwn(PERIODER, periode)) return feil(400, 'Ukjent periode.');
    const apiNokkel = process.env.PLAUSIBLE_API_KEY;
    if (!apiNokkel) {
        console.error('PLAUSIBLE_API_KEY mangler i miljøvariablene på Netlify.');
        return feil(503, 'Statistikken er ikke koblet til ennå. Prøv igjen senere.');
    }
    try {
        return svar(200, await tallMedLager(apiNokkel, k.nettsted, periode));
    } catch (e) {
        console.error(`Statistikk for ${k.nettsted} feilet: ${e.message}`);
        if (e.status === 429) return feil(503, 'Mange spør etter tall akkurat nå. Prøv igjen om noen minutter.');
        return feil(502, 'Fikk ikke hentet tallene akkurat nå. Prøv igjen om litt.');
    }
}

export default async (req, context) => {
    const sti = new URL(req.url).pathname.replace(/\/+$/, '');
    const nokkel = process.env.PORTAL_NOKKEL || '';
    if (nokkel.length < 32) {
        console.error('PORTAL_NOKKEL mangler eller er kortere enn 32 tegn (lag den med «node lag-kunde.mjs --nokkel»).');
        return feil(503, 'Kundeportalen er ikke satt opp ennå.');
    }
    const metode = req.method;
    if (metode === 'POST' && !fraOssSelv(req)) return feil(403, 'Ugyldig forespørsel.');
    const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'ukjent';

    if (sti === '/api/kunde/logginn') {
        return metode === 'POST' ? loggInn(req, ip, nokkel) : feil(405, 'Bruk POST.', { Allow: 'POST' });
    }
    if (sti === '/api/kunde/loggut') {
        return metode === 'POST' ? svar(200, { ok: true }, { 'Set-Cookie': slettCookie() }) : feil(405, 'Bruk POST.', { Allow: 'POST' });
    }
    if (sti === '/api/kunde/meg' || sti === '/api/kunde/tall') {
        if (metode !== 'GET') return feil(405, 'Bruk GET.', { Allow: 'GET' });
        const k = innloggetKunde(req, nokkel);
        if (!k) return feil(401, 'Ikke innlogget.');
        return sti === '/api/kunde/meg' ? svar(200, { navn: k.navn, nettsted: k.nettsted, epost: k.epost }) : statistikk(req, k);
    }
    return feil(404, 'Finnes ikke.');
};

export const config = {
    path: '/api/kunde/*',
    // Netlify stopper en IP som sender over 30 forespørsler i minuttet (svarer 429). Vanlig bruk
    // er et par i minuttet. Bremser gjetting og hindrer at noen bruker opp Plausible-kvoten.
    rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
