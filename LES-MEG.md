# DOTDEV – nettsiden

## Filene

| Fil / mappe | Hva |
|---|---|
| `index.html`, `personvern.html`, `404.html` | Kildefilene. Det er disse dere redigerer. Guiden øverst i `index.html` forklarer alt. |
| `kunde.html` | Kundeportalen (dotdev.no/kunde): innlogging og statistikk for kundene. Se «Kundeportalen» under. |
| `netlify/functions/kunde-api.mjs` | Serverfunksjonen bak kundeportalen. Sjekker innloggingen og henter tallene fra Plausible. |
| `lag-kunde.mjs` | Lager innlogging til en kunde (kjøres på egen PC). Publiseres ikke. |
| `bygg.py` | Lager en publiseringsklar kopi i `dist/` (uten guiden og kommentarene). |
| `netlify.toml` | Får Netlify til å kjøre `bygg.py` og publisere bare `dist/`. |
| `dist/` | Det som publiseres. Netlify lager den på nytt hver gang, så den ligger ikke i GitHub. Ikke rediger her. |
| `_headers` | Sikkerhetsheadere og mellomlagring på Netlify. |
| `robots.txt`, `sitemap.xml` | Forteller Google hvilke sider som finnes. |
| `fonter/`, `bilder/`, ikonene | Fonter, skjermbilder og favicon. |

## Publisere en endring

1. Rediger kildefilene.
2. Last dem opp til GitHub (`main`).
3. Netlify kjører `python3 bygg.py` og publiserer `dist/` automatisk (se `netlify.toml`). Etter et par minutter er endringen ute.

Bare `dist/` blir publisert, så guiden, kommentarene, `LES-MEG.md` og `bygg.py` er ikke synlige på nettsiden. Feiler byggingen, blir forrige versjon liggende ute, og feilen står under **Deploys** i Netlify.

## Venter på dere

- **Team:** navn, roller, bilder og LinkedIn. Blokken ✏️ TEAM i SEKSJON: Om oss.
- **Telefon og sosiale medier:** linjene står klare i footeren og som `telephone`/`sameAs` i JSON-LD i `<head>`.
- **Startpris:** skriv den i svaret på «Hva koster en nettside?».
- **Les gjennom de nye tekstene:** tjenestene (særlig AI-eksemplene), Om oss og spørsmål og svar. Alt skal stemme med det dere faktisk leverer.

## Kundeportalen

Kunder som har kjøpt nettside av oss, kan logge inn på **dotdev.no/kunde** og se besøksstatistikken for sin egen nettside: besøkende, sidevisninger, hvor de kommer fra, sider, land, enheter og handlinger (mål). Tallene hentes fra Plausible av serverfunksjonen `netlify/functions/kunde-api.mjs`. API-nøkkelen og passordene ligger bare i Netlify, aldri i GitHub og aldri i nettleseren.

**Repoet er offentlig. Ikke legg API-nøkler, passord eller verdiene fra `lag-kunde.mjs` i noen fil her.**

### Sette opp (én gang)

1. **Plausible:** Velg laget der nettsidene ligger, i menyen øverst til høyre. Gå så til Account settings → API Keys → New API Key → velg **Stats API** → Create API Key. Kopier nøkkelen (den vises bare én gang). Stats API krever Business-planen (prøveperioden har den til ca. 2. november 2026).
2. **Netlify:** Project configuration → Environment variables → Add a variable, for hver av disse:
   - `PLAUSIBLE_API_KEY` = nøkkelen fra Plausible
   - `PORTAL_NOKKEL` = verdien fra `node lag-kunde.mjs --nokkel`

   Huk av «Contains secret values». Under Scopes holder det med Functions. Under Values velger dere «Different value for each deploy context» og fyller bare inn **Production**, så nøklene aldri havner i forhåndsvisninger.
3. **Sikkerhet (viktig):** Repoet er offentlig, så hvem som helst kan foreslå endringer (pull request). Godkjenn aldri publisering av forhåndsvisninger fra folk dere ikke kjenner, og la «Sensitive variable policy» (Project configuration → Build & deploy) stå på «Require approval». Da kan ingen lure til seg nøklene.
4. Legg til minst én kunde (under), og publiser på nytt: Deploys → Trigger deploy → Deploy project. Endringer i variablene virker først etter ny publisering.

### Ny kunde

1. Legg kundens nettside til i Plausible (i samme lag som API-nøkkelen), og legg inn skriptet på nettsiden deres.
2. Kjør på egen PC, i denne mappen:

   ```
   node lag-kunde.mjs --epost post@kunde.no --nettsted kunde.no --navn "Kunde AS"
   ```

   Nettstedet skrives nøyaktig som i Plausible. Skriptet skriver ut en variabel (`KUNDE_…`) og et tilfeldig passord. Legg variabelen inn i Netlify på samme måte som nøklene over (secret, Functions, bare Production).
3. Publiser på nytt (Deploys → Trigger deploy → Deploy project).
4. Send adressen og e-posten til kunden, og passordet i en annen kanal (for eksempel SMS).

Én e-post gir tilgang til ett nettsted. Har en kunde flere nettsider, bruk en egen e-post for hver (for eksempel post+butikk@kunde.no). Samme e-post to ganger lager samme variabel og erstatter den gamle innloggingen.

**Nytt passord:** kjør skriptet på nytt med samme e-post, bytt verdien på variabelen i Netlify og publiser. Gamle innlogginger slutter da å virke.
**Stenge tilgangen:** slett `KUNDE_…`-variabelen og publiser.
**Logge ut alle:** bytt `PORTAL_NOKKEL` og publiser.

### Godt å vite

- **Personvern:** For kundens nettside er vi databehandler (kunden er ansvarlig, Plausible er underleverandør). Inngå databehandleravtale med kunden, og sørg for at personvernerklæringen på kundens nettside nevner Plausible.
- **Plausible-pakken:** Business-planen dekker 10 nettsider, og dotdev.no er én av dem (plass til 9 kunder). Alle sidevisningene på kundenes nettsider teller med i vår pakke, så kunder med mye trafikk kan gjøre den dyrere. Plausible tillater 600 spørringer i timen per nøkkel. Portalen bruker 8 per visning og husker tallene i 5 minutter, så det holder godt.
- **Netlify:** Er kontoen på Netlifys nye kredittplan, koster hver publisering (også Trigger deploy) 15 kreditter, og gratisplanen har 300 i måneden. Samle gjerne flere kundeendringer før dere publiserer. Feil fra funksjonen står under Logs → Functions.
- **Sikkerhet:** Passordene lagres som scrypt-hasher. Innloggingen er en signert cookie (HttpOnly, Secure, SameSite=Strict) som bare sendes til `/api/kunde`, ikke inneholder e-post eller navn og varer i 14 dager. Netlify stopper en IP som sender over 30 forespørsler i minuttet til portalen.

## Etter publisering

- Legg til dotdev.no i Google Search Console og send inn `https://dotdev.no/sitemap.xml`.
- Sjekk headerne på securityheaders.com og hastigheten i PageSpeed Insights.
- Opprett en Google Business-profil og be fornøyde kunder om omtaler der.
