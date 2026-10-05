// DOTDEV · kundeportalen: henter tallene fra Plausible og setter dem sammen for API-et
// (/oppsett, /data og /detaljer). Hver del hentes for seg med egne spørringer,
// så én del som feiler, ikke ødelegger resten.

import { lagPeriode, Ugyldig, tidsetiketter, punktstatus, endring, INTERVALL_DIM, gyldigTidssone, gyldigDato } from './perioder.mjs';
import { sporV2, besokendeNaa, hentNettsted, hentMal, hentEgenskaper, PlausibleFeil, MINUTT, LAGER_MS, LEVENDE_MS, OPPSETT_MS } from './plausible.mjs';
import { kontekst, utenMalOgEgenskap, inntektIFilter, INTERNE_EGENSKAPER } from './filtre.mjs';
import {
    harImport, finnRapport, metrikker, toppMetrikker, toppEtikett, kolonneEtikett, sporring, rader, metrikkverdi,
    valuta, tomVerdi, lagRad, merknader, harInntektsvarsel, sortering, utenTommeInntekter, UTREGNET, INNTEKT,
} from './rapporter.mjs';

export const STANDARD_TIDSSONE = 'Europe/Oslo';

// ── Oppsett: tidssone, mål og egenskaper (Sites API, 1 time i mellomlageret) ──

// Feiler Sites API, brukes norsk tid og tomme lister, og samme kall prøves ikke igjen på et minutt
const pause = new Map();
async function forsok(navn, fn) {
    if ((pause.get(navn) || 0) > Date.now()) return null;
    try {
        return (await fn()).data;
    } catch (e) {
        console.error(`Oppsett feilet (${navn}): ${e.message}`);
        if (pause.size > 1000) pause.clear();
        pause.set(navn, Date.now() + MINUTT);
        return null;
    }
}

const tekster = (liste) => (Array.isArray(liste) ? liste : []).filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 300).slice(0, 300);

// Svarer alltid. mal og egenskaper er null når listene ikke kunne hentes (da avvises is-filtre på
// mål, og siden sier at målene ikke kunne hentes i stedet for at ingen finnes).
export async function hentOppsett(apiNokkel, nettsted) {
    const [sted, mal] = await Promise.all([
        forsok('nettsted ' + nettsted, () => hentNettsted(apiNokkel, nettsted)),
        forsok('mål ' + nettsted, () => hentMal(apiNokkel, nettsted)),
    ]);
    let egenskaper = sted && Array.isArray(sted.custom_properties) ? tekster(sted.custom_properties) : null;
    if (!egenskaper && sted) {
        // Svaret om nettstedet hadde ikke listen: les den for seg
        const e = await forsok('egenskaper ' + nettsted, () => hentEgenskaper(apiNokkel, nettsted));
        if (e) egenskaper = tekster((Array.isArray(e.custom_properties) ? e.custom_properties : []).map((x) => x?.property));
    }
    const goals = Array.isArray(mal?.goals) ? mal.goals : null;
    return {
        tidssone: gyldigTidssone(sted?.timezone) ? sted.timezone : STANDARD_TIDSSONE,
        mal: goals && goals.filter((g) => typeof g?.display_name === 'string' && g.display_name.length > 0 && g.display_name.length <= 300)
            .map((g) => ({ navn: g.display_name, type: ['event', 'page', 'scroll'].includes(g.goal_type) ? g.goal_type : 'event' })),
        egenskaper,
        interne: INTERNE_EGENSKAPER,
        inntekt: inntektKjent(nettsted) === true,
    };
}

// ── Inntekt: har nettstedet inntektsmål, og hvilke? ──
// Plausible viser inntektskolonner bare når nettstedet har inntektsmål. Sites API sier ikke hvilke
// mål som har valuta, så det leses av svaret på en målspørring (1 time i mellomlageret). Listen
// over mål uten målfilter forteller det samme, så den fyller inn uten ekstra spørring.

const inntektLager = new Map();            // nettsted → { til, har, liste? }
function inntektKjent(nettsted) {
    const x = inntektLager.get(nettsted);
    return x && x.til > Date.now() ? x.har : null;
}
function settInntekt(nettsted, har) {
    const x = inntektLager.get(nettsted);
    if (x && x.til > Date.now() && x.har === har) return;
    if (inntektLager.size > 1000) inntektLager.clear();
    inntektLager.set(nettsted, { til: Date.now() + OPPSETT_MS, har });
}
async function inntektsinfo(apiNokkel, nettsted) {
    const x = inntektLager.get(nettsted);
    if (x && x.til > Date.now() && (x.liste || !x.har)) return x;
    let svar;
    try {
        svar = await sporV2(apiNokkel, sporring(nettsted, { metrics: ['visitors', 'total_revenue'], range: 'all', dims: ['event:goal'] }), OPPSETT_MS);
    } catch (e) {
        if (!(e instanceof PlausibleFeil && e.status === 400)) throw e;
        console.error(`Inntekt kan ikke brukes for ${nettsted}: ${e.message}`);
        svar = null;                          // planen har ikke inntekt: vis den ikke
    }
    const liste = svar ? rader(svar.data).map((r) => ({ navn: String(r.dimensions?.[0] ?? ''), valuta: valuta(r.metrics?.[1]) })).filter((m) => m.valuta) : [];
    const ny = { til: Date.now() + OPPSETT_MS, har: Boolean(svar) && !harInntektsvarsel(svar.data), liste };
    inntektLager.set(nettsted, ny);
    return ny;
}

// ── Perioden ──

// «All tid» starter på dagen Plausible har første besøk. Den står i svaret på en spørring med
// «all», og spørringen er den samme som tallene øverst uten filtre (så den gjenbrukes derfra).
const altLager = new Map();
const toppSporring = (nettsted, k, inntekt, range, filtre) => sporring(nettsted, { metrics: toppMetrikker(k, inntekt), range, filtre });
async function altStart(apiNokkel, nettsted) {
    const x = altLager.get(nettsted);
    if (x && x.til > Date.now()) return x.dato;
    const svar = await sporV2(apiNokkel, toppSporring(nettsted, kontekst([], false), false, 'all', []));
    const d = String(svar.data?.query?.date_range?.[0] ?? '').slice(0, 10);
    if (altLager.size > 1000) altLager.clear();
    altLager.set(nettsted, { til: Date.now() + OPPSETT_MS, dato: gyldigDato(d) ? d : null });
    return gyldigDato(d) ? d : null;
}

export const PERIODE_PARAMETRE = ['periode', 'dato', 'fra', 'til', 'sml', 'sml_fra', 'sml_til', 'ukedag'];

// «Nå» holdes fast i ett minutt per nettsted. Sanntid, «i dag» og «siste 24 timer» bruker nå på
// sekundet (som Plausible), og med et fast anker gir like visninger innen samme minutt samme
// spørring, så mellomlageret virker. Etter et minutt flyttes ankeret til ny nå.
const ankere = new Map();                  // nettsted → { naa, til }
export function anker(nettsted, naa) {
    const x = ankere.get(nettsted);
    if (x && naa >= x.naa && naa < x.til) return x.naa;
    if (ankere.size > 1000) ankere.clear();
    ankere.set(nettsted, { naa, til: naa + MINUTT });
    return naa;
}

export async function lesPeriode(apiNokkel, nettsted, sp, tz, naaInn) {
    const naa = anker(nettsted, naaInn);
    const inn = { tz, naa };
    for (const navn of PERIODE_PARAMETRE) inn[navn] = sp.get(navn) ?? undefined;
    if (inn.periode === 'alt') inn.altStart = await altStart(apiNokkel, nettsted);
    return lagPeriode(inn);
}

// Perioden slik API-et viser den
export function periodeJson(p) {
    const ut = {
        key: p.key, fra: p.fraDato, til: p.tilDato, tidssone: p.tz, idag: p.idag, levende: p.levende,
        forrige_mulig: Boolean(p.forrigeDato), neste_mulig: Boolean(p.nesteDato),
        forrige_dato: p.forrigeDato ?? null, neste_dato: p.nesteDato ?? null,
        ukedag: p.matchUkedag,
        sml: p.sml ? { modus: p.sml.modus, ...omradeJson(p.sml) } : null,
        endring_mot: p.endring ? omradeJson(p.endring) : null,
        intervaller: p.intervaller, standard_intervall: p.standardIntervall,
    };
    if (p.dag) ut.dag = p.dag;
    if (p.fraKl) { ut.fra_kl = p.fraKl; ut.til_kl = p.tilKl; }
    return ut;
}
function omradeJson(o) {
    const ut = { fra: o.fra, til: o.til };
    if (o.fraKl) { ut.fra_kl = o.fraKl; ut.til_kl = o.tilKl; }
    return ut;
}

// ── Delene i /data ──

// Grensene holder prisen for én forespørsel nede (høyst ~13 kall uten mellomlager). Siden ber om
// høyst 8 deler (tallene øverst, én graf, fem lister og «nå»), og én graf om gangen.
export const MAKS_DELER = 10;

// «topp», «nå» (eller «naa»), «graf:<metrikk>:<intervall>», «liste:<rapport>»
export function lesDeler(raa, per, k, opp) {
    if (!raa) throw new Ugyldig('Si hvilke deler du vil ha (deler=topp,graf:visitors:dag,…).');
    if (raa.length > 4000) throw new Ugyldig('For mange deler.');
    const navn = raa.split(',');
    if (navn.length > MAKS_DELER) throw new Ugyldig(`Høyst ${MAKS_DELER} deler om gangen.`);
    if (new Set(navn).size !== navn.length) throw new Ugyldig('Samme del står to ganger.');
    if (navn.filter((n) => n.startsWith('graf:')).length > 1) throw new Ugyldig('Høyst én graf om gangen.');
    return navn.map((n) => {
        if (n === 'topp') return { navn: n, type: 'topp' };
        if (n === 'nå' || n === 'naa') return { navn: n, type: 'naa' };
        if (n.startsWith('graf:')) {
            const [, metrikk, intervall, ...rest] = n.split(':');
            if (k.sanntid) throw new Ugyldig('Sanntid har ingen graf.');
            if (rest.length || !toppMetrikker(k, true).includes(metrikk)) throw new Ugyldig('Ugyldig metrikk for grafen.');
            if (!per.intervaller.includes(intervall)) throw new Ugyldig('Ugyldig intervall for perioden.');
            return { navn: n, type: 'graf', metrikk, intervall };
        }
        if (n.startsWith('liste:')) {
            const rap = finnRapport(n.slice(6), opp.egenskaper);
            if (!rap) throw new Ugyldig('Ukjent rapport.');
            return { navn: n, type: 'liste', rap };
        }
        throw new Ugyldig('Ukjent del.');
    });
}

// Fjerner «unsupported_interval» fra delene når nettstedet ikke har importerte data (se harImport)
export function ryddMerknader(deler, nettsted) {
    if (harImport(nettsted)) return;
    for (const del of Object.values(deler)) {
        if (Array.isArray(del?.merknader)) del.merknader = del.merknader.filter((m) => m.kode !== 'unsupported_interval');
    }
}

export function kjorDel(ctx, d) {
    if (d.type === 'topp') return delTopp(ctx);
    if (d.type === 'naa') return besokendeNaa(ctx.apiNokkel, ctx.nettsted).then((s) => ({ hentet: [s.hentet], verdi: { besokende: s.data } }));
    if (d.type === 'graf') return delGraf(ctx, d.metrikk, d.intervall);
    return delListe(ctx, d.rap);
}

const forsteRad = (svar) => rader(svar)[0]?.metrics || [];

async function delTopp(ctx) {
    const { apiNokkel, nettsted, per, filtre, k } = ctx;
    if (k.sanntid) {
        // Besøkende nå (siste 5 min, uten filtre – det er alt Plausible gir) og siste 30 minutter
        const metrics = toppMetrikker(k, false);
        const [naa, svar] = await Promise.all([
            besokendeNaa(apiNokkel, nettsted),
            sporV2(apiNokkel, sporring(nettsted, { metrics, range: per.range, filtre }), LEVENDE_MS),
        ]);
        const m = forsteRad(svar.data);
        return {
            hentet: [naa.hentet, svar.hentet],
            verdi: {
                kontekst: 'sanntid',
                metrikker: [
                    { key: 'naa', etikett: toppEtikett('naa', k), verdi: naa.data, forrige: null, endring: null },
                    ...metrics.map((x, i) => ({ key: x, etikett: toppEtikett(x, k), verdi: metrikkverdi(m[i]) ?? tomVerdi(x), forrige: null, endring: null })),
                ].filter((o) => o.verdi !== null),
                merknader: merknader([svar.data], { nettsted }),
            },
        };
    }
    const inntekt = k.mal ? (await inntektsinfo(apiNokkel, nettsted)).har : false;
    const q = (range) => sporV2(apiNokkel, toppSporring(nettsted, k, inntekt, range, filtre));
    const [hoved, sml] = await Promise.all([q(per.range), per.endring ? q(per.endring.range) : null]);
    const a = forsteRad(hoved.data), b = sml ? forsteRad(sml.data) : [];
    // Tall uten verdi (inntekt uten inntektsmål i filteret, scrolldybde uten data …) vises ikke,
    // som i Plausibles dashbord (TopStats tar bort alle med value null)
    const metrikkene = toppMetrikker(k, inntekt).map((x, i) => {
        const o = {
            key: x, etikett: toppEtikett(x, k),
            verdi: metrikkverdi(a[i]) ?? tomVerdi(x),
            forrige: sml ? metrikkverdi(b[i]) ?? tomVerdi(x) : null,
            endring: sml ? endring(x, b[i] ?? tomVerdi(x), a[i] ?? tomVerdi(x)) : null,
        };
        if (per.sml) o.sml_verdi = o.forrige;
        const v = valuta(a[i]) || valuta(b[i]);
        if (v) o.valuta = v;
        return o;
    }).filter((o) => o.verdi !== null);
    return {
        hentet: [hoved.hentet, ...(sml ? [sml.hentet] : [])],
        verdi: {
            kontekst: k.mal ? 'mal' : k.side ? 'side' : 'standard',
            metrikker: metrikkene,
            merknader: merknader([hoved.data, sml?.data], { nettsted, skjulInntekt: !metrikkene.some((o) => INNTEKT.includes(o.key)) }),
        },
    };
}

// ── Graf ──

const LENGDE = { time: 13, dag: 10, uke: 10, mnd: 7 };   // «ÅÅÅÅ-MM-DD HH», «ÅÅÅÅ-MM-DD», «ÅÅÅÅ-MM»
const ADDITIVE = new Set(['visitors', 'visits', 'pageviews', 'events', 'total_revenue']);

// Radene fra en tidsspørring → Map(nøkkel → verdier). To rader med samme nøkkel (to 02-timer den
// natta klokka stilles tilbake) slås sammen: tellinger legges sammen, andeler og snitt får snittet.
function tidsverdier(svar, metrics, intervall) {
    const ut = new Map(), antall = new Map();
    for (const r of rader(svar)) {
        const t = String(r.dimensions?.[0] ?? '').slice(0, LENGDE[intervall]);
        const v = metrics.map((m, i) => metrikkverdi(r.metrics?.[i]));
        const f = ut.get(t);
        if (!f) { ut.set(t, v); antall.set(t, 1); continue; }
        const n = antall.get(t) + 1;
        antall.set(t, n);
        ut.set(t, f.map((x, i) => (v[i] == null ? x : x == null ? v[i] : ADDITIVE.has(metrics[i]) ? x + v[i] : x + (v[i] - x) / n)));
    }
    return ut;
}

// Timene lager vi selv (alltid 00–23 per døgn, se tidsetiketter); dag, uke og måned tas fra
// Plausibles time_labels, så nøklene alltid passer med radene.
function etiketterFor(svar, intervall, omr, tz, dag24) {
    if (intervall !== 'time' && Array.isArray(svar?.meta?.time_labels)) return svar.meta.time_labels.map(String);
    return tidsetiketter(intervall, { first: omr.first, last: omr.last, tz, dag24 });
}

// Én eller flere metrikker per tidspunkt, med sammenligning etter plass (punkt nr. i mot
// punkt nr. i, som Plausible) når smlSvar er med.
export function byggSerie(svar, metrics, intervall, per, smlSvar) {
    const omr = { first: per.first, last: per.grafLast };
    const etiketter = etiketterFor(svar, intervall, omr, per.tz, per.dag24 && intervall === 'time');
    const verdier = tidsverdier(svar, metrics, intervall);
    const status = punktstatus(intervall, etiketter, { ...omr, tz: per.tz, naa: per.naa });
    let smlEtiketter = null, smlVerdier = null;
    if (smlSvar) {
        smlEtiketter = etiketterFor(smlSvar, intervall, per.sml, per.tz, false).map((e) => e.slice(0, LENGDE[intervall]));
        smlVerdier = tidsverdier(smlSvar, metrics, intervall);
    }
    const punkter = etiketter.map((e, i) => {
        const t = e.slice(0, LENGDE[intervall]);
        const v = verdier.get(t);
        const p = { t, verdier: metrics.map((m, j) => v?.[j] ?? tomVerdi(m)), ...status[i] };
        if (smlEtiketter && i < smlEtiketter.length) {
            const s = smlVerdier.get(smlEtiketter[i]);
            p.smlVerdier = metrics.map((m, j) => s?.[j] ?? tomVerdi(m));
        }
        return p;
    });
    return { punkter, smlEtiketter };
}

async function delGraf(ctx, metrikk, intervall) {
    const { apiNokkel, nettsted, per, filtre } = ctx;
    // Konverteringsrate tegnes som group_conversion_rate, som i Plausible
    const m = metrikk === 'conversion_rate' ? 'group_conversion_rate' : metrikk;
    const q = (range, trim) => sporV2(apiNokkel, sporring(nettsted, { metrics: [m], range, dims: [INTERVALL_DIM[intervall]], filtre, etiketter: true, trim }));
    const [hoved, sml] = await Promise.all([q(per.range, per.trim), per.sml ? q(per.sml.range, false) : null]);
    const serie = byggSerie(hoved.data, [m], intervall, per, sml?.data);
    const ut = {
        metric: metrikk,
        intervall,
        punkter: serie.punkter.map((p) => {
            const o = { t: p.t, v: p.verdier[0] };
            if (p.smlVerdier) o.sml_v = p.smlVerdier[0];
            if (p.delvis) o.delvis = true;
            if (p.senere) o.senere = true;
            return o;
        }),
        merknader: merknader([hoved.data, sml?.data], { nettsted }),
    };
    if (serie.smlEtiketter) ut.sml_etiketter = serie.smlEtiketter;
    return { hentet: [hoved.hentet, ...(sml ? [sml.hentet] : [])], verdi: ut };
}

// ── Lister ──

// Sanntid: listene viser de siste 5 minuttene, mål de siste 30 (som Plausible)
const omradeFor = (per, rap, k) => (k.sanntid && rap.type !== 'mal' ? per.range5 : per.range);

// Hvilke inntektskolonner listen skal ha. Mål uten målfilter: spør alltid med inntekt og se på
// svaret om nettstedet har inntektsmål (sjekk = true), så det ikke koster en ekstra spørring.
async function inntektFor(ctx, rap) {
    const { apiNokkel, nettsted, filtre, k } = ctx;
    if (rap.type === 'mal') return k.mal ? { inntekt: (await inntektsinfo(apiNokkel, nettsted)).har } : { inntekt: true, sjekk: true };
    if (k.mal) return { inntektFilter: inntektIFilter(filtre, (await inntektsinfo(apiNokkel, nettsted)).liste) };
    return {};
}

function synligeMetrikker(metrics, svar, sjekk, nettsted) {
    if (!sjekk) return metrics;
    const har = !harInntektsvarsel(svar);
    settInntekt(nettsted, har);
    return har ? metrics : metrics.filter((m) => !INNTEKT.includes(m));
}

function lagListe(rap, svar, alle, vis, k, nettsted, utregnet = () => undefined) {
    const radene = rader(svar).map((r) => {
        const rad = lagRad(r, alle.filter((m) => !UTREGNET.has(m)), rap, nettsted);
        const verdier = {};
        for (const m of vis) verdier[m] = UTREGNET.has(m) ? utregnet(m, r) ?? null : rad.verdier[m];
        rad.verdier = verdier;
        if (!vis.some((m) => INNTEKT.includes(m))) delete rad.valuta;
        return rad;
    });
    return {
        rapport: rap.navn,
        kolonner: vis.map((m) => ({ key: m, etikett: kolonneEtikett(m, rap, k) })),
        rader: radene,
        totalt_rader: Number.isInteger(svar?.meta?.total_rows) ? svar.meta.total_rows : radene.length,
    };
}

async function delListe(ctx, rap) {
    const { apiNokkel, nettsted, per, filtre, k } = ctx;
    const valg = await inntektFor(ctx, rap);
    const metrics = metrikker(rap, k, valg);
    const grense = rap.grense || 9;
    const svar = await sporV2(apiNokkel, sporring(nettsted, {
        metrics, range: omradeFor(per, rap, k), dims: rap.dims, filtre, ekstraFiltre: rap.alltid, limit: grense, totalRader: true,
        order: rap.navn === 'kart' ? [['visitors', 'desc']] : sortering(rap.dims),
    }), k.sanntid ? LEVENDE_MS : LAGER_MS);
    const vis = utenTommeInntekter(synligeMetrikker(metrics, svar.data, valg.sjekk, nettsted), rader(svar.data), metrics);
    const liste = lagListe(rap, svar.data, metrics, vis, k, nettsted);
    liste.flere = liste.totalt_rader > liste.rader.length;
    liste.merknader = merknader([svar.data], { skjulInntekt: !vis.includes('total_revenue'), nettsted });
    return { hentet: [svar.hentet], verdi: liste };
}

// ── /detaljer: 100 rader per side, søk og sortering ──

export const DETALJ_SIDE = 100;
const rundEn = (x) => Math.sign(x) * Math.round(Math.abs(x) * 10) / 10;

export function lesDetaljvalg(sp, opp) {
    const rap = finnRapport(sp.get('rapport'), opp.egenskaper);
    if (!rap || rap.kunListe) throw new Ugyldig('Ukjent rapport.');
    const sok = (sp.get('sok') ?? '').trim();
    if (sok.length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(sok)) throw new Ugyldig('Ugyldig søk.');
    const s = sp.get('sorter');
    let sorter = null;
    if (s != null) {
        const m = /^(navn|[a-z_]{1,30}):(asc|desc)$/.exec(s);
        if (!m) throw new Ugyldig('Ugyldig sortering.');
        sorter = [m[1], m[2]];
    }
    const sideRaa = sp.get('side') ?? '0';
    if (!/^\d{1,2}$/.test(sideRaa) || Number(sideRaa) > 50) throw new Ugyldig('Ugyldig side.');
    return { rap, sok, sorter, side: Number(sideRaa) };
}

export async function detaljer(ctx, { rap, sok, sorter, side }) {
    const { apiNokkel, nettsted, per, filtre, k } = ctx;
    const valg = await inntektFor(ctx, rap);
    const alle = metrikker(rap, k, { ...valg, detaljert: true });
    const spor = alle.filter((m) => !UTREGNET.has(m));
    const navnDim = rap.vert != null ? rap.dims[rap.verdi] : rap.dims[0];
    // Valgt kolonne først, så dimensjonene stigende (som dashbordets detaljvisning)
    let order = sortering(rap.dims);
    if (sorter) {
        if (sorter[0] === 'navn') {
            // event:goal kan ikke stå i order_by hos Plausible
            if (rap.ikkeNavnSortering) throw new Ugyldig('Denne listen kan ikke sorteres på navn.');
            order = sortering(rap.dims, [[navnDim, sorter[1]]]);
        } else if (spor.includes(sorter[0])) {
            order = sortering(rap.dims, [[sorter[0], sorter[1]]]);
        } else {
            throw new Ugyldig('Kan ikke sortere på den kolonnen.');
        }
    }
    // Søket er et «inneholder»-filter uten store/små bokstaver, som i Plausibles detaljvisning
    const sokFilter = sok ? [['contains', navnDim, [sok], { case_sensitive: false }]] : [];
    const range = omradeFor(per, rap, k);
    const ttl = k.sanntid ? LEVENDE_MS : LAGER_MS;
    const svar = await sporV2(apiNokkel, sporring(nettsted, {
        metrics: spor, range, dims: rap.dims, filtre, ekstraFiltre: [...(rap.alltid || []), ...sokFilter],
        order, limit: DETALJ_SIDE, offset: side * DETALJ_SIDE, totalRader: true,
    }), ttl);
    const hentet = [svar.hentet];
    const radene = rader(svar.data);
    const verdiIndeks = rap.verdi ?? 0;
    // Hjelpespørringene tar med importerte tall bare når hovedspørringen gjorde det (som Plausible)
    const imports = svar.data?.meta?.imports_included === true;
    const unike = (i) => [...new Set(radene.map((r) => r.dimensions?.[i]))].filter((v) => v != null && v !== '');

    // «Besøkende totalt» med målfilter: samme gruppe uten mål- og egenskapsfiltrene (Plausibles
    // total_visitors), avgrenset til radene på siden
    const totalt = new Map();
    if (alle.includes('total_visitors') && radene.length) {
        const dim = rap.dims[verdiIndeks];
        const verdier = unike(verdiIndeks).map((v) => (dim === 'visit:city' ? Number(v) : String(v)));
        if (verdier.length) {
            const t = await sporV2(apiNokkel, sporring(nettsted, {
                metrics: ['visitors'], range, dims: rap.dims, filtre: utenMalOgEgenskap(filtre),
                ekstraFiltre: [...(rap.alltid || []), ...sokFilter, ['is', dim, verdier]], limit: 1000, imports,
            }), ttl);
            hentet.push(t.hentet);
            for (const r of rader(t.data)) totalt.set(JSON.stringify(r.dimensions), metrikkverdi(r.metrics?.[0]));
        }
    }
    // Utgangsrate = utganger / sidevisninger på siden (Plausibles exit_rate), uten filtrene på utgangsside
    const visninger = new Map();
    if (alle.includes('exit_rate') && radene.length) {
        const stier = unike(verdiIndeks).map(String);
        if (stier.length) {
            const t = await sporV2(apiNokkel, sporring(nettsted, {
                metrics: ['pageviews'], range, dims: ['event:page'], filtre: filtre.filter((f) => f.dim !== 'visit:exit_page'),
                ekstraFiltre: [['is', 'event:page', stier]], limit: 1000, imports,
            }), ttl);
            hentet.push(t.hentet);
            for (const r of rader(t.data)) visninger.set(String(r.dimensions?.[0]), metrikkverdi(r.metrics?.[0]));
        }
    }
    const besokIndeks = spor.indexOf('visits');
    const utregnet = (m, r) => {
        if (m === 'total_visitors') return totalt.get(JSON.stringify(r.dimensions)) ?? null;
        const pv = visninger.get(String(r.dimensions?.[verdiIndeks]));
        const ut = metrikkverdi(r.metrics?.[besokIndeks]);
        return pv > 0 && ut != null ? rundEn((ut / pv) * 100) : null;
    };
    const vis = utenTommeInntekter(synligeMetrikker(alle, svar.data, valg.sjekk, nettsted), radene, spor);
    const liste = lagListe(rap, svar.data, alle, vis, k, nettsted, utregnet);
    liste.side = side;
    liste.flere = side * DETALJ_SIDE + liste.rader.length < liste.totalt_rader;
    liste.merknader = merknader([svar.data], { skjulInntekt: !vis.includes('total_revenue'), nettsted });
    return { hentet, verdi: liste };
}
