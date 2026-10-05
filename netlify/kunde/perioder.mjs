// DOTDEV · kundeportalen: perioder, sammenligninger og tidsetiketter.
//
// Alt regnes i nettstedets tidssone, nøyaktig slik Plausible gjør det, så tallene blir de samme
// som i Plausible-dashbordet. Portert fra Plausible (lib/plausible/stats/query_period.ex,
// comparisons.ex, compare.ex og time.ex) og dashbordet (assets/js/…/graph/intervals.ts).
//
// Rene funksjoner uten nett og uten egen klokke: «naa» (millisekunder) sendes inn, så alt kan
// testes med en hvilken som helst dato. Bare Intl og Date, ingen pakker.

export class Ugyldig extends Error {}          // blir 400 { feil: melding } i API-et

const DAG = 86400000;
const TIME = 3600000;
const MIN_DATO = '2019-01-01';                 // eldste dato kunden kan velge
const pad = (n) => String(n).padStart(2, '0');

// Periodene kunden kan velge (URL «periode»). Plausible-navnet står i kommentaren.
export const PERIODER = {
    sanntid: {},            // realtime
    dag: {},                // day (+ dato)
    '24t': {},              // 24h
    '7d': { dager: 7 }, '28d': { dager: 28 }, '30d': { dager: 30 }, '91d': { dager: 91 },
    mnd: {},                // month (+ dato)
    aar: {},                // year (+ dato)
    '6mnd': { maneder: 6 }, '12mnd': { maneder: 12 },
    alt: {},                // all
    egen: {},               // custom (fra, til)
};
export const ALIASER = { idag: 'dag', '12m': '12mnd' };   // gamle navn fra første versjon av portalen
export const STANDARD_PERIODE = '28d';                     // Plausibles standard
export const SAMMENLIGNINGER = ['av', 'forrige', 'aar', 'egen'];

// ── Datoer som tekst «ÅÅÅÅ-MM-DD» (regnet som UTC-midnatt, så de aldri forskyves) ──

const tilMs = (d) => Date.parse(d + 'T00:00:00Z');
const tilDato = (t) => new Date(t).toISOString().slice(0, 10);

export function gyldigDato(d) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const t = tilMs(d);
    return Number.isFinite(t) && tilDato(t) === d;       // 2026-02-30 osv. avvises
}
export const plussDager = (d, n) => tilDato(tilMs(d) + n * DAG);
export const dagerMellom = (a, b) => Math.round((tilMs(a) - tilMs(b)) / DAG);      // a − b
export const ukedag = (d) => ((new Date(tilMs(d)).getUTCDay() + 6) % 7) + 1;       // mandag 1 … søndag 7, som Elixir
const dagerIManed = (aar, mnd) => new Date(Date.UTC(aar, mnd, 0)).getUTCDate();

// Som Elixir Date.shift(month: n): 31. mars minus én måned blir 28./29. februar, ikke 3. mars
export function plussManeder(d, n) {
    const [a, m, dg] = d.split('-').map(Number);
    const tot = a * 12 + m - 1 + n;
    const na = Math.floor(tot / 12), nm = tot - na * 12 + 1;
    return `${na}-${pad(nm)}-${pad(Math.min(dg, dagerIManed(na, nm)))}`;
}
export const forsteIManed = (d) => d.slice(0, 8) + '01';
export const sisteIManed = (d) => d.slice(0, 8) + pad(dagerIManed(Number(d.slice(0, 4)), Number(d.slice(5, 7))));
export const ukestart = (d) => plussDager(d, 1 - ukedag(d));

// ── Tidssoner (bare Intl) ──
// «Naiv» tid = veggklokka i tidssonen skrevet som om den var UTC. Da blir dato- og timeregning enkel.

const formatere = new Map();
function formater(tz) {
    let f = formatere.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
        });
        formatere.set(tz, f);
    }
    return f;
}

export function gyldigTidssone(tz) {
    if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return false;
    try { formater(tz); return true; } catch { return false; }
}

export function naiv(tz, t) {
    const d = {};
    for (const x of formater(tz).formatToParts(new Date(t))) d[x.type] = x.value;
    return Date.UTC(Number(d.year), Number(d.month) - 1, Number(d.day), Number(d.hour) % 24, Number(d.minute), Number(d.second));
}
const forskyvning = (tz, t) => naiv(tz, t) - Math.floor(t / 1000) * 1000;
export const lokalDato = (tz, t) => tilDato(naiv(tz, t));
export const klokke = (tz, t) => new Date(naiv(tz, t)).toISOString().slice(11, 16);

// Lokal dato + sekunder etter midnatt → tidspunkt. Når klokka stilles, velges det samme som Elixir
// (DateTimeRange.new!): starten av en dag tar første tidspunkt etter et hull og den SENESTE av to
// like klokkeslett, slutten av en dag tar siste tidspunkt før hullet og den TIDLIGSTE av to like.
export function lokalTilUtc(tz, d, sekunder, sluttAvDag) {
    const n = tilMs(d) + sekunder * 1000;
    const treff = [...new Set([n - DAG, n, n + DAG].map((x) => n - forskyvning(tz, x)))]
        .filter((t) => naiv(tz, t) === n).sort((a, b) => a - b);
    if (treff.length) return sluttAvDag ? treff[0] : treff[treff.length - 1];
    // Klokkeslettet finnes ikke (klokka hoppet fram): finn overgangen med binærsøk på hele sekunder
    const etter = forskyvning(tz, n + DAG);
    let lo = n - etter, hi = n - forskyvning(tz, n - DAG);
    while (hi - lo > 1000) {
        const midt = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (forskyvning(tz, midt) === etter) hi = midt; else lo = midt;
    }
    return sluttAvDag ? hi - 1000 : hi;
}
export const dagStart = (tz, d) => lokalTilUtc(tz, d, 0, false);
export const dagSlutt = (tz, d) => lokalTilUtc(tz, d, 86399, true);

// Tidspunkt til Plausible sendes i UTC med hele sekunder (Plausible gjør dem om til nettstedets sone)
export const isoUtc = (t) => new Date(Math.floor(t / 1000) * 1000).toISOString().slice(0, 19) + 'Z';
export function isoLokal(tz, t) {
    const o = Math.round(forskyvning(tz, t) / 60000), a = Math.abs(o);
    return new Date(naiv(tz, t)).toISOString().slice(0, 19) + (o < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
}

// ── Periodene ──

// Leser URL-verdiene og regner ut perioden, sammenligningene og grafintervallene.
// inn: { periode, dato, fra, til, sml, sml_fra, sml_til, ukedag, tz, naa, altStart }
// (strengene slik de kom i adressen, undefined når de mangler). Kaster Ugyldig ved feil.
export function lagPeriode(inn) {
    const { tz, naa } = inn;
    let key = inn.periode == null || inn.periode === '' ? STANDARD_PERIODE : inn.periode;
    if (Object.hasOwn(ALIASER, key)) key = ALIASER[key];
    if (!Object.hasOwn(PERIODER, key)) throw new Ugyldig('Ukjent periode.');
    if (inn.dato != null && !['dag', 'mnd', 'aar'].includes(key)) throw new Ugyldig('dato kan bare brukes med periode dag, mnd eller aar.');
    if ((inn.fra != null || inn.til != null) && key !== 'egen') throw new Ugyldig('fra og til kan bare brukes med periode egen.');

    const idag = lokalDato(tz, naa);
    // Perioder som slutter «nå» bruker nå i hele sekunder, som Plausible. API-et holder «nå» fast
    // i ett minutt per nettsted (se lesPeriode i statistikk.mjs), så like visninger innen samme
    // minutt gir samme spørring og treff i mellomlageret.
    const naaQ = Math.floor(naa / 1000) * 1000;
    const p = { key, tz, idag, naa, levende: false, datetime: false, trim: false, dag24: false };

    const valgtDato = () => {
        const d = inn.dato ?? idag;
        if (!gyldigDato(d) || d < MIN_DATO) throw new Ugyldig('Ugyldig dato.');
        return d;
    };

    if (key === 'sanntid') {
        // Som Plausible: siste 30 minutter for tallene øverst og mål, siste 5 minutter for listene
        p.levende = true;
        p.last = naaQ + 5000;
        p.first = naaQ - 30 * 60000;
        p.first5 = naaQ - 5 * 60000;
        p.range = [isoUtc(p.first), isoUtc(p.last)];
        p.range5 = [isoUtc(p.first5), isoUtc(p.last)];
    } else if (key === 'dag') {
        const d = valgtDato();
        if (d > idag) throw new Ugyldig('Ugyldig dato.');
        p.dag = d;
        p.dag24 = true;
        p.first = dagStart(tz, d);
        if (d === idag) {
            // «I dag» er fra midnatt til nå, og sammenlignes med samme klokkeslett (Plausible «day»)
            p.last = Math.min(naaQ, dagSlutt(tz, d));
            p.levende = p.datetime = true;
            p.range = [isoUtc(p.first), isoUtc(p.last)];
        } else {
            p.last = dagSlutt(tz, d);
            p.range = [d, d];
        }
        p.forrigeDato = d > MIN_DATO ? plussDager(d, -1) : null;
        p.nesteDato = d < idag ? plussDager(d, 1) : null;
    } else if (key === '24t') {
        p.last = naaQ;
        p.first = naaQ - 24 * TIME;
        p.levende = p.datetime = true;
        p.range = [isoUtc(p.first), isoUtc(p.last)];
    } else if (PERIODER[key].dager) {
        // N hele dager som slutter i går (Plausible «Nd» tar ikke med i dag)
        const n = PERIODER[key].dager;
        p.first = dagStart(tz, plussDager(idag, -n));
        p.last = dagSlutt(tz, plussDager(idag, -1));
        p.range = `${n}d`;
    } else if (key === 'mnd') {
        const d = forsteIManed(valgtDato());
        if (d > forsteIManed(idag)) throw new Ugyldig('Ugyldig dato.');
        p.dag = d;
        p.first = dagStart(tz, d);
        p.last = dagSlutt(tz, sisteIManed(d));
        if (d === forsteIManed(idag)) { p.range = 'month'; p.trim = p.levende = true; }
        else p.range = [d, sisteIManed(d)];
        p.forrigeDato = d > forsteIManed(MIN_DATO) ? plussManeder(d, -1) : null;
        p.nesteDato = d < forsteIManed(idag) ? plussManeder(d, 1) : null;
    } else if (key === 'aar') {
        const aar = valgtDato().slice(0, 4);
        if (aar > idag.slice(0, 4)) throw new Ugyldig('Ugyldig dato.');
        const d = `${aar}-01-01`;
        p.dag = d;
        p.first = dagStart(tz, d);
        p.last = dagSlutt(tz, `${aar}-12-31`);
        if (aar === idag.slice(0, 4)) { p.range = 'year'; p.trim = p.levende = true; }
        else p.range = [d, `${aar}-12-31`];
        p.forrigeDato = d > MIN_DATO ? `${Number(aar) - 1}-01-01` : null;
        p.nesteDato = aar < idag.slice(0, 4) ? `${Number(aar) + 1}-01-01` : null;
    } else if (PERIODER[key].maneder) {
        // N hele måneder som slutter forrige måned (Plausible «Nmo» tar ikke med denne måneden)
        const n = PERIODER[key].maneder;
        p.first = dagStart(tz, forsteIManed(plussManeder(idag, -n)));
        p.last = dagSlutt(tz, sisteIManed(plussManeder(idag, -1)));
        p.range = `${n}mo`;
    } else if (key === 'alt') {
        // Fra første besøk (Plausible «stats_start_date», hentet av API-et) til og med i dag
        const start = gyldigDato(inn.altStart) && inn.altStart <= idag ? inn.altStart : idag;
        p.first = dagStart(tz, start);
        p.last = dagSlutt(tz, idag);
        p.range = 'all';
        p.levende = true;
    } else {
        const { fra, til } = inn;
        if (!gyldigDato(fra) || !gyldigDato(til) || fra < MIN_DATO || til > idag || fra > til) {
            throw new Ugyldig('Ugyldige datoer: fra og til må være fra 2019-01-01 til i dag, og fra kan ikke være etter til.');
        }
        p.first = dagStart(tz, fra);
        p.last = dagSlutt(tz, til);
        p.range = [fra, til];
        p.levende = til === idag;
    }

    // Datoene som vises: perioder som går forbi i dag (denne måneden, i år), kuttes ved i dag,
    // som Plausibles Query.date_range(trim_trailing: true). Sammenligningen regnes fra dette.
    const f = lokalDato(tz, p.first), l = lokalDato(tz, p.last);
    p.fraDato = f;
    p.tilDato = idag < f ? f : idag > l ? l : idag;
    // Grafen slutter samme sted (Plausible sender trim_relative_date_range for disse)
    p.grafLast = p.trim ? dagSlutt(tz, p.tilDato) : p.last;
    // Klokkeslettene som vises, regnes fra nå (24t flytter begge ender, «i dag» bare slutten)
    p.forskyv = p.datetime && p.last === naaQ ? naaQ - naa : 0;
    p.forskyvStart = key === '24t' ? p.forskyv : 0;
    if (p.datetime) { p.fraKl = klokke(tz, p.first - p.forskyvStart); p.tilKl = klokke(tz, p.last - p.forskyv); }

    // Sammenligning. Tallene øverst sammenlignes ALLTID med forrige periode (som i Plausible),
    // med «samme ukedag» som standard. Velger kunden en sammenligning, brukes den i stedet.
    const modus = inn.sml == null || inn.sml === '' ? 'av' : inn.sml;
    if (!SAMMENLIGNINGER.includes(modus)) throw new Ugyldig('Ukjent sammenligning.');
    if (inn.ukedag != null && inn.ukedag !== '1' && inn.ukedag !== '0') throw new Ugyldig('ukedag må være 1 eller 0.');
    const matchUkedag = inn.ukedag !== '0';
    if ((inn.sml_fra != null || inn.sml_til != null) && modus !== 'egen') throw new Ugyldig('sml_fra og sml_til kan bare brukes med sml=egen.');
    p.matchUkedag = matchUkedag;
    p.sml = null;
    p.endring = null;
    let egen = null;
    if (modus === 'egen') {
        const { sml_fra: sf, sml_til: st } = inn;
        if (!gyldigDato(sf) || !gyldigDato(st) || sf < MIN_DATO || st > idag || sf > st) {
            throw new Ugyldig('Ugyldige datoer for sammenligningen: sml_fra og sml_til må være fra 2019-01-01 til i dag.');
        }
        egen = { fra: sf, til: st };
    }
    if (key === 'sanntid' || key === 'alt') {
        if (modus !== 'av') throw new Ugyldig('Sammenligning finnes ikke for denne perioden.');
    } else {
        const plMod = { av: 'previous_period', forrige: 'previous_period', aar: 'year_over_year', egen: 'egen' }[modus];
        p.endring = sammenligning(p, plMod, matchUkedag, egen);
        if (modus !== 'av') p.sml = { modus, ...p.endring };
    }

    settIntervaller(p, egen, inn.altStart);
    return p;
}

function omrade(tz, first, last, range, medKlokke, forskyvStart = 0, forskyv = 0) {
    // Som DateTimeRange.new!: står slutten før starten (29. februar minus ett år), byttes de om
    if (first > last) {
        [first, last] = [last, first];
        if (medKlokke) range = [range[1], range[0]];
    }
    const o = { first, last, range, fra: lokalDato(tz, first), til: lokalDato(tz, last) };
    if (medKlokke) { o.fraKl = klokke(tz, first - forskyvStart); o.tilKl = klokke(tz, last - forskyv); }
    return o;
}

// Plausibles shift_to_nearest: «nærmeste» samme ukedag er i praksis den neste, unntatt når det er
// selve startdatoen i hovedperioden (da den forrige). Rekkefølgen kommer av sort_by(Date.diff(dato, x)).
function narmeste(dow, d, avvis) {
    if (ukedag(d) === dow) return d;
    let fram = dow - ukedag(d); if (fram <= 0) fram += 7;
    let bak = ukedag(d) - dow; if (bak <= 0) bak += 7;
    return [plussDager(d, fram), plussDager(d, -bak)].find((x) => x !== avvis);
}

// Som Elixir DateTime.shift(utc, year: n): samme klokkeslett i UTC, 29. februar blir 28.
function plussAarUtc(t, n) {
    const d = tilDato(t);
    return tilMs(plussManeder(d, 12 * n)) + (t - tilMs(d));
}

// Plausible.Stats.Comparisons.get_comparison_utc_time_range
function sammenligning(p, modus, matchUkedag, egen) {
    const { tz } = p;
    if (p.datetime) {
        // «I dag» og «24 timer»: hele tidspunkter flyttes, så det blir samme klokkeslett
        if (modus === 'egen') return omrade(tz, dagStart(tz, egen.fra), dagSlutt(tz, egen.til), [egen.fra, egen.til]);
        let a, b;
        if (modus === 'previous_period') {
            const flytt = matchUkedag ? 7 * DAG : DAG;
            a = p.first - flytt;
            b = p.last - flytt;
        } else {
            a = plussAarUtc(p.first, -1);
            b = plussAarUtc(p.last, -1);
            if (matchUkedag) {
                const kilde = lokalDato(tz, p.first), sml = lokalDato(tz, a);
                const n = dagerMellom(narmeste(ukedag(kilde), sml, kilde), sml);
                a += n * DAG;
                b += n * DAG;
            }
        }
        return omrade(tz, a, b, [isoUtc(a), isoUtc(b)], true, p.forskyvStart, p.forskyv);
    }
    if (modus === 'egen') return omrade(tz, dagStart(tz, egen.fra), dagSlutt(tz, egen.til), [egen.fra, egen.til]);
    const f = p.fraDato, l = p.tilDato;
    let nf, nl;
    if (modus === 'year_over_year') {
        nf = plussManeder(f, -12);
        nl = plussDager(nf, dagerMellom(l, f));
    } else {
        const flytt = dagerMellom(f, l) - 1;          // like mange dager bakover som perioden er lang
        nf = plussDager(f, flytt);
        nl = plussDager(l, flytt);
    }
    if (matchUkedag) {
        const m = narmeste(ukedag(f), nf, f);
        nl = plussDager(nl, dagerMellom(m, nf));
        nf = m;
    }
    return omrade(tz, dagStart(tz, nf), dagSlutt(tz, nl), [nf, nl]);
}

// ── Grafintervaller (dashbordets intervals.ts). «minute» finnes ikke i det offentlige API-et. ──

const FASTE_INTERVALLER = {
    dag: ['minute', 'hour'], '24t': ['minute', 'hour'], '7d': ['hour', 'day'],
    '28d': ['day', 'week'], '30d': ['day', 'week'], '91d': ['day', 'week', 'month'], mnd: ['day', 'week'],
    '6mnd': ['day', 'week', 'month'], '12mnd': ['day', 'week', 'month'], aar: ['day', 'week', 'month'],
};
const FASTE_STANDARD = { dag: 'hour', '24t': 'hour', '7d': 'day', '6mnd': 'month', '12mnd': 'month', aar: 'month' };
const GROVHET = { minute: 0, hour: 1, day: 2, week: 3, month: 4 };
export const INTERVALL_NAVN = { hour: 'time', day: 'dag', week: 'uke', month: 'mnd' };
export const INTERVALL_DIM = { time: 'time:hour', dag: 'time:day', uke: 'time:week', mnd: 'time:month' };

// dayjs: a.diff(b, 'days') og a.diff(b, 'months') kuttet mot null, med datoene som naiv tid
const kutt = (x) => (x < 0 ? Math.ceil(x) || 0 : Math.floor(x));
function leggTilMnd(t, n) {
    const d = tilDato(t);
    return tilMs(plussManeder(d, n)) + (t - tilMs(d));
}
function manedsdiff(a, b) {
    if (new Date(a).getUTCDate() < new Date(b).getUTCDate()) return -manedsdiff(b, a);
    const hel = (new Date(b).getUTCFullYear() - new Date(a).getUTCFullYear()) * 12 + (new Date(b).getUTCMonth() - new Date(a).getUTCMonth());
    const anker = leggTilMnd(a, hel);
    const c = b - anker < 0;
    const anker2 = leggTilMnd(a, hel + (c ? -1 : 1));
    return +(-(hel + ((b - anker) / (c ? anker - anker2 : anker2 - anker)))) || 0;
}
function egneIntervaller(fra, til) {
    const dager = kutt((til - fra) / DAG), mnd = kutt(manedsdiff(til, fra));
    if (dager < 1) return ['minute', 'hour'];
    if (dager < 7) return ['hour', 'day'];
    if (mnd < 1) return ['day', 'week'];
    if (mnd < 12) return ['day', 'week', 'month'];
    return ['week', 'month'];
}
function egenStandard(fra, til) {
    const dager = kutt((til - fra) / DAG), mnd = kutt(manedsdiff(til, fra));
    if (dager < 1) return 'hour';
    if (dager < 30) return 'day';
    if (mnd < 6) return 'week';
    return 'month';
}
const grovest = (a, b) => (Math.max(...a.map((i) => GROVHET[i])) >= Math.max(...b.map((i) => GROVHET[i])) ? a : b);

function settIntervaller(p, egen, altStart) {
    if (p.key === 'sanntid') { p.intervaller = []; p.standardIntervall = null; return; }
    let gyldige, standard;
    if (p.key === 'egen') {
        gyldige = egneIntervaller(tilMs(p.fraDato), tilMs(lokalDato(p.tz, p.last)));
        standard = egenStandard(tilMs(p.fraDato), tilMs(lokalDato(p.tz, p.last)));
    } else if (p.key === 'alt') {
        const start = gyldigDato(altStart) ? tilMs(altStart) : tilMs(p.idag);
        gyldige = egneIntervaller(start, naiv(p.tz, p.naa));
        standard = gyldige.includes('day') ? 'day' : 'month';
    } else {
        gyldige = FASTE_INTERVALLER[p.key];
        standard = FASTE_STANDARD[p.key] ?? gyldige[0];
    }
    if (egen) {
        // Egen sammenligningsperiode: det grovere settet vinner, så begge periodene får mening
        const sg = egneIntervaller(tilMs(egen.fra), tilMs(egen.til));
        gyldige = grovest(gyldige, sg);
        if (!sg.includes(standard)) standard = egenStandard(tilMs(egen.fra), tilMs(egen.til));
    }
    p.intervaller = gyldige.filter((i) => i !== 'minute').map((i) => INTERVALL_NAVN[i]);
    const s = INTERVALL_NAVN[standard];
    p.standardIntervall = p.intervaller.includes(s) ? s
        : p.intervaller.includes('dag') ? 'dag' : p.intervaller.includes('mnd') ? 'mnd' : p.intervaller[0];
}

// ── Tidsetiketter og delvise/fremtidige punkter (Plausible.Stats.Time) ──

// Etikettene i samme format som Plausible: «ÅÅÅÅ-MM-DD HH:00:00» (time), «ÅÅÅÅ-MM-DD» (dag, uke)
// og «ÅÅÅÅ-MM-01» (måned). Uke = mandag, eller periodens første dag hvis mandagen er før perioden.
// Timer regnes på veggklokka, så en dag har alltid timene 00–23: dagen klokka stilles fram, får
// 02 tom, og dagen den stilles tilbake, får to rader for 02 som legges sammen (se grafen).
// dag24: hele døgnet vises, også timene som ikke har vært ennå.
export function tidsetiketter(intervall, { first, last, tz, dag24 }) {
    if (intervall === 'time') {
        let a = Math.floor(naiv(tz, first) / TIME) * TIME;
        let b = Math.floor(naiv(tz, last) / TIME) * TIME;
        if (dag24) { a = tilMs(lokalDato(tz, first)); b = a + 23 * TIME; }
        const ut = [];
        for (let t = a; t <= b; t += TIME) ut.push(new Date(t).toISOString().slice(0, 13).replace('T', ' ') + ':00:00');
        return ut;
    }
    const f = lokalDato(tz, first), l = lokalDato(tz, last);
    const ut = [];
    if (intervall === 'dag') {
        for (let d = f; d <= l; d = plussDager(d, 1)) ut.push(d);
    } else if (intervall === 'uke') {
        const n = Math.trunc(dagerMellom(l, ukestart(f)) / 7);
        for (let s = 0; s <= n; s++) {
            const d = plussDager(f, 7 * s), u = ukestart(d);
            ut.push(u >= f && u <= l ? u : d);
        }
    } else {
        for (let d = forsteIManed(f); d <= l; d = plussManeder(d, 1)) ut.push(d);
    }
    return ut;
}

const bokstart = (intervall, e) => (intervall === 'time' ? Date.parse(e.replace(' ', 'T') + 'Z')
    : tilMs(intervall === 'uke' ? ukestart(e) : e));
function bokslutt(intervall, e) {
    const s = bokstart(intervall, e);
    if (intervall === 'time') return s + TIME - 1000;
    if (intervall === 'dag') return s + DAG - 1000;
    if (intervall === 'uke') return s + 7 * DAG - 1000;
    return tilMs(plussManeder(tilDato(s), 1)) - 1000;
}

// Plausibles partial_time_labels: første punkt er delvis når perioden starter midt i det (f.eks. en
// uke), og punktet der perioden slutter (eller nå) er delvis når det ikke er helt over.
// Punkter som starter etter nå, er «senere» (bare dagen i dag, der hele døgnet vises).
export function punktstatus(intervall, etiketter, { first, last, tz, naa }) {
    const start = naiv(tz, first), now = naiv(tz, naa), kutt_ = Math.min(now, naiv(tz, last));
    return etiketter.map((e, i) => {
        const s = bokstart(intervall, e), slutt = bokslutt(intervall, e);
        const o = {};
        if (s > now) o.senere = true;
        else if ((i === 0 && start > s) || (s <= kutt_ && slutt > kutt_)) o.delvis = true;
        return o;
    });
}

// ── Endring (Plausible.Stats.Compare) ──

const tall = (x) => typeof x === 'number' && Number.isFinite(x);
const verdi = (x) => (x && typeof x === 'object' ? x.value : x);           // inntekt kommer som { value, … }
const rundAvHel = (x) => Math.sign(x) * Math.round(Math.abs(x));             // Elixir round: halv bort fra null
const rund = (x, n) => { const f = 10 ** n; return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f; };

// Prosent som heltall; fluktfrekvens i prosentpoeng; konverteringsrate i poeng med én desimal
export function endring(metrikk, gammel, ny) {
    gammel = verdi(gammel);
    ny = verdi(ny);
    if (!tall(gammel) || !tall(ny)) return null;
    if (metrikk === 'conversion_rate') return rund(ny - gammel, 1);
    if (metrikk === 'bounce_rate') return gammel > 0 ? rund(ny - gammel, 2) : null;
    if (gammel === 0) return ny > 0 ? 100 : ny === 0 ? 0 : null;
    return rundAvHel(((ny - gammel) / gammel) * 100);
}
