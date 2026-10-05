// DOTDEV · kundeportalen: «Last ned» – en ZIP med CSV-filer, som Plausibles «Export stats».
//
// Samme filnavn, kolonnenavn, metrikker, sortering og radgrenser som Plausible
// (lib/plausible/stats/dashboard/csv_export.ex og dashbordets csv-export-body.ts), så filene kan
// brukes på samme måte. Høyst 6 spørringer samtidig; en side kan laste ned én gang i minuttet.
// En nedlasting koster 22 spørringer + én per egenskap (høyst MAKS_EGENSKAPER), altså høyst 32.

import { INTERVALL_DIM, tidsetiketter } from './perioder.mjs';
import { sporV2, LAGER_MS } from './plausible.mjs';
import { INTERNE_EGENSKAPER } from './filtre.mjs';
import { RAPPORTER, metrikker, sporring, rader, metrikkverdi, UTREGNET } from './rapporter.mjs';
import { lagCsv, lagZip } from './zip.mjs';

const SAMTIDIG = 6;
const MAKS_EGENSKAPER = 10;

// Filnavn → rapport, i Plausibles rekkefølge
const FILER = [
    ['pages.csv', 'sider'], ['entry_pages.csv', 'inngang'], ['exit_pages.csv', 'utgang'],
    ['browsers.csv', 'nettlesere'], ['browser_versions.csv', 'nettleserversjoner'],
    ['operating_systems.csv', 'os'], ['operating_system_versions.csv', 'osversjoner'], ['devices.csv', 'skjerm'],
    ['channels.csv', 'kanaler'], ['sources.csv', 'kilder'], ['referrers.csv', 'henvisninger'],
    ['utm_mediums.csv', 'utm_medium'], ['utm_sources.csv', 'utm_source'], ['utm_campaigns.csv', 'utm_campaign'],
    ['utm_contents.csv', 'utm_content'], ['utm_terms.csv', 'utm_term'],
    ['countries.csv', 'land'], ['regions.csv', 'regioner'], ['cities.csv', 'byer'],
];

// Kolonnenavn (csv_first_row i csv_export.ex)
function metrikkNavn(metrics, dims, malFilter) {
    let over = {};
    if (malFilter) {
        if (dims[0].startsWith('time:')) over = { visitors: 'unique_conversions', events: 'total_conversions', group_conversion_rate: 'conversion_rate' };
        else if (dims[0] === 'event:goal') over = { visitors: 'unique_conversions', events: 'total_conversions' };
        else over = { visitors: 'conversions', group_conversion_rate: 'conversion_rate' };
    } else if (dims.length === 1 && dims[0] === 'visit:entry_page') over = { visitors: 'unique_entrances', visits: 'total_entrances' };
    else if (dims.length === 1 && dims[0] === 'visit:exit_page') over = { visitors: 'unique_exits', visits: 'total_exits' };
    else if (dims.length === 1 && dims[0] === 'event:goal') over = { visitors: 'unique_conversions', events: 'total_conversions' };
    return metrics.map((m) => over[m] || m);
}
const versjoner = (dims) => dims.length === 2 && (dims[0] === 'visit:browser_version' || dims[0] === 'visit:os_version');

// Plausibles empty_metrics for tomme tidspunkter
const TOM = { visit_duration: null, time_on_page: null, scroll_depth: null };
const tom = (m) => (Object.hasOwn(TOM, m) ? null : 0);

async function besokendeCsv(ctx, intervall) {
    const { apiNokkel, nettsted, per, filtre, k } = ctx;
    const metrics = k.mal ? ['visitors', 'events', 'conversion_rate']
        : k.side ? ['visitors', 'pageviews', 'visits', 'bounce_rate', 'time_on_page', 'scroll_depth']
            : ['visitors', 'pageviews', 'visits', 'views_per_visit', 'bounce_rate', 'visit_duration'];
    const dim = INTERVALL_DIM[intervall];
    const { data } = await sporV2(apiNokkel, sporring(nettsted, {
        metrics, range: per.range, dims: [dim], filtre, order: [[dim, 'asc']], etiketter: true, trim: per.trim,
    }), LAGER_MS);
    const etiketter = Array.isArray(data?.meta?.time_labels) ? data.meta.time_labels.map(String)
        : tidsetiketter(intervall, { first: per.first, last: per.grafLast, tz: per.tz });
    const verdier = new Map();
    for (const r of rader(data)) {
        const t = String(r.dimensions?.[0] ?? '');
        const v = metrics.map((m, i) => metrikkverdi(r.metrics?.[i]));
        const f = verdier.get(t);
        // Natta klokka stilles tilbake kan samme time komme to ganger: tellingene legges sammen
        verdier.set(t, f ? f.map((x, i) => (['visitors', 'visits', 'pageviews', 'events'].includes(metrics[i]) ? (x ?? 0) + (v[i] ?? 0) : x)) : v);
    }
    const tabell = [['date', ...metrikkNavn(metrics, [dim], k.mal)]];
    for (const e of etiketter) tabell.push([e, ...(verdier.get(e) || metrics.map(tom))]);
    return lagCsv(tabell);
}

async function rapportCsv(ctx, filnavn, rapNavn) {
    const { apiNokkel, nettsted, per, filtre, k } = ctx;
    const rap = { navn: rapNavn, ...RAPPORTER[rapNavn] };
    const dims = rap.csvDims || rap.dims;
    const alle = metrikker(rap, k, { csv: true });
    const spor = alle.filter((m) => !UTREGNET.has(m));
    // Plausible: 100 rader for sider og utgangssider, ellers 300; sortert på besøkende, så navn
    const limit = filnavn === 'pages.csv' || filnavn === 'exit_pages.csv' ? 100 : 300;
    const order = rap.type === 'mal' ? [['visitors', 'desc']] : [['visitors', 'desc'], ...dims.map((d) => [d, 'asc'])];
    const { data } = await sporV2(apiNokkel, sporring(nettsted, {
        metrics: spor, range: per.range, dims, filtre, ekstraFiltre: rap.alltid, order, limit,
    }), LAGER_MS);
    const radene = rader(data);
    // Hjelpespørringen tar med importerte tall bare når hovedspørringen gjorde det (som Plausible)
    const imports = data?.meta?.imports_included === true;
    const visninger = new Map();
    if (alle.includes('exit_rate') && radene.length) {
        const stier = [...new Set(radene.map((r) => r.dimensions?.[0]))].filter((s) => typeof s === 'string' && s);
        if (stier.length) {
            const t = await sporV2(apiNokkel, sporring(nettsted, {
                metrics: ['pageviews'], range: per.range, dims: ['event:page'], filtre: filtre.filter((f) => f.dim !== 'visit:exit_page'),
                ekstraFiltre: [['is', 'event:page', stier]], limit: 1000, imports,
            }), LAGER_MS);
            for (const r of rader(t.data)) visninger.set(String(r.dimensions?.[0]), metrikkverdi(r.metrics?.[0]));
        }
    }
    const dimNavn = versjoner(dims) ? ['name', 'version'] : ['name'];
    const tabell = [[...dimNavn, ...metrikkNavn(alle, dims, k.mal)]];
    for (const r of radene) {
        const d = (r.dimensions || []).map((x) => (x == null ? '' : x));
        const ut = alle.map((m) => {
            if (m !== 'exit_rate') return metrikkverdi(r.metrics?.[spor.indexOf(m)]);
            const pv = visninger.get(String(d[0])), besok = metrikkverdi(r.metrics?.[spor.indexOf('visits')]);
            return pv > 0 && besok != null ? Math.round((besok / pv) * 1000) / 10 : null;
        });
        tabell.push([...(versjoner(dims) ? [...d].reverse() : d), ...ut]);
    }
    return lagCsv(tabell);
}

async function malCsv(ctx) {
    const { apiNokkel, nettsted, per, filtre, k } = ctx;
    const rap = { navn: 'mal', ...RAPPORTER.mal };
    const { data } = await sporV2(apiNokkel, sporring(nettsted, {
        metrics: ['visitors', 'events'], range: per.range, dims: ['event:goal'], filtre, order: [['visitors', 'desc']], limit: 300,
    }), LAGER_MS);
    const tabell = [['name', ...metrikkNavn(metrikker(rap, k, { csv: true }), ['event:goal'], k.mal)]];
    for (const r of rader(data)) tabell.push([String(r.dimensions?.[0] ?? ''), metrikkverdi(r.metrics?.[0]), metrikkverdi(r.metrics?.[1])]);
    return lagCsv(tabell);
}

// Egenskapene i custom_props.csv: med et egenskapsfilter bare den (som Plausible), ellers
// nettstedets egne (høyst MAKS_EGENSKAPER minus Plausibles egne) og Plausibles url, path og
// search_query, som alltid er tillatt.
export function egenskapsliste(filtre, egenskaper) {
    const filtrert = filtre.find((f) => f.nokkel.startsWith('egenskap:'));
    if (filtrert) return [filtrert.nokkel.slice(9)];
    const egne = (egenskaper || []).filter((e) => !INTERNE_EGENSKAPER.includes(e));
    return [...egne.slice(0, MAKS_EGENSKAPER - INTERNE_EGENSKAPER.length), ...INTERNE_EGENSKAPER];
}
// Antall spørringer en nedlasting høyst bruker (sjekkes mot kvoten før den starter)
export const eksportKall = (filtre, egenskaper) => 1 + FILER.length + 1 + egenskapsliste(filtre, egenskaper).length + 1;

const egenskapMetrikker = (k) => (k.mal ? ['visitors', 'events', 'conversion_rate'] : ['visitors', 'events', 'percentage']);

// Radene for én egenskap: [property, value, metrikker …]
async function egenskapRader(ctx, nokkel) {
    const { apiNokkel, nettsted, per, filtre, k } = ctx;
    const metrics = egenskapMetrikker(k);
    const dim = 'event:props:' + nokkel;
    const { data } = await sporV2(apiNokkel, sporring(nettsted, {
        metrics, range: per.range, dims: [dim], filtre, order: [['visitors', 'desc'], [dim, 'asc']], limit: 300,
    }), LAGER_MS);
    return rader(data).map((r) => [nokkel, String(r.dimensions?.[0] ?? ''), ...metrics.map((m, i) => metrikkverdi(r.metrics?.[i]))]);
}

// Kjører oppgavene med høyst SAMTIDIG om gangen. Feiler én, feiler hele nedlastingen.
async function iPuljer(oppgaver) {
    const ut = new Array(oppgaver.length);
    let neste = 0;
    const arbeider = async () => {
        while (neste < oppgaver.length) {
            const i = neste++;
            ut[i] = await oppgaver[i]();
        }
    };
    await Promise.all(Array.from({ length: Math.min(SAMTIDIG, oppgaver.length) }, arbeider));
    return ut;
}

export async function lagEksport(ctx, intervall, egenskaper) {
    // Hver egenskap er en egen oppgave, så de hentes samtidig (innenfor SAMTIDIG) og ikke etter tur
    const nokler = egenskapsliste(ctx.filtre, egenskaper);
    const oppgaver = [
        ['visitors.csv', () => besokendeCsv(ctx, intervall)],
        ...FILER.map(([fil, rap]) => [fil, () => rapportCsv(ctx, fil, rap)]),
        ...nokler.map((n) => ['egenskap', () => egenskapRader(ctx, n)]),
        ['conversions.csv', () => malCsv(ctx)],
    ];
    const innhold = await iPuljer(oppgaver.map(([, fn]) => fn));
    const filer = [];
    const egenskapsrader = [];
    oppgaver.forEach(([navn], i) => {
        if (navn === 'egenskap') { egenskapsrader.push(...innhold[i]); return; }
        if (navn === 'conversions.csv' && egenskapsrader.length) {
            // Én fil for alle egenskapene (property, value, metrikker); ingen rader → ingen fil
            filer.push({ navn: 'custom_props.csv', data: Buffer.from(lagCsv([['property', 'value', ...egenskapMetrikker(ctx.k)], ...egenskapsrader]), 'utf8') });
        }
        if (innhold[i] != null) filer.push({ navn, data: Buffer.from(innhold[i], 'utf8') });
    });
    return lagZip(filer);
}

// «DOTDEV statistikk dotdev.no 2026-09-06–2026-10-03.zip». Content-Disposition får et rent
// ASCII-navn og det fulle navnet kodet (RFC 6266/5987), så ingen tegn kan bryte headeren.
export function filnavn(nettsted, fra, til) {
    const sted = String(nettsted).toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const navn = `DOTDEV statistikk ${sted} ${fra}–${til}.zip`;
    const ascii = navn.replace('–', '-').replace(/[^A-Za-z0-9 ._-]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(navn)}`;
}
