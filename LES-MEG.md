# DOTDEV – nettsiden

## Filene

| Fil / mappe | Hva |
|---|---|
| `index.html`, `personvern.html`, `404.html` | Kildefilene. Det er disse dere redigerer. Guiden øverst i `index.html` forklarer alt. |
| `kunde.html`, `kunde.js` | Kundeportalen (dotdev.no/kunde): innlogging og statistikk for kundene. `kunde.html` er utseendet, `kunde.js` koden. Se «Kundeportalen» under. |
| `netlify/functions/kunde-api.mjs` | Serverfunksjonen bak kundeportalen. Sjekker innloggingen og henter tallene fra Plausible. Resten av koden ligger i `netlify/kunde/` (perioder, filtre, lister, nedlasting). |
| `lag-kunde.mjs` | Lager innlogging til en kunde (kjøres på egen PC). Publiseres ikke. |
| `bygg.py` | Lager en publiseringsklar kopi i `dist/` (uten guiden og kommentarene), og fyller inn sikkerhetsreglene i `_headers`. |
| `netlify.toml` | Får Netlify til å kjøre `bygg.py` og publisere bare `dist/`, sender statistikken via eget domene (`/dd/`), og sender gamle `.html`-adresser videre til de korte (`/personvern.html` → `/personvern`). |
| `dist/` | Det som publiseres. Netlify lager den på nytt hver gang, så den ligger ikke i GitHub. Ikke rediger her. |
| `_headers` | Sikkerhetsheadere og mellomlagring på Netlify. Se «Sikkerhet» under. |
| `.well-known/security.txt` | Forteller hvor man melder fra om sikkerhetshull (kontakt@dotdev.no). Må fornyes hvert år. |
| `robots.txt`, `sitemap.xml` | Forteller Google hvilke sider som finnes. |
| `fonter/`, `bilder/`, ikonene | Fonter, skjermbilder og favicon. |

## Publisere en endring

1. Rediger kildefilene.
2. Last dem opp til GitHub (`main`).
3. Netlify kjører `python3 bygg.py` og publiserer `dist/` automatisk (se `netlify.toml`). Etter et par minutter er endringen ute.

Bare `dist/` blir publisert, så guiden, kommentarene, `LES-MEG.md` og `bygg.py` er ikke synlige på nettsiden. Feiler byggingen, blir forrige versjon liggende ute, og feilen står under **Deploys** i Netlify.

## Lys og mørk modus

Nettsiden følger innstillingen til den besøkende: står telefonen eller nettleseren i mørk modus (for eksempel mørkt tema i Chrome), vises den mørke utgaven, ellers den lyse som før. Den mørke utgaven er designforslag 2, «Mørk premium». CSS-en står i seksjon 19 nederst i `<style>` i `index.html` (fargene er tokens `--x-…`, og planeten i hero blir blå via `--c-planet…`), og i en tilsvarende blokk nederst i `<style>` i `personvern.html` og `404.html`. Nettleserlinjen får en egen mørk farge (`theme-color` med `media`), og utskrift er alltid lys. Kundeportalen (dotdev.no/kunde) er foreløpig bare lys.

## Venter på dere

- **Team:** navn, roller, bilder og LinkedIn. Blokken ✏️ TEAM i SEKSJON: Om oss.
- **Telefon og sosiale medier:** linjene står klare i footeren og som `telephone`/`sameAs` i JSON-LD i `<head>`.
- **Startpris:** skriv den i svaret på «Hva koster en nettside?».
- **Les gjennom de nye tekstene:** tjenestene (særlig AI-eksemplene), Om oss og spørsmål og svar. Alt skal stemme med det dere faktisk leverer.
- **Bookingsiden i Google:** beskrivelsen der tilbyr fortsatt telefon. Nettsiden sier at samtalen er på video, så rett beskrivelsen i Google Kalender.

## Booking

**Skjult fra 8. oktober 2026.** «Book en samtale» er fjernet fra siden: bookingseksjonen har `hidden`, og alle knappene heter «Bestill nettside» og går til skjemaet (`#bestill`, se «Skjema» under). Målet «Book samtale» i Plausible får derfor ingen nye treff. For å hente bookingen tilbake: fjern `hidden` på seksjonen og sett knappene tilbake til `href="#booking"` og `data-i18n="nav.book"` (se kommentaren over seksjonen i `index.html`). Bookingsiden i Google Kalender finnes fortsatt og kan sendes som lenke.

«Book en samtale» på forsiden bruker bookingsiden «Introsamtale med DOTDEV» i Google Kalender (kontoen kontakt@dotdev.no). Nettsiden har ikke noe eget bookingskjema: knappen «Velg tidspunkt» åpner Google-siden i en ny fane, der den besøkende ser ledige tider og booker selv. Google legger bookingen i kalenderen og sender bekreftelse med lenke til Google Meet. Samtalen er på video. Uten JavaScript viser siden en e-postknapp til kontakt@dotdev.no i stedet, og lenken «Foretrekker du e-post? kontakt@dotdev.no» står alltid i bookingseksjonen.

- **Bytte lenken:** lim inn den nye adressen i `BOOKING.externalUrl` (øverst i skriptet nederst i `index.html`). Bruk den lange adressen (`https://calendar.google.com/calendar/appointments/schedules/…?hl=no`), ikke kortlenken `calendar.app.google/…`, som mister `?hl=no` når den sender videre. På engelsk bytter siden selv `hl=no` til `hl=en`.
- **Endrer dere samtalen i Google** (navn eller lengde), endre `BOOKING.types` også, så kortet på nettsiden stemmer.
- **Endrer dere feltene i Google-skjemaet** (i dag navn og e-post, og frivillig telefon og «Bedrift og nettside»), oppdater raden «Du booker en samtale» i avsnitt 2 i `personvern.html`, på norsk og engelsk.
- **Bytter dere bookingtjeneste**, bytt lenken og oppdater avsnitt 3 og 6 i `personvern.html` (begge språk). `_headers` trenger ingen endring, fordi siden bare lenker til bookingsiden og ikke bygger den inn.
- **Telling:** et klikk på «Velg tidspunkt» telles som målet «Book samtale» i Plausible.

## Skjema: nettside-sjekk og meldinger

Seksjonen «Nettside-sjekk» (`#sjekk`, rett under bookingen) har ett skjema med to valg: **Nettside-sjekk** (adressen til nettsiden + e-post) og **Bestill nettside** (enkle spørsmål med valgknapper: hva de trenger, bransje, hva nettsiden skal hjelpe med, hva de har klart og når de vil starte; så e-post og frivillig melding). Svarene kommer som egne felt i varselet: Behov, Bransje, Hensikt, Innhold og Oppstart. Uten JavaScript (sjeldent) sendes skjemaet som vanlig skjema; da kan flere avkryssinger komme som flere verdier, og emnet blir «Henvendelse fra dotdev.no». Navn er frivillig. Overskriften og punktene til venstre bytter med valget. Innsendingene tas imot av **Netlify Forms** (skjemaet heter `henvendelse`), så det trengs ingen egen server eller nøkler.

**Gjør dette én gang i Netlify (ellers kommer ingenting frem):**

1. Netlify → nettstedet → **Forms** → **Enable form detection**. Publiser på nytt etterpå (Deploys → Trigger deploy), så Netlify finner skjemaet. Til da får besøkende en feilmelding med e-postadressen i stedet for takk.
2. Forms → **Submission notifications** (heter «Form notifications» noen steder) → Add notification → **Email notification** → skjemaet `henvendelse` → `kontakt@dotdev.no`.
3. Send en test fra dotdev.no og sjekk at den dukker opp under Forms og på e-post.

- **Svare:** trykk «Svar» på varselet i kontakt@dotdev.no. Feltet heter `email`, så svaret skal gå til kunden og ikke til Netlify (sjekk det med testen i punkt 3). Emnet viser om det er nettside-sjekk eller bestilling av nettside, og `sprak` sier om skjemaet ble sendt på norsk eller engelsk.
- **Slette:** Netlify sletter aldri innsendingene selv. Slett dem etter reglene i `personvern.html` (avsnitt 4: senest 12 måneder etter siste kontakt hvis det ikke blir oppdrag) på tre steder: under Forms i Netlify, i «Spam submissions» der, og varsel-e-postene i kontakt@dotdev.no. Sett gjerne av en fast dag to ganger i året.
- **Spam:** et skjult felle-felt og Netlifys spamfilter. Spam havner under «Spam submissions» i Netlify.
- **Telling:** vellykket innsending telles som hendelsen «Henvendelse» i Plausible (med `type`). Legg den til som mål (Plausible → Site settings → Goals → Custom event `Henvendelse`). Fordelingen på type krever Business-planen; på de andre planene vises bare antallet.
- **Kostnad:** hvordan innsendinger telles, avhenger av Netlify-planen (de gamle planene har en månedlig grense, kredittplanene har egne regler). Sjekk under Billing / Usage, og følg med den første tiden. Kommer det mye spam, kan skjemaet slås av ved å fjerne `data-netlify="true"` og publisere.
- **Uten JavaScript** er bare e-post påkrevd, så en sjelden gang kan det komme en henvendelse uten adresse eller melding.
- **Endrer dere feltene**, oppdater raden «Du sender skjemaet» i avsnitt 2 og avsnitt 3 i `personvern.html` (begge språk), og punkt 8b i guiden i `index.html`.

## Kundeportalen

Kunder som har kjøpt nettside av oss, kan logge inn på **dotdev.no/kunde** og se besøksstatistikken for sin egen nettside. Portalen har to visninger:

- **Enkel visning** (det kunden ser først): en kort **oppsummering i klartekst** («De siste 28 dagene hadde nettsiden 1 049 besøkende, 9 % færre enn perioden før. Flest kom fra søkemotorer som Google (43 %). Mest besøkt var forsiden. Målet «Book samtale» ble nådd 7 ganger.»), fire tall (unike besøkende, sidevisninger, besøkstid, og konverteringer når nettstedet har mål, ellers fluktfrekvens), grafen over besøkende og de fem øverste kanalene, sidene og målene (målene etter antall ganger, uten 404). Bare perioden kan velges; radene er ikke knapper. Oppsummeringen lages i nettleseren av tallene som allerede er hentet (koden står mellom merkene `OPPSUMMERING-START` og `-SLUTT` i `kunde.js`). Konverteringer er alle målene til sammen, uten 404.
- **Detaljert visning** («Vis alle detaljer», `visning=detaljert` i adressen): de samme tallene som i Plausible-dashbordet (uten oppsummeringen, siden listene der følger fanene kunden har valgt). Valg av sammenligning, graf og inndeling gjelder bare her (de står i adressen også når kunden går tilbake til den enkle).

Den detaljerte visningen har:

- **Tallene øverst** (unike besøkende, besøk, sidevisninger, sider per besøk, fluktfrekvens, besøkstid) med endring mot perioden før. Med filter på en side eller et mål bytter de til scrolldybde og tid på siden, eller konverteringer, inntekt og konverteringsrate, som i Plausible. Trykk på et tall for å vise det i grafen.
- **Grafen** per time, dag, uke eller måned, med sammenligningen som en blålilla trappelinje. Søyler som ikke dekker en hel time, dag eller uke (ennå), er hule. Trykk på en dag eller måned for å åpne den.
- **Periode:** i dag, i går, sanntid, siste 24 timer, 7, 28, 30 og 91 dager, denne og forrige måned, siste 6 og 12 måneder, i år, all tid og egne datoer, med ◀ ▶ for dag, måned og år. **Sammenligning** med forrige periode, samme periode i fjor eller egne datoer (samme ukedag eller nøyaktig dato).
- **Fem paneler med faner:** kanaler, kilder (henvisninger når en kilde er valgt) og kampanjer (UTM), mest besøkte sider, inngangs- og utgangssider (sti eller hele URL-en), kart, land, regioner og byer, nettlesere, operativsystemer og skjermstørrelse (med versjoner når en nettleser eller et system er valgt), og mål og egenskaper. «Vis alle» åpner hele listen med flere tall, søk og sortering.
- **Filtre:** trykk på en rad (eller et land i kartet). Filtrene vises som etiketter øverst, med × for å fjerne ett og «Fjern alle» (eller Esc). De står i adressen (`f=…`), og der kan de også være «er ikke», «inneholder» eller ha flere verdier (for eksempel i en delt lenke); de vises og virker på samme måte. «Mål er ikke» betyr besøk som ikke fullførte målet (som i Plausible).
- **Last ned** gir en ZIP med CSV-filer i Plausibles format. Hurtigtastene er de samme som i Plausible (lista står under «Om tallene» i portalen, der de også kan slås av). Periodetastene virker i begge visningene; X og I bare i den detaljerte, og / søker i «Vis alle».

Alt kunden velger, står i adressen, så en visning kan deles og tilbake-knappen virker. Portalen lagrer ingenting i nettleseren. Tallene hentes fra Plausible av serverfunksjonen `netlify/functions/kunde-api.mjs` (med koden i `netlify/kunde/`). API-nøkkelen og passordene ligger bare i Netlify, aldri i GitHub og aldri i nettleseren.

Det som ikke finnes i Plausibles API, er ikke med: trakter, brukerreiser, Google-søkeord, notater i grafen, lagrede segmenter og minuttgrafen i sanntid.

**Kartet** under «Hvor de er» lastes fra `kunde-kart.json` (ca. 40 KB pakket) bare når fanen vises. Det er laget av `verktoy/lag-kart.mjs` fra Natural Earth-data via world-atlas (fritt, ISC-lisens, lisensteksten ligger i selve fila). Krym er tegnet som en del av Ukraina, etter de internasjonalt anerkjente grensene. Skal kartet lages på nytt, se toppen av `verktoy/lag-kart.mjs`. Mangler fila, skjules fanen og «Land» vises i stedet.

**Repoet er offentlig. Ikke legg API-nøkler, passord eller verdiene fra `lag-kunde.mjs` i noen fil her.**

### Sette opp (én gang)

1. **Plausible:** Velg laget der nettsidene ligger, i menyen øverst til høyre. Gå så til Account settings → API Keys → New API Key → velg **Stats API** → Create API Key. Kopier nøkkelen (den vises bare én gang). Stats API krever Business-planen (prøveperioden har den til ca. 2. november 2026).
2. **Netlify:** Project configuration → Environment variables → Add a variable, for hver av disse:
   - `PLAUSIBLE_API_KEY` = nøkkelen fra Plausible
   - `PORTAL_NOKKEL` = verdien fra `node lag-kunde.mjs --nokkel`

   Huk av «Contains secret values». Under Values velger dere «Different value for each deploy context» og fyller bare inn **Production**, så nøklene aldri havner i forhåndsvisninger. Finnes valget Scopes (Pro-planen), velg bare Functions. På gratisplanen finnes det ikke, og det er greit.
3. **Sikkerhet (viktig):** Repoet er offentlig, så hvem som helst kan foreslå endringer (pull request). Godkjenn aldri publisering av forhåndsvisninger fra folk dere ikke kjenner, og la «Sensitive variable policy» (Project configuration → Environment variables → Site policies) stå på «Require approval». Da kan ingen lure til seg nøklene.
4. Legg til minst én kunde (under), og publiser på nytt: Deploys → Trigger deploy → Deploy project. Endringer i variablene virker først etter ny publisering.

### Ny kunde

1. Legg kundens nettside til i Plausible (i samme lag som API-nøkkelen), og legg inn skriptet på nettsiden deres. Bruker kunden egne egenskaper (custom properties), legg dem inn under Site settings → Custom properties: portalen viser bare egenskapene som står der (pluss Plausibles egne `url` og `path` for utgående lenker, nedlastinger og 404). Står listen tom, vises ingen egenskaper.
2. Kjør på egen PC, i denne mappen, i et vanlig terminalvindu (ikke via en AI-assistent, fordi den lagrer det som vises):

   ```
   node lag-kunde.mjs --epost post@kunde.no --nettsted kunde.no --navn "Kunde AS"
   ```

   Nettstedet skrives nøyaktig som i Plausible. Skriptet skriver ut en variabel (`KUNDE_…`) og et tilfeldig passord, og legger dem på utklippstavlen etter tur: først verdien (lim inn i Netlify), så passordet når du trykker Enter (lim inn i SMS-en). Da slipper du å markere den lange linjen i terminalen. Legg variabelen inn i Netlify på samme måte som nøklene over (secret, Functions, bare Production).
3. Publiser på nytt (Deploys → Trigger deploy → Deploy project).
4. Send adressen og e-posten til kunden, og passordet i en annen kanal (for eksempel SMS). Lukk terminalen etterpå, og lagre aldri verdiene i en fil i denne mappen.

Én e-post gir tilgang til ett nettsted. Har en kunde flere nettsider, bruk en egen e-post for hver (for eksempel post+butikk@kunde.no). Samme e-post to ganger lager samme variabel og erstatter den gamle innloggingen.

**Nytt passord:** sjekk først at det virkelig er kunden som spør. Svar til e-posten dere har fra før, eller ring nummeret i avtalen, aldri et nummer som står i forespørselen. Kjør så skriptet på nytt med samme e-post, bytt verdien på variabelen i Netlify, publiser, og send passordet på SMS til nummeret dere har fra før. Gamle innlogginger slutter da å virke.
**Stenge tilgangen:** slett `KUNDE_…`-variabelen og publiser.
**Logge ut alle:** bytt `PORTAL_NOKKEL` og publiser.

### Godt å vite

- **Personvern:** For kundens nettside er vi databehandler (kunden er ansvarlig, Plausible er underleverandør). Inngå databehandleravtale med kunden, og sørg for at personvernerklæringen på kundens nettside nevner Plausible.
- **Plausible-pakken:** Business-planen dekker 10 nettsider, og dotdev.no er én av dem (plass til 9 kunder). Alle sidevisningene på kundenes nettsider teller med i vår pakke, så kunder med mye trafikk kan gjøre den dyrere. Plausible tillater 600 spørringer i timen for hele laget (alle nøkler og alle kundene til sammen, fast klokketime), og 60 på 10 sekunder. Portalen husker hver spørring i 5 minutter (sanntid 1 minutt, oppsettet 1 time) og henter bare det kunden ser på: den enkle visningen koster 9 spørringer første gang (8 uten mål) og ingen de neste 5 minuttene, den detaljerte 11, og bytte fra enkel til detaljert 2 (resten deles), et nytt filter rundt 8, en ny fane 1, «Vis alle» 1–2 per side med 100 rader, og en nedlasting 22 pluss én per egenskap (høyst 32, og høyst én gang i minuttet per nettsted). «Besøkende nå» koster 1 spørring i minuttet per nettsted mens portalen er åpen og synlig, og sanntid 4–5 i minuttet (tallene øverst hvert minutt, listene annethvert). Det stopper etter et kvarter uten aktivitet (sanntid etter fem minutter), når fanen er skjult, og når kvoten er brukt opp (til kunden gjør noe igjen).
- **Kvotevern:** Hvert nettsted kan bruke 120 spørringer i én rykk, og får 4 nye i minuttet (240 i timen). Bruker en kunde mer, ser den kunden «Du har hentet mange tall på kort tid. Vent et par minutter» for de delene som ikke fikk plass, mens de andre kundene ikke merker noe. Portalen sender i tillegg høyst 500 spørringer per klokketime og 50 per 10 sekunder (litt under Plausibles grenser), og svarer Plausible likevel «for mange», tar den pause til neste klokketime (eller 10 sekunder) i stedet for å sende spørringer som uansett blir avvist. Da ser kundene «Mange spør etter tall akkurat nå». Grensene ligger i `netlify/kunde/plausible.mjs` (KVOTE). Merk: de gjelder per serverinstans, og Netlify kan kjøre flere samtidig, så de er en brems, ikke en mur. Får dere mange kunder, be Plausible om høyere grense.
- **Tid:** Netlify stopper en forespørsel etter 60 sekunder. Portalen gir hver forespørsel en frist på 25 sekunder (nedlastingen 45), og svarer med det som rakk å bli ferdig. Er Plausible veldig tregt, kan en nedlasting feile med «Plausible svarer tregt akkurat nå»; den kan da prøves igjen med en gang.
- **Netlify:** Er kontoen på Netlifys nye kredittplan, koster hver publisering (også Trigger deploy) 15 kreditter, og gratisplanen har 300 i måneden. Samle gjerne flere kundeendringer før dere publiserer. Feil fra funksjonen står under Logs → Functions.
- **Sikkerhet:** Passordene lagres som scrypt-hasher. Innloggingen er en signert cookie (HttpOnly, Secure, SameSite=Strict) som bare sendes til `/api/kunde`, ikke inneholder e-post eller navn og varer i 14 dager. I tillegg settes flagget `__Secure-dd_innlogget=1` (ikke HttpOnly, gjelder hele nettstedet, samme levetid). Det gir ingen tilgang til noe, men forteller forsiden at kunden er innlogget: da spør forsiden `/api/kunde/meg` og viser «Min side» i stedet for «Logg inn» (headeren og footeren). Besøkende uten flagget gir ingen kall til portalen. Utlogging fjerner begge, og `/meg` fjerner flagget hvis innloggingen har gått ut. Netlify stopper en IP som sender over 90 forespørsler i minuttet til portalen.

## Sikkerhet

- **Sikkerhetsreglene (CSP):** nettleseren kjører bare kode som ligger på dotdev.no, og innebygde `<script>`- og `<style>`-blokker bare hvis hashen deres står i `_headers`. Hashene fyller `bygg.py` inn automatisk ved hver publisering, så dere trenger ikke gjøre noe når dere endrer koden. Bruk aldri `onclick="…"`, `style="…"` eller `javascript:`-lenker i HTML-en: byggingen stopper da med en feilmelding (og forrige versjon blir liggende ute). Tar dere i bruk noe eksternt (innebygd video, kalender, skjematjeneste), må domenet legges til i `_headers`.
- **Kundeportalen** har i tillegg Trusted Types: `innerHTML` og lignende virker ikke der. Bruk `textContent` og `createElement`.
- **HTTPS på alle underdomener:** `_headers` sier til nettleseren at hele dotdev.no, også underdomener, bare skal brukes med HTTPS i to år. Et nytt underdomene (for eksempel til en kunde eller en Google-tjeneste) må ha gyldig HTTPS fra første dag. Google Workspace sine «egne adresser» (CNAME til ghs.googlehosted.com) har ikke HTTPS og virker derfor ikke.
- **Kjent avvik (godtatt):** svarene fra statistikk-proxyen (`/dd/js/s.js` og `/dd/api/e`) har Plausibles egne headere, blant annet `Strict-Transport-Security: max-age=31536000` uten `includeSubDomains`. Etter et besøk på en side med statistikk gjelder HTTPS-kravet derfor bare dotdev.no (ett år), ikke underdomenene. Det er godtatt fordi www selv sender regelen med `includeSubDomains`, innloggingscookien bare gjelder dotdev.no, og HSTS-preload bare sjekker svaret fra forsiden. Skal det rettes, trengs en edge-funksjon på de to stiene som setter headeren (ett ekstra kall per sidevisning på Netlify).
- **security.txt:** `.well-known/security.txt` har en utløpsdato (Expires). Flytt den ett år fram hver høst.
- **Ingen avhengigheter:** byggingen og serverfunksjonen bruker ingen pakker fra npm eller pip, og ingen Netlify-utvidelser. La det være slik: alt som kjøres under bygging, kan lese nøklene.

## Hvis noe skjer

Mistenker dere at noen har kommet seg inn (ukjent publisering i Netlify, rare commits i GitHub, varsel om innlogging dere ikke kjenner igjen, mistet PC eller telefon), gjør dette i rekkefølge:

1. **Stopp skaden.** Bytt passord på kontoen det gjelder, og fjern alt en inntrenger kan ha lagt igjen:
   - **Google:** Sikkerhet → Enhetene dine → Administrer alle enheter → logg av ukjente. Sjekk videresending, filtre og delegering i Gmail, tredjepartstilgang, og gjenopprettingsnummer og -e-post.
   - **GitHub:** Settings → Sessions (logg av ukjente), SSH and GPG keys, Developer settings → Personal access tokens, Applications, og i repoet Settings → Deploy keys og Webhooks. Fjern ukjente commits fra `main` før dere publiserer noe.
   - **Netlify:** User settings → Applications (slett tilgangsnøkler og ukjente apper), Team members og Build hooks. Logger dere inn med GitHub, dekker GitHub-stegene innloggingen. Vil dere hindre at noe nytt går ut mens dere rydder: Deploys → «Lock to stop auto publishing».
2. **Bytt nøklene, i denne rekkefølgen:**
   1. Lag en ny API-nøkkel i Plausible, og en ny `PORTAL_NOKKEL` (`node lag-kunde.mjs --nokkel`), som logger ut alle kunder. Gi kundene nye passord hvis kundevariablene kan ha lekket. Legg de nye verdiene inn i Netlify.
   2. Slett den gamle nøkkelen i Plausible.
   3. Publiser: Deploys → Trigger deploy → Deploy project. Har dere låst publiseringen, åpner dere den nye publiseringen og trykker «Publish deploy», eller låser opp med «Unlock to start auto publishing».
   4. Sjekk at dotdev.no kjører den nye publiseringen, og at innloggingen virker.
   5. Slett eldre publiseringer (Deploys → velg publisering → Options → Delete deploy), fordi de har de gamle nøklene. Lås opp igjen hvis dere låste.
3. **Sjekk domenet.** Logg inn hos domene.no og se at navnetjenerne, MX, A-posten, www og TXT-postene (SPF, DMARC, google._domainkey) er som før.
4. **Vurder om personopplysninger er rammet.** Gjelder det kunders eller besøkendes opplysninger, skal Datatilsynet varsles innen **72 timer** etter at dere ble klar over det (Altinn: «Melding om brudd på personopplysningssikkerheten»). Er risikoen høy for de berørte, skal de også få beskjed. Skriv ned hva som skjedde, når, og hva dere gjorde, også om dere ikke varsler.
5. **Gjelder det statistikk på en kundes nettside**, er kunden behandlingsansvarlig. Gi kunden beskjed uten opphold, så kan de vurdere varsling.

Hold denne lista oppdatert. Skriv aldri passord, nøkler eller telefonnumre her, fordi repoet er offentlig.

## Etter publisering

- Legg til dotdev.no i Google Search Console og send inn `https://dotdev.no/sitemap.xml`.
- Sjekk headerne på securityheaders.com og hastigheten i PageSpeed Insights.
- Opprett en Google Business-profil og be fornøyde kunder om omtaler der.
