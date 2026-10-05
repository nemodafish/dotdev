// DOTDEV · kundeportalen (dotdev.no/kunde): innlogging og statistikk.
//
// Netlify kjører filen som en serverfunksjon på /api/kunde/*. Siden kunde.html
// snakker bare med denne funksjonen, aldri direkte med Plausible. Resten av koden ligger i
// netlify/kunde/ (perioder, Plausible-kall, filtre, lister, nedlasting).
//
//   POST /api/kunde/logginn   { epost, passord } → setter innloggingscookien
//   POST /api/kunde/loggut                       → sletter den
//   GET  /api/kunde/meg                          → hvem som er logget inn ({ innlogget: false } uten gyldig cookie)
//   GET  /api/kunde/oppsett                      → tidssone, mål og egenskaper for nettstedet
//   GET  /api/kunde/data?<periode>&deler=…       → flere deler på én gang: topp, nå, graf:…, liste:…
//   GET  /api/kunde/detaljer?rapport=…&<periode> → én liste med 100 rader per side, søk og sortering
//   GET  /api/kunde/eksport?<periode>            → ZIP med CSV-filer (som «Export stats» i Plausible)
//
//   <periode> = periode (sanntid | dag | 24t | 7d | 28d | 30d | 91d | mnd | aar | 6mnd | 12mnd | alt | egen),
//   dato (dag/mnd/aar), fra og til (egen), sml (av | forrige | aar | egen) med sml_fra og sml_til,
//   ukedag (1 | 0), og f=<op>,<dim>,<verdier…> (filtre, høyst 10). /data tar i tillegg deler=…,
//   /detaljer rapport, sok, sorter (<kolonne|navn>:<asc|desc>) og side (0–50), /eksport intervall.
//   Alt sjekkes mot faste lister, og ukjente parametre gir 400 { feil }. Feiler Plausible, gir
//   /data { feil } bare for den delen (502/503/504 når alle deler feiler).
//
// KVOTE
//   Plausible tillater 600 kall i timen (og 60 på 10 sekunder) for hele laget, delt av alle kundene.
//   Hvert kall mellomlagres for seg i 5 minutter (sanntid og «besøkende nå» 1 minutt, oppsett 1 time),
//   og nettleseren ber bare om det som vises. En full visning uten mellomlager koster 11 kall:
//   oppsett 2, tallene øverst 2, grafen 1, fem lister 5 og besøkende nå 1. /data tar høyst 10 deler
//   og én graf. Nedlastingen koster 22 + én per egenskap (høyst 32) og kan tas én gang i minuttet
//   per nettsted. plausible.mjs gir hvert nettsted en egen del av kvoten (429 «Du har hentet mange
//   tall …» når den er brukt opp), holder laget under Plausibles grenser og tar pause etter 429.
//   Alle grensene i minnet gjelder per serverinstans.
//
// TID
//   Netlify stopper en forespørsel etter 60 sekunder. Hver forespørsel får en frist (25 s,
//   nedlasting 45 s, FRIST i plausible.mjs); kall til Plausible som ikke er ferdige da, avbrytes, og /data
//   svarer med de delene som rakk å bli ferdige (504 når ingen gjorde det).
//
// SIKKERHET
//   • Plausible-nøkkelen og passordene ligger bare i miljøvariabler på Netlify,
//     aldri i nettleseren og aldri i GitHub (repoet er offentlig).
//   • Hvilket nettsted som spørres, bestemmes her ut fra innloggingen. Nettleseren sender aldri
//     nettstedet, så en kunde kan aldri se en annen kundes tall.
//   • Passordene lagres som scrypt-hasher. Innloggingen er en signert cookie (HttpOnly, Secure,
//     SameSite=Strict) som varer i OKT_DAGER dager. Den sendes bare til /api/kunde, og den
//     inneholder verken e-post eller navn.
//   • Netlify stopper en IP som sender mer enn 90 forespørsler i minuttet (config nederst).
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
import { Ugyldig } from '../kunde/perioder.mjs';
import { PlausibleFeil, KvoteSide, Frist, FRIST, medRamme, sjekkKvote } from '../kunde/plausible.mjs';
import { lesFiltre, kontekst, MalUkjent } from '../kunde/filtre.mjs';
import {
    hentOppsett, lesPeriode, periodeJson, lesDeler, kjorDel, ryddMerknader, lesDetaljvalg, detaljer, PERIODE_PARAMETRE,
} from '../kunde/statistikk.mjs';
import { lagEksport, filnavn, eksportKall } from '../kunde/eksport.mjs';

const OKT_DAGER = 14;                     // så lenge kunden er innlogget på en enhet
const COOKIE = '__Secure-dd_kunde';
const COOKIE_STI = '/api/kunde';           // cookien sendes bare hit, ikke til resten av nettsiden
const MAKS_FORSOK = 8;                    // feilede innlogginger per IP …
const SPERRE_MS = 15 * 60 * 1000;         // … per kvarter
const EKSPORT_PAUSE_MS = 60 * 1000;       // én nedlasting per nettsted i minuttet
const MAKS_ADRESSE = 32768;               // lengste spørrestreng (10 filtre med 10 verdier får plass)

// Brukes når e-posten ikke finnes, så svaret tar like lang tid som et feil passord.
const DUMMY = 'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const MELDING_KVOTE = 'Mange spør etter tall akkurat nå. Prøv igjen om noen minutter.';
const MELDING_FEIL = 'Fikk ikke hentet tallene akkurat nå. Prøv igjen om litt.';
const MELDING_SIDE = 'Du har hentet mange tall på kort tid. Vent et par minutter og prøv igjen.';
const MELDING_TREG = 'Plausible svarer tregt akkurat nå. Prøv igjen om litt.';

// ── Svar ────────────────────────────────────────────────────────────────────
// Netlify legger ikke headerne fra _headers på svar fra funksjoner, så de settes her.

const SIKKERHET = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

function svar(status, data, ekstra = {}) {
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...SIKKERHET });
    // En liste gir flere like headere (innloggingen setter to cookies)
    for (const [navn, verdi] of Object.entries(ekstra)) {
        if (Array.isArray(verdi)) verdi.forEach((v) => headers.append(navn, v));
        else headers.set(navn, verdi);
    }
    return new Response(JSON.stringify(data), { status, headers });
}

const feil = (status, melding, ekstra) => svar(status, { feil: melding }, ekstra);

// Valideringsfeil → 400 med meldingen; nettstedets kvote brukt opp → 429 (med Retry-After);
// lagets kvote → 503; fristen gikk ut → 504; andre Plausible-feil → 502 (detaljene bare i loggen,
// aldri til nettleseren)
function feilSvar(e, hva, nettsted) {
    if (e instanceof Ugyldig) return feil(400, e.message);
    console.error(`${hva} for ${nettsted} feilet: ${e.message}`);
    if (e instanceof KvoteSide) return feil(429, MELDING_SIDE, { 'Retry-After': String(e.sekunder) });
    if (e instanceof PlausibleFeil && e.status === 429) return feil(503, MELDING_KVOTE);
    if (e instanceof Frist) return feil(504, MELDING_TREG);
    return feil(502, MELDING_FEIL);
}
function delFeil(e) {
    if (e instanceof KvoteSide) return MELDING_SIDE;
    if (e instanceof PlausibleFeil && e.status === 429) return MELDING_KVOTE;
    if (e instanceof Frist) return MELDING_TREG;
    return MELDING_FEIL;
}

// ── Kunder ──────────────────────────────────────────────────────────────────
// Hver KUNDE_…-variabel er JSON: {"epost":"…","nettsted":"…","navn":"…","passord":"scrypt$…"}

function kunder() {
    const liste = [];
    for (const [navn, verdi] of Object.entries(process.env)) {
        if (!navn.startsWith('KUNDE_') || !verdi) continue;
        try {
            // Verdien limes inn fra en terminal som kan ha brutt den lange linjen med linjeskift.
            // Ingen av feltene skal ha linjeskift, og e-post, nettsted og hash ingen mellomrom heller.
            const k = JSON.parse(verdi.replace(/[\r\n]+/g, ''));
            const uten = (s) => s.replace(/\s+/g, '');
            if (typeof k.epost !== 'string' || typeof k.nettsted !== 'string' || typeof k.passord !== 'string' || !uten(k.passord).startsWith('scrypt$')) throw new Error();
            liste.push({
                epost: uten(k.epost).toLowerCase(),
                nettsted: uten(k.nettsted),
                navn: typeof k.navn === 'string' && k.navn.trim() ? k.navn.trim() : uten(k.nettsted),
                passord: uten(k.passord),
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

// Et flagg («1») uten opplysninger om kunden, som forsiden kan lese. Da vet den at det er verdt å spørre
// /meg om hvem som er innlogget, og kan vise «Min side» i stedet for «Logg inn». Vanlige besøkende har
// ikke flagget, så forsiden spør aldri portalen for dem. Det gir ingen tilgang: alt sjekkes mot COOKIE.
const FLAGG = '__Secure-dd_innlogget';
const lagFlagg = (sekunder = OKT_DAGER * 86400) => `${FLAGG}=1; Path=/; Max-Age=${Math.max(0, Math.floor(sekunder))}; Secure; SameSite=Lax`;
const slettFlagg = () => `${FLAGG}=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
const harFlagg = (req) => (req.headers.get('cookie') || '').split(';').some((del) => del.trim().startsWith(FLAGG + '='));

function lesCookies(req) {
    const verdier = [];
    for (const del of (req.headers.get('cookie') || '').split(';')) {
        const i = del.indexOf('=');
        if (i > 0 && del.slice(0, i).trim() === COOKIE) verdier.push(del.slice(i + 1).trim());
    }
    return verdier.slice(0, 5);
}

// Gyldig innlogging → { kunde, utloper } (utloper i unix-sekunder), ellers null
function innlogging(req, nokkel) {
    for (const verdi of lesCookies(req)) {
        const s = kundeFraCookie(verdi, nokkel);
        if (s) return s;
    }
    return null;
}

function kundeFraCookie(verdi, nokkel) {
    const [data, sig, ...rest] = verdi.split('.');
    if (!data || !sig || rest.length) return null;
    const faktisk = Buffer.from(sig, 'base64url');
    const forventet = signatur(data, nokkel);
    if (faktisk.length !== forventet.length || !timingSafeEqual(faktisk, forventet)) return null;
    let innhold;
    try { innhold = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
    if (!innhold || typeof innhold.e !== 'number' || typeof innhold.f !== 'string' || innhold.e * 1000 < Date.now()) return null;
    const kunde = kunder().find((x) => fingeravtrykk(x) === innhold.f);
    return kunde ? { kunde, utloper: innhold.e } : null;
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
    else if (++f.antall === MAKS_FORSOK) console.warn('Innlogging sperret et kvarter for én IP etter for mange feil.');
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

// ── Parametre ───────────────────────────────────────────────────────────────
// Bare kjente navn, hvert høyst én gang (unntatt filtrene «f»). Alt annet gir 400, så en
// skrivefeil i nettleseren ikke stille gir feil tall, og ingen parameter kan velge nettsted.

const TILLATT = {
    data: [...PERIODE_PARAMETRE, 'f', 'deler'],
    detaljer: [...PERIODE_PARAMETRE, 'f', 'rapport', 'sok', 'sorter', 'side'],
    eksport: [...PERIODE_PARAMETRE, 'f', 'intervall'],
    oppsett: [],
};

function parametre(adresse, rute) {
    if (adresse.search.length > MAKS_ADRESSE) throw new Ugyldig('Adressen er for lang.');
    const sp = adresse.searchParams;
    const tillatt = TILLATT[rute];
    const sett = new Set();
    for (const navn of sp.keys()) {
        if (!tillatt.includes(navn)) throw new Ugyldig(`Ukjent parameter: ${navn.slice(0, 40)}.`);
        if (navn !== 'f' && sett.has(navn)) throw new Ugyldig(`Parameteren ${navn} står to ganger.`);
        sett.add(navn);
    }
    return sp;
}

// Det som trengs for å hente tall: oppsett, filtre og periode
async function forbered(sp, k, apiNokkel) {
    const opp = await hentOppsett(apiNokkel, k.nettsted);
    const filtre = lesFiltre(sp.getAll('f'), { mal: opp.mal ? opp.mal.map((m) => m.navn) : null, egenskaper: opp.egenskaper });
    const per = await lesPeriode(apiNokkel, k.nettsted, sp, opp.tidssone, Date.now());
    return { opp, ctx: { apiNokkel, nettsted: k.nettsted, per, filtre, k: kontekst(filtre, per.key === 'sanntid') } };
}

const tidligst = (liste) => new Date(liste.length ? Math.min(...liste) : Date.now()).toISOString();

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
    console.log(`Innlogging ok: ${k.nettsted}`);
    return svar(200, { navn: k.navn, nettsted: k.nettsted, epost: k.epost }, { 'Set-Cookie': [lagCookie(k, nokkel), lagFlagg()] });
}

// mal og egenskaper er null når Plausible ikke svarte (siden viser da «Fikk ikke hentet målene»)
async function oppsett(adresse, k, apiNokkel) {
    parametre(adresse, 'oppsett');
    const opp = await hentOppsett(apiNokkel, k.nettsted);
    return svar(200, { tidssone: opp.tidssone, mal: opp.mal, egenskaper: opp.egenskaper, interne: opp.interne, inntekt: opp.inntekt });
}

async function data(adresse, k, apiNokkel) {
    const sp = parametre(adresse, 'data');
    const { opp, ctx } = await forbered(sp, k, apiNokkel);
    const deler = lesDeler(sp.get('deler'), ctx.per, ctx.k, opp);
    // Hver del for seg: en del som feiler, får { feil } uten å ta med seg resten
    const resultater = await Promise.allSettled(deler.map((d) => kjorDel(ctx, d)));
    const ut = {};
    const hentet = [];
    const grunner = [];
    resultater.forEach((r, i) => {
        if (r.status === 'fulfilled') {
            ut[deler[i].navn] = r.value.verdi;
            hentet.push(...r.value.hentet);
            return;
        }
        grunner.push(r.reason);
        console.error(`Delen ${deler[i].navn} for ${k.nettsted} feilet: ${r.reason?.message}`);
        ut[deler[i].navn] = { feil: delFeil(r.reason) };
    });
    if (grunner.length === deler.length) {
        // Ingen deler: samme status som én feil ville gitt (kvoten først, så frist, så annet)
        const side = grunner.find((e) => e instanceof KvoteSide);
        if (side) return feil(429, MELDING_SIDE, { 'Retry-After': String(side.sekunder) });
        if (grunner.some((e) => e instanceof PlausibleFeil && e.status === 429)) return feil(503, MELDING_KVOTE);
        if (grunner.some((e) => e instanceof Frist)) return feil(504, MELDING_TREG);
        return feil(502, MELDING_FEIL);
    }
    ryddMerknader(ut, k.nettsted);
    return svar(200, { periode: periodeJson(ctx.per), oppdatert: tidligst(hentet), deler: ut });
}

async function detaljvisning(adresse, k, apiNokkel) {
    const sp = parametre(adresse, 'detaljer');
    const { opp, ctx } = await forbered(sp, k, apiNokkel);
    const valg = lesDetaljvalg(sp, opp);
    const r = await detaljer(ctx, valg);
    return svar(200, { ...r.verdi, oppdatert: tidligst(r.hentet) });
}

// Siste nedlasting per nettsted (i minnet til instansen, som innloggingssperren)
const nedlastet = new Map();

async function eksport(adresse, k, apiNokkel) {
    const sp = parametre(adresse, 'eksport');
    const { opp, ctx } = await forbered(sp, k, apiNokkel);
    if (ctx.per.key === 'sanntid') throw new Ugyldig('Sanntid kan ikke lastes ned.');
    const intervall = sp.get('intervall') ?? ctx.per.standardIntervall;
    if (!ctx.per.intervaller.includes(intervall)) throw new Ugyldig('Ugyldig intervall for perioden.');
    const forrige = nedlastet.get(k.nettsted) || 0;
    if (Date.now() - forrige < EKSPORT_PAUSE_MS) {
        return feil(429, 'Vent litt før du laster ned igjen.', { 'Retry-After': String(Math.ceil((forrige + EKSPORT_PAUSE_MS - Date.now()) / 1000)) });
    }
    // Nok kvote igjen til hele nedlastingen? Ellers ikke start (halve filer hjelper ingen)
    sjekkKvote(k.nettsted, eksportKall(ctx.filtre, opp.egenskaper));
    if (nedlastet.size > 1000) nedlastet.clear();
    const tid = Date.now();
    nedlastet.set(k.nettsted, tid);
    let zip;
    try {
        zip = await lagEksport(ctx, intervall, opp.egenskaper);
    } catch (e) {
        if (nedlastet.get(k.nettsted) === tid) nedlastet.delete(k.nettsted);    // feilet: kan prøves igjen med en gang
        throw e;
    }
    console.log(`Nedlasting: ${k.nettsted} ${ctx.per.fraDato}–${ctx.per.tilDato}`);
    return new Response(zip, {
        status: 200,
        headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': filnavn(k.nettsted, ctx.per.fraDato, ctx.per.tilDato),
            'Content-Length': String(zip.length),
            ...SIKKERHET,
        },
    });
}

const STATISTIKK = { '/api/kunde/oppsett': oppsett, '/api/kunde/data': data, '/api/kunde/detaljer': detaljvisning, '/api/kunde/eksport': eksport };

async function statistikk(rute, adresse, k) {
    const apiNokkel = process.env.PLAUSIBLE_API_KEY;
    if (!apiNokkel) {
        console.error('PLAUSIBLE_API_KEY mangler i miljøvariablene på Netlify.');
        return feil(503, 'Statistikken er ikke koblet til ennå. Prøv igjen senere.');
    }
    try {
        // Fristen gjelder alle kall til Plausible i denne forespørselen (se plausible.mjs)
        const frist = AbortSignal.timeout(rute === eksport ? FRIST.eksport : FRIST.vanlig);
        return await medRamme({ frist, nettsted: k.nettsted }, () => rute(adresse, k, apiNokkel));
    } catch (e) {
        if (e instanceof MalUkjent) e = new PlausibleFeil(502, e.message);
        return feilSvar(e, adresse.pathname, k.nettsted);
    }
}

export default async (req, context) => {
    const adresse = new URL(req.url);
    // Portalen svarer bare på eget domene, ikke på Netlifys adresser for gamle eller
    // forhåndsviste publiseringer (de kan ha gamle nøkler og kundelister).
    const vert = adresse.hostname.replace(/\.+$/, '');      // «dotdev.no.» med punktum til slutt er samme adresse
    if (vert === 'netlify.app' || vert.endsWith('.netlify.app')) return feil(404, 'Finnes ikke.');
    const sti = adresse.pathname.replace(/\/+$/, '');
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
        return metode === 'POST' ? svar(200, { ok: true }, { 'Set-Cookie': [slettCookie(), slettFlagg()] }) : feil(405, 'Bruk POST.', { Allow: 'POST' });
    }
    if (sti === '/api/kunde/meg' || Object.hasOwn(STATISTIKK, sti)) {
        if (metode !== 'GET') return feil(405, 'Bruk GET.', { Allow: 'GET' });
        const s = innlogging(req, nokkel);
        const k = s ? s.kunde : null;
        // /meg spør bare om noen er innlogget, og «nei» er et vanlig svar (200), ikke en feil. Da får
        // innloggingssiden ingen rød 401 i konsollen ved hvert besøk. Statistikken svarer fortsatt 401.
        if (sti === '/api/kunde/meg') {
            if (k) {
                // Mangler flagget (innlogget fra før flagget fantes, eller det er slettet), settes det her,
                // med samme utløpstid som innloggingen. Portalen spør /meg hver gang den åpnes.
                const flagg = harFlagg(req) ? {} : { 'Set-Cookie': lagFlagg(s.utloper - Date.now() / 1000) };
                return svar(200, { innlogget: true, navn: k.navn, nettsted: k.nettsted, epost: k.epost }, flagg);
            }
            // Utløpt eller ugyldig innlogging: fjern flagget, så forsiden slutter å spørre
            return svar(200, { innlogget: false }, harFlagg(req) ? { 'Set-Cookie': slettFlagg() } : {});
        }
        if (!k) return feil(401, 'Ikke innlogget.');
        return statistikk(STATISTIKK[sti], adresse, k);
    }
    return feil(404, 'Finnes ikke.');
};

export const config = {
    path: '/api/kunde/*',
    // Netlify stopper en IP som sender over 90 forespørsler i minuttet (svarer 429). En visning
    // er et par forespørsler (oppsett, data, detaljer), så dette holder godt, og det bremser
    // gjetting. Plausible-kvoten passes i tillegg per nettsted i plausible.mjs.
    rateLimit: { windowLimit: 90, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
