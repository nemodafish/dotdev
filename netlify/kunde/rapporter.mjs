// DOTDEV · kundeportalen: listene («rapporter»), metrikkene og etikettene.
//
// Dimensjoner, metrikker og faste filtre er de samme som Plausibles dashbord bruker
// (assets/js/dashboard/stats/reports/reports-config.ts), så tallene blir like. Metrikker merket
// «regnes ut» finnes ikke i det offentlige API-et og regnes her med en ekstra spørring.

import { tilPlausible, kjentEgenskap } from './filtre.mjs';

const utenTomme = (dim) => [['is_not', dim, ['']]];
const LAND_FILTER = [['is_not', 'visit:country', ['\u0000\u0000', 'ZZ']]];

// navn: indeks i dimensjonene som er radens navn. verdi: indeksen som filteret bruker.
// kode/land/gruppe: indekser for landkode, flagg og «forelder» (nettleser for versjoner).
// type: hvilket metrikksett detaljvisningen bruker. sok: dimensjonen søket gjelder.
export const RAPPORTER = {
    kanaler: { dims: ['visit:channel'], filter: 'kanal' },
    kilder: { dims: ['visit:source'], filter: 'kilde' },
    henvisninger: { dims: ['visit:referrer'], filter: 'henvisning' },
    utm_medium: { dims: ['visit:utm_medium'], filter: 'utm_medium', alltid: utenTomme('visit:utm_medium') },
    utm_source: { dims: ['visit:utm_source'], filter: 'utm_source', alltid: utenTomme('visit:utm_source') },
    utm_campaign: { dims: ['visit:utm_campaign'], filter: 'utm_campaign', alltid: utenTomme('visit:utm_campaign') },
    utm_content: { dims: ['visit:utm_content'], filter: 'utm_content', alltid: utenTomme('visit:utm_content') },
    utm_term: { dims: ['visit:utm_term'], filter: 'utm_term', alltid: utenTomme('visit:utm_term') },
    sider: { dims: ['event:page'], filter: 'side', type: 'sider', lenke: true },
    sider_url: { dims: ['event:hostname', 'event:page'], filter: 'side', verdi: 1, vert: 0, type: 'sider', lenke: true },
    inngang: { dims: ['visit:entry_page'], filter: 'inngang', type: 'inngang', lenke: true, alltid: utenTomme('visit:entry_page') },
    inngang_url: { dims: ['visit:entry_page_hostname', 'visit:entry_page'], filter: 'inngang', verdi: 1, vert: 0, type: 'inngang', lenke: true, alltid: utenTomme('visit:entry_page') },
    utgang: { dims: ['visit:exit_page'], filter: 'utgang', type: 'utgang', lenke: true, alltid: utenTomme('visit:exit_page') },
    utgang_url: { dims: ['visit:exit_page_hostname', 'visit:exit_page'], filter: 'utgang', verdi: 1, vert: 0, type: 'utgang', lenke: true, alltid: utenTomme('visit:exit_page') },
    kart: { dims: ['visit:country_name', 'visit:country'], filter: 'land', verdi: 1, kode: 1, type: 'bare_besokende', alltid: LAND_FILTER, grense: 300, kunListe: true },
    land: { dims: ['visit:country_name', 'visit:country'], filter: 'land', verdi: 1, kode: 1, type: 'bare_besokende', alltid: LAND_FILTER, csvDims: ['visit:country_name'] },
    regioner: { dims: ['visit:region_name', 'visit:region', 'visit:country'], filter: 'region', verdi: 1, kode: 1, land: 2, type: 'bare_besokende', alltid: utenTomme('visit:region'), csvDims: ['visit:region_name'] },
    byer: { dims: ['visit:city_name', 'visit:city', 'visit:country'], filter: 'by', verdi: 1, kode: 1, land: 2, type: 'bare_besokende', alltid: [['is_not', 'visit:city', [0]]], csvDims: ['visit:city_name'] },
    nettlesere: { dims: ['visit:browser'], filter: 'nettleser', type: 'bare_besokende' },
    nettleserversjoner: { dims: ['visit:browser_version', 'visit:browser'], filter: 'nettleserversjon', gruppe: 1, type: 'bare_besokende' },
    os: { dims: ['visit:os'], filter: 'os', type: 'bare_besokende' },
    osversjoner: { dims: ['visit:os_version', 'visit:os'], filter: 'osversjon', gruppe: 1, type: 'bare_besokende' },
    skjerm: { dims: ['visit:device'], filter: 'skjerm', type: 'bare_besokende' },
    mal: { dims: ['event:goal'], filter: 'mal', type: 'mal', ikkeNavnSortering: true },
};

// Rapport fra URL: et navn over, eller «egenskap:<nøkkel>» (nøkkelen encodeURIComponent-kodet).
// Nøkkelen må være en av nettstedets egenskaper eller en av Plausibles egne (url, path, search_query).
export function finnRapport(navn, egenskaper) {
    if (typeof navn !== 'string') return null;
    if (navn.startsWith('egenskap:')) {
        let nokkel;
        try { nokkel = decodeURIComponent(navn.slice(9)); } catch { return null; }
        if (!kjentEgenskap(nokkel, egenskaper)) return null;
        return { navn, dims: ['event:props:' + nokkel], filter: 'egenskap:' + nokkel, type: 'egenskap', egenskap: nokkel };
    }
    return Object.hasOwn(RAPPORTER, navn) ? { navn, ...RAPPORTER[navn] } : null;
}

// ── Metrikksett (chooseMetrics i reports-config.ts, samme rekkefølge av regler) ──

const INNTEKT = ['total_revenue', 'average_revenue'];
const DETALJ = {
    sider: ['visitors', 'percentage', 'pageviews', 'bounce_rate', 'time_on_page', 'scroll_depth'],
    inngang: ['visitors', 'percentage', 'visits', 'bounce_rate', 'visit_duration'],
    utgang: ['visitors', 'percentage', 'visits', 'exit_rate'],
};
const CSV = {
    sider: ['visitors', 'pageviews', 'bounce_rate', 'time_on_page', 'scroll_depth'],
    inngang: ['visitors', 'visits', 'bounce_rate', 'visit_duration'],
    utgang: ['visitors', 'visits', 'exit_rate'],
    bare_besokende: ['visitors'],
};

// k: kontekst fra filtrene. inntekt: nettstedet har inntektsmål. inntektFilter: målfilteret
// gjelder inntektsmål med én valuta. detaljert / csv: detaljvisning eller nedlasting.
export function metrikker(r, k, { detaljert = false, csv = false, inntekt = false, inntektFilter = false } = {}) {
    if (r.type === 'mal') {
        if (csv) return ['visitors', 'events'];
        return ['visitors', 'events', 'conversion_rate', ...(inntekt ? INNTEKT : [])];
    }
    if (r.type === 'egenskap') {
        if (k.mal && inntektFilter && !csv) return ['visitors', 'events', 'conversion_rate', ...INNTEKT];
        if (k.mal) return ['visitors', 'events', 'conversion_rate'];
        return ['visitors', 'events', 'percentage'];
    }
    let m;
    if (csv && k.mal) m = ['visitors', 'group_conversion_rate'];
    else if (csv) m = CSV[r.type] || ['visitors', 'bounce_rate', 'visit_duration'];
    else if (k.mal && detaljert) m = ['total_visitors', 'visitors', 'group_conversion_rate', ...(inntektFilter ? INNTEKT : [])];
    else if (k.mal) m = ['visitors', 'group_conversion_rate'];
    else if (k.sanntid) m = ['visitors', 'percentage'];
    else if (detaljert) m = DETALJ[r.type] || ['visitors', 'percentage', 'bounce_rate', 'visit_duration'];
    else m = ['visitors', 'percentage'];
    // Utgangsrate vises ikke med filtre på hendelser (Plausible gjør det samme)
    return r.type === 'utgang' && k.hendelse ? m.filter((x) => x !== 'exit_rate') : m;
}

// Metrikker som ikke finnes i det offentlige API-et og regnes ut her
export const UTREGNET = new Set(['total_visitors', 'exit_rate']);

// Tallene øverst (chooseMetrics i fetch-top-stats.ts)
export function toppMetrikker(k, inntekt) {
    if (k.sanntid) return k.mal ? ['visitors', 'events'] : ['visitors', 'pageviews'];
    if (k.mal) return ['visitors', 'events', ...(inntekt ? INNTEKT : []), 'conversion_rate'];
    if (k.side) return ['visitors', 'visits', 'pageviews', 'bounce_rate', 'scroll_depth', 'time_on_page'];
    return ['visitors', 'visits', 'pageviews', 'views_per_visit', 'bounce_rate', 'visit_duration'];
}

// ── Etiketter ──

const TOPP_ETIKETT = {
    visitors: 'Unike besøkende', visits: 'Besøk totalt', pageviews: 'Sidevisninger totalt',
    views_per_visit: 'Sider per besøk', bounce_rate: 'Fluktfrekvens', visit_duration: 'Besøkstid',
    scroll_depth: 'Scrolldybde', time_on_page: 'Tid på siden', events: 'Konverteringer totalt',
    total_revenue: 'Inntekt totalt', average_revenue: 'Snittinntekt', conversion_rate: 'Konverteringsrate',
};
export function toppEtikett(m, k) {
    if (m === 'naa') return 'Besøkende nå';
    let e = m === 'visitors' && k.mal ? 'Unike konverteringer' : TOPP_ETIKETT[m];
    if (k.sanntid) e = m === 'pageviews' ? 'Sidevisninger' : e;
    return k.sanntid ? `${e} (siste 30 min)` : e;
}

const KOLONNE = {
    visitors: 'Besøkende', percentage: '%', pageviews: 'Sidevisninger', bounce_rate: 'Fluktfrekvens',
    visit_duration: 'Besøkstid', time_on_page: 'Tid på siden', scroll_depth: 'Scrolldybde', visits: 'Besøk',
    exit_rate: 'Utgangsrate', events: 'Hendelser', conversion_rate: 'KR', group_conversion_rate: 'KR',
    total_revenue: 'Inntekt', average_revenue: 'Snitt', total_visitors: 'Besøkende totalt',
};
export function kolonneEtikett(m, r, k) {
    if (r.type === 'mal') return { visitors: 'Unike', events: 'Totalt' }[m] || KOLONNE[m];
    if (m === 'visitors' && k.mal && r.type !== 'egenskap') return 'Konverteringer';
    // Sanntid: listene gjelder de siste 5 minuttene («Current visitors» i Plausible)
    if (m === 'visitors' && k.sanntid && !k.mal) return 'Besøkende nå';
    if (r.type === 'inngang') return { visitors: 'Unike innganger', visits: 'Innganger totalt' }[m] || KOLONNE[m];
    if (r.type === 'utgang') return { visitors: 'Unike utganger', visits: 'Utganger totalt' }[m] || KOLONNE[m];
    return KOLONNE[m];
}

// ── Spørringer ──

// Sortering som dashbordet: metrikken (besøkende synkende), så hver dimensjon stigende, så rader
// med like tall alltid kommer i samme rekkefølge (og «Vis flere» aldri gjentar eller hopper over
// rader). event:goal kan ikke stå i order_by. Kartet sorterer bare på besøkende (map.tsx).
export function sortering(dims, forst = [['visitors', 'desc']]) {
    const brukt = new Set(forst.map((o) => o[0]));
    return [...forst, ...dims.filter((d) => d !== 'event:goal' && !brukt.has(d)).map((d) => [d, 'asc'])];
}

// Bygger en v2-spørring. Nøklene står alltid i samme rekkefølge, så like spørringer gir samme
// nøkkel i mellomlageret. include.imports = true som i dashbordet (importerte data tas med);
// hjelpespørringer følger hovedspørringen (imports: false når den ikke kunne ta dem med).
export function sporring(nettsted, { metrics, range, dims, filtre = [], ekstraFiltre = [], order, limit, offset, totalRader, etiketter, trim, imports = true }) {
    const q = { site_id: nettsted, metrics, date_range: range };
    if (dims && dims.length) q.dimensions = dims;
    const f = [...tilPlausible(filtre), ...ekstraFiltre];
    if (f.length) q.filters = f;
    if (order) q.order_by = order;
    const include = { imports };
    if (etiketter) include.time_labels = true;
    if (trim) include.trim_relative_date_range = true;
    if (totalRader) include.total_rows = true;
    q.include = include;
    if (limit != null) q.pagination = { limit, offset: offset || 0 };
    return q;
}

export const rader = (svar) => (svar && Array.isArray(svar.results) ? svar.results : []);

// Inntekt kommer som { value, currency, … } – vi sender bare tallet, og valutaen for seg
export function metrikkverdi(v) {
    if (v && typeof v === 'object') return typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : null;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export const valuta = (v) => (v && typeof v === 'object' && typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency) ? v.currency : null);
// Verdien når Plausible ikke har noe (Plausible.Stats.Metrics.default_value): tid, scrolldybde,
// utgangsrate og inntekt er null («–» i portalen), alt annet 0
const UTEN_STANDARD = new Set(['visit_duration', 'time_on_page', 'scroll_depth', 'exit_rate', 'total_revenue', 'average_revenue', 'total_visitors']);
export const tomVerdi = (m) => (UTEN_STANDARD.has(m) ? null : 0);
export { INNTEKT };

// Lenke til siden på kundens nettsted. Bare stier som starter med «/», og bare nettstedet selv
// eller et underdomene av det (vertsnavn i dataene kan være forfalsket).
function lenke(vert, sti, nettsted) {
    if (typeof sti !== 'string' || !sti.startsWith('/') || sti.length > 2000 || /[\u0000-\u001f\u007f\s\\]/.test(sti)) return undefined;
    vert = typeof vert === 'string' ? vert.toLowerCase() : nettsted;
    if (!/^[a-z0-9.-]{1,253}$/.test(vert) || !(vert === nettsted || vert.endsWith('.' + nettsted))) return undefined;
    try {
        const u = new URL('https://' + vert + sti);
        return u.hostname === vert && u.protocol === 'https:' ? u.href : undefined;
    } catch { return undefined; }
}

// Én rad fra Plausible → { navn, verdier, filter, vert?, kode?, land?, gruppe?, lenke?, valuta? }
// vert (URL-listene): vertsnavnet, som legges til som eget filter ved klikk (som i Plausible)
export function lagRad(r, metrikkListe, rap, nettsted) {
    const d = Array.isArray(r.dimensions) ? r.dimensions : [];
    const tekst = (i) => (d[i] == null ? '' : String(d[i]));
    const verdier = {};
    let val = null;
    metrikkListe.forEach((m, i) => {
        const v = r.metrics?.[i];
        verdier[m] = metrikkverdi(v) ?? tomVerdi(m);
        val = val || valuta(v);
    });
    const rad = {
        navn: rap.vert != null ? tekst(rap.vert) + tekst(rap.verdi) : tekst(0),
        verdier,
        filter: { dim: rap.filter, verdi: tekst(rap.verdi ?? 0) },
    };
    if (rap.vert != null && tekst(rap.vert)) rad.vert = tekst(rap.vert);
    if (rap.kode != null) rad.kode = tekst(rap.kode);
    if (rap.land != null) rad.land = tekst(rap.land);
    if (rap.gruppe != null) rad.gruppe = tekst(rap.gruppe);
    if (rap.lenke) {
        const l = lenke(rap.vert != null ? tekst(rap.vert) : nettsted, tekst(rap.verdi ?? 0), nettsted);
        if (l) rad.lenke = l;
    }
    if (val) rad.valuta = val;
    return rad;
}

// ── Merknader fra Plausible (meta.imports_* og meta.metric_warnings) ──

const IMPORT_TEKST = {
    unsupported_query: 'Importerte tall er ikke med, fordi filtrene ikke kan brukes på importerte data.',
    unsupported_interval: 'Importerte tall finnes bare per dag, så de er ikke med i denne visningen.',
};
const METRIKK_TEKST = {
    no_imported_bounce_rate: 'Fluktfrekvensen tar ikke med importerte tall når det er filter på side.',
    no_imported_scroll_depth: 'Ingen importerte tall med scrolldybde.',
    legacy_time_on_page_used: 'Deler av perioden bruker Plausibles gamle beregning av tid på siden.',
    no_revenue_goals_matching: 'Ingen inntektsmål passer med filteret.',
    no_single_revenue_currency: 'Målene har ulik valuta, så inntekten kan ikke legges sammen.',
    revenue_goals_unavailable: 'Inntekt er ikke tilgjengelig for nettstedet.',
};

// Plausible sier «unsupported_interval» om alle timegrafer, også for nettsteder uten importerte
// data. Merknaden gir bare mening når nettstedet har importer, og det ser vi av andre svar
// (importerte tall er med, eller er utenfor perioden / ikke støttet av filtrene).
const importer = new Map();                 // nettsted → tidspunkt vi sist så at det har importer
export const harImport = (nettsted) => (importer.get(nettsted) || 0) > Date.now() - 60 * 60 * 1000;

// Gir [{ kode, metrikk?, tekst }] uten duplikater. skjulInntekt: inntektsvarsler tas bort
// når inntektskolonnene ikke vises.
export function merknader(svarListe, { skjulInntekt = false, nettsted } = {}) {
    const ut = new Map();
    for (const s of svarListe) {
        const meta = s && s.meta;
        if (!meta || typeof meta !== 'object') continue;
        const grunn = meta.imports_skip_reason;
        if (nettsted && (meta.imports_included === true || grunn === 'out_of_range' || grunn === 'unsupported_query')) {
            if (importer.size > 1000) importer.clear();
            importer.set(nettsted, Date.now());
        }
        if (meta.imports_included === false && Object.hasOwn(IMPORT_TEKST, grunn)) ut.set(grunn, { kode: grunn, tekst: IMPORT_TEKST[grunn] });
        const varsler = meta.metric_warnings && typeof meta.metric_warnings === 'object' ? meta.metric_warnings : {};
        for (const [metrikk, v] of Object.entries(varsler)) {
            const kode = v && v.code;
            if (!Object.hasOwn(METRIKK_TEKST, kode)) continue;
            if (skjulInntekt && INNTEKT.includes(metrikk)) continue;
            ut.set(kode + ' ' + metrikk, { kode, metrikk, tekst: METRIKK_TEKST[kode] });
        }
    }
    return [...ut.values()];
}

export const harInntektsvarsel = (svar) => Boolean(svar?.meta?.metric_warnings?.total_revenue);

// Inntektskolonner der alle radene er tomme, vises ikke (hideMetricsIfAllNull i dashbordet).
// rader: Plausibles rader, metrics: metrikkene i spørringen, vis: kolonnene som skal vises.
export function utenTommeInntekter(vis, rader_, metrics) {
    if (!rader_.length) return vis;
    return vis.filter((m) => {
        if (!INNTEKT.includes(m)) return true;
        const i = metrics.indexOf(m);
        return i < 0 || rader_.some((r) => metrikkverdi(r.metrics?.[i]) !== null);
    });
}
