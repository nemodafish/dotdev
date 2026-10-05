// DOTDEV · kundeportalen: alle kall til Plausible går gjennom denne filen.
//
// Plausible tillater 600 kall i timen (fast klokketime) og 60 på 10 sekunder for hele laget,
// delt av alle kundene. Derfor:
//   • hvert enkelt kall mellomlagres (nøkkel = nettsted + nøyaktig forespørsel), og like kall som
//     er i gang samtidig deles. Bare kall som ikke står i mellomlageret, koster kvote;
//   • det går aldri mer enn MAKS_SAMTIDIG kall om gangen;
//   • hvert nettsted har en egen «bøtte» med kall (KVOTE.side, fylles opp med KVOTE.sidePerTime),
//     så én kunde aldri kan bruke opp kvoten for de andre. Tom bøtte → KvoteSide (429 til kunden);
//   • laget som helhet får høyst KVOTE.time kall per klokketime og KVOTE.tiSek per 10 sekunder
//     (litt under Plausibles grenser). Er 10-sekundersvinduet fullt, venter kallet til neste vindu;
//   • svarer Plausible 429, stoppes alle kall til neste vindu (10 s) eller neste klokketime, i
//     stedet for å sende kall som uansett blir avvist (Plausible teller også avviste kall).
// Grensene gjelder per serverinstans (Netlify kan kjøre flere), så de er en brems, ikke en mur.
//
// Hvert kall avbrytes etter 8 sekunder, og alle kall i en forespørsel stopper ved fristen API-et
// setter (medRamme), godt før Netlifys grense på 60 sekunder. Feilteksten fra Plausible havner
// bare i loggen.

import { AsyncLocalStorage } from 'node:async_hooks';

const PLAUSIBLE = 'https://plausible.io';
const TIDSAVBRUDD_MS = 8000;
const MAKS_SAMTIDIG = 8;
const MAKS_LAGER = 2000;
const TIME_MS = 60 * 60 * 1000;
const VINDU_MS = 10 * 1000;

export const MINUTT = 60 * 1000;
export const LAGER_MS = 5 * MINUTT;          // vanlige tall
export const LEVENDE_MS = MINUTT;            // sanntid og «besøkende nå»
export const OPPSETT_MS = 60 * MINUTT;       // tidssone, mål og egenskaper

// Grensene (kan endres av testene med settKvote)
export const KVOTE = {
    time: 500,           // kall per klokketime for hele laget (Plausible: 600)
    tiSek: 50,           // kall per 10-sekundersvindu (Plausible: 60)
    side: 120,           // kall ett nettsted kan bruke i én rykk …
    sidePerTime: 240,    // … og hvor mange som kommer tilbake per time (4 i minuttet)
};
const STANDARD_KVOTE = { ...KVOTE };

// Fristen for en hel forespørsel til API-et (Netlify stopper funksjonen etter 60 sekunder)
export const FRIST = { vanlig: 25 * 1000, eksport: 45 * 1000 };
const STANDARD_FRIST = { ...FRIST };

export class PlausibleFeil extends Error {
    constructor(status, melding) {
        super(melding);
        this.status = status;
    }
}
// Nettstedet har brukt opp sin del av kvoten. sekunder = når det er nok igjen til et nytt kall.
export class KvoteSide extends Error {
    constructor(sekunder) {
        super('Nettstedet har brukt opp kvoten sin en stund.');
        this.sekunder = Math.max(1, Math.ceil(sekunder));
    }
}
// Fristen for hele forespørselen gikk ut før Plausible svarte
export class Frist extends Error {}

// Fristen og nettstedet for forespørselen som kjører nå (settes i kunde-api.mjs)
const ramme = new AsyncLocalStorage();
export const medRamme = (verdi, fn) => ramme.run(verdi, fn);
const fristNaa = () => ramme.getStore()?.frist;

// ── Mellomlageret: nøkkel → { til, svar } for ferdige svar, eller { lover } mens kallet pågår ──
const lager = new Map();

function rydd() {
    if (lager.size <= MAKS_LAGER) return;
    const naa = Date.now();
    for (const [k, v] of lager) if (v.til && v.til <= naa) lager.delete(k);
    while (lager.size > MAKS_LAGER) lager.delete(lager.keys().next().value);
}

// ── Kø: høyst MAKS_SAMTIDIG kall om gangen ──
let aktive = 0;
const venter = [];
async function iKo(fn) {
    if (aktive >= MAKS_SAMTIDIG) await new Promise((ok) => venter.push(ok));   // overtar plassen til den som blir ferdig
    else aktive++;
    try { return await fn(); } finally {
        const neste = venter.shift();
        if (neste) neste(); else aktive--;
    }
}

// ── Kvoten ──
const botter = new Map();                    // nettsted → { kall, sist }
let timeNr = -1, iTimen = 0;                 // kall i denne klokketimen
let vinduNr = -1, iVinduet = 0;              // kall i dette 10-sekundersvinduet
let stengtTil = 0;                           // ingen kall før dette (etter 429 fra Plausible)

function botte(nettsted, naa) {
    let b = botter.get(nettsted);
    if (!b) {
        if (botter.size > 1000) botter.clear();
        b = { kall: KVOTE.side, sist: naa };
        botter.set(nettsted, b);
    }
    b.kall = Math.min(KVOTE.side, b.kall + ((naa - b.sist) * KVOTE.sidePerTime) / TIME_MS);
    b.sist = naa;
    return b;
}
const sekunderTil = (mangler) => (mangler * TIME_MS) / KVOTE.sidePerTime / 1000;
function tellTime(naa) {
    const nr = Math.floor(naa / TIME_MS);
    if (nr !== timeNr) { timeNr = nr; iTimen = 0; }
}
function tellVindu(naa) {
    const nr = Math.floor(naa / VINDU_MS);
    if (nr !== vinduNr) { vinduNr = nr; iVinduet = 0; }
}
const kvoteFeil = () => new PlausibleFeil(429, 'Kvoten for denne timen er brukt opp (portalens egen grense).');

// Kaster hvis et nytt kall ikke skal sendes nå (stengt etter 429, eller timen er full)
function sjekkLaget(naa) {
    if (naa < stengtTil) throw new PlausibleFeil(429, 'Pause etter 429 fra Plausible.');
    tellTime(naa);
    if (iTimen >= KVOTE.time) throw kvoteFeil();
}

// Sjekker på forhånd om nettstedet har minst n kall igjen (brukes før nedlastingen)
export function sjekkKvote(nettsted, n) {
    const naa = Date.now();
    sjekkLaget(naa);
    if (iTimen + n > KVOTE.time) throw kvoteFeil();
    const b = botte(nettsted, naa);
    if (b.kall < n) throw new KvoteSide(sekunderTil(n - b.kall));
}

const sov = (ms, frist) => new Promise((ok, avvis) => {
    const t = setTimeout(ok, ms);
    frist?.addEventListener('abort', () => { clearTimeout(t); avvis(new Frist('Fristen gikk ut.')); }, { once: true });
});

// Venter på plass i 10-sekundersvinduet og trekker kallet fra kvoten. Kalles rett før fetch.
async function slipp(nettsted, frist) {
    for (;;) {
        if (frist?.aborted) throw new Frist('Fristen gikk ut.');
        const naa = Date.now();
        sjekkLaget(naa);
        tellVindu(naa);
        if (iVinduet < KVOTE.tiSek) break;
        await sov((vinduNr + 1) * VINDU_MS - naa + 20, frist);
    }
    const naa = Date.now();
    const b = botte(nettsted, naa);
    if (b.kall < 1) throw new KvoteSide(sekunderTil(1 - b.kall));
    b.kall -= 1;
    iTimen++;
    iVinduet++;
}

// Plausible svarte 429: ingen nye kall før vinduet (10 s) eller klokketimen er over
function steng(tekst) {
    const naa = Date.now();
    const kort = /short period|seconds/i.test(tekst);
    stengtTil = Math.max(stengtTil, kort ? (Math.floor(naa / VINDU_MS) + 1) * VINDU_MS + 1000 : (Math.floor(naa / TIME_MS) + 1) * TIME_MS);
    console.error(`Plausible svarte 429. Ingen kall før ${new Date(stengtTil).toISOString()}.`);
}

async function hent(apiNokkel, metode, sti, kropp, frist) {
    const signaler = [AbortSignal.timeout(TIDSAVBRUDD_MS)];
    if (frist) signaler.push(frist);
    let res;
    try {
        res = await fetch(PLAUSIBLE + sti, {
            method: metode,
            headers: { Authorization: `Bearer ${apiNokkel}`, ...(kropp ? { 'Content-Type': 'application/json' } : {}) },
            body: kropp,
            signal: signaler.length > 1 ? AbortSignal.any(signaler) : signaler[0],
        });
    } catch (e) {
        if (frist?.aborted) throw new Frist('Fristen gikk ut.');
        throw e;
    }
    if (!res.ok) {
        const tekst = (await res.text().catch(() => '')).slice(0, 300);
        if (res.status === 429) steng(tekst);
        throw new PlausibleFeil(res.status, `Plausible svarte ${res.status} på ${metode} ${sti.split('?')[0]}: ${tekst}`);
    }
    return res.json();
}

// Et kall som allerede er i gang, men som denne forespørselen ikke vil vente på etter fristen
function innenFrist(lover, frist) {
    if (!frist) return lover;
    if (frist.aborted) return Promise.reject(new Frist('Fristen gikk ut.'));
    return new Promise((ok, avvis) => {
        const stopp = () => avvis(new Frist('Fristen gikk ut.'));
        frist.addEventListener('abort', stopp, { once: true });
        lover.then((v) => { frist.removeEventListener('abort', stopp); ok(v); }, (e) => { frist.removeEventListener('abort', stopp); avvis(e); });
    });
}

// Ett kall med mellomlager. Gir { data, hentet } der hentet er tidspunktet Plausible svarte.
async function kall(apiNokkel, nettsted, metode, sti, kropp, ttl) {
    const nokkel = `${metode} ${sti} ${kropp || ''}`;
    const frist = fristNaa();
    const treff = lager.get(nokkel);
    if (treff) {
        if (treff.lover) return innenFrist(treff.lover, frist);
        if (treff.til > Date.now()) return treff.svar;
        lager.delete(nokkel);
    }
    sjekkLaget(Date.now());                  // stengt eller full time: ikke engang still deg i køen
    const lover = iKo(async () => {
        await slipp(nettsted, frist);
        return hent(apiNokkel, metode, sti, kropp, frist);
    }).then(
        (data) => {
            const svar = { data, hentet: Date.now() };
            lager.set(nokkel, { til: Date.now() + ttl, svar });
            rydd();
            return svar;
        },
        (e) => {
            lager.delete(nokkel);           // feil lagres ikke, neste visning prøver igjen
            throw e;
        },
    );
    lager.set(nokkel, { lover });
    return lover;
}

// Stats API v2. sporring må inneholde site_id, og den kommer alltid fra innloggingen.
export function sporV2(apiNokkel, sporring, ttl = LAGER_MS) {
    return kall(apiNokkel, sporring.site_id, 'POST', '/api/v2/query', JSON.stringify(sporring), ttl);
}

// Besøkende de siste 5 minuttene (v1, svaret er et tall)
export async function besokendeNaa(apiNokkel, nettsted) {
    const svar = await kall(apiNokkel, nettsted, 'GET', `/api/v1/stats/realtime/visitors?site_id=${encodeURIComponent(nettsted)}`, null, LEVENDE_MS);
    return { ...svar, data: Number.isFinite(svar.data) ? Math.max(0, Math.round(svar.data)) : 0 };
}

// Sites API (lesing virker med samme Stats-nøkkel)
export const hentNettsted = (apiNokkel, nettsted) =>
    kall(apiNokkel, nettsted, 'GET', `/api/v1/sites/${encodeURIComponent(nettsted)}`, null, OPPSETT_MS);
export const hentMal = (apiNokkel, nettsted) =>
    kall(apiNokkel, nettsted, 'GET', `/api/v1/sites/goals?site_id=${encodeURIComponent(nettsted)}&limit=100`, null, OPPSETT_MS);
export const hentEgenskaper = (apiNokkel, nettsted) =>
    kall(apiNokkel, nettsted, 'GET', `/api/v1/sites/custom-props?site_id=${encodeURIComponent(nettsted)}`, null, OPPSETT_MS);

// For testene: tømmer mellomlageret og nullstiller kvoten og pausen
export function tomLager() {
    lager.clear();
    botter.clear();
    timeNr = vinduNr = -1;
    iTimen = iVinduet = 0;
    stengtTil = 0;
}
// For testene: andre grenser og frister (uten argument: standardverdiene). settKvote nullstiller
// også tellerne og pausen etter 429, men ikke mellomlageret.
export function settKvote(ny) {
    Object.assign(KVOTE, STANDARD_KVOTE, ny || {});
    botter.clear();
    timeNr = vinduNr = -1;
    iTimen = iVinduet = 0;
    stengtTil = 0;
}
export function settFrist(ny) {
    Object.assign(FRIST, STANDARD_FRIST, ny || {});
}
