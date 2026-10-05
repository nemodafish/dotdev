// DOTDEV · kundeportalen (dotdev.no/kunde): innlogging og dashbordet.
//
// kunde.html er skallet og utseendet; denne filen bygger dashbordet og snakker bare med
// serverfunksjonen på /api/kunde/… (netlify/functions/kunde-api.mjs), aldri med Plausible.
//
//  • Alt som kommer fra statistikken (sidenavn, kilder, mål, egenskaper …) settes inn med
//    textContent, aldri som HTML. Trusted Types i kunde.html stopper innerHTML uansett.
//  • Ingen localStorage, sessionStorage eller IndexedDB (personvernerklæringen lover det).
//    Alt kunden velger (periode, sammenligning, filtre, faner, åpne vinduer) står i adressen,
//    så en visning kan deles, og tilbake-knappen virker.
//  • Kvote: Plausible tillater 600 kall i timen for hele laget, delt av alle kundene. Siden
//    ber bare om det som vises: én /data-forespørsel per visning (med alle delene), én del når
//    kunden bytter fane, og husker svarene like lenge som serveren (5 min, sanntid 1 min).
//    Bare «besøkende nå» og sanntid oppdateres av seg selv, hvert minutt mens fanen er synlig
//    (i sanntid listene annethvert minutt), ikke når kunden har vært borte en stund (et kvarter,
//    i sanntid fem minutter), og ikke etter at serveren har sagt at kvoten er brukt opp.
//  • Hurtigtastene kan slås av (WCAG 2.1.4); valget står i adressen (taster=0).
(function () {
    'use strict';

    var API = '/api/kunde';
    var LAGER_MS = 5 * 60 * 1000;       // samme som på serveren
    var LEVENDE_MS = 60 * 1000;         // sanntid og «besøkende nå»
    var LEDIG_MS = 15 * 60 * 1000;      // ingen automatisk oppdatering etter et kvarter uten aktivitet
    var SANNTID_LEDIG_MS = 5 * 60 * 1000;  // sanntid koster ~4–5 kall i minuttet, så den stopper før
    var SOK_VENT_MS = 300;
    var DAG_MS = 86400000;
    var MIN_DATO = '2019-01-01';        // eldste dato serveren godtar
    var STANDARD_PERIODE = '28d';       // som Plausible
    var MAKS_FILTRE = 10;
    // Kontrolltegn og linjeskilletegn (U+2028/2029) avvises i filterverdier, som på serveren
    var KONTROLLTEGN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f' + String.fromCharCode(0x2028, 0x2029) + ']');
    var MELDING_FEIL = 'Fikk ikke hentet tallene akkurat nå. Prøv igjen om litt.';
    var MELDING_NETT = 'Fikk ikke kontakt. Sjekk nettet og prøv igjen.';
    var MELDING_MANGE = 'Mange forespørsler på kort tid. Vent et minutt og prøv igjen.';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
    var har = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

    function lag(tag, klasse, tekst) {
        var el = document.createElement(tag);
        if (klasse) el.className = klasse;
        if (tekst != null) el.textContent = tekst;
        return el;
    }
    function knapp(klasse, tekst) {
        var b = lag('button', klasse, tekst);
        b.type = 'button';
        return b;
    }
    // SVG bygges med createElementNS (ikke innerHTML), så Trusted Types kan stå på for hele siden
    var SVG = 'http://www.w3.org/2000/svg';
    function lagSvg(tag, attr) {
        var el = document.createElementNS(SVG, tag);
        Object.keys(attr || {}).forEach(function (k) { el.setAttribute(k, attr[k]); });
        return el;
    }
    function ikonLenke() {
        // Pil ut av en boks, i piksler som resten av siden
        var svg = lagSvg('svg', { viewBox: '0 0 7 7', 'aria-hidden': 'true', focusable: 'false' });
        svg.append(lagSvg('path', { d: 'M3 0h4v4H6V2H5v1H4v1H3v1H2V4h1V3h1V2h1V1H3zM0 1h2v1H1v4h4V5h1v2H0z' }));
        return svg;
    }

    // ── Formatering ─────────────────────────────────────────────────────
    var NF = new Intl.NumberFormat('nb-NO');
    var NF1 = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 1 });
    var NF2 = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 2 });
    var NF2F = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var PST = String.fromCharCode(160) + '%';   // hardt mellomrom, så «%» aldri havner alene på en linje
    var heltall = function (n) { return NF.format(Math.round(n)); };
    function varighet(s) {
        s = Math.round(s);
        if (s < 60) return s + ' s';
        var t = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return t ? t + ' t ' + m + ' min' : m + ' min ' + (s % 60) + ' s';
    }
    function penger(n, valuta) {
        var hel = Math.round(n) === n;
        try {
            return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: valuta || 'NOK', minimumFractionDigits: hel ? 0 : 2, maximumFractionDigits: hel ? 0 : 2 }).format(n);
        } catch (e) { return NF2.format(n); }
    }
    // Prosent som Plausible viser den: én desimal (uten «,0»), to desimaler mellom 0 og 0,1
    function prosent(v) {
        var a = Math.abs(v);
        return (a > 0 && a < 0.1 ? NF2F : NF1).format(v) + PST;
    }
    // Ett tall slik det vises i kort, lister og grafen. null = ingen tall («–»).
    function verdiTekst(m, v, valuta) {
        if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) return '–';
        switch (m) {
            case 'visit_duration': case 'time_on_page': return varighet(v);
            case 'bounce_rate': case 'scroll_depth': return NF.format(Math.round(v)) + PST;
            case 'percentage': case 'exit_rate': case 'conversion_rate': case 'group_conversion_rate': return prosent(v);
            case 'views_per_visit': return NF2F.format(v);
            case 'total_revenue': case 'average_revenue': return penger(v, valuta);
            default: return heltall(v);
        }
    }
    // Eksakt verdi til verktøytips
    function verdiLang(m, v, valuta) {
        if (v === null || v === undefined) return 'Ingen tall';
        if (m === 'visit_duration' || m === 'time_on_page') return varighet(v) + ' (' + heltall(v) + ' sekunder)';
        if (m === 'views_per_visit') return NF2.format(v);
        if (m === 'percentage' || m === 'conversion_rate' || m === 'group_conversion_rate' || m === 'exit_rate') return NF2.format(v) + PST;
        return verdiTekst(m, v, valuta);
    }

    var fmt = function (o) { return new Intl.DateTimeFormat('nb-NO', Object.assign({ timeZone: 'UTC' }, o)); };
    var fKort = fmt({ day: 'numeric', month: 'short' });
    var fMedAar = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
    var fLang = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
    var fLangAar = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    var fDagMnd = fmt({ day: 'numeric', month: 'long' });
    var fDagMndAar = fmt({ day: 'numeric', month: 'long', year: 'numeric' });
    var fMnd = fmt({ month: 'short', year: 'numeric' });
    var fMndLang = fmt({ month: 'long', year: 'numeric' });
    var fKortDag = fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    var smal = function () { return window.matchMedia && matchMedia('(max-width: 640px)').matches; };
    var beroring = function () { return window.matchMedia && matchMedia('(hover: none)').matches; };
    var klokker = {};
    function fKlokke(tz) {
        if (!klokker[tz]) {
            try { klokker[tz] = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: tz }); }
            catch (e) { klokker[tz] = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' }); }
        }
        return klokker[tz];
    }
    var landnavn = null;
    try { landnavn = new Intl.DisplayNames(['nb'], { type: 'region' }); } catch (e) { /* eldre nettlesere: navnet fra Plausible vises */ }

    // Datoer er tekst «ÅÅÅÅ-MM-DD» i nettstedets tidssone; de regnes som UTC-midnatt, så de aldri forskyves
    var stor = function (s) { return s.charAt(0).toUpperCase() + s.slice(1); };
    var ms = function (d) { return Date.parse(d + 'T00:00:00Z'); };
    var tilDato = function (t) { return new Date(t).toISOString().slice(0, 10); };
    function dato(s) {
        var d = s.slice(0, 10).split('-').map(Number);
        return new Date(Date.UTC(d[0], d[1] - 1, d[2] || 1));
    }
    var plussDager = function (d, n) { return tilDato(ms(d) + n * DAG_MS); };
    function plussManeder(d, n) {
        var a = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)), dg = Number(d.slice(8, 10));
        var tot = a * 12 + m - 1 + n, na = Math.floor(tot / 12), nm = tot - na * 12 + 1;
        var sist = new Date(Date.UTC(na, nm, 0)).getUTCDate();
        return na + '-' + String(nm).padStart(2, '0') + '-' + String(Math.min(dg, sist)).padStart(2, '0');
    }
    var forsteIManed = function (d) { return d.slice(0, 8) + '01'; };
    function gyldigDato(d) {
        return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && isFinite(ms(d)) && tilDato(ms(d)) === d;
    }
    var formatere = {};
    // Veggklokka i en tidssone skrevet som om den var UTC (samme som serverens naiv())
    function naiv(tz, t) {
        var f = formatere[tz];
        if (!f) {
            f = formatere[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
        }
        var d = {};
        f.formatToParts(new Date(t)).forEach(function (x) { d[x.type] = x.value; });
        return Date.UTC(+d.year, +d.month - 1, +d.day, +d.hour % 24, +d.minute, +d.second);
    }
    function tidssone() {
        var tz = oppsett && oppsett.tidssone;
        try { if (tz) { naiv(tz, Date.now()); return tz; } } catch (e) { /* ukjent sone: norsk tid */ }
        return 'Europe/Oslo';
    }
    var idag = function () { return tilDato(naiv(tidssone(), Date.now())); };

    function spenn(fra, til) {
        var a = dato(fra), b = dato(til);
        if (fra === til) return fMedAar.format(a);
        return (a.getUTCFullYear() !== b.getUTCFullYear() ? fMedAar : fKort).format(a) + '–' + fMedAar.format(b);
    }
    // Et område fra API-et ({ fra, til, fra_kl?, til_kl? }) som tekst
    function omradeTekst(o) {
        if (!o) return '';
        if (o.fra_kl) {
            if (o.fra === o.til) return fMedAar.format(dato(o.fra)) + (o.fra_kl === '00:00' ? ' til kl. ' + o.til_kl : ', kl. ' + o.fra_kl + '–' + o.til_kl);
            return fKort.format(dato(o.fra)) + ' kl. ' + o.fra_kl + '–' + fMedAar.format(dato(o.til)) + ' kl. ' + o.til_kl;
        }
        return spenn(o.fra, o.til);
    }

    // ── Norske navn ─────────────────────────────────────────────────────
    var KANALER = {
        'Direct': 'Direkte', 'Organic Search': 'Søk', 'Paid Search': 'Betalt søk', 'Organic Social': 'Sosiale medier',
        'Paid Social': 'Betalt i sosiale medier', 'Email': 'E-post', 'Referral': 'Lenker fra andre nettsider',
        'Affiliates': 'Partnerlenker', 'Display': 'Bannerannonser', 'Organic Video': 'Video', 'Paid Video': 'Betalt video',
        'Organic Shopping': 'Shopping', 'Paid Shopping': 'Betalt shopping', 'Cross-network': 'På tvers av nettverk',
        'SMS': 'SMS', 'Audio': 'Lyd', 'Mobile Push Notifications': 'Push-varsler', 'Paid Other': 'Annet betalt',
        'AI Assistants': 'AI-assistenter'
    };
    var ENHETER = { Desktop: 'PC', Laptop: 'Bærbar PC', Tablet: 'Nettbrett', Mobile: 'Mobil' };
    var MAL = {
        'Outbound Link: Click': 'Klikk på lenker til andre nettsider',
        'File Download': 'Nedlastede filer',
        'Form: Submission': 'Utfylte skjema',
        'Cloaked Link: Click': 'Klikk på skjulte lenker',
        '404': 'Besøk på sider som ikke finnes (404)'
    };
    // Mål med egen egenskapsliste i Plausible (når kunden filtrerer på akkurat det målet)
    var SPESIALMAL = {
        '404': { nokkel: 'path', etikett: '404-sider' },
        'Outbound Link: Click': { nokkel: 'url', etikett: 'Lenker ut' },
        'Cloaked Link: Click': { nokkel: 'url', etikett: 'Skjulte lenker' },
        'File Download': { nokkel: 'url', etikett: 'Nedlastinger' },
        'Form: Submission': { nokkel: 'path', etikett: 'Skjema' },
        'WP Search Queries': { nokkel: 'search_query', etikett: 'Søk på nettsiden' },
        'WP Form Completions': { nokkel: 'path', etikett: 'Utfylte skjema' }
    };
    var oversett = function (tabell, n) { return har(tabell, n) ? tabell[n] : null; };
    function spesialverdi(n) {
        if (n === '(not set)' || n === '') return 'Ukjent';
        if (n === '(none)') return '(ingen)';
        if (n === 'Direct / None') return 'Direkte (adresse eller bokmerke)';
        return n;
    }
    function land(kode, navn) {
        if (/^[A-Z]{2}$/.test(kode || '') && kode !== 'ZZ' && kode !== 'XX') {
            try {
                var n = landnavn && landnavn.of(kode);
                if (n && n !== kode) return n;
            } catch (e) { /* ukjent kode */ }
        }
        return navn || 'Ukjent';
    }
    // Flagg som emoji av landkoden (bilder er stengt av CSP-en, og emoji krever ingen filer)
    function flagg(kode) {
        if (!/^[A-Z]{2}$/.test(kode || '') || kode === 'ZZ') return '';
        return String.fromCodePoint(0x1F1E6 + kode.charCodeAt(0) - 65, 0x1F1E6 + kode.charCodeAt(1) - 65);
    }
    var erEgenskap = function (r) { return String(r).indexOf('egenskap:') === 0; };
    function egenskapNokkel(r) {
        try { return decodeURIComponent(String(r).slice(9)); } catch (e) { return String(r).slice(9); }
    }
    // Radens navn på norsk, for rapporten den kom fra
    function radNavn(rapport, rad) {
        var n = rad.navn;
        if (erEgenskap(rapport)) return spesialverdi(n);
        switch (rapport) {
            case 'kanaler': return oversett(KANALER, n) || spesialverdi(n);
            case 'sider': case 'inngang': case 'utgang': return n === '/' ? '/ (forsiden)' : n;
            case 'kart': case 'land': return land(rad.kode, n);
            case 'regioner': case 'byer': return n || 'Ukjent';
            case 'skjerm': return oversett(ENHETER, n) || spesialverdi(n);
            case 'nettleserversjoner': case 'osversjoner':
                return (rad.gruppe && rad.gruppe !== '(not set)' ? rad.gruppe + ' ' : '') + (n === '(not set)' || n === '' ? '(ukjent versjon)' : n);
            case 'mal': return oversett(MAL, n) || n;
            default: return spesialverdi(n);
        }
    }

    // Rapportene: tittel i «Vis alle» og navnet på første kolonne
    var RAPPORTER = {
        kanaler: ['Kanaler', 'Kanal'], kilder: ['Kilder', 'Kilde'], henvisninger: ['Henvisninger', 'Henvisning'],
        utm_medium: ['UTM-medium', 'UTM-medium'], utm_source: ['UTM-kilder', 'UTM-kilde'], utm_campaign: ['UTM-kampanjer', 'UTM-kampanje'],
        utm_content: ['UTM-innhold', 'UTM-innhold'], utm_term: ['UTM-begreper', 'UTM-begrep'],
        sider: ['Mest besøkte sider', 'Side'], sider_url: ['Mest besøkte sider', 'URL'],
        inngang: ['Inngangssider', 'Inngangsside'], inngang_url: ['Inngangssider', 'URL'],
        utgang: ['Utgangssider', 'Utgangsside'], utgang_url: ['Utgangssider', 'URL'],
        kart: ['Land', 'Land'], land: ['Land', 'Land'], regioner: ['Regioner', 'Region'], byer: ['Byer', 'By'],
        nettlesere: ['Nettlesere', 'Nettleser'], nettleserversjoner: ['Nettleserversjoner', 'Versjon'],
        os: ['Operativsystemer', 'Operativsystem'], osversjoner: ['Operativsystemversjoner', 'Versjon'],
        skjerm: ['Skjermstørrelse', 'Enhet'], mal: ['Mål', 'Mål']
    };
    function rapportTittel(r) {
        if (erEgenskap(r)) return 'Egenskapen ' + egenskapNokkel(r);
        if ((r === 'sider' || r === 'sider_url') && kontekst() === 'mal') return 'Konverteringssider';
        return har(RAPPORTER, r) ? RAPPORTER[r][0] : r;
    }
    var forsteKolonne = function (r) { return erEgenskap(r) ? egenskapNokkel(r) : har(RAPPORTER, r) ? RAPPORTER[r][1] : 'Navn'; };

    // ── Filtrene ────────────────────────────────────────────────────────
    var ALLE_OPS = ['is', 'is_not', 'contains', 'contains_not'];
    var ER_OPS = ['is', 'is_not'];
    var OP_NAVN = { is: 'er', is_not: 'er ikke', contains: 'inneholder', contains_not: 'inneholder ikke' };
    // Portalnavn → etikett, lovlige operatorer og listen forslagene hentes fra
    var DIMS = {
        side: { etikett: 'Side', ops: ALLE_OPS, rapport: 'sider' },
        inngang: { etikett: 'Inngangsside', ops: ALLE_OPS, rapport: 'inngang' },
        utgang: { etikett: 'Utgangsside', ops: ALLE_OPS, rapport: 'utgang' },
        vert: { etikett: 'Vertsnavn', ops: ALLE_OPS, rapport: 'sider_url' },
        kilde: { etikett: 'Kilde', ops: ALLE_OPS, rapport: 'kilder' },
        kanal: { etikett: 'Kanal', ops: ALLE_OPS, rapport: 'kanaler' },
        henvisning: { etikett: 'Henvisning', ops: ALLE_OPS, rapport: 'henvisninger' },
        utm_medium: { etikett: 'UTM-medium', ops: ALLE_OPS, rapport: 'utm_medium' },
        utm_source: { etikett: 'UTM-kilde', ops: ALLE_OPS, rapport: 'utm_source' },
        utm_campaign: { etikett: 'UTM-kampanje', ops: ALLE_OPS, rapport: 'utm_campaign' },
        utm_term: { etikett: 'UTM-begrep', ops: ALLE_OPS, rapport: 'utm_term' },
        utm_content: { etikett: 'UTM-innhold', ops: ALLE_OPS, rapport: 'utm_content' },
        land: { etikett: 'Land', ops: ER_OPS, rapport: 'kart', monster: /^[A-Z]{2}$/ },
        region: { etikett: 'Region', ops: ER_OPS, rapport: 'regioner', monster: /^[A-Z]{2}-[A-Z0-9]{1,3}$/ },
        by: { etikett: 'By', ops: ER_OPS, rapport: 'byer', monster: /^[1-9]\d{0,9}$/ },
        skjerm: { etikett: 'Skjermstørrelse', ops: ER_OPS, faste: ['Desktop', 'Laptop', 'Tablet', 'Mobile'] },
        nettleser: { etikett: 'Nettleser', ops: ALLE_OPS, rapport: 'nettlesere' },
        nettleserversjon: { etikett: 'Nettleserversjon', ops: ALLE_OPS, rapport: 'nettleserversjoner' },
        os: { etikett: 'Operativsystem', ops: ALLE_OPS, rapport: 'os' },
        osversjon: { etikett: 'Versjon av operativsystem', ops: ALLE_OPS, rapport: 'osversjoner' },
        mal: { etikett: 'Mål', ops: ['is', 'is_not', 'contains'] }     // «er ikke» = has_not_done hos Plausible
    };
    var GRUPPER = [
        { id: 'side', etikett: 'Side', dims: ['side', 'inngang', 'utgang'] },
        { id: 'vert', etikett: 'Vertsnavn', dims: ['vert'] },
        { id: 'kilde', etikett: 'Kilde', dims: ['kilde', 'kanal', 'henvisning'] },
        { id: 'utm', etikett: 'UTM', dims: ['utm_medium', 'utm_source', 'utm_campaign', 'utm_term', 'utm_content'] },
        { id: 'sted', etikett: 'Sted', dims: ['land', 'region', 'by'] },
        { id: 'skjerm', etikett: 'Skjermstørrelse', dims: ['skjerm'] },
        { id: 'nettleser', etikett: 'Nettleser', dims: ['nettleser', 'nettleserversjon'] },
        { id: 'os', etikett: 'Operativsystem', dims: ['os', 'osversjon'] },
        { id: 'mal', etikett: 'Mål', dims: ['mal'] },
        { id: 'egenskap', etikett: 'Egenskap', dims: [] }
    ];
    var dimInfo = function (dim) { return erEgenskap(dim) ? { etikett: 'Egenskapen ' + dim.slice(9), ops: ALLE_OPS } : DIMS[dim]; };
    function gruppeFor(dim) {
        if (erEgenskap(dim)) return 'egenskap';
        for (var i = 0; i < GRUPPER.length; i++) if (GRUPPER[i].dims.indexOf(dim) >= 0) return GRUPPER[i].id;
        return null;
    }
    // Verdien i et filter slik den vises (land og steder med navn, kanaler på norsk)
    function filterVerdiTekst(dim, v) {
        var e = S.etiketter[dim + '|' + v];
        if (dim === 'land') return land(v, e || v);
        if (e) return e;
        if (dim === 'kanal') return oversett(KANALER, v) || spesialverdi(v);
        if (dim === 'skjerm') return oversett(ENHETER, v) || spesialverdi(v);
        if (dim === 'mal') return oversett(MAL, v) || v;
        if (dim === 'side' || dim === 'inngang' || dim === 'utgang' || dim === 'vert') return v;
        // Kilder, UTM, nettlesere, OS, versjoner og egenskaper: (none)/(not set) som i radene
        return spesialverdi(v);
    }
    function filterTekst(f) {
        var info = dimInfo(f.dim);
        return info.etikett + ' ' + OP_NAVN[f.op] + ' ' + f.verdier.map(function (v) { return filterVerdiTekst(f.dim, v); }).join(' eller ');
    }
    // f=<op>,<dim>,<v1>,… med hver verdi (og egenskapsnøkkelen) kodet, slik API-et vil ha det
    function filterParam(f) {
        var dim = erEgenskap(f.dim) ? 'egenskap:' + encodeURIComponent(f.dim.slice(9)) : f.dim;
        return [f.op, dim].concat(f.verdier.map(encodeURIComponent)).join(',');
    }
    // Egenskaper nettstedet har satt opp, pluss Plausibles egne (url, path, search_query)
    var INTERNE = ['url', 'path', 'search_query'];
    function kjentEgenskap(n) {
        return Boolean(oppsett) && ((oppsett.interne || INTERNE).indexOf(n) >= 0 || oppsett.egenskaper.indexOf(n) >= 0);
    }
    function lesFilter(raa) {
        var deler = String(raa).split(',');
        var op = deler[0], dimRaa = deler[1] || '', dim;
        if (ALLE_OPS.indexOf(op) < 0) return null;
        if (dimRaa.indexOf('egenskap:') === 0) {
            try { dim = 'egenskap:' + decodeURIComponent(dimRaa.slice(9)); } catch (e) { return null; }
            if (!kjentEgenskap(dim.slice(9))) return null;
        } else if (har(DIMS, dimRaa)) {
            dim = dimRaa;
        } else {
            return null;
        }
        var info = dimInfo(dim);
        if (info.ops.indexOf(op) < 0) return null;
        var verdier = [];
        for (var i = 2; i < deler.length; i++) {
            var v;
            try { v = decodeURIComponent(deler[i]); } catch (e) { return null; }
            if (!v.length || v.length > 300 || KONTROLLTEGN.test(v)) return null;
            if (info.monster && !info.monster.test(v)) return null;
            if (verdier.indexOf(v) < 0) verdier.push(v);
        }
        if (!verdier.length || verdier.length > 10) return null;
        // Mål som ikke finnes lenger, gir 400 hos serveren; de tas bort her (ikke når mållisten mangler)
        if (dim === 'mal' && op !== 'contains' && !oppsett.malUkjent && verdier.some(function (x) { return malNavn().indexOf(x) < 0; })) return null;
        return { op: op, dim: dim, verdier: verdier };
    }
    var malNavn = function () { return oppsett ? oppsett.mal.map(function (m) { return m.navn; }) : []; };
    var harFilter = function (dim) { return S.filtre.some(function (f) { return f.dim === dim; }); };
    // Akkurat ett filter på dimensjonen, «er», med én verdi (Plausibles isFilteringOnFixedValue)
    function isFilter(dim) {
        var fl = S.filtre.filter(function (f) { return f.dim === dim; });
        return fl.length === 1 && fl[0].op === 'is' && fl[0].verdier.length === 1;
    }
    // «Mål er ikke» (has_not_done hos Plausible) gjør ikke visningen til en konverteringsvisning
    var erMalFilter = function (f) { return f.dim === 'mal' && f.op !== 'is_not'; };
    function kontekst() {
        if (S.periode === 'sanntid') return 'sanntid';
        if (S.filtre.some(erMalFilter)) return 'mal';
        if (harFilter('side')) return 'side';
        return 'standard';
    }
    // Plausibles egne lister for målene 404, Outbound Link: Click osv. (url og path er alltid tillatt)
    function spesialMal() {
        var m = S.filtre.filter(function (f) { return f.dim === 'mal'; });
        if (m.length !== 1 || m[0].op !== 'is' || m[0].verdier.length !== 1) return null;
        return oversett(SPESIALMAL, m[0].verdier[0]);
    }
    // Måltypen fra oppsettet (event, page eller scroll)
    function malType(navn) {
        var m = oppsett && oppsett.mal.filter(function (x) { return x.navn === navn; })[0];
        return m ? m.type : null;
    }

    // ── Tallene øverst og grafen ────────────────────────────────────────
    var METRIKKER = {
        standard: ['visitors', 'visits', 'pageviews', 'views_per_visit', 'bounce_rate', 'visit_duration'],
        side: ['visitors', 'visits', 'pageviews', 'bounce_rate', 'scroll_depth', 'time_on_page'],
        mal: ['visitors', 'events', 'total_revenue', 'average_revenue', 'conversion_rate'],
        sanntid: ['naa', 'visitors', 'pageviews']
    };
    var METRIKK_NAVN = {
        visitors: 'Unike besøkende', visits: 'Besøk totalt', pageviews: 'Sidevisninger totalt', views_per_visit: 'Sider per besøk',
        bounce_rate: 'Fluktfrekvens', visit_duration: 'Besøkstid', scroll_depth: 'Scrolldybde', time_on_page: 'Tid på siden',
        events: 'Konverteringer totalt', total_revenue: 'Inntekt totalt', average_revenue: 'Snittinntekt',
        conversion_rate: 'Konverteringsrate', naa: 'Besøkende nå'
    };
    function metrikkNavn(m) {
        if (m === 'visitors' && kontekst() === 'mal') return 'Unike konverteringer';
        return METRIKK_NAVN[m] || m;
    }
    function grafMetrikk() {
        var k = kontekst();
        if (k === 'sanntid' || METRIKKER[k].indexOf(S.graf) < 0) return 'visitors';
        // Tall uten verdi står ikke øverst (som i Plausible); da viser grafen besøkende
        var topp = lager.get(nokkel(grunnlag(), 'topp'));
        if (topp && topp.verdi.metrikker && !topp.verdi.metrikker.some(function (x) { return x.key === S.graf; })) return 'visitors';
        return S.graf;
    }
    var LAVT_ER_BRA = { bounce_rate: true };
    // Plausible.Stats.Compare (samme som serveren), til grafens verktøytips
    function endring(m, gammel, ny) {
        if (typeof gammel !== 'number' || typeof ny !== 'number') return null;
        var rund = function (x, n) { var f = Math.pow(10, n); return Math.sign(x) * Math.round(Math.abs(x) * f) / f; };
        if (m === 'conversion_rate') return rund(ny - gammel, 1);
        if (m === 'bounce_rate') return gammel > 0 ? rund(ny - gammel, 2) : null;
        if (gammel === 0) return ny > 0 ? 100 : ny === 0 ? 0 : null;
        return Math.sign((ny - gammel) / gammel) * Math.round(Math.abs((ny - gammel) / gammel * 100));
    }
    // «▲ 12 %» med farge (grønt er bra, for fluktfrekvens er ned bra) og «Opp»/«Ned» for skjermlesere
    function endringEl(m, e) {
        var span = lag('span');
        if (e === null || e === undefined) return span;
        if (e === 0) { span.textContent = 'Uendret'; return span; }
        var opp = e > 0;
        span.className = opp !== Boolean(LAVT_ER_BRA[m]) ? 'bra' : 'darlig';
        var pil = lag('span', null, opp ? '▲ ' : '▼ ');
        pil.setAttribute('aria-hidden', 'true');
        var tall = m === 'bounce_rate' ? NF2.format(Math.abs(e)) + PST + '-poeng'
            : m === 'conversion_rate' ? NF1.format(Math.abs(e)) + PST + '-poeng'
            : NF.format(Math.abs(e)) + PST;
        span.append(pil, lag('span', 'sr-only', opp ? 'Opp ' : 'Ned '), document.createTextNode(tall));
        return span;
    }

    // ── Grafintervallene (samme regler som serveren, så grafen kan bes om i samme forespørsel) ──
    var FASTE_INTERVALLER = {
        dag: ['time'], '24t': ['time'], '7d': ['time', 'dag'], '28d': ['dag', 'uke'], '30d': ['dag', 'uke'],
        '91d': ['dag', 'uke', 'mnd'], mnd: ['dag', 'uke'], '6mnd': ['dag', 'uke', 'mnd'], '12mnd': ['dag', 'uke', 'mnd'], aar: ['dag', 'uke', 'mnd']
    };
    var FASTE_STANDARD = { dag: 'time', '24t': 'time', '7d': 'dag', '6mnd': 'mnd', '12mnd': 'mnd', aar: 'mnd' };
    var GROVHET = { minute: 0, hour: 1, day: 2, week: 3, month: 4 };
    var INTERVALL = { hour: 'time', day: 'dag', week: 'uke', month: 'mnd' };
    var INTERVALL_NAVN = { time: 'Timer', dag: 'Dager', uke: 'Uker', mnd: 'Måneder' };
    var kutt = function (x) { return x < 0 ? (Math.ceil(x) || 0) : Math.floor(x); };
    function leggTilMnd(t, n) { var d = tilDato(t); return ms(plussManeder(d, n)) + (t - ms(d)); }
    function manedsdiff(a, b) {
        if (new Date(a).getUTCDate() < new Date(b).getUTCDate()) return -manedsdiff(b, a);
        var hel = (new Date(b).getUTCFullYear() - new Date(a).getUTCFullYear()) * 12 + (new Date(b).getUTCMonth() - new Date(a).getUTCMonth());
        var anker = leggTilMnd(a, hel), c = b - anker < 0, anker2 = leggTilMnd(a, hel + (c ? -1 : 1));
        return +(-(hel + ((b - anker) / (c ? anker - anker2 : anker2 - anker)))) || 0;
    }
    function egneIntervaller(fra, til) {
        var dager = kutt((til - fra) / DAG_MS), mnd = kutt(manedsdiff(til, fra));
        if (dager < 1) return ['minute', 'hour'];
        if (dager < 7) return ['hour', 'day'];
        if (mnd < 1) return ['day', 'week'];
        if (mnd < 12) return ['day', 'week', 'month'];
        return ['week', 'month'];
    }
    function egenStandard(fra, til) {
        var dager = kutt((til - fra) / DAG_MS), mnd = kutt(manedsdiff(til, fra));
        if (dager < 1) return 'hour';
        if (dager < 30) return 'day';
        if (mnd < 6) return 'week';
        return 'month';
    }
    var maksGrov = function (l) { return Math.max.apply(null, l.map(function (i) { return GROVHET[i]; })); };
    // { liste, standard } for visningen, eller null når det ikke kan vites ennå (All tid første gang)
    function beregnIntervaller() {
        var p = S.periode, gyldige, standard;
        if (p === 'sanntid') return { liste: [], standard: null };
        if (p === 'egen') {
            gyldige = egneIntervaller(ms(S.fra), ms(S.til));
            standard = egenStandard(ms(S.fra), ms(S.til));
        } else if (p === 'alt') {
            if (!altStart) return null;
            gyldige = egneIntervaller(ms(altStart), naiv(tidssone(), Date.now()));
            standard = gyldige.indexOf('day') >= 0 ? 'day' : 'month';
        } else {
            var navn = { time: 'hour', dag: 'day', uke: 'week', mnd: 'month' };
            gyldige = FASTE_INTERVALLER[p].map(function (i) { return navn[i]; });
            standard = navn[FASTE_STANDARD[p] || FASTE_INTERVALLER[p][0]];
        }
        if (S.sml === 'egen' && p !== 'alt' && S.smlFra) {
            var sg = egneIntervaller(ms(S.smlFra), ms(S.smlTil));
            if (maksGrov(sg) > maksGrov(gyldige)) gyldige = sg;
            if (sg.indexOf(standard) < 0) standard = egenStandard(ms(S.smlFra), ms(S.smlTil));
        }
        var liste = gyldige.filter(function (i) { return i !== 'minute'; }).map(function (i) { return INTERVALL[i]; });
        var s = INTERVALL[standard];
        return { liste: liste, standard: liste.indexOf(s) >= 0 ? s : liste.indexOf('dag') >= 0 ? 'dag' : liste.indexOf('mnd') >= 0 ? 'mnd' : liste[0] };
    }

    // ── Tilstanden (speiler adressen) ───────────────────────────────────
    var PERIODER = ['sanntid', 'dag', '24t', '7d', '28d', '30d', '91d', 'mnd', 'aar', '6mnd', '12mnd', 'alt', 'egen'];
    var ALIASER = { idag: 'dag', '12m': '12mnd' };
    var SAMMENLIGNINGER = ['av', 'forrige', 'aar', 'egen'];
    var UTM = ['utm_medium', 'utm_source', 'utm_campaign', 'utm_content', 'utm_term'];
    var FANER = {
        kilder: ['kanaler', 'kilder', 'kampanjer'], sider: ['sider', 'inngang', 'utgang'], sted: ['kart', 'land', 'regioner', 'byer'],
        enheter: ['nettlesere', 'os', 'skjerm'], handlinger: ['mal', 'egenskaper']
    };
    var GRAF_METRIKKER = ['visitors', 'visits', 'pageviews', 'views_per_visit', 'bounce_rate', 'visit_duration', 'scroll_depth', 'time_on_page', 'events', 'total_revenue', 'average_revenue', 'conversion_rate'];

    function nyTilstand() {
        return {
            periode: STANDARD_PERIODE, dato: null, fra: null, til: null,
            sml: 'av', smlFra: null, smlTil: null, ukedag: '1',
            filtre: [], etiketter: {}, graf: 'visitors', intervall: null,
            fane: { kilder: null, utm: null, sider: null, url: false, sted: null, enheter: null, handlinger: null, egenskap: null },
            detaljer: null, filterGruppe: null
        };
    }
    var S = nyTilstand();
    // Hurtigtastene kan slås av. Valget gjelder resten av besøket på siden og står i adressen.
    var tasterPa = new URLSearchParams(location.search).get('taster') !== '0';

    var harDato = function (p) { return p === 'dag' || p === 'mnd' || p === 'aar'; };
    var harSml = function (p) { return p !== 'sanntid' && p !== 'alt'; };

    // Rydder tilstanden, så adressen alltid er den korteste som betyr det samme
    function normaliser(s) {
        var d = idag();
        if (!harDato(s.periode)) s.dato = null;
        if (s.dato) {
            if (s.periode === 'mnd') s.dato = forsteIManed(s.dato);
            if (s.periode === 'aar') s.dato = s.dato.slice(0, 4) + '-01-01';
            var naa = s.periode === 'dag' ? d : s.periode === 'mnd' ? forsteIManed(d) : d.slice(0, 4) + '-01-01';
            if (s.dato === naa || s.dato > naa || s.dato < MIN_DATO) s.dato = null;
        }
        if (s.periode === 'egen') {
            if (!gyldigDato(s.fra) || !gyldigDato(s.til) || s.fra > s.til || s.fra < MIN_DATO || s.til > d) {
                s.periode = STANDARD_PERIODE;
            } else if (s.fra === s.til) {
                // Samme dag to ganger blir én dag, som i Plausible
                s.periode = 'dag';
                s.dato = s.fra === d ? null : s.fra;
            }
        }
        if (s.periode !== 'egen') { s.fra = null; s.til = null; }
        if (s.sml === 'egen' && (!gyldigDato(s.smlFra) || !gyldigDato(s.smlTil) || s.smlFra > s.smlTil || s.smlFra < MIN_DATO || s.smlTil > d)) s.sml = 'av';
        if (s.sml !== 'egen') { s.smlFra = null; s.smlTil = null; }
        // Etiketter bare for verdier som står i et filter
        var brukt = {};
        s.filtre.forEach(function (f) { f.verdier.forEach(function (v) { brukt[f.dim + '|' + v] = true; }); });
        Object.keys(s.etiketter).forEach(function (k) { if (!brukt[k]) delete s.etiketter[k]; });
    }

    function lesAdresse() {
        var sp = new URLSearchParams(location.search);
        var s = nyTilstand();
        var p = sp.get('periode') || STANDARD_PERIODE;
        if (har(ALIASER, p)) p = ALIASER[p];
        s.periode = PERIODER.indexOf(p) >= 0 ? p : STANDARD_PERIODE;
        var d = sp.get('dato');
        if (gyldigDato(d)) s.dato = d;
        s.fra = sp.get('fra');
        s.til = sp.get('til');
        var sml = sp.get('sml');
        if (SAMMENLIGNINGER.indexOf(sml) >= 0) s.sml = sml;
        s.smlFra = sp.get('sml_fra');
        s.smlTil = sp.get('sml_til');
        if (sp.get('ukedag') === '0') s.ukedag = '0';
        var sett = {};
        sp.getAll('f').forEach(function (raa) {
            var f = lesFilter(raa);
            if (!f || s.filtre.length >= MAKS_FILTRE || sett[f.op + ' ' + f.dim]) return;
            sett[f.op + ' ' + f.dim] = true;
            s.filtre.push(f);
        });
        sp.getAll('l').forEach(function (raa) {
            var x = raa.split(',');
            if (x.length !== 3) return;
            try { s.etiketter[decodeURIComponent(x[0]) + '|' + decodeURIComponent(x[1])] = decodeURIComponent(x[2]).slice(0, 200); } catch (e) { /* ødelagt etikett */ }
        });
        var g = sp.get('graf');
        if (GRAF_METRIKKER.indexOf(g) >= 0) s.graf = g;
        var iv = sp.get('intervall');
        if (har(INTERVALL_NAVN, iv)) s.intervall = iv;
        Object.keys(FANER).forEach(function (panel) {
            var v = sp.get(panel);
            if (FANER[panel].indexOf(v) >= 0) s.fane[panel] = v;
        });
        if (UTM.indexOf(sp.get('utm')) >= 0) s.fane.utm = sp.get('utm');
        s.fane.url = sp.get('url') === '1';
        var eg = sp.get('egenskap');
        if (eg && oppsett && oppsett.egenskaper.indexOf(eg) >= 0) s.fane.egenskap = eg;
        var r = sp.get('detaljer');
        if (r && gyldigRapport(r)) {
            var sorter = sp.get('sortering');
            s.detaljer = {
                rapport: r,
                sok: (sp.get('sok') || '').slice(0, 100),
                sorter: /^(navn|[a-z_]{1,30}):(asc|desc)$/.test(sorter || '') ? sorter : null
            };
        }
        var gr = sp.get('filter');
        if (gr === 'velg' || GRUPPER.some(function (x) { return x.id === gr && gruppeTilgjengelig(x); })) s.filterGruppe = gr;
        normaliser(s);
        return s;
    }
    function gyldigRapport(r) {
        if (erEgenskap(r)) return kjentEgenskap(egenskapNokkel(r));
        return har(RAPPORTER, r) && r !== 'kart';
    }

    function adresseFra(s) {
        var sp = new URLSearchParams();
        if (s.periode !== STANDARD_PERIODE) sp.set('periode', s.periode);
        if (s.dato) sp.set('dato', s.dato);
        if (s.periode === 'egen') { sp.set('fra', s.fra); sp.set('til', s.til); }
        if (s.sml !== 'av') sp.set('sml', s.sml);
        if (s.sml === 'egen') { sp.set('sml_fra', s.smlFra); sp.set('sml_til', s.smlTil); }
        if (s.ukedag === '0') sp.set('ukedag', '0');
        s.filtre.forEach(function (f) { sp.append('f', filterParam(f)); });
        // Etiketter til pillene (regioner og byer har bare koder i filteret); sendes aldri til API-et
        Object.keys(s.etiketter).forEach(function (k) {
            var i = k.indexOf('|');
            sp.append('l', [k.slice(0, i), k.slice(i + 1), s.etiketter[k]].map(encodeURIComponent).join(','));
        });
        if (s.graf !== 'visitors') sp.set('graf', s.graf);
        if (s.intervall) sp.set('intervall', s.intervall);
        Object.keys(FANER).forEach(function (panel) { if (s.fane[panel]) sp.set(panel, s.fane[panel]); });
        if (s.fane.utm) sp.set('utm', s.fane.utm);
        if (s.fane.url) sp.set('url', '1');
        if (s.fane.egenskap) sp.set('egenskap', s.fane.egenskap);
        if (s.detaljer) {
            sp.set('detaljer', s.detaljer.rapport);
            if (s.detaljer.sok) sp.set('sok', s.detaljer.sok);
            if (s.detaljer.sorter) sp.set('sortering', s.detaljer.sorter);
        }
        if (s.filterGruppe) sp.set('filter', s.filterGruppe);
        if (!tasterPa) sp.set('taster', '0');
        var q = sp.toString();
        return location.pathname + (q ? '?' + q : '');
    }

    // Parametrene til API-et: bare kjente verdier, aldri adressen som den er (API-et avviser ukjente)
    function apiParametre(s, filtre) {
        var sp = new URLSearchParams();
        if (s.periode !== STANDARD_PERIODE) sp.set('periode', s.periode);
        if (s.dato && harDato(s.periode)) sp.set('dato', s.dato);
        if (s.periode === 'egen') { sp.set('fra', s.fra); sp.set('til', s.til); }
        if (harSml(s.periode)) {
            if (s.sml !== 'av') sp.set('sml', s.sml);
            if (s.sml === 'egen') { sp.set('sml_fra', s.smlFra); sp.set('sml_til', s.smlTil); }
            if (s.ukedag === '0') sp.set('ukedag', '0');
        }
        (filtre || s.filtre).forEach(function (f) { sp.append('f', filterParam(f)); });
        return sp;
    }
    var grunnlag = function () { return apiParametre(S).toString(); };

    // Endrer tilstanden og adressen, og tegner. valg.push: nytt steg i historikken (tilbake-knappen),
    // valg.dialog: steget åpner et vindu (lukkes med tilbake), valg.lukk: vinduet lukkes i samme steg.
    function naviger(endre, valg) {
        valg = valg || {};
        endre(S);
        normaliser(S);
        var url = adresseFra(S);
        if (valg.push) {
            history.pushState(valg.dialog ? { dialog: valg.dialog } : null, '', url);
        } else {
            history.replaceState(valg.lukk ? null : history.state, '', url);
        }
        if (valg.bareDialog) synkDialoger();
        else visning();
    }

    // ── Server ──────────────────────────────────────────────────────────
    function api(sti, valg) {
        valg = valg || {};
        var hoder = { Accept: 'application/json' };
        if (valg.body) hoder['Content-Type'] = 'application/json';
        return fetch(API + sti, { method: valg.method || 'GET', headers: hoder, body: valg.body, credentials: 'same-origin', cache: 'no-store' })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data || {} }; });
            });
    }

    // Mellomlageret i nettleseren: hver del for seg, nøkkel = parametrene + delens navn.
    // «naa» er lik for alle visninger (Plausible ignorerer filtrene der).
    var lager = new Map();          // nøkkel → { verdi, tid, ttl, oppdatert }
    var perioder = new Map();       // parametre → periode-objektet fra API-et
    var delfeil = new Map();        // nøkkel → feilmelding
    var venter = new Set();         // nøkler som hentes nå
    var ukjentGraf = new Set();     // parametre der intervallet må leses av svaret først
    var altStart = null;            // første dag med besøk (fra All tid), for grafintervallene
    var nokkel = function (grunn, del) { return del === 'naa' ? 'naa' : grunn + '|' + del; };
    var sanntidGrunn = function (grunn) { return /(^|&)periode=sanntid(&|$)/.test(grunn); };
    function fersk(k) {
        var x = lager.get(k);
        return x && Date.now() - x.tid < x.ttl ? x : null;
    }
    function rydd() {
        if (lager.size < 400) return;
        var naa = Date.now();
        lager.forEach(function (x, k) { if (naa - x.tid > x.ttl) lager.delete(k); });
    }

    // Henter delene som mangler, i én /data-forespørsel. Gir { status, data, antall }.
    function hentDeler(grunn, deler, tving) {
        var mangler = deler.filter(function (d) {
            var k = nokkel(grunn, d);
            return !venter.has(k) && (tving || !fersk(k));
        });
        if (!mangler.length) return Promise.resolve({ status: 200, data: {}, antall: 0 });
        mangler.forEach(function (d) { venter.add(nokkel(grunn, d)); delfeil.delete(nokkel(grunn, d)); });
        var sti = '/data?' + (grunn ? grunn + '&' : '') + 'deler=' + mangler.map(encodeURIComponent).join(',');
        return api(sti).then(function (svar) {
            mangler.forEach(function (d) { venter.delete(nokkel(grunn, d)); });
            svar.antall = mangler.length;
            if (svar.status !== 200) {
                // Alle delene får feilen (så ingen gamle tall blir stående). Én del viser den i sitt eget
                // kort; feiler en full visning, vises ett varsel øverst i stedet (se last()).
                if (svar.status !== 401 && svar.status !== 400) {
                    var melding = svar.data.feil || (svar.status === 429 ? MELDING_MANGE : MELDING_FEIL);
                    mangler.forEach(function (d) { delfeil.set(nokkel(grunn, d), melding); });
                }
                return svar;
            }
            var d = svar.data;
            if (d.periode) {
                perioder.set(grunn, d.periode);
                if (d.periode.key === 'alt') altStart = d.periode.fra;
            }
            mangler.forEach(function (del) {
                var k = nokkel(grunn, del);
                var v = d.deler && d.deler[del];
                if (!v || v.feil) { delfeil.set(k, (v && v.feil) || MELDING_FEIL); return; }
                delfeil.delete(k);
                lager.set(k, { verdi: v, tid: Date.now(), ttl: del === 'naa' || sanntidGrunn(grunn) ? LEVENDE_MS : LAGER_MS, oppdatert: d.oppdatert });
            });
            rydd();
            return svar;
        }, function () {
            mangler.forEach(function (d) {
                var k = nokkel(grunn, d);
                venter.delete(k);
                delfeil.set(k, MELDING_NETT);
            });
            return { status: 0, data: {}, antall: mangler.length };
        });
    }

    // Delene som vises nå: tallene øverst, grafen, én liste per panel og «besøkende nå»
    function synligeDeler(grunn) {
        var d = ['topp'];
        var g = grafDel(grunn);
        if (g) d.push(g);
        PANELER.forEach(function (p) {
            var v = panelValg(p);
            if (v && v.rapport && !(v.fane === 'kart' && kart.status !== 'ok')) d.push('liste:' + v.rapport);
        });
        if (naaSynlig()) d.push('naa');
        return d;
    }
    function intervallInfo(grunn) {
        var p = perioder.get(grunn);
        if (p) return { liste: p.intervaller || [], standard: p.standard_intervall };
        if (ukjentGraf.has(grunn)) return null;
        return beregnIntervaller();
    }
    function grafIntervall(grunn) {
        var info = intervallInfo(grunn);
        if (!info || !info.liste.length) return null;
        return info.liste.indexOf(S.intervall) >= 0 ? S.intervall : info.standard;
    }
    function grafDel(grunn) {
        if (S.periode === 'sanntid') return null;
        var iv = grafIntervall(grunn);
        return iv ? 'graf:' + grafMetrikk() + ':' + iv : null;
    }
    var naaSynlig = function () { return innlogget && S.periode !== 'sanntid' && !S.filtre.length; };

    var visningNr = 0;
    // Henter det som mangler for visningen og tegner. stille: ingen dempet «laster»-tilstand
    // (automatisk oppdatering i sanntid); tving: hent på nytt selv om svaret er i mellomlageret.
    function last(stille, tving) {
        var nr = ++visningNr;
        var grunn = grunnlag();
        var deler = synligeDeler(grunn);
        if (!stille) skjulVarsel();
        var lover = hentDeler(grunn, deler, tving);
        if (!stille) tegnData();
        lover.then(function (svar) {
            if (nr !== visningNr || !innlogget) return;
            if (svar.status === 401) return visLogin('Du er logget ut. Logg inn igjen.');
            if (svar.status === 400) return ugyldigVisning(svar.data.feil, deler, grunn);
            if (svar.status !== 200 && svar.antall > 1 && !stille) {
                visVarsel(svar.status === 0 ? MELDING_NETT : svar.status === 429 && !svar.data.feil ? MELDING_MANGE : svar.data.feil || MELDING_FEIL);
            }
            tegnData();
            // All tid første gang: grafen kan bes om først når perioden (og intervallene) er kjent
            var g = grafDel(grunn);
            if (svar.status === 200 && g && deler.indexOf(g) < 0) return last(stille);
            if (!stille && svar.antall) kunngjor();
            planleggEtter(svar);
        });
    }

    // 400 fra API-et: en gammel eller ødelagt adresse. Grafen prøves én gang til med intervallet
    // fra serveren; ellers vises standardvisningen.
    function ugyldigVisning(melding, deler, grunn) {
        var g = deler.filter(function (d) { return d.indexOf('graf:') === 0; })[0];
        if (g && !ukjentGraf.has(grunn)) {
            ukjentGraf.add(grunn);
            S.intervall = null;
            history.replaceState(history.state, '', adresseFra(S));
            return last();
        }
        var standard = nyTilstand();
        var erStandard = S.periode === standard.periode && !S.dato && S.sml === 'av' && !S.filtre.length;
        if (!erStandard) {
            naviger(function (s) {
                s.periode = STANDARD_PERIODE; s.dato = null; s.sml = 'av'; s.ukedag = '1'; s.filtre = []; s.detaljer = null; s.filterGruppe = null;
            });
        }
        visVarsel((melding ? melding + ' ' : '') + (erStandard ? 'Last siden på nytt.' : 'Du ser standardvisningen nå.'));
    }

    // ── Visningene (laster / innlogging / dashbord) ─────────────────────
    var vis = { laster: $('[data-vis="laster"]'), login: $('[data-vis="login"]'), dash: $('[data-vis="dash"]') };
    var skjema = $('[data-skjema]');
    var felt = { epost: $('#epost'), passord: $('#passord') };
    var loggInnKnapp = $('[data-knapp]');
    var feilTekst = $('[data-feil]');
    var innlogget = false;
    var oppsett = null;
    var nettsted = '';

    function visDel(navn) {
        Object.keys(vis).forEach(function (k) { vis[k].hidden = k !== navn; });
        $('[data-bruker]').hidden = navn !== 'dash';
    }

    function visLogin(melding) {
        innlogget = false;
        visningNr++;                 // svar som er underveis fra forrige innlogging, kastes
        lager.clear(); perioder.clear(); delfeil.clear(); venter.clear(); detaljLager.clear(); ukjentGraf.clear();
        sistKunngjort = null;
        sanntidTikk = 0;
        oppsett = null; altStart = null; nettsted = '';
        S = nyTilstand();
        clearTimeout(tidtaker); tidtaker = 0;
        [D.el, F.el].forEach(function (d) { if (d.open) d.close(); });
        nullstill();
        $('[data-varsel]').hidden = true;
        felt.passord.type = 'password';
        $('[data-vis-passord]').textContent = 'Vis';
        $('[data-vis-passord]').setAttribute('aria-pressed', 'false');
        document.title = 'Kundeportal · DOTDEV';
        visDel('login');
        settFeil(melding || '');
        if (melding) $('#login-tittel').focus();
    }

    function visDash(meg, flyttFokus) {
        innlogget = true;
        nettsted = meg.nettsted;
        $('[data-nettsted]').textContent = meg.nettsted;
        $('[data-epost]').textContent = meg.epost || '';
        document.title = 'Statistikk for ' + meg.nettsted + ' · DOTDEV';
        visDel('dash');
        if (flyttFokus) $('#dash-tittel').focus();
        var raaSted = new URLSearchParams(location.search).get('sted');
        // Kartet hentes bare når kartfanen vises (standardfanen i «Hvor de er»)
        var kartLover = !raaSted || raaSted === 'kart' ? lastKart() : Promise.resolve();
        var oppsettLover = hentOppsett();
        Promise.all([oppsettLover, kartLover]).then(function (r) {
            if (!innlogget) return;
            if (r[0] === false) return visLogin('Du er logget ut. Logg inn igjen.');
            S = lesAdresse();
            history.replaceState(history.state, '', adresseFra(S));
            visning();
        });
    }

    // Tidssone, mål og egenskaper. mal/egenskaper er null fra API-et når Plausible ikke svarte:
    // da står malUkjent/egenskaperUkjent, og siden sier det i stedet for «ingen mål».
    function settOppsett(d) {
        d = d || {};
        var tekster = function (l) { return l.filter(function (e) { return typeof e === 'string'; }); };
        oppsett = {
            tidssone: typeof d.tidssone === 'string' ? d.tidssone : 'Europe/Oslo',
            mal: Array.isArray(d.mal) ? d.mal.filter(function (m) { return m && typeof m.navn === 'string'; }) : [],
            malUkjent: !Array.isArray(d.mal),
            egenskaper: Array.isArray(d.egenskaper) ? tekster(d.egenskaper) : [],
            egenskaperUkjent: !Array.isArray(d.egenskaper),
            interne: Array.isArray(d.interne) ? tekster(d.interne) : INTERNE,
            inntekt: Boolean(d.inntekt)
        };
    }
    // Gir false når kunden er logget ut
    function hentOppsett() {
        return api('/oppsett').then(function (svar) {
            if (svar.status === 401) return false;
            settOppsett(svar.status === 200 ? svar.data : null);
            return true;
        }, function () {
            settOppsett(null);
            return true;
        });
    }
    var oppsettUkjent = function () { return Boolean(oppsett && (oppsett.malUkjent || oppsett.egenskaperUkjent)); };
    // «Prøv igjen» når mål eller egenskaper manglet: hent oppsettet, les adressen på nytt og tegn
    function provOppsettIgjen() {
        return hentOppsett().then(function (inne) {
            if (!innlogget) return;
            if (!inne) return visLogin('Du er logget ut. Logg inn igjen.');
            S = lesAdresse();
            visning();
        });
    }

    // Tegner alt fra tilstanden og henter det som mangler
    function visning() {
        if (!innlogget || !oppsett) return;
        lukkDatoer(true);
        last();
        synkDialoger();
    }

    // ── Innlogging ──────────────────────────────────────────────────────
    function settFeil(tekst, ugyldig) {
        feilTekst.textContent = tekst;
        [felt.epost, felt.passord].forEach(function (f) { f.removeAttribute('aria-invalid'); });
        if (ugyldig) { ugyldig.setAttribute('aria-invalid', 'true'); ugyldig.focus(); }
    }

    skjema.addEventListener('submit', function (e) {
        e.preventDefault();
        var epost = felt.epost.value.trim();
        var passord = felt.passord.value;
        if (!epost) return settFeil('Skriv inn e-posten.', felt.epost);
        if (!passord) return settFeil('Skriv inn passordet.', felt.passord);
        settFeil('');
        loggInnKnapp.disabled = true;
        loggInnKnapp.textContent = 'Logger inn …';
        api('/logginn', { method: 'POST', body: JSON.stringify({ epost: epost, passord: passord }) })
            .then(function (svar) {
                if (svar.status === 200) {
                    felt.passord.value = '';
                    visDash(svar.data, true);
                } else {
                    settFeil(svar.data.feil || (svar.status === 429 ? 'For mange forsøk. Vent litt og prøv igjen.' : 'Noe gikk galt. Prøv igjen.'), svar.status === 401 ? felt.passord : null);
                }
            })
            .catch(function () { settFeil('Fikk ikke kontakt. Sjekk nettet og prøv igjen.'); })
            .then(function () { loggInnKnapp.disabled = false; loggInnKnapp.textContent = 'Logg inn'; });
    });

    $('[data-vis-passord]').addEventListener('click', function () {
        var synlig = felt.passord.type === 'password';
        felt.passord.type = synlig ? 'text' : 'password';
        this.textContent = synlig ? 'Skjul' : 'Vis';
        this.setAttribute('aria-pressed', String(synlig));
    });

    $('[data-loggut]').addEventListener('click', function () {
        var knappUt = this;
        knappUt.disabled = true;
        api('/loggut', { method: 'POST' })
            .then(function (svar) { return svar.status === 200; }, function () { return false; })
            .then(function (ok) {
                knappUt.disabled = false;
                if (!ok) return visVarsel('Fikk ikke logget ut. Sjekk nettet og prøv igjen.');
                history.replaceState(null, '', location.pathname);
                visLogin('');
                felt.epost.focus();
            });
    });

    // ── Varsel og kunngjøring ───────────────────────────────────────────
    function visVarsel(tekst) {
        $('[data-varsel-tekst]').textContent = tekst;
        $('[data-varsel]').hidden = false;
    }
    function skjulVarsel() { $('[data-varsel]').hidden = true; }
    // Mens varselet øverst vises, viser kortene ikke sin egen feilboks i tillegg
    var varselVises = function () { return !$('[data-varsel]').hidden; };
    $('[data-prov-igjen]').addEventListener('click', function () {
        delfeil.clear();
        if (oppsettUkjent()) { skjulVarsel(); provOppsettIgjen(); return; }
        last(false, true);
    });
    // Skjermlesere får vite hva som vises etter et bytte av periode, sammenligning eller filtre
    // (ikke ved faner og grafvalg, og ikke for hver automatiske oppdatering)
    var sistKunngjort = null;
    function kunngjor() {
        var g = grunnlag();
        if (g === sistKunngjort) return;
        sistKunngjort = g;
        var n = S.filtre.length;
        $('[data-status]').textContent = 'Viser ' + periodeEtikett().toLowerCase() + (n ? ', med ' + n + (n === 1 ? ' filter' : ' filtre') : '') + '.';
    }

    // Tømmer dashbordet, så det aldri står igjen tall fra en annen innlogging
    function nullstill() {
        $('[data-meta]').textContent = '';
        $('[data-kpier]').replaceChildren();
        $('[data-naa]').hidden = true;
        $('[data-filtre]').hidden = true;
        $('[data-filterliste]').replaceChildren();
        $('[data-filterliste]').removeAttribute('data-sig');
        $('[data-eksport-status]').textContent = '';
        G = null;
        grafVist = null;
        kpiVist = null;
        aktiv = -1;
        tips.hidden = true;
        var svg = graf.querySelector('svg');
        if (svg) svg.remove();
        ['[data-graf-maks]', '[data-graf-akse]', '[data-tabell]', '[data-tabell-hode]'].forEach(function (s) { $(s).replaceChildren(); });
        PANELER.forEach(function (p) { if (p.el) { p.el.liste.replaceChildren(); p.vist = null; p.vistX = null; } });
    }

    // ── Perioden ────────────────────────────────────────────────────────
    function periodeEtikett(kort) {
        var d = idag(), p = S.periode;
        switch (p) {
            case 'sanntid': return 'Sanntid';
            case 'dag':
                if (!S.dato) return 'I dag';
                if (S.dato === plussDager(d, -1)) return 'I går';
                return stor((kort ? fKortDag : fLangAar).format(dato(S.dato)));
            case '24t': return 'Siste 24 timer';
            case '7d': return 'Siste 7 dager';
            case '28d': return 'Siste 28 dager';
            case '30d': return 'Siste 30 dager';
            case '91d': return 'Siste 91 dager';
            case 'mnd':
                if (!S.dato) return 'Denne måneden';
                if (S.dato === plussManeder(forsteIManed(d), -1)) return 'Forrige måned';
                return stor(fMndLang.format(dato(S.dato)));
            case 'aar': return S.dato ? S.dato.slice(0, 4) : 'I år';
            case '6mnd': return 'Siste 6 måneder';
            case '12mnd': return 'Siste 12 måneder';
            case 'alt': return 'All tid';
            default: return spenn(S.fra, S.til);
        }
    }
    // Verdien i periodemenyen som svarer til visningen (tom = vises som egen linje øverst)
    function menyVerdi() {
        var d = idag();
        if (S.periode === 'dag') return !S.dato ? 'dag' : S.dato === plussDager(d, -1) ? 'igar' : '';
        if (S.periode === 'mnd') return !S.dato ? 'mnd' : S.dato === plussManeder(forsteIManed(d), -1) ? 'forrige_mnd' : '';
        if (S.periode === 'aar') return S.dato ? '' : 'aar';
        if (S.periode === 'egen') return '';
        return S.periode;
    }
    function velgPeriode(v) {
        if (v === 'egen') return visDatoer('periode');
        naviger(function (s) {
            s.dato = null;
            if (v === 'igar') { s.periode = 'dag'; s.dato = plussDager(idag(), -1); }
            else if (v === 'forrige_mnd') { s.periode = 'mnd'; s.dato = plussManeder(forsteIManed(idag()), -1); }
            else if (PERIODER.indexOf(v) >= 0) s.periode = v;
        }, { push: true });
    }
    // Datoen ◀ / ▶ går til (dag, måned eller år), eller null når det ikke går lenger
    function nabodato(retning) {
        if (!harDato(S.periode)) return null;
        var d = idag(), ny;
        if (S.periode === 'dag') {
            ny = plussDager(S.dato || d, retning);
            return ny < MIN_DATO || ny > d ? null : ny;
        }
        if (S.periode === 'mnd') {
            ny = plussManeder(S.dato || forsteIManed(d), retning);
            return ny < MIN_DATO || ny > forsteIManed(d) ? null : ny;
        }
        ny = (Number((S.dato || d).slice(0, 4)) + retning) + '-01-01';
        return ny < MIN_DATO || ny > d ? null : ny;
    }
    function flyttPeriode(retning) {
        var ny = nabodato(retning);
        if (!ny) return false;
        naviger(function (s) { s.dato = ny; }, { push: true });
        return true;
    }

    var periodeVelger = $('[data-periode-velger]');
    var smlVelger = $('[data-sml-velger]');
    periodeVelger.addEventListener('change', function () {
        var v = periodeVelger.value;
        if (v) velgPeriode(v);
        if (v === 'egen') tegnVerktoy();       // menyen viser fortsatt perioden til datoene er valgt
    });
    $('[data-forrige]').addEventListener('click', function () { flyttPeriode(-1); });
    $('[data-neste]').addEventListener('click', function () { flyttPeriode(1); });
    smlVelger.addEventListener('change', function () {
        var v = smlVelger.value;
        if (v === 'egen') { visDatoer('sml'); tegnVerktoy(); return; }
        naviger(function (s) { s.sml = v; }, { push: true });
    });
    $$('[data-ukedag-verdi]').forEach(function (b) {
        b.addEventListener('click', function () {
            var v = b.getAttribute('data-ukedag-verdi');
            if (v !== S.ukedag) naviger(function (s) { s.ukedag = v; }, { push: true });
        });
    });
    $('[data-naa]').addEventListener('click', function () { velgPeriode('sanntid'); });

    // Egne datoer: ett skjema for både perioden og sammenligningen
    var datoSkjema = $('[data-datoer]');
    var datoModus = null;
    function visDatoer(modus) {
        if (modus === 'sml' && !harSml(S.periode)) return;
        datoModus = modus;
        var d = idag(), p = perioder.get(grunnlag());
        var fra, til;
        if (modus === 'periode') {
            fra = S.periode === 'egen' ? S.fra : p ? p.fra : plussDager(d, -28);
            til = S.periode === 'egen' ? S.til : p ? p.til : plussDager(d, -1);
        } else {
            var o = S.sml === 'egen' ? { fra: S.smlFra, til: S.smlTil } : p && p.endring_mot;
            fra = o ? o.fra : plussDager(d, -56);
            til = o ? o.til : plussDager(d, -29);
        }
        $('[data-datoer-tittel]').textContent = modus === 'periode' ? 'Velg datoer' : 'Sammenlign med disse datoene';
        [$('[data-dato-fra]'), $('[data-dato-til]')].forEach(function (inp, i) {
            inp.min = MIN_DATO;
            inp.max = d;
            inp.value = i ? til : fra;
            inp.removeAttribute('aria-invalid');
        });
        $('[data-datoer-feil]').textContent = '';
        datoSkjema.hidden = false;
        $('[data-dato-fra]').focus();
    }
    function lukkDatoer(stille) {
        if (datoSkjema.hidden) return;
        datoSkjema.hidden = true;
        var modus = datoModus;
        datoModus = null;
        if (!stille) (modus === 'sml' ? smlVelger : periodeVelger).focus();
    }
    datoSkjema.addEventListener('submit', function (e) {
        e.preventDefault();
        var fraEl = $('[data-dato-fra]'), tilEl = $('[data-dato-til]');
        var fra = fraEl.value, til = tilEl.value, d = idag();
        var feil = null, galt = null;
        if (!gyldigDato(fra) || fra < MIN_DATO || fra > d) { feil = 'Velg en fra-dato mellom 1. januar 2019 og i dag.'; galt = fraEl; }
        else if (!gyldigDato(til) || til < MIN_DATO || til > d) { feil = 'Velg en til-dato mellom 1. januar 2019 og i dag.'; galt = tilEl; }
        else if (fra > til) { feil = 'Fra-datoen må være før til-datoen.'; galt = fraEl; }
        [fraEl, tilEl].forEach(function (x) { x.removeAttribute('aria-invalid'); });
        if (feil) {
            $('[data-datoer-feil]').textContent = feil;
            galt.setAttribute('aria-invalid', 'true');
            galt.focus();
            return;
        }
        var modus = datoModus;
        datoSkjema.hidden = true;
        datoModus = null;
        naviger(function (s) {
            if (modus === 'periode') { s.periode = 'egen'; s.fra = fra; s.til = til; s.dato = null; }
            else { s.sml = 'egen'; s.smlFra = fra; s.smlTil = til; }
        }, { push: true });
        (modus === 'sml' ? smlVelger : periodeVelger).focus();
    });
    $('[data-datoer-avbryt]').addEventListener('click', function () { lukkDatoer(false); });
    datoSkjema.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); lukkDatoer(false); }
    });

    // Toppen: menyene, pilene, «besøkende nå», metalinjen og nedlastingsknappen
    function tegnVerktoy() {
        var gjeldende = $('[data-periode-gjeldende]');
        var mv = menyVerdi();
        gjeldende.textContent = periodeEtikett(smal());
        periodeVelger.value = mv || '';
        var forrige = $('[data-forrige]'), neste = $('[data-neste]');
        forrige.hidden = neste.hidden = !harDato(S.periode);
        forrige.disabled = !nabodato(-1);
        neste.disabled = !nabodato(1);

        $('[data-sml-gruppe]').hidden = !harSml(S.periode);
        smlVelger.value = S.sml;
        var ukedag = $('[data-ukedag]');
        ukedag.hidden = S.sml !== 'forrige' && S.sml !== 'aar';
        $$('[data-ukedag-verdi]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-ukedag-verdi') === S.ukedag)); });

        var lastNed = $('[data-last-ned]');
        lastNed.hidden = S.periode === 'sanntid';
        var sp = apiParametre(S);
        var iv = grafIntervall(grunnlag());
        if (iv) sp.set('intervall', iv);
        lastNed.href = API + '/eksport?' + sp.toString();
    }

    function tegnMeta(grunn) {
        var p = perioder.get(grunn);
        var meta = $('[data-meta]');
        if (!p) { if (!meta.textContent) meta.textContent = periodeEtikett(); return; }
        var deler = [];
        if (p.key === 'sanntid') deler.push('Siste 30 minutter (listene: siste 5), oppdateres av seg selv');
        else deler.push(omradeTekst({ fra: p.fra, til: p.til, fra_kl: p.fra_kl, til_kl: p.til_kl }));
        var eldst = null;
        synligeDeler(grunn).forEach(function (d) {
            if (d === 'naa') return;
            var x = lager.get(nokkel(grunn, d));
            if (x && x.oppdatert && (!eldst || x.oppdatert < eldst)) eldst = x.oppdatert;
        });
        if (eldst) deler.push('Oppdatert kl. ' + fKlokke(p.tidssone || tidssone()).format(new Date(eldst)));
        if (p.sml) deler.push('Sammenlignet med ' + omradeTekst(p.sml));
        else if (p.endring_mot) deler.push('Endring mot ' + omradeTekst(p.endring_mot));
        meta.textContent = deler.join(' · ');
    }

    function tegnNaa() {
        var el = $('[data-naa]');
        var x = lager.get('naa');
        if (!naaSynlig() || !x) { el.hidden = true; return; }
        var n = x.verdi.besokende;
        $('[data-naa-tekst]').textContent = heltall(n) + ' besøkende nå';
        el.setAttribute('aria-label', heltall(n) + ' besøkende nå. Se sanntid.');
        el.hidden = false;
    }

    // ── Filterpillene ───────────────────────────────────────────────────
    function tegnFiltre() {
        var boks = $('[data-filtre]'), ul = $('[data-filterliste]');
        // Bygges bare på nytt når filtrene endres, så fokus på en pille står
        var sig = JSON.stringify([S.filtre, S.etiketter]);
        if (ul.getAttribute('data-sig') === sig) return;
        ul.setAttribute('data-sig', sig);
        ul.replaceChildren();
        boks.hidden = !S.filtre.length;
        S.filtre.forEach(function (f, i) {
            var tekst = filterTekst(f);
            var li = lag('li', 'pille');
            var rediger = knapp('pille__tekst', tekst);
            rediger.title = 'Endre filteret: ' + tekst;
            rediger.setAttribute('data-pille', String(i));
            rediger.addEventListener('click', function () { apneFilter(gruppeFor(f.dim)); });
            var fjern = knapp('pille__fjern', '×');
            fjern.setAttribute('aria-label', 'Fjern filteret: ' + tekst);
            fjern.title = 'Fjern filteret';
            fjern.addEventListener('click', function () {
                // Sammenlign på operator og dimensjon (unike), ikke på objektet: S bygges på nytt
                // fra adressen ved tilbake/fram og når et vindu lukkes, mens pillene kan stå
                naviger(function (s) { s.filtre = s.filtre.filter(function (x) { return !(x.op === f.op && x.dim === f.dim); }); }, { push: true });
                var neste = $$('.pille__tekst')[Math.min(i, S.filtre.length - 1)];
                (neste || $('[data-filtrer]')).focus();
            });
            li.append(rediger, fjern);
            ul.append(li);
        });
        $('[data-fjern-alle]').hidden = S.filtre.length < 2;
    }
    function fjernAlleFiltre() {
        if (!S.filtre.length) return;
        naviger(function (s) { s.filtre = []; }, { push: true });
        $('[data-filtrer]').focus();
    }
    $('[data-fjern-alle]').addEventListener('click', fjernAlleFiltre);

    // Legger til et «er»-filter fra en rad (erstatter andre filtre på samme dimensjon, som Plausible).
    // forVert: rader i URL-listene filtrerer også på vertsnavnet (Plausibles hostname + page).
    function leggTilFilter(dim, verdi, etikett, ekstra, valg, forVert) {
        var nye = (forVert ? [{ op: 'is', dim: 'vert', verdier: [forVert] }] : []).concat([{ op: 'is', dim: dim, verdier: [verdi] }]);
        var andre = S.filtre.filter(function (f) { return !nye.some(function (n) { return n.dim === f.dim; }); });
        if (andre.length + nye.length > MAKS_FILTRE) { visVarsel('Høyst ' + MAKS_FILTRE + ' filtre om gangen. Fjern et filter først.'); return; }
        naviger(function (s) {
            s.filtre = andre.concat(nye);
            if (etikett && (dim === 'region' || dim === 'by')) s.etiketter[dim + '|' + verdi] = etikett;
            if (ekstra) ekstra(s);
        }, valg || { push: true });
        var pille = $$('.pille__tekst').filter(function (b) { return S.filtre[Number(b.getAttribute('data-pille'))].dim === dim; })[0];
        if (pille) pille.focus();
    }
    // Klikk på et land går videre til regionene, en region til byene, et mål med egen liste til den
    function etterKlikk(dim) {
        return function (s) {
            if (dim === 'land') s.fane.sted = 'regioner';
            if (dim === 'region') s.fane.sted = 'byer';
            if (dim === 'mal') s.fane.handlinger = null;
        };
    }

    // ── Tallene øverst ──────────────────────────────────────────────────
    var kpiVist = null;     // nøkkelen som står i kortene nå
    function tegnKpi(grunn) {
        var boks = $('[data-kpier]');
        var k = nokkel(grunn, 'topp');
        var x = lager.get(k);
        var feil = delfeil.get(k);
        boks.setAttribute('aria-busy', String(venter.has(k)));
        var feilBoks = $('[data-kpi-feil]');
        feilBoks.hidden = !feil || Boolean(x) || varselVises();
        if (feil && !x && !varselVises()) visDelfeil(feilBoks, feil, function () { delfeil.delete(k); hentOgTegn(grunn, ['topp']); });
        var ktx = kontekst();
        var data = x ? x.verdi : null;
        if (!data && !feil && kpiVist && kpiVist.ktx === ktx) return;     // det gamle står (dempet) til det nye kommer
        var p = perioder.get(grunn);
        var valgt = grafMetrikk();
        if (x && kpiVist && kpiVist.x === x && kpiVist.p === p && kpiVist.valgt === valgt && kpiVist.ktx === ktx) return;
        var fokus = document.activeElement && boks.contains(document.activeElement) ? document.activeElement.getAttribute('data-kpi') : null;
        var metrikker = data ? data.metrikker : METRIKKER[ktx].filter(function (m) { return ktx !== 'mal' || (m !== 'total_revenue' && m !== 'average_revenue') || oppsett.inntekt; })
            .map(function (m) { return { key: m, etikett: metrikkNavn(m), verdi: null, forrige: null, endring: null }; });
        kpiVist = { ktx: ktx, x: x, p: p, valgt: valgt };
        var merknadMetrikk = {};
        var generelle = [];
        (data && data.merknader || []).forEach(function (m) {
            if (m.metrikk) merknadMetrikk[m.metrikk] = m.tekst;
            else generelle.push(m.tekst);
        });
        boks.setAttribute('data-antall', String(metrikker.length));
        boks.replaceChildren();
        metrikker.forEach(function (m) {
            var graferbar = ktx !== 'sanntid' && m.key !== 'naa';
            var el = graferbar ? knapp('kpi') : lag('div', 'kpi');
            el.setAttribute('data-kpi', m.key);
            if (graferbar) {
                el.setAttribute('aria-pressed', String(m.key === valgt));
                el.addEventListener('click', function () {
                    if (m.key !== S.graf) naviger(function (s) { s.graf = m.key; });
                });
            }
            var navn = lag('span', 'kpi__navn', m.etikett + (merknadMetrikk[m.key] ? ' *' : ''));
            var verdiTxt = verdiTekst(m.key, m.verdi, m.valuta);
            // Lange verdier («1 min 57 s», «1 413,08 kr») får mindre skrift på smal skjerm, så de ikke kuttes
            var verdi = lag('span', 'kpi__verdi' + (verdiTxt.length > 10 ? ' lengre' : verdiTxt.length > 7 ? ' lang' : ''), verdiTxt);
            var tittel = m.etikett + ': ' + verdiLang(m.key, m.verdi, m.valuta);
            if (merknadMetrikk[m.key]) tittel += '\n* ' + merknadMetrikk[m.key];
            el.title = tittel + (graferbar ? '\nTrykk for å vise dette i grafen.' : '');
            el.append(navn, verdi);
            if (ktx === 'sanntid') { el.append(lag('span', 'kpi__endring')); }
            else if (p && p.sml) {
                // Sammenligning: endringen, så begge periodene med hvert sitt tall
                var e = lag('span', 'kpi__endring');
                e.append(endringEl(m.key, m.endring));
                var sml = lag('span', 'kpi__sml');
                sml.append(lag('span', null, omradeTekst({ fra: p.fra, til: p.til, fra_kl: p.fra_kl, til_kl: p.til_kl })),
                    lag('span', 'kpi__smlverdi', verdiTekst(m.key, m.sml_verdi, m.valuta)),
                    lag('span', null, omradeTekst(p.sml)));
                el.append(e, sml);
                el.title += '\nMot ' + omradeTekst(p.sml) + ': ' + verdiLang(m.key, m.sml_verdi, m.valuta);
            } else {
                var e2 = lag('span', 'kpi__endring');
                if (m.endring !== null && m.endring !== undefined) {
                    e2.append(endringEl(m.key, m.endring), lag('span', null, 'mot forrige periode'));
                    if (p && p.endring_mot) el.title += '\nMot ' + omradeTekst(p.endring_mot) + ': ' + verdiLang(m.key, m.forrige, m.valuta);
                }
                el.append(e2);
            }
            boks.append(el);
        });
        if (fokus) { var nyFokus = $('[data-kpi="' + fokus + '"]', boks); if (nyFokus) nyFokus.focus(); }
        var merk = $('[data-kpi-merknad]');
        var tekster = unike(generelle.concat(Object.keys(merknadMetrikk).map(function (m) { return '* ' + merknadMetrikk[m]; })));
        merk.textContent = tekster.join(' ');
        merk.hidden = !tekster.length;
    }
    // Samme tekst bare én gang (to inntektstall gir ellers samme merknad to ganger)
    function unike(liste) { return liste.filter(function (x, i) { return liste.indexOf(x) === i; }); }

    // Liten feilboks i ett kort, med «Prøv igjen» som bare henter den delen
    function visDelfeil(boks, melding, prov) {
        boks.replaceChildren();
        var b = knapp('btn btn--ghost btn--liten', 'Prøv igjen');
        b.addEventListener('click', prov);
        boks.append(lag('p', null, melding), b);
        boks.hidden = false;
    }
    function hentOgTegn(grunn, deler) {
        var lover = hentDeler(grunn, deler, true);
        tegnData();
        lover.then(function (svar) {
            if (svar.status === 401) return visLogin('Du er logget ut. Logg inn igjen.');
            tegnData();
        });
    }

    // ── Grafen ──────────────────────────────────────────────────────────
    // Et rutenett av piksler fra kant til kant. Hver søyle får like mange kolonner (bredere søyler
    // når det er få av dem), med én tom kolonne mellom søylene. Pikslene er omtrent kvadratiske og
    // ligger på hele skjermpiksler, så kantene blir skarpe. Sammenligningen er en trappelinje.
    var graf = $('[data-graf]');
    var tips = $('[data-graf-tips]');
    var G = null;            // { data, n, per, fylt, steg, X, hull, sml }
    var aktiv = -1;          // valgt søyle
    var grafVist = null;

    function tegnGrafkort(grunn) {
        var kort = $('[data-graf-kort]');
        kort.hidden = S.periode === 'sanntid';
        if (kort.hidden) return;
        var m = grafMetrikk();
        var info = intervallInfo(grunn);
        var iv = grafIntervall(grunn);
        $('[data-graf-tittel]').textContent = metrikkNavn(m);
        var velger = $('[data-intervall]');
        var boks = $('[data-intervall-boks]');
        velger.replaceChildren();
        (info ? info.liste : []).forEach(function (i) { velger.add(new Option(INTERVALL_NAVN[i], i, false, i === iv)); });
        boks.hidden = !info || info.liste.length < 2;

        var del = grafDel(grunn);
        var k = del && nokkel(grunn, del);
        var x = k && lager.get(k);
        var feil = k && delfeil.get(k);
        kort.setAttribute('aria-busy', String(!del || venter.has(k)));
        var feilBoks = $('[data-graf-feil]');
        feilBoks.hidden = !feil || Boolean(x) || varselVises();
        if (feil && !x && !varselVises()) visDelfeil(feilBoks, feil, function () { delfeil.delete(k); hentOgTegn(grunn, [del]); });
        if (x) {
            if (grafVist !== k || !G || G.data !== x.verdi) {
                grafVist = k;
                G = { data: x.verdi, periode: perioder.get(grunn) };
                skjulSoyle();
                tegnTabell();
            }
        } else if (feil) {
            G = null; grafVist = null;
        }
        var p = perioder.get(grunn);
        var forklaring = $('[data-graf-forklaring]');
        forklaring.replaceChildren();
        var delvis = Boolean(G && G.data.punkter.some(function (z) { return z.delvis; }));
        forklaring.hidden = !(p && p.sml) && !delvis;
        if (p && p.sml) {
            forklaring.append(lag('span', null, omradeTekst({ fra: p.fra, til: p.til, fra_kl: p.fra_kl, til_kl: p.til_kl })), lag('span', 'sml', omradeTekst(p.sml)));
        }
        // Søyler som ikke dekker en hel time/dag/uke (ennå), tegnes hule
        if (delvis) forklaring.append(lag('span', 'delvis', 'Ikke hele perioden'));
        var merk = $('[data-graf-merknad]');
        var mt = unike(G && G.data.merknader ? G.data.merknader.map(function (z) { return z.tekst; }) : []);
        merk.textContent = mt.join(' ');
        merk.hidden = !mt.length;
        // Feilet grafen (eller hele visningen), står det i stedet for et tomt rutenett
        var ingen = !G && Boolean(feil) && !venter.has(k);
        graf.hidden = ingen;
        $('[data-graf-tom]').hidden = !ingen || !feilBoks.hidden;    // feilboksen sier det selv når den vises
        if (ingen) boks.hidden = true;
        var zoombar = info && (iv === 'dag' || iv === 'mnd');
        graf.setAttribute('aria-label', 'Graf. Bruk piltastene for å se tallene for hver søyle' + (zoombar ? ', og Enter for å åpne ' + (iv === 'dag' ? 'en dag' : 'en måned') : '') + '.');
        tegnGraf();
    }

    $('[data-intervall]').addEventListener('change', function () {
        var v = this.value;
        naviger(function (s) { s.intervall = v; });
    });

    function verdiAv(p) { return typeof p.v === 'number' ? p.v : 0; }
    function smlAv(p) { return typeof p.sml_v === 'number' ? p.sml_v : null; }

    function tegnGraf() {
        var svgGammel = graf.querySelector('svg');
        if (!G) {
            if (svgGammel) svgGammel.remove();
            $('[data-graf-akse]').replaceChildren();
            $('[data-graf-maks]').textContent = '';
            return;
        }
        var d = G.data, punkter = d.punkter, n = punkter.length;
        var B = graf.clientWidth, H = graf.clientHeight;
        if (!n || !B || !H) return;

        var per = 1;         // kolonner per søyle, inkludert mellomrommet
        for (var s = 12; s >= 5; s--) { per = Math.floor(B / s / n); if (per >= 3) break; }
        per = Math.max(1, per);
        var fylt = per > 1 ? per - 1 : 1;
        var kol = per * n - (per > 1 ? 1 : 0);
        var steg = B / kol;
        var rader = Math.max(4, Math.round(H / steg));
        var stegY = H / rader;
        var hull = steg >= 8 ? 2 : 1;
        var X = function (c) { return Math.round(c * steg); };
        var Y = function (r) { return Math.round(r * stegY); };
        var rute = function (c, r) {
            var x = X(c), y = Y(rader - 1 - r);
            return 'M' + x + ' ' + y + 'h' + (X(c + 1) - x - hull) + 'v' + (Y(rader - r) - y - hull) + 'h' + (x - X(c + 1) + hull) + 'z';
        };
        var alle = punkter.map(verdiAv).concat(punkter.map(smlAv).filter(function (v) { return v !== null; }));
        var maks = Math.max.apply(null, alle.concat([0]));
        if (!(maks > 0)) maks = 1;
        var hoydeFor = function (v) { return v > 0 ? Math.max(1, Math.round(v / maks * rader)) : 0; };

        var av = [], pa = [], delvis = [], delvisLys = [], senere = [];
        // Hul piksel: ytre kvadrat og et indre hull (fill-rule evenodd), så rutenettet synes inni
        var hul = function (c, r) {
            var x = X(c), y = Y(rader - 1 - r), b = X(c + 1) - x - hull, h = Y(rader - r) - y - hull;
            return rute(c, r) + 'M' + (x + 1) + ' ' + (y + 1) + 'v' + (h - 2) + 'h' + (b - 2) + 'v' + (2 - h) + 'z';
        };
        var hule = X(1) - X(0) - hull >= 4 && Y(1) - Y(0) - hull >= 4;
        for (var c = 0; c < kol; c++) {
            // Timer som ikke har vært ennå i dag, får et lysere rutenett
            var liste_ = (punkter[Math.floor(c / per)] || {}).senere ? senere : av;
            for (var r = 0; r < rader; r++) liste_.push(rute(c, r));
        }
        punkter.forEach(function (p, i) {
            var hoyde = hoydeFor(verdiAv(p));
            for (var c2 = 0; c2 < fylt; c2++) for (var r2 = 0; r2 < hoyde; r2++) {
                if (!p.delvis) pa.push(rute(i * per + c2, r2));
                else if (hule) delvis.push(hul(i * per + c2, r2));
                else delvisLys.push(rute(i * per + c2, r2));
            }
        });
        // Sammenligningen: en trapp langs toppen av søylene den ville hatt
        var trapp = '';
        punkter.forEach(function (p, i) {
            var v = smlAv(p);
            if (v === null) return;
            var y = Math.min(H - 1, Y(rader - hoydeFor(v)) + 1);
            var x0 = X(i * per), x1 = X(i * per + fylt) - hull;
            trapp += (trapp ? 'H' + x0 + 'V' + y : 'M' + x0 + ' ' + y) + 'H' + x1;
        });

        var svg = lagSvg('svg', { viewBox: '0 0 ' + B + ' ' + H, 'aria-hidden': 'true', focusable: 'false' });
        svg.append(
            lagSvg('path', { 'class': 'av', d: av.join('') }),
            lagSvg('path', { 'class': 'senere', d: senere.join('') }),
            lagSvg('rect', { 'class': 'markor', 'data-markor': '', x: '0', y: '0', width: '0', height: String(H - hull) }),
            lagSvg('path', { 'class': 'pa', d: pa.join('') }),
            lagSvg('path', { 'class': 'delvis', d: delvis.join('') }),
            lagSvg('path', { 'class': 'delvis-lys', d: delvisLys.join('') }),
            lagSvg('path', { 'class': 'sml-kant', d: trapp }),
            lagSvg('path', { 'class': 'sml', d: trapp })
        );
        if (svgGammel) svgGammel.replaceWith(svg); else graf.prepend(svg);

        G.n = n; G.per = per; G.fylt = fylt; G.steg = steg; G.X = X; G.hull = hull;
        var tom = punkter.every(function (p) { return !verdiAv(p); });
        var hoyest = Math.max.apply(null, punkter.map(verdiAv));
        $('[data-graf-maks]').textContent = tom ? 'Ingen data i perioden' : 'Høyeste: ' + verdiTekst(d.metric, hoyest);
        graf.classList.toggle('graf--zoom', d.intervall === 'dag' || d.intervall === 'mnd');

        var akse = $('[data-graf-akse]');
        akse.replaceChildren();
        var valgte = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 2 ? [0, 1] : [0];
        valgte.forEach(function (i) { akse.append(lag('span', null, kortEtikett(punkter[i].t, d.intervall))); });
        if (aktiv >= 0) visSoyle(aktiv);
    }

    function kortEtikett(t, intervall) {
        if (intervall === 'time') return 'kl. ' + t.slice(11, 13);
        if (intervall === 'mnd') return fMnd.format(dato(t));
        return fKort.format(dato(t));
    }
    // Lang etikett til verktøytips og tabellen. medDato: timer med dato (24 timer og sammenligningen).
    function langEtikett(t, intervall, medDato) {
        var aar = t.slice(0, 4) !== idag().slice(0, 4);
        if (intervall === 'time') {
            var h = Number(t.slice(11, 13));
            var kl = 'kl. ' + String(h).padStart(2, '0') + '–' + String((h + 1) % 24).padStart(2, '0');
            return medDato ? stor((aar ? fLangAar : fLang).format(dato(t))) + ', ' + kl : stor(kl);
        }
        if (intervall === 'mnd') return stor(fMndLang.format(dato(t)));
        if (intervall === 'uke') return 'Uken fra ' + (aar ? fDagMndAar : fDagMnd).format(dato(t));
        return stor((aar ? fLangAar : fLang).format(dato(t)));
    }

    function tegnTabell() {
        var d = G.data;
        var navn = metrikkNavn(d.metric);
        var p = G.periode;
        var medSml = Array.isArray(d.sml_etiketter);
        $('[data-tabell-tittel]').textContent = navn + ', ' + (p ? omradeTekst({ fra: p.fra, til: p.til, fra_kl: p.fra_kl, til_kl: p.til_kl }) : periodeEtikett());
        var hode = $('[data-tabell-hode]');
        hode.replaceChildren();
        ['Tid', navn].concat(medSml ? ['Sammenlignet med', navn + ' før'] : []).forEach(function (t) {
            var th = lag('th', null, t);
            th.scope = 'col';
            hode.append(th);
        });
        var rader = $('[data-tabell]');
        rader.replaceChildren();
        var medDato = p && p.key === '24t';
        d.punkter.forEach(function (pkt, i) {
            var tr = document.createElement('tr');
            var th = lag('th', null, langEtikett(pkt.t, d.intervall, medDato));
            th.scope = 'row';
            tr.append(th, lag('td', null, pkt.senere ? 'Ikke ennå' : verdiTekst(d.metric, pkt.v)));
            if (medSml) {
                var se = d.sml_etiketter[i];
                tr.append(lag('td', null, se ? langEtikett(se, d.intervall, true) : '–'), lag('td', null, se ? verdiTekst(d.metric, pkt.sml_v) : '–'));
            }
            rader.append(tr);
        });
    }

    function visSoyle(i) {
        if (!G || !G.n) return;
        aktiv = Math.max(0, Math.min(G.n - 1, i));
        var d = G.data, p = d.punkter[aktiv];
        var fra = G.X(aktiv * G.per), til = G.X(aktiv * G.per + G.fylt) - G.hull;
        var markor = graf.querySelector('[data-markor]');
        if (markor) {
            markor.setAttribute('x', fra - G.hull);
            markor.setAttribute('width', til - fra + 2 * G.hull);
        }
        tips.replaceChildren();
        var medDato = G.periode && G.periode.key === '24t';
        tips.append(lag('b', null, langEtikett(p.t, d.intervall, medDato)));
        if (p.senere) {
            tips.append(lag('span', null, 'Ikke ennå'));
        } else {
            var neste = d.punkter[aktiv + 1];
            var sist = Boolean(G.periode && G.periode.levende) && (!neste || neste.senere);   // perioden pågår fortsatt
            tips.append(lag('span', null, metrikkNavn(d.metric) + ': ' + verdiTekst(d.metric, p.v) + (p.delvis ? (sist ? ' (så langt)' : ' (delvis)') : '')));
            var se = d.sml_etiketter && d.sml_etiketter[aktiv];
            if (se && typeof p.sml_v !== 'undefined') {
                var linje = lag('span', 'tips__sml', langEtikett(se, d.intervall, true) + ': ' + verdiTekst(d.metric, p.sml_v));
                var e = endring(d.metric, p.sml_v, p.v);
                if (e !== null) { linje.append(document.createTextNode(' · ')); linje.append(endringEl(d.metric, e)); }
                tips.append(linje);
            }
            if (d.intervall === 'dag' || d.intervall === 'mnd') {
                var hva = d.intervall === 'dag' ? 'dagen' : 'måneden';
                tips.append(lag('span', 'tips__hint', pekertype === 'touch' ? 'Trykk igjen for å se ' + hva : pekertype === 'tast' ? 'Enter: se ' + hva : 'Klikk for å se ' + hva));
            }
        }
        tips.hidden = false;
        // Tipset er aldri bredere enn grafen (max-width i CSS), og midten holdes innenfor
        var halv = Math.min(tips.offsetWidth, graf.clientWidth) / 2;
        tips.style.left = Math.max(halv, Math.min(graf.clientWidth - halv, (fra + til) / 2)) + 'px';
    }

    function skjulSoyle() {
        aktiv = -1;
        tips.hidden = true;
        var markor = graf.querySelector('[data-markor]');
        if (markor) markor.setAttribute('width', 0);
    }
    function soyleVed(clientX) {
        return Math.floor((clientX - graf.getBoundingClientRect().left) / (G.per * G.steg));
    }
    // Klikk på en dag eller måned åpner den (som i Plausible); timer og uker kan ikke åpnes
    function zoom(i) {
        if (!G || i < 0 || i >= G.n) return;
        var d = G.data, p = d.punkter[i];
        if (p.senere) return;
        if (d.intervall === 'dag') naviger(function (s) { s.periode = 'dag'; s.dato = p.t; }, { push: true });
        else if (d.intervall === 'mnd') naviger(function (s) { s.periode = 'mnd'; s.dato = p.t + '-01'; }, { push: true });
    }

    var forrigeAktiv = -1, pekertype = 'mouse';
    graf.addEventListener('pointermove', function (e) { if (G && G.n) visSoyle(soyleVed(e.clientX)); });
    graf.addEventListener('pointerdown', function (e) {
        pekertype = e.pointerType;
        forrigeAktiv = aktiv;
        if (G && G.n) visSoyle(soyleVed(e.clientX));
    });
    graf.addEventListener('click', function (e) {
        if (!G || !G.n) return;
        var i = soyleVed(e.clientX);
        // På berøringsskjerm viser første trykk tallene, andre trykk på samme søyle åpner den
        if (pekertype === 'touch' && forrigeAktiv !== i) return;
        zoom(i);
    });
    graf.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && document.activeElement !== graf) skjulSoyle(); });
    graf.addEventListener('blur', skjulSoyle);
    graf.addEventListener('focus', function () { if (aktiv < 0 && G && G.n) visSoyle(G.n - 1); });
    graf.addEventListener('keydown', function (e) {
        if (pekertype !== 'tast') { pekertype = 'tast'; if (aktiv >= 0) visSoyle(aktiv); }
        if (e.key === 'Escape') { if (aktiv >= 0) { e.preventDefault(); skjulSoyle(); } return; }
        if (!G || !G.n) return;
        if (e.key === 'Enter') { e.preventDefault(); zoom(aktiv); return; }
        var ny = { ArrowLeft: aktiv - 1, ArrowRight: aktiv + 1, Home: 0, End: G.n - 1 }[e.key];
        if (ny === undefined) return;
        e.preventDefault();
        visSoyle(ny);
    });

    var venterTegning = 0;
    if ('ResizeObserver' in window) {
        new ResizeObserver(function () {
            cancelAnimationFrame(venterTegning);
            venterTegning = requestAnimationFrame(tegnGraf);
        }).observe(graf);
    }

    // ── Panelene ────────────────────────────────────────────────────────
    var PANELER = [
        { id: 'kilder', tittel: 'Hvor de kommer fra', faner: [
            { id: 'kanaler', etikett: 'Kanaler' }, { id: 'kilder', etikett: 'Kilder' }, { id: 'kampanjer', etikett: 'Kampanjer' }] },
        { id: 'sider', tittel: 'Sider', faner: [
            { id: 'sider', etikett: 'Mest besøkte', kort: 'Mest besøkt' }, { id: 'inngang', etikett: 'Inngangssider', kort: 'Innganger' },
            { id: 'utgang', etikett: 'Utgangssider', kort: 'Utganger' }] },
        { id: 'sted', tittel: 'Hvor de er', faner: [
            { id: 'kart', etikett: 'Kart' }, { id: 'land', etikett: 'Land' }, { id: 'regioner', etikett: 'Regioner' }, { id: 'byer', etikett: 'Byer' }] },
        { id: 'enheter', tittel: 'Enheter', faner: [
            { id: 'nettlesere', etikett: 'Nettlesere' }, { id: 'os', etikett: 'Operativsystemer', kort: 'OS' },
            { id: 'skjerm', etikett: 'Skjermstørrelse', kort: 'Skjerm' }] },
        { id: 'handlinger', tittel: 'Handlinger', bred: true, faner: [
            { id: 'mal', etikett: 'Mål' }, { id: 'egenskaper', etikett: 'Egenskaper' }] }
    ];

    // Hvilken fane og rapport et panel viser nå: { fane, rapport, skjul:[faner], etiketter:{fane: tekst} }
    function panelValg(p) {
        var f = S.fane;
        if (p.id === 'kilder') {
            var fane = f.kilder || 'kanaler';
            var henv = isFilter('kilde');
            return {
                fane: fane,
                rapport: fane === 'kanaler' ? 'kanaler' : fane === 'kilder' ? (henv ? 'henvisninger' : 'kilder') : (f.utm || 'utm_campaign'),
                etiketter: henv ? { kilder: 'Henvisninger' } : {}
            };
        }
        if (p.id === 'sider') {
            var fs = f.sider || 'sider';
            return { fane: fs, rapport: fs + (f.url ? '_url' : ''), etiketter: kontekst() === 'mal' ? { sider: 'Konverteringssider' } : {} };
        }
        if (p.id === 'sted') {
            var uten = kart.status === 'mangler';
            var st = f.sted || (uten ? 'land' : 'kart');
            if (st === 'kart' && uten) st = 'land';
            return { fane: st, rapport: st, skjul: uten ? ['kart'] : [] };
        }
        if (p.id === 'enheter') {
            var fe = f.enheter || 'nettlesere';
            return {
                fane: fe,
                rapport: fe === 'nettlesere' ? (isFilter('nettleser') ? 'nettleserversjoner' : 'nettlesere') : fe === 'os' ? (isFilter('os') ? 'osversjoner' : 'os') : 'skjerm'
            };
        }
        var spesial = spesialMal();
        var harMal = oppsett.mal.length > 0, harEgenskap = oppsett.egenskaper.length > 0 || Boolean(spesial);
        if (!harMal && !harEgenskap) return null;
        var fh = f.handlinger || (spesial ? 'egenskaper' : harMal ? 'mal' : 'egenskaper');
        if (fh === 'mal' && !harMal) fh = 'egenskaper';
        if (fh === 'egenskaper' && !harEgenskap) fh = 'mal';
        var nokkelen = spesial ? spesial.nokkel : oppsett.egenskaper.indexOf(f.egenskap) >= 0 ? f.egenskap : oppsett.egenskaper[0];
        return {
            fane: fh,
            rapport: fh === 'mal' ? 'mal' : 'egenskap:' + encodeURIComponent(nokkelen),
            nokkel: nokkelen,
            spesial: spesial,
            skjul: (harMal ? [] : ['mal']).concat(harEgenskap ? [] : ['egenskaper']),
            etiketter: spesial ? { egenskaper: spesial.etikett } : {}
        };
    }

    function byggPaneler() {
        var rot = $('[data-paneler]');
        PANELER.forEach(function (p) {
            var sek = lag('section', 'kort panel' + (p.bred ? ' panel--bred' : ''));
            sek.setAttribute('data-panel', p.id);
            sek.setAttribute('aria-labelledby', 'panel-' + p.id);
            var topp = lag('div', 'panel__topp');
            var h2 = lag('h2', null, p.tittel);
            h2.id = 'panel-' + p.id;
            var faner = lag('div', 'faner');
            faner.setAttribute('role', 'tablist');
            faner.setAttribute('aria-labelledby', h2.id);
            var innhold = lag('div', 'panel__innhold');
            innhold.id = 'innhold-' + p.id;
            innhold.setAttribute('role', 'tabpanel');
            var el = { sek: sek, faner: faner, fane: {}, innhold: innhold };
            p.faner.forEach(function (fd) {
                var b = knapp('fane');
                b.id = 'fane-' + p.id + '-' + fd.id;
                b.setAttribute('role', 'tab');
                b.setAttribute('aria-controls', innhold.id);
                b.setAttribute('data-fane', fd.id);
                b.addEventListener('click', function () { velgFane(p, fd.id); });
                el.fane[fd.id] = b;
                faner.append(b);
            });
            // Piltastene flytter mellom fanene (og velger dem), som ARIA-mønsteret for faner
            faner.addEventListener('keydown', function (e) {
                var synlige = p.faner.map(function (fd) { return el.fane[fd.id]; }).filter(function (b) { return !b.hidden; });
                var i = synlige.indexOf(document.activeElement);
                if (i < 0) return;
                var ny = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: synlige.length - 1 }[e.key];
                if (ny === undefined) return;
                e.preventDefault();
                var b = synlige[(ny + synlige.length) % synlige.length];
                b.focus();
                velgFane(p, b.getAttribute('data-fane'));
            });
            topp.append(h2, faner);

            el.valg = lag('div', 'panel__valg');
            el.kart = lag('div', 'kart');
            el.kart.hidden = true;
            el.hode = lag('div', 'liste__hode');
            el.hode.setAttribute('aria-hidden', 'true');
            el.liste = lag('ol', 'liste');
            el.tom = lag('p', 'tom', 'Ingen data i perioden.');
            el.tom.hidden = true;
            el.henter = lag('p', 'henter', 'Henter tall …');
            el.henter.hidden = true;
            el.feil = lag('div', 'delfeil');
            el.feil.hidden = true;
            el.cta = lag('p', 'cta', 'Ingen mål er satt opp ennå. Vil dere telle for eksempel klikk på «Bestill» eller «Ring oss»? Si fra til kontakt@dotdev.no, så setter vi det opp.');
            el.cta.hidden = true;
            el.merknad = lag('p', 'merknad');
            el.merknad.hidden = true;
            el.bunn = lag('div', 'panel__bunn');
            el.bunnValg = lag('div', 'panel__bunnvalg');
            el.alle = knapp('btn btn--ghost btn--liten', 'Vis alle');
            el.alle.setAttribute('aria-haspopup', 'dialog');
            el.alle.addEventListener('click', function () {
                var v = panelValg(p);
                if (v) apneDetaljer(v.rapport === 'kart' ? 'land' : v.rapport);
            });
            el.bunn.append(el.bunnValg, el.alle);
            innhold.append(el.valg, el.kart, el.hode, el.liste, el.henter, el.tom, el.cta, el.feil, el.merknad, el.bunn);
            sek.append(topp, innhold);
            byggValg(p, el);
            p.el = el;
            rot.append(sek);
        });
    }

    // Valgene inni panelet: UTM-liste (Kampanjer), egenskapsliste og «Sti / URL»
    function byggValg(p, el) {
        if (p.id === 'kilder') {
            el.utm = lagVelger('Kampanjer', UTM.map(function (u) { return [u, RAPPORTER[u][0]]; }), function (v) {
                naviger(function (s) { s.fane.utm = v; });
            });
        }
        if (p.id === 'handlinger') {
            el.egenskap = lagVelger('Egenskap', [], function (v) { naviger(function (s) { s.fane.egenskap = v; }); });
        }
        if (p.id === 'sider') {
            el.url = lag('div', 'bryter bryter--rolig');
            el.url.setAttribute('role', 'group');
            el.url.setAttribute('aria-label', 'Vis sidene som');
            [['sti', 'Sti'], ['url', 'URL']].forEach(function (x) {
                var b = knapp(null, x[1]);
                b.setAttribute('data-url', x[0]);
                b.title = x[0] === 'url' ? 'Med vertsnavn (for eksempel www.)' : 'Bare stien';
                b.addEventListener('click', function () {
                    var url = x[0] === 'url';
                    if (url !== S.fane.url) naviger(function (s) { s.fane.url = url; });
                });
                el.url.append(b);
            });
        }
    }
    var velgerNr = 0;
    function lagVelger(etikett, valg, endret) {
        var boks = lag('span', 'velger velger--hvit');
        var id = 'velger-' + (++velgerNr);
        var l = lag('label', 'sr-only', etikett);
        l.htmlFor = id;
        var sel = document.createElement('select');
        sel.id = id;
        valg.forEach(function (v) { sel.add(new Option(v[1], v[0])); });
        sel.addEventListener('change', function () { endret(sel.value); });
        boks.append(l, sel);
        boks.select = sel;
        return boks;
    }

    function velgFane(p, fane) {
        if (fane === 'kart' && kart.status === 'ukjent') {
            lastKart().then(function () { if (kart.status === 'ok') naviger(function (s) { s.fane.sted = 'kart'; }); else tegnData(); });
            return;
        }
        naviger(function (s) {
            s.fane[p.id] = fane;
            if (p.id === 'handlinger' && fane === 'egenskaper' && spesialMal()) s.fane.handlinger = null;
        });
    }

    function tegnPaneler(grunn) {
        PANELER.forEach(function (p) { tegnPanel(p, grunn); });
    }

    function tegnPanel(p, grunn) {
        var el = p.el, v = panelValg(p);
        if (!v) {
            // Ingen mål og ingen egenskaper: bare en rolig forklaring, og ingen spørring.
            // Kunne ikke målene hentes (Plausible svarte ikke), står det det, med «Prøv igjen».
            el.faner.hidden = true;
            [el.valg, el.kart, el.hode, el.liste, el.henter, el.tom, el.feil, el.merknad, el.bunn].forEach(function (x) { x.hidden = true; });
            el.cta.hidden = oppsett.malUkjent;
            if (oppsett.malUkjent) visDelfeil(el.feil, 'Fikk ikke hentet målene akkurat nå.', provOppsettIgjen);
            el.sek.classList.add('panel--tom');
            el.innhold.removeAttribute('role');
            p.vist = null;
            return;
        }
        el.cta.hidden = true;
        el.faner.hidden = false;
        el.innhold.setAttribute('role', 'tabpanel');
        p.faner.forEach(function (fd) {
            var b = el.fane[fd.id];
            var skjult = Boolean(v.skjul && v.skjul.indexOf(fd.id) >= 0);
            var valgt = fd.id === v.fane;
            var tekst = (v.etiketter && v.etiketter[fd.id]) || fd.etikett;
            b.hidden = skjult;
            b.setAttribute('aria-selected', String(valgt));
            b.tabIndex = valgt ? 0 : -1;
            b.replaceChildren();
            if (fd.kort && !(v.etiketter && v.etiketter[fd.id])) {
                var kortform = lag('span', 'kortform', fd.kort);
                kortform.setAttribute('aria-hidden', 'true');
                b.append(lag('span', 'lang', tekst), kortform);
            } else {
                b.textContent = tekst;
            }
        });
        el.innhold.setAttribute('aria-labelledby', el.fane[v.fane].id);

        // Valgene i panelet
        var valg = [];
        if (p.id === 'kilder' && v.fane === 'kampanjer') {
            el.utm.select.value = v.rapport;
            valg.push(el.utm);
        }
        if (p.id === 'handlinger' && v.fane === 'egenskaper' && !v.spesial && oppsett.egenskaper.length > 1) {
            var sel = el.egenskap.select;
            if (sel.options.length !== oppsett.egenskaper.length) {
                sel.replaceChildren();
                oppsett.egenskaper.forEach(function (e) { sel.add(new Option(e, e)); });
            }
            sel.value = v.nokkel;
            valg.push(el.egenskap);
        }
        if (p.id === 'sider') {
            // «Sti / URL» står nederst ved «Vis alle», så listene i kortene ved siden av starter i samme høyde
            $$('[data-url]', el.url).forEach(function (b) { b.setAttribute('aria-pressed', String((b.getAttribute('data-url') === 'url') === S.fane.url)); });
            if (el.url.parentNode !== el.bunnValg) el.bunnValg.append(el.url);
        }
        // Bare bytt når valgene faktisk endres (ellers mister en valgt liste fokus)
        var naa = Array.prototype.slice.call(el.valg.children);
        if (naa.length !== valg.length || naa.some(function (x, i) { return x !== valg[i]; })) el.valg.replaceChildren.apply(el.valg, valg);

        var del = 'liste:' + v.rapport;
        var k = nokkel(grunn, del);
        var x = lager.get(k);
        var feil = delfeil.get(k);
        if (v.fane === 'kart' && kart.status === 'ukjent') lastKart().then(function () { if (innlogget) last(); });
        var laster = venter.has(k) || (v.fane === 'kart' && kart.status === 'laster');
        el.sek.setAttribute('aria-busy', String(laster));
        el.feil.hidden = !feil || Boolean(x) || varselVises();
        if (feil && !x && !varselVises()) visDelfeil(el.feil, feil, function () { delfeil.delete(k); hentOgTegn(grunn, [del]); });

        var visKart = v.fane === 'kart';
        el.kart.hidden = !visKart;
        // Tomme lister, feil og deler som ikke kunne hentes (da står varselet øverst) trenger ikke plass til ni rader
        el.sek.classList.toggle('panel--tom', Boolean(x ? !visKart && !(x.verdi.rader || []).length : feil || !laster));
        if (x) {
            p.vist = { rapport: v.rapport, kart: visKart };
            el.henter.hidden = true;
            if (visKart) {
                [el.hode, el.liste, el.tom].forEach(function (z) { z.hidden = true; });
                tegnKart(el, x.verdi);
                visBunn(el, x.verdi.rader.length > 0);
                el.alle.title = 'Alle landene med flere tall, søk og sortering';
            } else if (p.vistX !== x || p.vistRapport !== v.rapport) {
                beholdFokus(el.liste, '.rad__navn', function () { tegnListe(p, el, v.rapport, x.verdi); });
            }
            // Kartskalaen står nederst til venstre når kartet vises
            if (el.kartSkala) el.kartSkala.hidden = !visKart;
            p.vistX = x;
            p.vistRapport = v.rapport;
            var mt = (x.verdi.merknader || []).map(function (z) { return z.tekst; });
            // Sanntid: målene gjelder 30 minutter, de andre listene 5 (som Plausible)
            if (S.periode === 'sanntid' && v.rapport === 'mal') mt.unshift('Målene gjelder de siste 30 minuttene.');
            mt = unike(mt);
            el.merknad.textContent = mt.join(' ');
            el.merknad.hidden = !mt.length;
            return;
        }
        // Ikke hentet ennå: samme liste for en annen periode står dempet, ellers «Henter tall …»
        var samme = p.vist && p.vist.rapport === v.rapport && p.vist.kart === visKart;
        if (!samme || feil) {
            p.vist = null;
            p.vistX = null;
            el.liste.replaceChildren();
            [el.hode, el.tom, el.merknad].forEach(function (z) { z.hidden = true; });
            visBunn(el, false);
            el.liste.hidden = true;
            if (visKart) el.kart.replaceChildren();
            el.henter.hidden = !laster;
        }
    }

    // Bunnen av panelet: «Vis alle» når listen har rader; valgene til venstre (Sti / URL) står også
    // mens en ny liste hentes, så knappen kunden nettopp trykket på, ikke forsvinner (og mister fokus)
    function visBunn(el, visAlle) {
        el.alle.hidden = !visAlle;
        var valg = Array.prototype.some.call(el.bunnValg.children, function (c) { return !c.hidden; });
        el.bunn.hidden = !visAlle && !valg;
    }
    var bredeKolonner = { total_revenue: true, average_revenue: true, total_visitors: true };
    // Korte kolonneoverskrifter på smal skjerm, så navnene får plass (hele navnet står i skjermleserteksten)
    var KORT_KOLONNE = {
        'Konverteringer': 'Konv.', 'Unike innganger': 'Innganger', 'Unike utganger': 'Utganger', 'Besøkende nå': 'Nå',
        'Besøkende totalt': 'Totalt', 'Sidevisninger': 'Visninger', 'Fluktfrekvens': 'Flukt'
    };
    var kortKolonne = function (e) { return har(KORT_KOLONNE, e) ? KORT_KOLONNE[e] : e.length > 9 ? e.slice(0, 7) + '.' : e; };
    // Fullt navn til skjermlesere og verktøytips («KR» kan leses som kroner)
    var LANG_KOLONNE = { 'KR': 'Konverteringsrate', '%': 'Andel' };
    var langKolonne = function (e) { return har(LANG_KOLONNE, e) ? LANG_KOLONNE[e] : e; };
    // Klassen til en tallkolonne i de korte listene. Med mer enn to tall (mål med inntekt) skjules
    // de mindre viktige på smal skjerm; alle står i «Vis alle».
    function kolKlasse(c, kolonner) {
        var tall = kolonner.filter(function (x) { return x.key !== 'percentage'; }).length;
        var viktig = c.key === 'visitors' || c.key === 'conversion_rate' || c.key === 'group_conversion_rate';
        return 'kol' + (bredeKolonner[c.key] ? ' kol--bred' : '') + (c.key === 'percentage' ? ' pst' : '') + (tall > 2 && !viktig && c.key !== 'percentage' ? ' kol--ekstra' : '');
    }
    function tegnListe(p, el, rapport, data) {
        // Prosenten (bare synlig ved pekeren) står først, så hovedtallet alltid står helt til høyre
        var kolonner = (data.kolonner || []).slice().sort(function (a, b) { return (b.key === 'percentage') - (a.key === 'percentage'); });
        var rader = (data.rader || []).slice(0, 9);
        el.hode.replaceChildren();
        el.liste.replaceChildren();
        el.hode.hidden = el.liste.hidden = !rader.length;
        el.tom.hidden = rader.length > 0;
        visBunn(el, rader.length > 0);
        el.alle.title = data.flere ? 'Hele listen (' + heltall(data.totalt_rader) + ' rader) med flere tall' : 'Listen med flere tall, søk og sortering';
        el.hode.append(lag('span', null, forsteKolonne(rapport)));
        kolonner.forEach(function (c) {
            var h = lag('span', kolKlasse(c, kolonner));
            var kort = kortKolonne(c.etikett);
            if (kort !== c.etikett) h.append(lag('span', 'lang', c.etikett), lag('span', 'kortform', kort));
            else h.textContent = c.etikett;
            el.hode.append(h);
        });
        var harPst = kolonner.some(function (c) { return c.key === 'percentage'; });
        var maks = Math.max.apply(null, rader.map(function (r) { return r.verdier.visitors || 0; }).concat([1]));
        // Bredden: plass til overskriften og det lengste tallet. På smal skjerm (--bs) bare tallet og
        // den korte overskriften, så navnet til venstre får plass.
        kolonner = kolonner.map(function (c) {
            var lengst = Math.max.apply(null, rader.map(function (r) { return verdiTekst(c.key, r.verdier[c.key], r.valuta).length; }).concat([1]));
            var tall = lengst * 0.58 + 0.4;
            return {
                key: c.key, etikett: c.etikett,
                bredde: Math.max(4.25, c.etikett.length * 0.45 + 0.4, tall).toFixed(2) + 'rem',
                smal: Math.max(3, kortKolonne(c.etikett).length * 0.5 + 0.4, tall).toFixed(2) + 'rem'
            };
        });
        $$('.kol', el.hode).forEach(function (s, i) { s.style.setProperty('--b', kolonner[i].bredde); s.style.setProperty('--bs', kolonner[i].smal); });
        rader.forEach(function (r) {
            var andel = harPst && typeof r.verdier.percentage === 'number' ? r.verdier.percentage / 100 : (r.verdier.visitors || 0) / maks;
            el.liste.append(lagRad(rapport, r, kolonner, andel, 'li'));
        });
    }

    // Tegner en beholder på nytt og gir fokus tilbake til elementet på samme plass
    function beholdFokus(rot, velger, tegn) {
        var a = document.activeElement;
        var i = a && rot.contains(a) ? $$(velger, rot).indexOf(a) : -1;
        tegn();
        if (i >= 0) { var ny = $$(velger, rot)[i]; if (ny) ny.focus(); }
    }

    // Én rad: navneknapp (legger til filter) med stolpe, lenke til siden, og tallene
    function lagRad(rapport, r, kolonner, andel, tag, fraDetaljer) {
        var navn = radNavn(rapport, r);
        var rad = lag(tag, tag === 'li' ? 'rad' : null);
        var b = knapp('rad__navn');
        b.style.setProperty('--andel', Math.max(0, Math.min(1, andel || 0)).toFixed(3));
        var info = r.filter && dimInfo(r.filter.dim);
        var filterNavn = info ? (r.vert ? 'Vertsnavn er ' + r.vert + ' og ' + info.etikett.toLowerCase() + ' er ' + r.filter.verdi : info.etikett + ' er ' + navn) : navn;
        b.title = 'Filtrer: ' + filterNavn;
        b.setAttribute('aria-label', navn + '. Filtrer på dette');
        var fl = flagg(rapport === 'kart' || rapport === 'land' ? r.kode : r.land);
        if (fl) {
            var f = lag('span', 'rad__flagg', fl);
            f.setAttribute('aria-hidden', 'true');
            b.append(f);
        }
        b.append(lag('span', 'rad__tekst', navn));
        b.addEventListener('click', function () {
            if (!r.filter) return;
            var etikett = r.filter.dim === 'region' || r.filter.dim === 'by' ? r.navn : null;
            var vert = typeof r.vert === 'string' && r.vert ? r.vert : null;
            if (fraDetaljer) {
                // Vinduet lukkes i samme steg, så tilbake-knappen går til visningen før filteret
                leggTilFilter(r.filter.dim, r.filter.verdi, etikett, function (s) { etterKlikk(r.filter.dim)(s); s.detaljer = null; }, { lukk: true }, vert);
            } else {
                leggTilFilter(r.filter.dim, r.filter.verdi, etikett, etterKlikk(r.filter.dim), null, vert);
            }
        });
        var forste = tag === 'li' ? rad : lag('div', 'celle');
        forste.append(b);
        if (r.lenke && /^https:\/\//.test(r.lenke)) {
            var a = lag('a', 'rad__lenke');
            a.href = r.lenke;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.title = 'Åpne siden';
            a.setAttribute('aria-label', 'Åpne siden ' + r.navn + ' i en ny fane');
            a.append(ikonLenke());
            forste.append(a);
        }
        if (tag !== 'li') {
            var td = lag('td');
            td.append(forste);
            rad.append(td);
        }
        kolonner.forEach(function (c) {
            var v = r.verdier[c.key];
            // Scrollmål har ikke «Totalt» i Plausible (bare unike)
            if (rapport === 'mal' && c.key === 'events' && malType(r.navn) === 'scroll') v = null;
            var celle = lag(tag === 'li' ? 'span' : 'td', tag === 'li' ? kolKlasse(c, kolonner) : null);
            if (c.bredde) { celle.style.setProperty('--b', c.bredde); celle.style.setProperty('--bs', c.smal); }
            // I listene får skjermlesere kolonnenavnet foran tallet (tabellen har det i hodet)
            if (tag === 'li') celle.append(lag('span', 'sr-only', langKolonne(c.etikett) + ': '));
            celle.append(document.createTextNode(verdiTekst(c.key, v, r.valuta)));
            celle.title = langKolonne(c.etikett) + ': ' + verdiLang(c.key, v, r.valuta);
            rad.append(celle);
        });
        return rad;
    }

    // ── Kartet ──────────────────────────────────────────────────────────
    // /kunde-kart.json: { "viewBox": "0 0 B H", "land": { "NO": "M…z", … } } med ISO-koder.
    // Hentes bare når kartfanen vises. Mangler filen, skjules fanen og «Land» vises i stedet.
    var kart = { status: 'ukjent', data: null, svg: null, stier: {}, lover: null };
    function gyldigKart(d) {
        if (!d || typeof d.viewBox !== 'string' || !/^-?[\d.]+(\s+-?[\d.]+){3}$/.test(d.viewBox.trim()) || !d.land || typeof d.land !== 'object') return false;
        var koder = Object.keys(d.land);
        return koder.length > 0 && koder.length < 400 && koder.every(function (k) {
            return /^[A-Z]{2}$/.test(k) && typeof d.land[k] === 'string' && d.land[k].length < 400000 && /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+eE-]*$/.test(d.land[k]);
        });
    }
    function lastKart() {
        if (kart.lover) return kart.lover;
        kart.status = 'laster';
        kart.lover = fetch('/kunde-kart.json', { credentials: 'same-origin' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (d) {
                if (!gyldigKart(d)) throw new Error('ugyldig kart');
                kart.data = d;
                kart.status = 'ok';
            })
            .catch(function () {
                kart.status = 'mangler';
                if (S.fane.sted === 'kart') { S.fane.sted = null; history.replaceState(history.state, '', adresseFra(S)); }
            });
        return kart.lover;
    }
    // viewBox beskåret til landene (tomt hav på sidene tar ellers høyde fra kartet)
    function kartUtsnitt() {
        var raa = kart.data.viewBox.trim(), vb = raa.split(/\s+/).map(Number);
        var stier = Object.keys(kart.data.land).map(function (k) { return kart.data.land[k]; });
        // Bare stier med absolutte M/L (som fra verktoy/lag-kart.mjs) kan måles så enkelt
        if (stier.some(function (d) { return /[^MLZz0-9.,\s-]/.test(d); })) return raa;
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        stier.forEach(function (d) {
            var tall = d.match(/-?\d+(?:\.\d+)?/g) || [];
            for (var i = 0; i + 1 < tall.length; i += 2) {
                var x = +tall[i], y = +tall[i + 1];
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        });
        if (!(x1 > x0 && y1 > y0) || x0 < vb[0] || y0 < vb[1] || x1 > vb[0] + vb[2] || y1 > vb[1] + vb[3]) return raa;
        var m = 2;
        x0 = Math.max(vb[0], x0 - m); y0 = Math.max(vb[1], y0 - m);
        x1 = Math.min(vb[0] + vb[2], x1 + m); y1 = Math.min(vb[1] + vb[3], y1 + m);
        return [x0, y0, x1 - x0, y1 - y0].map(function (n) { return Math.round(n * 10) / 10; }).join(' ');
    }
    function byggKartSvg() {
        var svg = lagSvg('svg', { viewBox: kartUtsnitt(), 'aria-hidden': 'true', focusable: 'false' });
        Object.keys(kart.data.land).forEach(function (kode) {
            var sti = lagSvg('path', { 'class': 'kart__land', d: kart.data.land[kode], 'data-kode': kode });
            kart.stier[kode] = sti;
            svg.append(sti);
        });
        kart.svg = svg;
    }
    function tegnKart(el, data) {
        if (!kart.data) return;
        if (!kart.svg) byggKartSvg();
        if (kart.svg.parentNode !== el.kart) {
            el.kart.replaceChildren();
            var forklaring = lag('p', 'sr-only', 'Kartet viser det samme som fanen Land.');
            el.kartTips = lag('div', 'tips');
            el.kartTips.hidden = true;
            el.kart.append(forklaring, kart.svg, el.kartTips);
            if (!kart.hendelser) { kart.hendelser = true; byggKartHendelser(el); }
        }
        if (!el.kartSkala) {
            // Skalaen står nederst i kortet, til venstre for «Vis alle»
            el.kartSkala = lag('p', 'kart__skala');
            el.kartSkala.setAttribute('aria-hidden', 'true');
            el.kartSkalaTekst = document.createTextNode('');
            el.kartSkala.append(document.createTextNode('Færre'));
            for (var i = 0; i < 5; i++) el.kartSkala.append(document.createElement('i'));
            el.kartSkala.append(el.kartSkalaTekst);
            el.bunnValg.append(el.kartSkala);
        }
        el.kartSkalaTekst.textContent = kontekst() === 'mal' ? 'Flere konverteringer' : 'Flere besøkende';
        var rader = data.rader || [];
        var maks = Math.max.apply(null, rader.map(function (r) { return r.verdier.visitors || 0; }).concat([1]));
        kart.verdier = {};
        rader.forEach(function (r) { kart.verdier[r.kode] = r; });
        Object.keys(kart.stier).forEach(function (kode) {
            var sti = kart.stier[kode], r = kart.verdier[kode];
            var v = r ? r.verdier.visitors || 0 : 0;
            // Kvadratrot, så små land også får farge ved siden av ett stort
            var niva = v > 0 ? Math.max(1, Math.ceil(Math.sqrt(v / maks) * 5)) : 0;
            sti.setAttribute('class', 'kart__land' + (niva ? ' n' + niva : ''));
            if (v > 0) sti.setAttribute('data-har', ''); else sti.removeAttribute('data-har');
        });
    }
    function byggKartHendelser(el) {
        var svg = kart.svg;
        svg.addEventListener('pointermove', function (e) {
            var sti = e.target.closest && e.target.closest('[data-kode]');
            var tip = el.kartTips;
            if (!sti) { tip.hidden = true; return; }
            var kode = sti.getAttribute('data-kode'), r = kart.verdier && kart.verdier[kode];
            // Med målfilter er tallet konverteringer (som Plausibles kart)
            var enhet = kontekst() === 'mal' ? 'konverteringer' : 'besøkende';
            tip.replaceChildren(lag('b', null, land(kode, r ? r.navn : kode)), lag('span', null, r ? verdiTekst('visitors', r.verdier.visitors) + ' ' + enhet : 'Ingen ' + enhet));
            tip.hidden = false;
            var boks = el.kart.getBoundingClientRect();
            var halv = tip.offsetWidth / 2;
            tip.style.left = Math.max(halv, Math.min(boks.width - halv, e.clientX - boks.left)) + 'px';
            tip.style.bottom = 'auto';
            tip.style.top = Math.max(0, e.clientY - boks.top - tip.offsetHeight - 12) + 'px';
        });
        svg.addEventListener('pointerleave', function () { el.kartTips.hidden = true; });
        svg.addEventListener('click', function (e) {
            var sti = e.target.closest && e.target.closest('[data-har]');
            if (!sti) return;
            var r = kart.verdier[sti.getAttribute('data-kode')];
            if (r && r.filter) leggTilFilter('land', r.filter.verdi, null, etterKlikk('land'));
        });
    }

    // ── «Vis alle»: detaljvinduet ───────────────────────────────────────
    var D = {
        el: $('[data-detaljer]'), sok: $('[data-detaljer-sok]'), hode: $('[data-detaljer-hode]'), rader: $('[data-detaljer-rader]'),
        flere: $('[data-detaljer-flere]'), info: $('[data-detaljer-info]'), tom: $('[data-detaljer-tom]'), feil: $('[data-detaljer-feil]'),
        q: null, sider: [], nr: 0, kolonner: null, laster: false
    };
    var detaljLager = new Map();    // adresse → { verdi, tid }
    var sokTid = 0;

    function apneDetaljer(rapport) {
        naviger(function (s) { s.detaljer = { rapport: rapport, sok: '', sorter: null }; }, { push: true, dialog: 'detaljer', bareDialog: true });
    }
    function detaljAdresse(side) {
        var sp = new URLSearchParams(grunnlag());
        sp.set('rapport', S.detaljer.rapport);
        if (S.detaljer.sok.trim()) sp.set('sok', S.detaljer.sok.trim());
        if (S.detaljer.sorter) sp.set('sorter', S.detaljer.sorter);
        sp.set('side', String(side));
        return '/detaljer?' + sp.toString();
    }
    function synkDetaljer() {
        if (!S.detaljer) { if (D.el.open) D.el.close(); D.q = null; return; }
        var r = S.detaljer.rapport;
        $('[data-detaljer-tittel]').textContent = rapportTittel(r);
        var periodeTekst = periodeEtikett() + (S.periode === 'sanntid' ? (r === 'mal' ? ' (siste 30 min)' : ' (siste 5 min)') : '');
        $('[data-detaljer-under]').textContent = periodeTekst + (S.filtre.length ? ' · ' + S.filtre.map(filterTekst).join(', ') : '');
        $('[data-detaljer-tekst]').textContent = rapportTittel(r) + ', ' + periodeEtikett();
        $('[data-detaljer-sokboks]').hidden = false;
        D.sok.hidden = r === 'skjerm';           // som Plausible: ingen søk i skjermstørrelser
        if (document.activeElement !== D.sok) D.sok.value = S.detaljer.sok;
        if (!D.el.open) {
            D.el.showModal();
            if (!D.sok.hidden) D.sok.focus(); else $('[data-lukk]', D.el).focus();
        }
        var q = detaljAdresse(0);
        if (q !== D.q) lastDetaljer(0);
    }
    function lastDetaljer(side) {
        var nr = ++D.nr;
        var q = detaljAdresse(side);
        if (side === 0) { D.q = q; D.sider = []; }
        var treff = detaljLager.get(q);
        D.laster = true;
        D.el.setAttribute('aria-busy', 'true');
        D.feil.hidden = true;
        var lover = treff && Date.now() - treff.tid < (S.periode === 'sanntid' ? LEVENDE_MS : LAGER_MS)
            ? Promise.resolve({ status: 200, data: treff.verdi })
            : api(q).catch(function () { return { status: 0, data: {} }; });
        if (side === 0 && !treff) tegnDetaljer();
        lover.then(function (svar) {
            if (nr !== D.nr || !S.detaljer) return;
            D.laster = false;
            D.el.removeAttribute('aria-busy');
            if (svar.status === 401) return visLogin('Du er logget ut. Logg inn igjen.');
            if (svar.status !== 200) {
                visDelfeil(D.feil, svar.status === 0 ? MELDING_NETT : svar.status === 429 && !svar.data.feil ? MELDING_MANGE : svar.data.feil || MELDING_FEIL,
                    function () { lastDetaljer(side); });
                if (side === 0) { D.sider = []; tegnDetaljer(); }
                return;
            }
            detaljLager.set(q, { verdi: svar.data, tid: treff ? treff.tid : Date.now() });
            if (detaljLager.size > 100) detaljLager.delete(detaljLager.keys().next().value);
            D.sider[side] = svar.data;
            tegnDetaljer();
        });
    }
    function tegnDetaljer() {
        var forste = D.sider[0];
        var r = S.detaljer.rapport;
        if (!forste) {
            D.rader.replaceChildren();
            D.tom.hidden = true;
            D.flere.hidden = true;
            D.info.textContent = D.laster ? 'Henter tall …' : '';
            return;
        }
        var kolonner = forste.kolonner || [];
        // Tabellhodet med sorterbare kolonner (de som regnes ut av serveren, kan ikke sorteres).
        // Fokus på en kolonneknapp blir stående på samme kolonne når hodet tegnes på nytt.
        var sortering = S.detaljer.sorter ? S.detaljer.sorter.split(':') : ['visitors', 'desc'];
        var fokusKol = document.activeElement && D.hode.contains(document.activeElement) ? document.activeElement.closest('th').getAttribute('data-kol') : null;
        D.hode.replaceChildren();
        var kol = [{ key: 'navn', etikett: forsteKolonne(r) }].concat(kolonner);
        kol.forEach(function (c) {
            var th = lag('th');
            th.scope = 'col';
            th.setAttribute('data-kol', c.key);
            var kanSortere = !(c.key === 'navn' && r === 'mal') && c.key !== 'total_visitors' && c.key !== 'exit_rate';
            var sortert = sortering[0] === c.key;
            if (sortert) th.setAttribute('aria-sort', sortering[1] === 'asc' ? 'ascending' : 'descending');
            if (kanSortere) {
                var b = knapp(null, c.etikett);
                if (langKolonne(c.etikett) !== c.etikett) b.setAttribute('aria-label', langKolonne(c.etikett));
                if (sortert) {
                    // Pila er pynt; aria-sort sier det samme til skjermlesere
                    var pil = lag('span', 'pil', sortering[1] === 'asc' ? ' ↑' : ' ↓');
                    pil.setAttribute('aria-hidden', 'true');
                    b.append(pil);
                }
                b.title = 'Sorter etter ' + langKolonne(c.etikett).toLowerCase();
                b.addEventListener('click', function () {
                    var retning = sortering[0] === c.key ? (sortering[1] === 'desc' ? 'asc' : 'desc') : c.key === 'navn' ? 'asc' : 'desc';
                    var ny = c.key + ':' + retning;
                    naviger(function (s) { s.detaljer.sorter = ny === 'visitors:desc' ? null : ny; }, { bareDialog: true });
                });
                th.append(b);
            } else {
                th.textContent = c.etikett;
                if (langKolonne(c.etikett) !== c.etikett) th.title = langKolonne(c.etikett);
            }
            D.hode.append(th);
        });
        if (fokusKol) { var fk = $('th[data-kol="' + fokusKol + '"] button', D.hode); if (fk) fk.focus(); }
        D.rader.replaceChildren();
        var alle = [];
        D.sider.forEach(function (sd) { if (sd) alle = alle.concat(sd.rader || []); });
        var harPst = kolonner.some(function (c) { return c.key === 'percentage'; });
        var maks = Math.max.apply(null, alle.map(function (x) { return x.verdier.visitors || 0; }).concat([1]));
        alle.forEach(function (x) {
            var andel = harPst && typeof x.verdier.percentage === 'number' ? x.verdier.percentage / 100 : (x.verdier.visitors || 0) / maks;
            D.rader.append(lagRad(r, x, kolonner, andel, 'tr', true));
        });
        var siste = D.sider[D.sider.length - 1];
        D.tom.hidden = alle.length > 0;
        D.tom.textContent = S.detaljer.sok.trim() ? 'Ingen treff på «' + S.detaljer.sok.trim() + '».' : 'Ingen data i perioden.';
        D.flere.hidden = !siste || !siste.flere;
        D.flere.disabled = D.laster;
        D.info.textContent = D.laster ? 'Henter tall …' : alle.length ? 'Viser ' + heltall(alle.length) + ' av ' + heltall(Math.max(alle.length, forste.totalt_rader || 0)) : '';
        merHoyre();
    }
    // Skygge til høyre i tabellen når det er flere kolonner å rulle til (på smal skjerm)
    var tabellRamme = $('[data-tabell-ramme]');
    function merHoyre() {
        tabellRamme.parentNode.classList.toggle('mer', tabellRamme.scrollLeft + tabellRamme.clientWidth < tabellRamme.scrollWidth - 2);
    }
    tabellRamme.addEventListener('scroll', merHoyre, { passive: true });
    if ('ResizeObserver' in window) new ResizeObserver(merHoyre).observe(tabellRamme);
    D.flere.addEventListener('click', function () {
        if (D.laster || !S.detaljer) return;
        var neste = D.sider.length;
        if (neste > 50) return;
        D.laster = true;
        tegnDetaljer();
        lastDetaljer(neste);
    });
    D.sok.addEventListener('input', function () {
        clearTimeout(sokTid);
        var v = D.sok.value.slice(0, 100);
        sokTid = setTimeout(function () {
            if (!S.detaljer || v === S.detaljer.sok) return;
            naviger(function (s) { s.detaljer.sok = v; }, { bareDialog: true });
        }, SOK_VENT_MS);
    });
    D.sok.addEventListener('keydown', function (e) {
        // Esc i et søkefelt med tekst tømmer feltet først (som i Plausible)
        if (e.key === 'Escape' && D.sok.value) { e.preventDefault(); D.sok.value = ''; D.sok.dispatchEvent(new Event('input')); }
    });

    // Lukket med Esc, ×, «Avbryt», bakgrunnen eller tilbake-knappen: adressen følger etter.
    // Vinduet ble åpnet som et eget steg i historikken, så det lukkes med «tilbake».
    var tilbakeTid = 0;
    function lukketDialog(felt) {
        if (!S[felt] || tilbakeTid) return;
        var navn = felt === 'detaljer' ? 'detaljer' : 'filter';
        if (history.state && history.state.dialog === navn) {
            tilbakeTid = setTimeout(function () { tilbakeTid = 0; }, 1500);   // i tilfelle popstate aldri kommer
            history.back();
        } else {
            naviger(function (s) { s[felt] = null; }, { lukk: true, bareDialog: true });
        }
    }
    function lukkVindu(d) {
        if (d.open) d.close();
        lukketDialog(d === D.el ? 'detaljer' : 'filterGruppe');
    }
    D.el.addEventListener('close', function () { clearTimeout(sokTid); D.q = null; lukketDialog('detaljer'); });
    $$('[data-lukk]').forEach(function (b) { b.addEventListener('click', function () { lukkVindu(b.closest('dialog')); }); });
    [D.el, $('[data-filterdialog]')].forEach(function (d) {
        // Esc: lukk selv, så adressen oppdateres med en gang
        d.addEventListener('cancel', function (e) { e.preventDefault(); lukkVindu(d); });
        // Klikk på bakgrunnen utenfor vinduet lukker det
        d.addEventListener('click', function (e) { if (e.target === d) lukkVindu(d); });
    });

    function synkDialoger() {
        if (!innlogget) return;
        synkDetaljer();
        synkFilter();
    }

    // ── Filtervinduet ───────────────────────────────────────────────────
    var F = {
        el: $('[data-filterdialog]'), skjema: $('[data-filterskjema]'), grupper: $('[data-filter-grupper]'), rader: $('[data-filter-rader]'),
        feil: $('[data-filter-feil]'), gruppe: null, forslag: {}, radNr: 0
    };
    function gruppeTilgjengelig(g) {
        if (g.id === 'mal') return Boolean(oppsett && oppsett.mal.length);
        if (g.id === 'egenskap') return egenskapsvalg().length > 0;
        return true;
    }
    // Egenskapene i filtervinduet: nettstedets egne, pluss nøkler som allerede står i et filter
    // (f.eks. url fra listen «Lenker ut»)
    function egenskapsvalg() {
        if (!oppsett) return [];
        var liste = oppsett.egenskaper.slice();
        S.filtre.forEach(function (f) { if (erEgenskap(f.dim) && liste.indexOf(f.dim.slice(9)) < 0) liste.push(f.dim.slice(9)); });
        return liste;
    }
    function apneFilter(gruppe) {
        if (F.el.open) return;
        naviger(function (s) { s.filterGruppe = gruppe || 'velg'; }, { push: true, dialog: 'filter', bareDialog: true });
    }
    $('[data-filtrer]').addEventListener('click', function () { apneFilter(); });

    function synkFilter() {
        if (!S.filterGruppe) { if (F.el.open) F.el.close(); F.gruppe = null; return; }
        if (F.gruppe !== S.filterGruppe || !F.el.open) byggFilter(S.filterGruppe);
        if (!F.el.open) {
            F.el.showModal();
            var forste = $('.grupper button:not([hidden]), .frad select, .frad input', F.el);
            if (forste) forste.focus();
        }
    }

    function byggFilter(gruppeId) {
        F.gruppe = gruppeId;
        F.feil.textContent = '';
        F.rader.replaceChildren();
        F.grupper.replaceChildren();
        var velg = gruppeId === 'velg';
        F.grupper.hidden = !velg;
        $('[data-filter-knapper]').hidden = velg;
        $('[data-filter-under]').textContent = periodeEtikett();
        if (velg) {
            $('[data-filter-tittel]').textContent = 'Filtrer';
            GRUPPER.forEach(function (g) {
                if (!gruppeTilgjengelig(g)) return;
                var b = knapp(null, g.etikett);
                b.addEventListener('click', function () {
                    naviger(function (s) { s.filterGruppe = g.id; }, { bareDialog: true });
                    var forste = $('.frad select, .frad input', F.el);
                    if (forste) forste.focus();
                });
                F.grupper.append(b);
            });
            return;
        }
        var g = GRUPPER.filter(function (x) { return x.id === gruppeId; })[0];
        $('[data-filter-tittel]').textContent = 'Filtrer på ' + (g.id === 'utm' ? 'UTM' : g.etikett.toLowerCase());
        if (g.id === 'egenskap') {
            var eksisterende = S.filtre.filter(function (f) { return erEgenskap(f.dim); });
            var forsteNokkel = egenskapsvalg()[0];
            (eksisterende.length ? eksisterende : [null]).forEach(function (f) { F.rader.append(filterRad(f ? f.dim : 'egenskap:' + forsteNokkel, f)); });
            var mer = knapp('lenkeknapp', 'Legg til en egenskap til');
            mer.addEventListener('click', function () {
                F.rader.insertBefore(filterRad('egenskap:' + forsteNokkel, null), mer);
            });
            F.rader.append(mer);
        } else {
            g.dims.forEach(function (dim) {
                var eksisterende = S.filtre.filter(function (f) { return f.dim === dim; });
                (eksisterende.length ? eksisterende : [null]).forEach(function (f) { F.rader.append(filterRad(dim, f)); });
            });
        }
        hentForslag(g);
    }

    // Én rad: navn (eller egenskapsliste), operator, verdier med forslag, og «Legg til verdi»
    function filterRad(dim, f) {
        var nr = ++F.radNr;
        var rad = lag('div', 'frad');
        rad.setAttribute('data-dim', dim);
        var topp = lag('div', 'frad__topp');
        var opId = 'op-' + nr;
        if (erEgenskap(dim)) {
            var nokkelVelger = lagVelger('Egenskap', egenskapsvalg().map(function (e) { return [e, e]; }), function (v) {
                rad.setAttribute('data-dim', 'egenskap:' + v);
                oppdaterDatalist(rad);
                hentForslag(null, [forslagDel('egenskap:' + v)]);
            });
            nokkelVelger.select.value = dim.slice(9);
            nokkelVelger.classList.add('frad__navn');
            topp.append(nokkelVelger);
        } else {
            // Synlig navn; operatorlisten har sitt eget navn («Land, hvordan») for skjermlesere
            var navn = lag('span', 'frad__navn', DIMS[dim].etikett);
            navn.setAttribute('aria-hidden', 'true');
            topp.append(navn);
        }
        var info = dimInfo(dim);
        var opBoks = lagVelger('Hvordan', info.ops.map(function (o) { return [o, OP_NAVN[o]]; }), function () {});
        opBoks.select.id = opId;
        $('label', opBoks).htmlFor = opId;
        if (!erEgenskap(dim)) $('label', opBoks).textContent = DIMS[dim].etikett + ', hvordan';
        opBoks.select.value = f ? f.op : 'is';
        opBoks.select.setAttribute('data-op', '');
        topp.append(opBoks);
        rad.append(topp);
        var verdier = lag('div', 'frad__verdier');
        verdier.setAttribute('data-verdier', '');
        rad.append(verdier);
        var liste = document.createElement('datalist');
        liste.id = 'forslag-' + nr;
        rad.append(liste);
        var feltNavn = (erEgenskap(dim) ? 'Egenskap' : DIMS[dim].etikett) + ', verdi';
        (f ? f.verdier : ['']).forEach(function (v) { verdier.append(verdiFelt(rad, liste.id, visVerdi(dim, v), feltNavn)); });
        rad.feltNavn = feltNavn;
        var mer = knapp('lenkeknapp', 'Legg til verdi');
        mer.title = 'Flere verdier betyr «eller»';
        mer.addEventListener('click', function () {
            var alle = $$('input', verdier);
            if (alle.length >= 10) return;
            var ny = verdiFelt(rad, liste.id, '', feltNavn);
            verdier.append(ny);
            $('input', ny).focus();
        });
        rad.append(mer);
        rad.append(lag('p', 'frad__feil'));
        oppdaterDatalist(rad);
        return rad;
    }
    function verdiFelt(rad, listeId, verdi, feltNavn) {
        var boks = lag('div', 'frad__verdi');
        var inp = document.createElement('input');
        inp.className = 'inndata';
        inp.type = 'text';
        inp.value = verdi;
        inp.maxLength = 300;
        inp.autocomplete = 'off';
        inp.spellcheck = false;
        inp.setAttribute('list', listeId);
        inp.setAttribute('aria-label', feltNavn);
        inp.setAttribute('data-verdi', '');
        var fjern = knapp('ikonknapp', '×');
        fjern.setAttribute('aria-label', 'Fjern verdien for ' + feltNavn.replace(/, verdi$/, '').toLowerCase());
        fjern.addEventListener('click', function () {
            var alle = $$('[data-verdi]', rad);
            if (alle.length > 1) boks.remove(); else inp.value = '';
            ($('[data-verdi]', rad) || inp).focus();
        });
        boks.append(inp, fjern);
        return boks;
    }
    // Verdien slik den står i feltet: navn for land, regioner og byer (koden finnes igjen ved «Bruk filter»)
    function visVerdi(dim, v) {
        if (!v) return '';
        if (dim === 'land') return land(v, v);
        if (dim === 'region' || dim === 'by') return S.etiketter[dim + '|' + v] || v;
        return v;
    }

    // Forslagene: kompakte lister for gruppen (uten filtrene i gruppen selv), én forespørsel
    function forslagDel(dim) {
        if (erEgenskap(dim)) return 'liste:egenskap:' + encodeURIComponent(dim.slice(9));
        var info = DIMS[dim];
        return info && info.rapport ? 'liste:' + info.rapport : null;
    }
    function forslagGrunn(gruppe) {
        var dims = gruppe ? gruppe.dims : [];
        var uten = S.filtre.filter(function (f) { return gruppe && gruppe.id === 'egenskap' ? !erEgenskap(f.dim) : dims.indexOf(f.dim) < 0; });
        return apiParametre(S, uten).toString();
    }
    function hentForslag(gruppe, ekstra) {
        var g = gruppe || GRUPPER.filter(function (x) { return x.id === F.gruppe; })[0];
        if (!g) return;
        var grunn = forslagGrunn(g);
        var deler = ekstra || [];
        if (!ekstra) {
            $$('.frad', F.rader).forEach(function (rad) {
                var d = forslagDel(rad.getAttribute('data-dim'));
                if (d && deler.indexOf(d) < 0) deler.push(d);
            });
        }
        F.grunn = grunn;
        hentDeler(grunn, deler, false).then(function () {
            if (!F.el.open || F.grunn !== grunn) return;
            $$('.frad', F.rader).forEach(oppdaterDatalist);
        });
    }
    // Forslag til én dimensjon: [{ verdi (i feltet), kode (i filteret), etikett }]
    function forslagFor(dim) {
        if (dim === 'mal') return oppsett.mal.map(function (m) { return { verdi: m.navn, kode: m.navn, etikett: oversett(MAL, m.navn) }; });
        if (dim === 'skjerm') return DIMS.skjerm.faste.map(function (v) { return { verdi: v, kode: v, etikett: ENHETER[v] }; });
        var del = forslagDel(dim);
        var x = del && lager.get(nokkel(F.grunn || '', del));
        if (!x) return [];
        var rapport = del.slice(6);
        var ut = [], sett = {};
        (x.verdi.rader || []).forEach(function (r) {
            var o;
            if (dim === 'vert') {
                var vert = r.navn.slice(0, r.navn.length - (r.filter ? r.filter.verdi.length : 0));
                o = { verdi: vert, kode: vert };
            } else if (dim === 'land' || dim === 'region' || dim === 'by') {
                var navn = dim === 'land' ? land(r.kode, r.navn) : r.navn;
                o = { verdi: navn, kode: r.filter.verdi, etikett: r.filter.verdi };
            } else {
                var vis = radNavn(rapport, r);
                o = { verdi: r.filter ? r.filter.verdi : r.navn, kode: r.filter ? r.filter.verdi : r.navn, etikett: vis !== r.navn ? vis : null };
            }
            if (o.verdi && !sett[o.verdi]) { sett[o.verdi] = true; ut.push(o); }
        });
        return ut;
    }
    function oppdaterDatalist(rad) {
        var dim = rad.getAttribute('data-dim');
        var liste = $('datalist', rad);
        F.forslag[dim] = forslagFor(dim);
        liste.replaceChildren();
        F.forslag[dim].forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = o.verdi;
            if (o.etikett) opt.label = o.etikett;
            liste.append(opt);
        });
    }
    // Feltverdien → verdien i filteret (navn på land/regioner/byer blir koder). null = ugyldig.
    function filterVerdi(dim, tekst) {
        var info = dimInfo(dim);
        if (!info.monster) return tekst;
        if (info.monster.test(tekst)) return tekst;
        var liten = tekst.toLowerCase();
        var treff = (F.forslag[dim] || []).filter(function (o) { return o.verdi.toLowerCase() === liten; })[0];
        if (treff) return treff.kode;
        var kjent = Object.keys(S.etiketter).filter(function (k) { return k.indexOf(dim + '|') === 0 && S.etiketter[k].toLowerCase() === liten; })[0];
        if (kjent) return kjent.slice(dim.length + 1);
        if (dim === 'land' && landnavn) {
            // Alle landkoder, så kunden kan skrive «Island» selv om landet ikke er i forslagene
            for (var a = 65; a <= 90; a++) for (var b = 65; b <= 90; b++) {
                var kode = String.fromCharCode(a, b);
                if (land(kode, '').toLowerCase() === liten) return kode;
            }
        }
        if (dim === 'land' && /^[a-z]{2}$/.test(liten)) return liten.toUpperCase();
        return null;
    }

    F.skjema.addEventListener('submit', function (e) {
        e.preventDefault();
        var g = GRUPPER.filter(function (x) { return x.id === F.gruppe; })[0];
        if (!g) return;
        var nye = [], etiketter = {}, feil = null, galt = null;
        $$('.frad', F.rader).forEach(function (rad) {
            var dim = rad.getAttribute('data-dim');
            var op = $('[data-op]', rad).value;
            var radFeil = $('.frad__feil', rad);
            radFeil.textContent = '';
            var verdier = [];
            $$('[data-verdi]', rad).forEach(function (inp) {
                inp.removeAttribute('aria-invalid');
                var tekst = inp.value.trim();
                if (!tekst) return;
                var v = filterVerdi(dim, tekst);
                if (v === null || v.length > 300 || KONTROLLTEGN.test(v)) {
                    radFeil.textContent = dim === 'land' ? 'Velg et land fra listen.' : 'Velg en verdi fra listen.';
                    inp.setAttribute('aria-invalid', 'true');
                    if (!galt) galt = inp;
                    feil = feil || radFeil.textContent;
                    return;
                }
                if (dim === 'mal' && op !== 'contains' && malNavn().indexOf(v) < 0) {
                    radFeil.textContent = 'Velg et mål fra listen, eller velg «inneholder».';
                    inp.setAttribute('aria-invalid', 'true');
                    if (!galt) galt = inp;
                    feil = feil || radFeil.textContent;
                    return;
                }
                if ((dim === 'region' || dim === 'by') && v !== tekst) etiketter[dim + '|' + v] = tekst;
                if (verdier.indexOf(v) < 0) verdier.push(v);
            });
            if (!verdier.length) return;
            // Samme dimensjon og operator to ganger slås sammen (serveren godtar ikke dubletter)
            var finnes = nye.filter(function (f) { return f.dim === dim && f.op === op; })[0];
            if (finnes) verdier.forEach(function (v) { if (finnes.verdier.indexOf(v) < 0) finnes.verdier.push(v); });
            else nye.push({ op: op, dim: dim, verdier: verdier });
        });
        nye.forEach(function (f) { if (f.verdier.length > 10) { f.verdier = f.verdier.slice(0, 10); } });
        var beholdt = S.filtre.filter(function (f) { return g.id === 'egenskap' ? !erEgenskap(f.dim) : g.dims.indexOf(f.dim) < 0; });
        if (!feil && beholdt.length + nye.length > MAKS_FILTRE) feil = 'Høyst ' + MAKS_FILTRE + ' filtre om gangen.';
        if (feil) {
            F.feil.textContent = feil;
            if (galt) galt.focus();
            return;
        }
        naviger(function (s) {
            s.filtre = beholdt.concat(nye);
            Object.keys(etiketter).forEach(function (k) { s.etiketter[k] = etiketter[k]; });
            s.filterGruppe = null;
        }, { lukk: true });
        $('[data-filtrer]').focus();
    });
    $('[data-filter-avbryt]').addEventListener('click', function () { lukkVindu(F.el); });
    $('[data-filter-tilbake]').addEventListener('click', function () {
        naviger(function (s) { s.filterGruppe = 'velg'; }, { bareDialog: true });
        var forste = $('.grupper button', F.el);
        if (forste) forste.focus();
    });
    F.el.addEventListener('close', function () { F.gruppe = null; lukketDialog('filterGruppe'); });

    // ── Nedlasting (ZIP med CSV-filer, som «Export stats» i Plausible) ──
    // Hentes med fetch og lagres med en midlertidig lenke, så en feil (f.eks. «vent litt») vises
    // her i stedet for å erstatte siden.
    var lastNedKnapp = $('[data-last-ned]');
    lastNedKnapp.addEventListener('click', function (e) {
        e.preventDefault();
        if (lastNedKnapp.getAttribute('aria-disabled') === 'true') return;
        var status = $('[data-eksport-status]');
        status.classList.remove('feil');
        status.textContent = 'Lager filen …';
        lastNedKnapp.setAttribute('aria-disabled', 'true');
        fetch(lastNedKnapp.href, { credentials: 'same-origin', cache: 'no-store' })
            .then(function (res) {
                if (!res.ok) {
                    return res.json().catch(function () { return {}; }).then(function (d) {
                        if (res.status === 401) { visLogin('Du er logget ut. Logg inn igjen.'); return; }
                        throw new Error(d.feil || (res.status === 429 ? MELDING_MANGE : MELDING_FEIL));
                    });
                }
                var navn = filnavn(res.headers.get('Content-Disposition'));
                return res.blob().then(function (blob) {
                    var url = URL.createObjectURL(blob);
                    var a = lag('a');
                    a.href = url;
                    a.download = navn;
                    a.hidden = true;
                    document.body.append(a);
                    a.click();
                    a.remove();
                    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
                    status.textContent = 'Lastet ned: ' + navn;
                });
            })
            .catch(function (err) {
                status.classList.add('feil');
                status.textContent = err && err.message && err.message !== 'Failed to fetch' ? err.message : MELDING_NETT;
            })
            .then(function () { lastNedKnapp.removeAttribute('aria-disabled'); });
    });
    function filnavn(cd) {
        var m = /filename\*=UTF-8''([^;]+)/i.exec(cd || '');
        if (m) { try { return decodeURIComponent(m[1]).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-'); } catch (e) { /* bruk reservenavnet */ } }
        return 'DOTDEV statistikk ' + nettsted + '.zip';
    }

    // ── Alt det som tegnes etter et svar ────────────────────────────────
    function tegnData() {
        if (!innlogget || !oppsett) return;
        var grunn = grunnlag();
        vis.dash.setAttribute('data-periode', S.periode);
        tegnVerktoy();
        tegnFiltre();
        tegnMeta(grunn);
        tegnNaa();
        tegnKpi(grunn);
        tegnGrafkort(grunn);
        tegnPaneler(grunn);
    }

    // ── Hurtigtaster (som i Plausible) ──────────────────────────────────
    var TASTER = { d: 'dag', e: 'igar', r: 'sanntid', h: '24t', w: '7d', f: '28d', t: '30d', n: '91d', m: 'mnd', p: 'forrige_mnd', y: 'aar', s: '6mnd', l: '12mnd', a: 'alt', c: 'egen' };
    document.addEventListener('keydown', function (e) {
        if (!tasterPa || !innlogget || !oppsett || vis.dash.hidden || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
        var t = e.target;
        // Menyene i verktøylinja (periode, sammenligning, inndeling) står med fokus etter et valg.
        // Der er bokstavene hurtigtaster (ellers hopper menyen til første valg med den bokstaven);
        // piltaster, Esc, Enter og mellomrom virker som vanlig i menyen.
        var meny = Boolean(t && t.tagName === 'SELECT' && t.hasAttribute('data-hurtigmeny'));
        var iFelt = t && !meny && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));
        var vindu = D.el.open || F.el.open;
        if (meny && (e.key.length !== 1 || e.key === ' ')) return;
        if (e.key === '/') {
            if (iFelt) return;
            if (D.el.open) { if (!D.sok.hidden) { e.preventDefault(); D.sok.focus(); } return; }
            if (!vindu) { e.preventDefault(); apneFilter(); }
            return;
        }
        if (iFelt || vindu) return;
        if (e.key === 'Escape') {
            if (!datoSkjema.hidden) return lukkDatoer(false);
            if (S.filtre.length) { e.preventDefault(); fjernAlleFiltre(); }
            return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            if (t.closest && t.closest('[role="tablist"], .graf, .bryter')) return;
            if (flyttPeriode(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
            return;
        }
        var k = e.key.length === 1 ? e.key.toLowerCase() : '';
        if (har(TASTER, k)) {
            e.preventDefault();
            velgPeriode(TASTER[k]);
            return;
        }
        if (k === 'x' && harSml(S.periode)) {
            e.preventDefault();
            naviger(function (s) { s.sml = s.sml === 'av' ? 'forrige' : 'av'; }, { push: true });
            return;
        }
        if (k === 'i' && S.periode !== 'sanntid') {
            var info = intervallInfo(grunnlag());
            var iv = grafIntervall(grunnlag());
            if (!info || info.liste.length < 2) return;
            e.preventDefault();
            var neste = info.liste[(info.liste.indexOf(iv) + 1) % info.liste.length];
            naviger(function (s) { s.intervall = neste; });
        }
    });

    // Knappen under «Hurtigtaster» slår dem av og på
    var tasterKnapp = $('[data-taster]');
    function tegnTasterKnapp() {
        tasterKnapp.textContent = tasterPa ? 'Slå av hurtigtastene' : 'Slå på hurtigtastene';
        $('[data-taster-liste]').classList.toggle('av', !tasterPa);
    }
    tasterKnapp.addEventListener('click', function () {
        tasterPa = !tasterPa;
        tegnTasterKnapp();
        history.replaceState(history.state, '', adresseFra(S));
        $('[data-status]').textContent = tasterPa ? 'Hurtigtastene er på.' : 'Hurtigtastene er av.';
    });
    tegnTasterKnapp();

    // Uten mus og tastatur (berøringsskjerm) gir hurtigtastene i menyene og søkefeltet ingen mening
    if (beroring()) {
        $$('option', periodeVelger).forEach(function (o) { o.textContent = o.textContent.replace(/ \([A-Z]\)$/, ''); });
        D.sok.placeholder = 'Søk';
    }

    window.addEventListener('popstate', function () {
        clearTimeout(tilbakeTid);
        tilbakeTid = 0;
        if (!innlogget || !oppsett) return;
        S = lesAdresse();
        visning();
    });

    // ── Automatisk oppdatering: «besøkende nå» og sanntid ───────────────
    // Hvert minutt mens fanen er synlig (serveren husker begge i 1 minutt, så oftere gir ingen nye
    // tall). «Besøkende nå» stopper etter et kvarter uten aktivitet, sanntid etter fem minutter (den
    // henter tallene øverst og alle listene), og begge starter igjen når kunden er tilbake.
    var tidtaker = 0;
    var sistAktiv = Date.now();
    var ledig = function () { return Date.now() - sistAktiv > (S.periode === 'sanntid' ? SANNTID_LEDIG_MS : LEDIG_MS); };
    function planlegg() {
        clearTimeout(tidtaker);
        tidtaker = 0;
        if (!innlogget || document.visibilityState !== 'visible' || ledig()) return;
        if (S.periode !== 'sanntid' && !naaSynlig()) return;
        tidtaker = setTimeout(oppfrisk, LEVENDE_MS);
    }
    // Etter et svar: planlegg neste oppdatering, unntatt når kvoten er brukt opp (429/503). Da
    // venter siden til kunden gjør noe igjen, så åpne faner ikke spør Plausible hvert minutt.
    function planleggEtter(svar) {
        if (svar && (svar.status === 429 || svar.status === 503)) { clearTimeout(tidtaker); tidtaker = 0; return; }
        planlegg();
    }
    var sanntidTikk = 0;
    function oppfrisk() {
        tidtaker = 0;
        if (!innlogget || document.visibilityState !== 'visible' || ledig()) return;
        if (S.periode === 'sanntid') {
            // Tallene øverst hvert minutt, listene annethvert minutt (de gjelder 5 minutter uansett)
            sanntidTikk++;
            var grunn = grunnlag();
            // Etter en pause (eller første gang) er listene eldre enn to minutter: hent alt
            var gamleLister = synligeDeler(grunn).some(function (d) {
                var x = d.indexOf('liste:') === 0 && lager.get(nokkel(grunn, d));
                return d.indexOf('liste:') === 0 && (!x || Date.now() - x.tid > 2 * LEVENDE_MS - 5000);
            });
            if (sanntidTikk % 2 === 0 || gamleLister) return last(true, true);
            hentDeler(grunn, ['topp'], true).then(function (svar) {
                if (!innlogget) return;
                if (svar.status === 401) return visLogin('Du er logget ut. Logg inn igjen.');
                if (grunn === grunnlag()) tegnData();
                planleggEtter(svar);
            });
            return;
        }
        if (!naaSynlig()) return;
        hentDeler('', ['naa'], true).then(function (svar) { tegnNaa(); planleggEtter(svar); });
    }
    function aktivitet() {
        var varLedig = ledig();
        if (!varLedig && Date.now() - sistAktiv < 5000) return;    // pekeren flyttes mange ganger i sekundet
        sistAktiv = Date.now();
        if (innlogget && !tidtaker && (varLedig || document.visibilityState === 'visible')) {
            // Tilbake etter en pause: hent med en gang hvis tallene er gamle
            var gamle = S.periode === 'sanntid' ? !fersk(nokkel(grunnlag(), 'topp')) : naaSynlig() && !fersk('naa');
            if (gamle && oppsett && !vis.dash.hidden) oppfrisk(); else planlegg();
        }
    }
    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach(function (h) { window.addEventListener(h, aktivitet, { passive: true, capture: true }); });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') aktivitet();
        else { clearTimeout(tidtaker); tidtaker = 0; }
    });

    // ── Start ───────────────────────────────────────────────────────────
    // Årstallet i bunnteksten, som på forsiden (2026 står i HTML-en som reserve)
    document.querySelectorAll('[data-year]').forEach(function (el) { el.textContent = String(new Date().getFullYear()); });
    byggPaneler();
    // /meg svarer 200 { innlogget: false } når ingen er logget inn (ikke 401, så innloggingssiden
    // ikke får en rød feil i konsollen ved hvert besøk). 401 godtas fortsatt som «ikke innlogget».
    api('/meg')
        .then(function (svar) {
            if (svar.status === 200 && svar.data.innlogget !== false && svar.data.nettsted) return visDash(svar.data, false);
            visLogin(svar.status === 200 || svar.status === 401 ? '' : (svar.data.feil || 'Kundeportalen svarer ikke akkurat nå. Prøv igjen senere.'));
        })
        .catch(function () { visLogin('Fikk ikke kontakt. Sjekk nettet og last siden på nytt.'); });
})();
