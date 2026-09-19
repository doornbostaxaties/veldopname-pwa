// app.js — Veldopname PWA (v1 "kern eerst"): taxatielijst, Meting, Indeling, Foto's, Aantekeningen.
//
// Architectuur: deze app praat NOOIT rechtstreeks met Taxatieweb — hij deelt dezelfde Airtable-data
// die taxatieweb-opname.user.js al gebruikt (zelfde webhook, zelfde `data`-vorm: afmetingen +
// externeBergruimte + indeling). Zo blijft "begin op de ene, werk verder op de andere" werken.
// Lokaal-eerst: alles (metingen én foto's) wordt eerst in IndexedDB bewaard, de sync-wachtrij
// verstuurt zodra er weer verbinding is — nooit wachten op verbinding om door te kunnen werken.

// ----------------------------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------------------------
const CLOUD_WEBHOOK = 'https://hook.eu1.make.com/3u02rxsgeup34uq1dgqum8m694i5kgay'; // zelfde als taxatieweb-opname.user.js
const LIJST_WEBHOOK = 'https://hook.eu1.make.com/n5uu657on1wsnnnzj7ul485uqpy2u479'; // Veldopname PWA - Taxatielijst ophalen (nieuwe hook 07-09-2026 — oude had een volle wachtrij door de credit-runaway hieronder)
const VOORONDERZOEK_WEBHOOK = 'https://hook.eu1.make.com/6z71b143w3nnerxjm7o5pqcx4gx4tr88'; // Veldopname PWA - Vooronderzoek ophalen
// Zet de foto (OneDrive-map "Taxaties/Taxatieopname-foto's/[adres]" binnen de werkvoorraad-drive)
// + een record in Airtable-tabel "Opname Foto's" (bestand als attachment via de tijdelijke
// pre-authenticated downloadUrl uit de OneDrive-upload — geen permanente publieke deellink nodig).
const FOTO_WEBHOOK = 'https://hook.eu1.make.com/w9oljmdhr4l9s7atf8kf38net3e7dhod'; // Veldopname PWA - Foto upload
// Documenten die Arno vooraf in Taxatieweb (Q/R > Bijlagen) plaatst, doorgestuurd door
// taxatieweb-opname.user.js naar Airtable-tabel "Bijlagen" — hier alleen UITLEZEN (de PWA upload
// zelf niets naar deze tabel, dat gebeurt aan de Taxatieweb-kant). Zelfde "geef alles terug, filter
// hier client-side op rapport_id"-patroon als LIJST_WEBHOOK.
const BIJLAGEN_WEBHOOK = 'https://hook.eu1.make.com/190eh6nt7efgk9d20frzac88ql9m87nq'; // Veldopname PWA - Bijlagen ophalen
// Al bestaand Make-scenario "Veldopname PWA - Foto's voor Q/R" (oorspronkelijk voor Taxatieweb's
// eigen Q/R-afvinklijst) — hergebruikt voor het PDF-rapport (genereerRapportPdf) om ook foto's terug
// te halen die WEL succesvol geüpload zijn maar niet meer lokaal op dit toestel staan (Arno's melding
// 16-09-2026: "mis foto's van Grote Bavenkelsweg 27, wel in Taxatieweb maar niet meer in de PWA" —
// state.fotos is altijd lokaal/IndexedDB-only, dit haalt de Airtable-kopie terug). `actie: 'ophalen'`
// geeft ALLE foto-records van ALLE taxaties terug (zelfde "geef alles terug, filter hier client-side
// op rapport_id"-patroon als BIJLAGEN_WEBHOOK hierboven) — geen apart nieuw Make-scenario nodig.
const FOTOS_OPHALEN_WEBHOOK = 'https://hook.eu1.make.com/72l4pur68x3u7kd1o4w0k53li8ej0j7i';

// Zelfde 19 categorieën als QR_CATEGORIEEN in taxatieweb-opname.user.js (v0.54.0) — dezelfde lijst
// als Taxatieweb's eigen Q/R-categorieselectie, plus "Anders" als vangnet.
const QR_CATEGORIEEN = [
  'Vooraanzicht', 'Straatbeeld', 'Achtergevel', 'Tuin', 'Badkamer', 'Keuken', 'Woonkamer',
  'Slaapkamer', 'Toilet', 'Zolder', 'Berging', 'Kelder', 'Meterkast', 'C.V.-ketel', 'Balkon',
  'Dakterras', 'Verbouwing', 'Achterstallig onderhoud',
];
// Verplichte vaste foto's (uit Q/R's eigen instructietekst) — altijd op de checklist, ongeacht Indeling.
// 'C.V.-ketel' toegevoegd op Arno's verzoek (12-09-2026): Verwarmingstoestel is net als Meterkast
// een verplichte foto — de bouwkundig-tab-fotoknop bij dat bouwdeel gebruikt dezelfde categorienaam,
// zodat die éne foto ook meteen deze checklist-regel afvinkt (zie ook FOTO_CATEGORIE_PER_BOUWDEEL).
// 'Tuin' is sinds 13-09-2026 GEEN vaste verplichting meer — alleen verplicht als "Tuin aanwezig" op
// Objectkenmerken op Ja staat (zie bepaalVerplichteFotos()), Arno: "Tuinfoto is ook verplicht als
// tuin geselecteerd is."
const VASTE_VERPLICHTE_FOTOS = [
  'Vooraanzicht', 'Straatbeeld', 'Achtergevel', 'Badkamer', 'Keuken', 'Woonkamer',
  'Toilet', 'Meterkast', 'C.V.-ketel',
];

// ----------------------------------------------------------------------------------------------
// DATAMODEL — 1-op-1 hetzelfde als taxatieweb-opname.user.js (leegData/leegWoonlaag/leegBlok/…)
// ----------------------------------------------------------------------------------------------
function leegBlok() {
  // x/y: positie op het tekencanvas (in meters) — zelfde velden als taxatieweb-opname.user.js'
  // Plattegrondschetser (sinds v0.17.0 daar); null = nog niet getekend, autoPlaatsBlok() kent dan
  // een vrije plek toe.
  return { naam: '', type: 'wonen', lengte: '', breedte: '', x: null, y: null };
}
function leegWoonlaag() {
  return { blokken: [leegBlok()] };
}
function leegExternBlok() {
  return { naam: '', lengte: '', breedte: '' };
}
function leegRuimte() {
  return { naam: '', toevoegingen: [] };
}
// `kenmerken` (Arno's verzoek 16-09-2026: "Kenmerken verdieping" bovenaan elke woonlaag in
// Indeling) — 5 multiselect-velden, opties komen uit de gelijknamige macro's (zie standaardMacros).
function leegWoonlaagKenmerken() {
  return { vloersoort: [], kozijnen: [], glastypes: [], verwarmingssysteem: [], vloerafwerking: [] };
}
function leegIndelingWoonlaag() {
  return { naam: '', vloerbeschrijving: '', vloerbeschrijvingen: [], ruimtes: [leegRuimte()], kenmerken: leegWoonlaagKenmerken() };
}
// installatieKenmerken (17-09-2026, Arno's advies-antwoord "A. prima") — zelfde soort probleem als
// Kenmerken verdieping, maar dan tussen Bouwkundig en Energetisch rechtstreeks: Ventilatie, Koeling
// en Warmwatertoestel stonden daar allebei met (bijna) dezelfde keuzelijst, dus dubbel in te vullen.
// Deze 3 velden zijn huisbreed (geen per-woonlaag-slot nodig zoals bij Indeling), dus 1 gedeelde
// opslagplek in `data` i.p.v. een koppeling naar Indeling — zie installatieGeselecteerd/-Wissel.
function leegInstallatieKenmerken() {
  return { ventilatie: [], koeling: [], warmwatertoestel: [], verwarmingstoestel: [] };
}
// Bijgebouwen (17-09-2026, Arno's verzoek: "een oplossing voor bijgebouwen ... zoals Provadie's
// Bij-/aanbouwen en buitenvoorzieningen: kiezen uit een lijst, toevoegen, dan extra's toevoegen")
// — 1-op-1 dezelfde velden als Provadie's editor (live nagekeken bij Spade 21): Type (vrije tekst +
// keuzelijst), Soort (Vrijstaand/Aangebouwd), Materiaal (multiselect), Isolatie (Geen/Deels/
// Volledig), Extra's (multiselect), Conditie. Woont in `data` (net als installatieKenmerken) zodat
// het meesynchroniseert via het bestaande `data`-veld, zonder een nieuwe Airtable-kolom nodig te
// hebben. Vervangt het oude, vrijwel ongebruikte "Extern"-blokje (losse naam+toevoegingen-kaart).
function leegBijgebouw() {
  return { type: '', soort: null, materialen: [], isolatie: '', extras: [], conditie: 5 };
}
function leegData() {
  return {
    afmetingen: { woonlagen: [leegWoonlaag()] },
    externeBergruimte: { blokken: [] },
    indeling: { woonlagen: [], extern: [] },
    installatieKenmerken: leegInstallatieKenmerken(),
    // attentieVelden (17-09-2026, Arno's verzoek: "bepaalde onderdelen extra attentiewaarde geven,
    // met een !-knopje") — lijst van id's ("bouwkundig:dakconstructie" e.d., zie attentieId()) van
    // bouwdelen/velden die de taxateur zelf als belangrijk heeft gemarkeerd. Controle-tab gebruikt
    // deze lijst om te waarschuwen als zo'n gemarkeerd veld nog leeg is — "niets vergeten".
    attentieVelden: [],
    bijgebouwen: [],
  };
}
// Arno (13-09-2026): "Kun je ook de woonlagen en meting woonlagen gelijk houden?" — Meting
// (data.afmetingen.woonlagen, met blokken) en Indeling (data.indeling.woonlagen, met ruimtes) waren
// bewust twee losse lijsten (zie de architectuur-notitie bovenaan dit bestand — beide tabbladen delen
// verder wél dezelfde `data`-vorm met taxatieweb-opname.user.js). Vanaf nu blijven de NAMEN en het
// AANTAL woonlagen in beide lijsten gelijk: renderMetingTab()/renderIndelingTab() schrijven een naam-
// wijziging en een "+ Woonlaag toevoegen"-klik voortaan naar BEIDE lijsten tegelijk (zie
// zorgVoorAfmetingenWoonlaag()/zorgVoorIndelingWoonlaag() hieronder). Deze functie doet de eenmalige
// reconciliatie bij het laden, voor taxaties die al bestonden vóór dit verzoek en waar de twee lijsten
// dus uit de pas kunnen lopen (verschillende lengte, of een naam die maar aan één kant is ingevuld).
function synchroniseerWoonlagen(data) {
  if (!data.afmetingen) data.afmetingen = { woonlagen: [] };
  if (!data.afmetingen.woonlagen) data.afmetingen.woonlagen = [];
  if (!data.indeling) data.indeling = { woonlagen: [], extern: [] };
  if (!data.indeling.woonlagen) data.indeling.woonlagen = [];
  const afm = data.afmetingen.woonlagen;
  const ind = data.indeling.woonlagen;
  const lengte = Math.max(afm.length, ind.length);
  for (let i = 0; i < lengte; i++) {
    if (!afm[i]) afm[i] = leegWoonlaag();
    if (!ind[i]) ind[i] = leegIndelingWoonlaag();
    const naamAfm = (afm[i].naam || '').trim();
    const naamInd = (ind[i].naam || '').trim();
    // Staat er maar aan één kant al een naam, dan die overnemen naar de andere kant. Hebben beide
    // kanten al een (verschillende) naam, dan bewust laten staan — dat is bestaande, moedwillig
    // ingevoerde data van vóór deze koppeling, niet zomaar overschrijven.
    if (naamAfm && !naamInd) ind[i].naam = afm[i].naam;
    else if (naamInd && !naamAfm) afm[i].naam = ind[i].naam;
  }
  return data;
}
function zorgVoorIndelingWoonlaag(data, idx) {
  while (data.indeling.woonlagen.length <= idx) data.indeling.woonlagen.push(leegIndelingWoonlaag());
  return data.indeling.woonlagen[idx];
}
function zorgVoorAfmetingenWoonlaag(data, idx) {
  while (data.afmetingen.woonlagen.length <= idx) data.afmetingen.woonlagen.push(leegWoonlaag());
  return data.afmetingen.woonlagen[idx];
}
function leegTaxatie(rapportId) {
  return {
    rapport_id: rapportId,
    adres: '', postcode: '', plaats: '', afspraak_datumtijd: null,
    aantekeningen: '',
    // voorlopig: true zodra deze taxatie ZELF in de PWA is aangemaakt (nog geen Taxatieweb-rapport
    // bestaat) — zie nieuweTaxatieScherm(). kavelnummer/bouwplan alleen relevant bij nieuwbouw (nog
    // geen BAG-adres). Zie project_taxatieweb_opname_bridge in memory voor de koppel-flow: het
    // Taxatieweb-script herkent deze taxaties op adres en biedt een importknop.
    voorlopig: false, kavelnummer: '', bouwplan: '',
    // Moment waarop deze taxatie voor het eerst op locatie geopend is — proxy voor "start van de
    // inspectie", gebruikt om Omgeving/Inspectie's begin-/eindtijd automatisch voor te stellen
    // (Arno's verzoek 13-09-2026: "tijdstip kan overgenomen worden van start opname moment op
    // locatie"). Wordt in laadOpname() precies 1x gezet, bij de allereerste keer laden.
    begintijdOpname: null,
    data: leegData(),
    bewoning: leegBewoning(),
    bouwkundig: leegBouwkundig(),
    energetisch: leegEnergetisch(),
    omgeving: leegOmgeving(),
    lokaalGewijzigd: false,
  };
}

// Sinds Arno's verzoek (11-09-2026): "de app afbouwen voor een volledige opname zoals Provadie" —
// Fase 1 = Bewoning, 1-op-1 dezelfde velden/volgorde als Taxatieweb's L. Bewoning (live nagekeken op
// een testrapport), zodat een latere "Vul in bij Taxatieweb"-knop (taxatieweb-opname.user.js) deze
// waarden zonder vertaalslag kan overnemen. ja_nee-velden: null (nog niet ingevuld) | true | false.
// Sinds Arno's verzoek (12-09-2026): Bewoning-tabblad hernoemd naar "Objectkenmerken" mét twee
// nieuwe velden vooraan (Woningtype uit Taxatieweb's C. Object, Bouwjaar uit H. Object/Omgeving) —
// de rest van dit object (gezochtEigenaarBewoner e.o.) is de bestaande L. Bewoning-data, bewust
// ongewijzigd (zelfde Airtable-veld bewoning_data, geen migratie nodig). woningtype/bouwjaar worden
// automatisch voorgevuld uit het vooronderzoek zodra ze nog leeg zijn, zie renderObjectkenmerkenTab().
function leegBewoning() {
  return {
    woningtype: '', bouwjaar: '', tuinAanwezig: null,
    // Taxatieweb H.1.D "Zijn er grote verbouwingen of uitbreidingen geweest?" — bevestigd live
    // aanwezig als eigen Ja/Nee+toelichting-veld (13-09-2026), dus wel de moeite waard als los veld
    // (i.t.t. Tuin-detailvelden die toch alleen in vrije tekst terecht zouden komen).
    grootVerbouwingGeweest: null, grootVerbouwingToelichting: '',
    gezochtEigenaarBewoner: null, gezochtEigenaarBewonerToelichting: '',
    gezochtMakelaar: null, gezochtMakelaarToelichting: '',
    gezochtAndereBronnen: null, gezochtAndereBronnenToelichting: '',
    volledigGeinspecteerd: null,
    situatie: '', situatieAnders: '',
    aanvragerWoontAl: null, aanvragerWoontAlToelichting: '',
    aanvragerBlijftWonen: null, aanvragerBlijftWonenToelichting: '',
    andereInfoOntdekt: null, andereInfoOntdektToelichting: '',
  };
}
// Nieuwe tab "Omgeving" (13-09-2026, Arno's advies-antwoord: "Zet er maar in. H.3 Fundering moet er
// ook in. Wellicht dat deze zaken een aparte knop nodig hebben") — Taxatieweb's H.2 Omgeving en
// H.3 Fundering volledig, plus alleen het ZICHTBARE/op-locatie-deel van K. Verontreiniging
// (K.1-C "Zie ik een risico..." en K.2-B/C over asbest zien/denken) — de rest van K (welke bronnen
// geraadpleegd) is bewust weggelaten, dat is kantoorwerk, geen locatie-observatie (zie het advies
// hierboven in de projectmemory). Live nagekeken op Spade 21.
function leegOmgeving() {
  return {
    // Inspectie (Arno's verzoek 13-09-2026, naar analogie van Provadie's Vragenlijst > Bewoning) —
    // begintijd/eindtijd worden automatisch voorgesteld vanuit begintijdOpname (zie renderOmgevingTab),
    // maar blijven gewoon aanpasbaar.
    // Live bevestigd in Taxatieweb's B. Inspectie (13-09-2026): "Anderen aanwezig bij inspectie" is
    // daar een checkbox-lijst (Verkopende makelaar/Aankopende makelaar/Eigenaar/Huurder-gebruiker/
    // Anderen) + los toelichtingsveld — aanwezigenInspectie daarom een lijst i.p.v. vrije tekst, voor
    // een 1-op-1 "Vul in bij Taxatieweb"-koppeling later (zelfde aanpak als Bewoning).
    weersomstandigheden: '', aanwezigenInspectie: [], aanwezigenInspectieToelichting: '',
    begintijdInspectie: null, eindtijdInspectie: null,
    // H.2 Omgeving
    locatie: '', gebouwenRondom: '', bereikbaarheid: '', voorzieningen: '',
    bijzonderhedenOmgeving: null, bijzonderhedenOmgevingToelichting: '',
    // H.3 Fundering
    funderingEigenaarBewoner: null, funderingOnderzoeksrapport: null, funderingAndereBronnen: null,
    funderingProblemen: null, funderingProblemenToelichting: '',
    // K. Verontreiniging — alleen het op-locatie-observatiedeel
    risicoVervuildeGrond: null, risicoVervuildeGrondToelichting: '',
    asbestGezien: null, asbestGezienToelichting: '',
    asbestAanwezigDenken: null, asbestAanwezigDenkenToelichting: '',
  };
}
// Zelfde migratie-patroon als de andere fases — vult alleen ontbrekende velden aan.
function metVolledigOmgeving(o) {
  const leeg = leegOmgeving();
  if (!o || typeof o !== 'object') return leeg;
  Object.keys(leeg).forEach(key => { if (o[key] === undefined) o[key] = leeg[key]; });
  // aanwezigenInspectie was heel kort een vrij tekstveld (13-09-2026) vóór de omzetting naar
  // checkboxes — een eerder als tekst opgeslagen waarde alsnog als toelichting bewaren i.p.v. weg te
  // gooien.
  if (typeof o.aanwezigenInspectie === 'string') {
    if (!o.aanwezigenInspectieToelichting) o.aanwezigenInspectieToelichting = o.aanwezigenInspectie;
    o.aanwezigenInspectie = [];
  }
  return o;
}
// Exacte tekst van Taxatieweb's eigen keuzelijst (F. Wat is de situatie van de woning?) — bewust
// woordelijk overgenomen, niet herschreven, zodat de importknop straks op exacte tekst kan matchen.
const BEWONING_SITUATIE_OPTIES = [
  'de woning leegstaat.',
  'alleen de eigenaar in de woning woont, eventueel samen met zijn gezin.',
  'de eigenaar in een deel van de woning woont, eventueel samen met zijn gezin. In een ander deel van de woning wonen anderen.',
  'de woning als geheel is verhuurd.',
  'de woning per kamer is verhuurd.',
  'de woning geheel is bewoond door anderen.',
  'de eigenaar in een deel van de woning woont, eventueel samen met zijn gezin. Een ander deel van de woning staat leeg.',
  'de woning gedeeltelijk is verhuurd. Een ander deel van de woning staat leeg.',
  'Anders, namelijk:',
];

// Fase 2 "volledige opname" (11-09-2026): Bouwkundige staat per ruimte/bouwdeel, 1-op-1 dezelfde
// bouwdelen/velden als Taxatieweb's J.4 Bouwkundige opnamestaat (live nagekeken op een testrapport).
// Bewust ALLEEN Buitenzijde uitgewerkt in deze fase (Arno's akkoord: "eerst Buitenzijde, dan
// Binnenzijde, dan Installaties") — Binnenzijde/Installaties/Overige bijzonderheden/Specifieke
// aandachtspunten volgen later, zelfde patroon.
//
// Elk "gewoon" bouwdeel (type 'tekst'/'materiaal') heeft: aanwezig (checkbox — Taxatieweb toont de
// rest van de velden alleen als dit aan staat), conditie (0-5, zelfde labels als Taxatieweb: 0=niet
// waarneembaar, 1=nader onderzoek nodig, 2=slecht, 3=matig, 4=redelijk, 5=goed — live afgelezen via
// de slider se aria-valuetext), omschrijving (vrije tekst) OF materialen (checkbox-multiselect, bij
// bouwdelen waar Taxatieweb zelf ook geen vrije tekst maar een vaste materiaallijst toont),
// aandachtspuntenAanwezig + -Toelichting (Ja/Nee, toelichting verplicht bij Ja — zelfde Ja/Nee-
// patroon als renderJaNeeVraag). Bewust GEEN indicatieve-herstelkosten-velden (Direct/1-5 jaar) — op
// Arno's verzoek (11-09-2026): "hoeft niet in de opname app te staan, is voor uitwerking in
// Taxatieweb" — die vult hij later zelf rechtstreeks in Taxatieweb in.
// Type 'simpel' (Overige waarnemingen) heeft GEEN conditie en GEEN aandachtspunten — Taxatieweb
// toont daar alleen kosten (niet hier) + omschrijving + foto.
// `details`: een paar bouwdelen (Verwarmings-/Warmwatertoestel, Meterkast) hebben in Taxatieweb nog
// een eigen "Details"-blokje met extra velden (Bouwjaar/Eigendom, Aantal groepen e.d.) — zie
// `def.details` in BOUWKUNDIG_SCHEMA. Waarden staan los in `details` (per bouwdeel-key), zodat een
// bouwdeel zonder eigen details gewoon een leeg object heeft.
// `overigeTekst`: bij type 'materiaal', zodra "Overige" is aangevinkt toont Taxatieweb daar zelf ook
// een vrij tekstveld (Arno's verzoek 12-09-2026) — los bewaard, niet in `materialen` zelf.
// `def` (optioneel): een NIEUW bouwdeel start met `aanwezig`/`conditie` op def.standaardAan/
// def.standaardConditie als die in het schema staan (Arno: bepaalde bouwdelen staan bij Taxatieweb
// standaard al aan, Riolering staat standaard op "niet waarneembaar") — bestaande, al opgeslagen
// bouwdelen worden hier NOOIT met terugwerkende kracht aangepast (alleen leegBouwkundig()/maakGroep()
// voor een gloednieuwe taxatie roept dit met een `def` aan).
function leegBouwdeel(def) {
  return {
    aanwezig: !!(def && def.standaardAan), conditie: def && def.standaardConditie !== undefined ? def.standaardConditie : 5,
    omschrijving: '', materialen: [], overigeTekst: '', details: {},
    // Alle aandachtspunten staan standaard op Nee (Arno's verzoek 12-09-2026) — was eerst `null`
    // (nog niets gekozen), maar Taxatieweb zelf toont hier ook altijd al "Nee" als startwaarde.
    aandachtspuntenAanwezig: false, aandachtspuntenToelichting: '',
  };
}
// Type 'risico' (Overige bijzonderheden: Houtaantasters/Vochtproblemen/Niet eerder genoemd) heeft
// een ANDER schema dan de rest — geen conditie/kosten, in plaats daarvan een simpele "Risico:
// Ja/Nee" (live nagekeken: Taxatieweb noemt dit veld daar zelf ook letterlijk "Risico").
function leegRisicoBouwdeel() {
  return { aanwezig: false, risico: null, omschrijving: '' };
}
function standaardDetailWaarde(type) {
  return type === 'ja_nee' ? null : '';
}
// Vult ontbrekende details-velden aan op een bestaand bouwdeel-object — gebruikt bij het aanmaken
// van een leeg bouwdeel EN bij het migreren van bestaande data (metVolledigBouwkundig) wanneer een
// bouwdeel al bestond vóórdat een `details`-veld aan het schema werd toegevoegd.
function vulOntbrekendeDetails(bouwdeel, def) {
  if (!def.details) return;
  if (!bouwdeel.details) bouwdeel.details = {};
  def.details.forEach(d => { if (!(d.key in bouwdeel.details)) bouwdeel.details[d.key] = standaardDetailWaarde(d.type); });
}
function maakGroep(bouwdelen) {
  const groep = {};
  bouwdelen.forEach(b => {
    const bouwdeel = b.type === 'risico' ? leegRisicoBouwdeel() : leegBouwdeel(b);
    vulOntbrekendeDetails(bouwdeel, b);
    groep[b.key] = bouwdeel;
  });
  return groep;
}
function leegBouwkundig() {
  return {
    buitenzijde: {
      daken: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.daken),
      gevel: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.gevel),
      bijgebouwen: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.bijgebouwen),
      perceel: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.perceel),
      overigeWaarnemingen: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.overigeWaarnemingen),
    },
    binnenzijde: {
      funderingen: maakGroep(BOUWKUNDIG_SCHEMA.binnenzijde.funderingen),
      vloeren: maakGroep(BOUWKUNDIG_SCHEMA.binnenzijde.vloeren),
      wanden: maakGroep(BOUWKUNDIG_SCHEMA.binnenzijde.wanden),
      plafonds: maakGroep(BOUWKUNDIG_SCHEMA.binnenzijde.plafonds),
      inrichting: maakGroep(BOUWKUNDIG_SCHEMA.binnenzijde.inrichting),
      overigeWaarnemingen: maakGroep(BOUWKUNDIG_SCHEMA.binnenzijde.overigeWaarnemingen),
    },
    installaties: {
      leidingen: maakGroep(BOUWKUNDIG_SCHEMA.installaties.leidingen),
      verwarming: maakGroep(BOUWKUNDIG_SCHEMA.installaties.verwarming),
      warmwater: maakGroep(BOUWKUNDIG_SCHEMA.installaties.warmwater),
      ventilatieKoeling: maakGroep(BOUWKUNDIG_SCHEMA.installaties.ventilatieKoeling),
      elektrotechnisch: maakGroep(BOUWKUNDIG_SCHEMA.installaties.elektrotechnisch),
      overigeWaarnemingen: maakGroep(BOUWKUNDIG_SCHEMA.installaties.overigeWaarnemingen),
    },
    overigeBijzonderheden: maakGroep(BOUWKUNDIG_SCHEMA.overigeBijzonderheden),
  };
}
// Vult ontbrekende hoofdstukken/groepen/bouwdelen aan bij bestaande data (nieuwe bouwdelen later
// toegevoegd, of data van vóór deze fase) — zelfde migratie-patroon als
// metExterneBergruimte()/metNieuweMacroCategorieen().
// Eenmalige (idempotente) migratie: Glas 1e/2e/3e/overige woonlaag stonden tot 18-09-2026 als vrije
// tekst (type 'tekst'), nu omgezet naar dezelfde gedeelde glastypes-multiselect als Energetisch en
// "Kenmerken verdieping". Bestaande, al ingetypte tekst gaat NIET verloren — verschijnt na deze
// migratie onder "Overige" met de oude tekst in het vrije "Namelijk…"-veld, zodat niets onzichtbaar
// wordt. Draait bij elke laadOpname() maar is een no-op zodra materialen al eens gezet is.
function migreerGlasWoonlaagVelden(bk) {
  if (!bk.buitenzijde || !bk.buitenzijde.gevel) return;
  ['glas1eWoonlaag', 'glas2eWoonlaag', 'glas3eWoonlaag', 'glasOverigeWoonlagen'].forEach((sleutel) => {
    const veld = bk.buitenzijde.gevel[sleutel];
    if (!veld) return;
    if (veld.omschrijving && (!Array.isArray(veld.materialen) || !veld.materialen.length) && !veld.overigeTekst) {
      veld.materialen = ['Overige'];
      veld.overigeTekst = veld.omschrijving;
    }
  });
}
function metVolledigBouwkundig(bk) {
  const leeg = leegBouwkundig();
  if (!bk || typeof bk !== 'object') return leeg;
  ['buitenzijde', 'binnenzijde', 'installaties'].forEach(hoofd => {
    if (!bk[hoofd]) bk[hoofd] = {};
    Object.keys(BOUWKUNDIG_SCHEMA[hoofd]).forEach(sectie => {
      if (!bk[hoofd][sectie]) bk[hoofd][sectie] = {};
      BOUWKUNDIG_SCHEMA[hoofd][sectie].forEach(def => {
        if (!bk[hoofd][sectie][def.key]) bk[hoofd][sectie][def.key] = leeg[hoofd][sectie][def.key];
        else {
          vulOntbrekendeDetails(bk[hoofd][sectie][def.key], def);
          if (bk[hoofd][sectie][def.key].overigeTekst === undefined) bk[hoofd][sectie][def.key].overigeTekst = '';
        }
      });
    });
  });
  if (!bk.overigeBijzonderheden) bk.overigeBijzonderheden = {};
  BOUWKUNDIG_SCHEMA.overigeBijzonderheden.forEach(def => {
    if (!bk.overigeBijzonderheden[def.key]) bk.overigeBijzonderheden[def.key] = leeg.overigeBijzonderheden[def.key];
  });
  migreerGlasWoonlaagVelden(bk);
  return bk;
}
const CONDITIE_LABELS = ['niet waarneembaar', 'nader onderzoek nodig', 'slecht', 'matig', 'redelijk', 'goed'];
const BOUWKUNDIG_SCHEMA = {
  buitenzijde: {
    daken: [
      { key: 'dakconstructie', label: 'Dakconstructie', type: 'tekst', standaardAan: true },
      { key: 'materiaalDak', label: 'Materiaal dak', type: 'materiaal', opties: ['Pannen', 'Leien', 'Riet', 'Bitumineus', 'EPDM', 'Sedum', 'Overige'], standaardAan: true },
      // "Aantal" als los getalveld i.p.v. een vaste keuzelijst (18-09-2026, Arno's verzoek n.a.v. de
      // taXapi-vergelijking: "vrij veld zou het aantal kunnen noemen, gewoon optellen") — komt
      // automatisch mee in de samenvatting/PDF via samenvatBouwdeel(), net als bij Meterkast.
      { key: 'dakkapellen', label: 'Dakkapel(len)', type: 'tekst', details: [{ key: 'aantal', label: 'Aantal dakkapellen', type: 'getal' }] },
      { key: 'schoorstenen', label: 'Schoorste(e)n(en)', type: 'tekst' },
      { key: 'goten', label: 'Goten (incl. hemelwaterafvoeren)', type: 'tekst' },
      { key: 'loodwerk', label: 'Loodwerk', type: 'tekst' },
    ],
    gevel: [
      { key: 'gevelwerk', label: 'Gevelwerk', type: 'materiaal', opties: ['Metselwerk', 'Gevelbetimmering', 'Gevelcement', 'Stucwerk', 'Composiet', 'Overige'], standaardAan: true },
      { key: 'balkon', label: 'Balkon', type: 'tekst' },
      // Multiselect i.p.v. vrije tekst (Arno's verzoek 16-09-2026) — opties komen live uit
      // state.macros.kozijnen (macroSleutel, zie bepaalOpties), zelfde lijst als bij "Kenmerken
      // verdieping" in Indeling.
      { key: 'kozijnen', label: 'Kozijnen', type: 'materiaal', opties: ['Kunststof', 'Hardhout', 'Hout', 'Aluminium', 'Staal', 'Overige'], macroSleutel: 'kozijnen', kenmerkenKoppeling: { macroSleutel: 'kozijnen', slot: 'alle' }, standaardAan: true },
      { key: 'buitendeuren', label: 'Buitendeuren', type: 'tekst', standaardAan: true },
      { key: 'hangEnSluitwerk', label: 'Hang- en sluitwerk', type: 'tekst', standaardAan: true },
      { key: 'buitenschilderwerk', label: 'Buitenschilderwerk', type: 'tekst', standaardAan: true },
      // Was tekst-type (vrije omschrijving) — 18-09-2026 omgezet naar dezelfde gedeelde
      // glastypes-koppeling als Energetisch en "Kenmerken verdieping" (Arno's verzoek: nog een
      // gemiste dubbeling wegwerken, "als het maar geen zooitje wordt"). Bestaande vrije tekst wordt
      // bij het laden eenmalig overgezet naar Overige/overigeTekst, zie migreerGlasWoonlaagVelden().
      { key: 'glas1eWoonlaag', label: 'Glas 1e woonlaag', type: 'materiaal', opties: ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas', 'Vacuümglas', 'Glas-in-lood', 'Voorzetramen', 'Overige'], macroSleutel: 'glastypes', kenmerkenKoppeling: { macroSleutel: 'glastypes', slot: '1e' }, standaardAan: true },
      { key: 'glas2eWoonlaag', label: 'Glas 2e woonlaag', type: 'materiaal', opties: ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas', 'Vacuümglas', 'Glas-in-lood', 'Voorzetramen', 'Overige'], macroSleutel: 'glastypes', kenmerkenKoppeling: { macroSleutel: 'glastypes', slot: '2e' } },
      { key: 'glas3eWoonlaag', label: 'Glas 3e woonlaag', type: 'materiaal', opties: ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas', 'Vacuümglas', 'Glas-in-lood', 'Voorzetramen', 'Overige'], macroSleutel: 'glastypes', kenmerkenKoppeling: { macroSleutel: 'glastypes', slot: '3e' } },
      { key: 'glasOverigeWoonlagen', label: 'Glas overige woonlagen', type: 'materiaal', opties: ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas', 'Vacuümglas', 'Glas-in-lood', 'Voorzetramen', 'Overige'], macroSleutel: 'glastypes', kenmerkenKoppeling: { macroSleutel: 'glastypes', slot: 'overige' } },
    ],
    bijgebouwen: [
      { key: 'schuurBerging', label: 'Schuur / berging', type: 'tekst' },
      { key: 'garage', label: 'Garage', type: 'tekst' },
      { key: 'overigeBijgebouwen', label: 'Overige bijgebouwen', type: 'tekst' },
    ],
    perceel: [
      { key: 'tuinaanleg', label: 'Tuinaanleg', type: 'tekst' },
      { key: 'nietStandaardBuitenVoorzieningen', label: 'Niet standaard buiten voorzieningen', type: 'tekst' },
    ],
    overigeWaarnemingen: [
      { key: 'overigeWaarnemingenBuitenzijde', label: 'Overige waarnemingen buitenzijde', type: 'simpel' },
      { key: 'overigeWaarnemingenBijgebouwenEnPerceel', label: 'Overige waarnemingen bijgebouwen en perceel', type: 'simpel' },
    ],
  },
  binnenzijde: {
    funderingen: [
      { key: 'fundering', label: 'Fundering', type: 'materiaal', opties: ['Fundering op staal', 'Fundering op houten palen', 'Fundering op vloerplaat', 'Strokenfundering', 'Fundering op betonnen palen', 'Overige'] },
      { key: 'kelder', label: 'Kelder', type: 'tekst' },
      { key: 'kruipruimte', label: 'Kruipruimte', type: 'tekst' },
    ],
    // macroSleutel: opties komen live uit state.macros.vloersoort (Arno's verzoek 16-09-2026: "1
    // lijst voor Indeling én de relevante bouwkundige onderdelen") — zie renderBouwdeelKaart, dat
    // macroSleutel vóór def.opties gebruikt zodra 'ie aanwezig is.
    vloeren: [
      { key: 'woonlaag1', label: 'Woonlaag 1', type: 'materiaal', opties: ['Beton', 'Hout', 'Kwaaitaal', 'Manta', 'Overige'], macroSleutel: 'vloersoort', kenmerkenKoppeling: { macroSleutel: 'vloersoort', slot: '1e' } },
      { key: 'woonlaag2', label: 'Woonlaag 2', type: 'materiaal', opties: ['Beton', 'Hout', 'Kwaaitaal', 'Manta', 'Overige'], macroSleutel: 'vloersoort', kenmerkenKoppeling: { macroSleutel: 'vloersoort', slot: '2e' } },
      { key: 'woonlaag3', label: 'Woonlaag 3', type: 'materiaal', opties: ['Beton', 'Hout', 'Kwaaitaal', 'Manta', 'Overige'], macroSleutel: 'vloersoort', kenmerkenKoppeling: { macroSleutel: 'vloersoort', slot: '3e' } },
      { key: 'woonlaagOverige', label: 'Woonlaag overige', type: 'materiaal', opties: ['Beton', 'Hout', 'Kwaaitaal', 'Manta', 'Overige'], macroSleutel: 'vloersoort', kenmerkenKoppeling: { macroSleutel: 'vloersoort', slot: 'overige' } },
    ],
    wanden: [
      { key: 'wandenEnBinnenmuren', label: 'Wanden en binnenmuren', type: 'tekst', standaardAan: true },
      // 19-09-2026: gevonden bij het vergelijken met Taxatieweb — stond daar al als los bouwdeel
      // onder J.4 > Binnenzijde > Wanden, maar ontbrak hier nog volledig.
      { key: 'binnendeurenKozijnenBinnenwanden', label: 'Binnendeuren en overige kozijnen (in de binnenwanden)', type: 'tekst' },
    ],
    plafonds: [
      { key: 'plafonds', label: 'Plafonds', type: 'tekst', standaardAan: true },
    ],
    inrichting: [
      { key: 'trappen', label: 'Trappen', type: 'tekst' },
      { key: 'binnenschilderwerk', label: 'Binnenschilderwerk', type: 'tekst', standaardAan: true },
      { key: 'keuken', label: "Keuken (+eventuele inbouwapparatuur)", type: 'materiaal', opties: ['Magnetron', 'Combi-Magnetron', 'Oven', 'Stoomoven', 'Afzuigkap', 'Koelkast', 'Vriezer', '4-pits gasstel', '5-pits gasstel', 'Electrische kookplaat', 'Keramische kookplaat', 'Inductie kookplaat', 'Combi-kookplaat', 'Kokendwaterkraan', 'Koffiezetapparaat', 'Close-in boiler', 'Vaatwasser', 'Overige'], standaardAan: true },
      { key: 'badkamer1', label: 'Badkamer 1', type: 'materiaal', opties: ['Ligbad', 'Jacuzzi whirlpool', 'Douchehoek', 'Douchecabine', 'Inloopdouche', 'Stoomdouche', 'Wastafel', 'Dubbele wastafel', 'Wastafel in meubel', 'Toilet', 'Bidet', 'Overige'], standaardAan: true },
      { key: 'badkamer2', label: 'Badkamer 2', type: 'materiaal', opties: ['Ligbad', 'Jacuzzi whirlpool', 'Douchehoek', 'Douchecabine', 'Inloopdouche', 'Stoomdouche', 'Wastafel', 'Dubbele wastafel', 'Wastafel in meubel', 'Toilet', 'Bidet', 'Overige'] },
      { key: 'badkamer3', label: 'Badkamer 3', type: 'materiaal', opties: ['Ligbad', 'Jacuzzi whirlpool', 'Douchehoek', 'Douchecabine', 'Inloopdouche', 'Stoomdouche', 'Wastafel', 'Dubbele wastafel', 'Wastafel in meubel', 'Toilet', 'Bidet', 'Overige'] },
      { key: 'toilet1', label: 'Toilet 1', type: 'tekst', standaardAan: true },
      { key: 'toilet2', label: 'Toilet 2', type: 'tekst' },
      { key: 'toilet3', label: 'Toilet 3', type: 'tekst' },
    ],
    overigeWaarnemingen: [
      { key: 'overigeWaarnemingenBinnenzijde', label: 'Overige waarnemingen binnenzijde', type: 'simpel' },
    ],
  },
  installaties: {
    leidingen: [
      { key: 'gas', label: 'Gas', type: 'tekst', standaardAan: true },
      { key: 'water', label: 'Water', type: 'tekst', standaardAan: true },
      { key: 'riolering', label: 'Riolering', type: 'tekst', standaardAan: true, standaardConditie: 0 },
    ],
    verwarming: [
      // installatieKoppeling (19-09-2026, zelfde principe als Warmwatertoestel/Ventilatie/Koeling
      // hieronder): stond hier al sinds het begin los van Energetisch's eigen Verwarmingstoestel met
      // vrijwel dezelfde keuzelijst — nu 1 gedeelde selectie via data.installatieKenmerken.
      { key: 'verwarmingstoestel', label: 'Verwarmingstoestel', type: 'materiaal', opties: ['Airconditioning', 'Blokverwarming', 'Centrale verwarming', 'CV-ketel', 'Gaskachels', 'Hybride warmtepomp', 'Lucht/lucht warmtepomp', 'Micro WKK(HRe-ketel)', 'Open haard/houtkachel', 'Stadsverwarming', 'Biomassaketel', 'Bodem/water warmtepomp', 'Collectieve warmtepomp', 'Elektrische verwarming', 'HR combi ketel', 'Infrarood', 'Lucht/water warmtepomp', 'Moederhaard', 'Pelletkachel', 'Water/water warmtepomp(WKO)', 'Overige'], installatieKoppeling: { sleutel: 'verwarmingstoestel' }, details: [{ key: 'bouwjaar', label: 'Bouwjaar', type: 'jaar' }, { key: 'eigendom', label: 'Eigendom', type: 'select', opties: ['Anders', 'Eigendom', 'Huur', 'Lease'] }], standaardAan: true, verplichteFoto: true, fotoCategorie: 'C.V.-ketel' },
      // hint (18-09-2026, Arno n.a.v. de taXapi-vergelijking): dit veld gaat over de AFGIFTE op
      // deze woonlaag — staat de bron (CV-ketel/warmtepomp) fysiek elders, dan hoort die bij
      // "Verwarmingstoestel" (huisbreed) en niet hier nogmaals ingevuld te worden.
      { key: 'verwarmingssysteem1eWoonlaag', label: 'Verwarmingssysteem 1e woonlaag', type: 'materiaal', opties: ['Radiatoren', 'Convectoren', 'Elektrische vloerverwarming', 'Infraroodpanelen', 'Vloerverwarming', 'Wandverwarming', 'Overige'], macroSleutel: 'verwarmingssysteem', kenmerkenKoppeling: { macroSleutel: 'verwarmingssysteem', slot: '1e' }, hint: 'Gaat over de afgifte op déze woonlaag (radiatoren, vloerverwarming). Staat de CV-ketel/warmtepomp zelf fysiek op een andere verdieping? Die vul je in bij "Verwarmingstoestel" (huisbreed), niet hier.' },
      { key: 'verwarmingssysteem2eEnVolgendeWoonlaag', label: 'Verwarmingssysteem 2e en volgende woonlaag', type: 'materiaal', opties: ['Radiatoren', 'Convectoren', 'Elektrische vloerverwarming', 'Infraroodpanelen', 'Vloerverwarming', 'Wandverwarming', 'Overige'], macroSleutel: 'verwarmingssysteem', kenmerkenKoppeling: { macroSleutel: 'verwarmingssysteem', slot: '2eEnVolgende' }, hint: 'Gaat over de afgifte op déze verdieping(en). Staat de CV-ketel/warmtepomp zelf fysiek op een andere verdieping? Die vul je in bij "Verwarmingstoestel" (huisbreed), niet hier.' },
    ],
    warmwater: [
      // installatieKoppeling (17-09-2026, Arno "A. prima"): zelfde gedeelde selectie als Energetisch >
      // Warmwatertoestel — zie installatieGeselecteerd/-Wissel en state.installatieKenmerken.
      { key: 'warmwatertoestel', label: 'Warmwatertoestel', type: 'materiaal', opties: ['Geiser', 'Boiler', 'Geïntegreerd in cv', 'Doorstroom (stadsverwarming)', 'Kokendwaterkraan', 'Zonneboiler', 'Overige'], macroSleutel: 'warmwatertoestel', installatieKoppeling: { sleutel: 'warmwatertoestel' }, details: [{ key: 'bouwjaar', label: 'Bouwjaar', type: 'jaar' }, { key: 'eigendom', label: 'Eigendom', type: 'select', opties: ['Anders', 'Eigendom', 'Huur', 'Lease'] }], standaardAan: true },
    ],
    ventilatieKoeling: [
      { key: 'ventilatie', label: 'Ventilatie', type: 'materiaal', opties: ['Natuurlijk', 'Mechanisch', 'Gebalanceerd', 'Decentraal mechanisch', 'Vraaggestuurd', 'Overige'], macroSleutel: 'ventilatie', installatieKoppeling: { sleutel: 'ventilatie' }, standaardAan: true },
      { key: 'koeling', label: 'Koeling', type: 'materiaal', opties: ['Airconditioning', 'Radiatoren', 'Vloerverwarming', 'Ventilatie', 'Overige'], macroSleutel: 'koeling', installatieKoppeling: { sleutel: 'koeling' } },
    ],
    elektrotechnisch: [
      { key: 'meterkast', label: 'Meterkast', type: 'tekst', details: [{ key: 'aantalGroepen', label: 'Aantal groepen', type: 'getal' }, { key: 'aantalAardlekschakelaars', label: 'Aantal aardlekschakelaars', type: 'getal' }, { key: 'krachtstroomAanwezig', label: 'Krachtstroom aanwezig', type: 'ja_nee' }, { key: 'oplaadpuntAanwezig', label: 'Oplaadpunt aanwezig', type: 'ja_nee' }], standaardAan: true, verplichteFoto: true, fotoCategorie: 'Meterkast' },
      { key: 'ictDomotica', label: 'ICT / Domotica', type: 'tekst' },
      { key: 'brandveiligheid', label: 'Brandveiligheid', type: 'tekst' },
      { key: 'brandmeldinstallatie', label: 'Brandmeldinstallatie', type: 'tekst' },
    ],
    overigeWaarnemingen: [
      { key: 'overigeWaarnemingenInstallaties', label: 'Overige waarnemingen installaties', type: 'simpel' },
    ],
  },
  // Geen sub-tabbladen (Taxatieweb toont deze drie los onder één hoofdstuk).
  overigeBijzonderheden: [
    { key: 'houtaantasters', label: 'Houtaantasters (zwam / schimmel / overige)', type: 'risico' },
    { key: 'vochtproblemen', label: 'Vochtproblemen (lekkage, condensatie)', type: 'risico' },
    { key: 'nietEerderGenoemd', label: 'Niet eerder genoemde bijzonderheden', type: 'risico' },
  ],
};
const BOUWKUNDIG_SUBTABS = {
  buitenzijde: [
    { id: 'daken', label: 'Daken' },
    { id: 'gevel', label: 'Gevel' },
    { id: 'bijgebouwen', label: 'Bijgebouwen' },
    { id: 'perceel', label: 'Perceel/tuin' },
    { id: 'overigeWaarnemingen', label: 'Overige waarnemingen' },
  ],
  binnenzijde: [
    { id: 'funderingen', label: 'Funderingen' },
    { id: 'vloeren', label: 'Vloeren' },
    { id: 'wanden', label: 'Wanden' },
    { id: 'plafonds', label: 'Plafonds' },
    { id: 'inrichting', label: 'Inrichting' },
    { id: 'overigeWaarnemingen', label: 'Overige waarnemingen' },
  ],
  installaties: [
    { id: 'leidingen', label: 'Leidingen' },
    { id: 'verwarming', label: 'Verwarming' },
    { id: 'warmwater', label: 'Warmwater' },
    { id: 'ventilatieKoeling', label: 'Ventilatie/Koeling' },
    { id: 'elektrotechnisch', label: 'Electrotechnisch' },
    { id: 'overigeWaarnemingen', label: 'Overige waarnemingen' },
  ],
};

// Fase 3 "volledige opname" (12-09-2026): Energetische opnamestaat, 1-op-1 Taxatieweb's I.4 (live
// nagekeken — LET OP: op een rapport met al ECHTE, ingevulde data, dus bewust alleen gelezen/
// gescrold, nooit geklikt om een leeg bouwdeel te "testen" zoals bij J.4). Andere veldvorm dan
// Bouwkundig (geen conditie/aandachtspunten): Isolatie/Installaties-velden hebben een "Gedeeltelijk"
// Ja/Nee + "Installatiemoment" (Bouwjaar/Installatiejaar/Onbekend) + vrije Opmerkingen. Type 'dak'
// heeft een EXTRA laag: "aanwezig" (het dak bestaat) staat los van "geïsoleerd" (Ja/Nee/nog niets
// gekozen) — de rest (Gedeeltelijk/Installatiemoment/Opmerkingen) toont Taxatieweb alleen als
// geïsoleerd op Ja staat. Type 'materiaalTijd' is het bekende materiaal-multiselect (+ "Overige" met
// tekstveld, zelfde patroon als Bouwkundig) maar met Installatiemoment i.p.v. Bouwjaar/Eigendom.
// Type 'simpel' = alleen aanwezig + Opmerkingen (geen Installatiemoment) — gebruikt voor de losse
// items waarvan de Taxatieweb-velden niet live geverifieerd konden worden zonder een leeg bouwdeel
// aan te klikken op dit ingevulde testrapport; als dat vermoeden niet klopt, breidt een latere
// sessie dit bouwdeel uit zodra er een leeg rapport voorhanden is.
const INSTALLATIEMOMENT_OPTIES = ['Bouwjaar', 'Installatiejaar', 'Onbekend'];
const ENERGETISCH_ORIENTATIE_OPTIES = ['Noord', 'Noordwest', 'West', 'Zuidwest', 'Zuid', 'Zuidoost', 'Oost', 'Noordoost', 'Horizontaal'];
const ENERGETISCH_EIGENDOM_OPTIES = ['Eigendom', 'Lease', 'Huur', 'Anders'];
const ENERGETISCH_BRON_OPTIES = ['Visuele waarneming taxateur', 'Verkopende makelaar', 'Huurder/gebruiker', 'Eigenaar', 'Aankopende makelaar', 'Anderen'];
const ENERGETISCH_BOUWTYPE_OPTIES = ['Houtbouw', 'Staalbouw', 'Metselwerk', 'Systeembouw', 'Overige bouwtype', 'Houtskeletbouw', 'Betonnen wanden en vloeren', 'Traditioneel gebouwd', 'Prefab bouw'];
// J.4 Algemeen (Bouwkundig) — live nagekeken bij Taxatieweb (19-09-2026): "Maak minimaal één keuze",
// dus een multiselect en geen keuzelijst (een dag kan bv. droog beginnen en gaan regenen).
const WEEROMSTANDIGHEDEN_OPTIES = ['Droog', 'Regen', 'Sneeuw'];
const GLAS_OPTIES = ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas', 'Vacuümglas', 'Overige'];
const ENERGETISCH_METEN_TYPE_OPTIES = ['Aantal Wattpiek', 'Aantal panelen'];
// Live geverifieerd bij Taxatieweb's eigen C. Object → Woningtype (13-09-2026).
const WONINGTYPE_OPTIES = [
  '2-onder-1-kapwoning', 'Benedenwoning', 'Bovenwoning', 'Corridorflat', 'Eindwoning', 'Galerijflat',
  'Geschakelde 2-onder-1-kapwoning', 'Geschakelde woning', 'Half vrijstaande woning', 'Hoekwoning',
  'Ligplaats', 'Maisonnette', 'Portiekflat', 'Portiekwoning', 'Tussenwoning', 'Vrijstaande woning',
  'Waterwoning', 'Woon-/winkelpand', 'Woonboot', 'Woonwagen/stacaravan',
  'Woonwagenstandplaats/Stacaravanstandplaats',
];
// Arno (13-09-2026): "Selecteer tuin automatisch als het geen appartement betreft" — deze
// woningtypes hebben geen eigen tuin (appartement-achtig, gestapeld); de rest krijgt Tuin aanwezig
// standaard op "Ja" (zie de auto-invul in renderObjectkenmerkenTab()) — altijd handmatig te
// corrigeren via de eigen toggle, dit is alleen een startwaarde.
const APPARTEMENTACHTIGE_WONINGTYPES = ['Benedenwoning', 'Bovenwoning', 'Corridorflat', 'Galerijflat', 'Maisonnette', 'Portiekflat', 'Portiekwoning'];
// Keuzelijst bouwjaren, aflopend vanaf het huidige jaar (Arno's verzoek 13-09-2026: "keuzelijst met
// bouwjaren teruglopend vanaf het huidige bouwjaar" i.p.v. een vrij getalveld) — 1850 als praktische
// ondergrens, ruim voor vrijwel elke Nederlandse woning.
const JAREN_OPTIES = (() => {
  const huidig = new Date().getFullYear();
  const lijst = [];
  for (let j = huidig; j >= 1850; j--) lijst.push(String(j));
  return lijst;
})();
function renderJaarSelect(waarde, onChange, klasse) {
  return el('select', {
    class: klasse || 'energetisch-select',
    onchange: (e) => { onChange(e.target.value); },
  },
    el('option', { value: '' }, 'Selecteer'),
    ...JAREN_OPTIES.map(j => el('option', { value: j, selected: String(waarde) === j ? 'selected' : null }, j)));
}
// Alle jaartallen die AL ELDERS in deze taxatie zijn ingevuld (19-09-2026, Arno's verzoek n.a.v.
// Provadie: "jaartallen hergebruiken op andere plekken, makkelijk klikken") — Bouwjaar
// (Objectkenmerken), elk Bouwkundig-bouwdeel met een 'jaar'-detail (Verwarmings-/Warmwatertoestel),
// en elk Energetisch-veld z'n Installatiejaar + "Meerdere jaartallen". Meest recent eerst.
function alleGebruikteJaartallen() {
  const t = state.taxatie;
  const jaren = new Set();
  const voegToe = (w) => { const s = String(w || '').trim(); if (s) jaren.add(s); };
  voegToe(t.bewoning.bouwjaar);
  ['buitenzijde', 'binnenzijde', 'installaties'].forEach((hoofdId) => {
    Object.entries(BOUWKUNDIG_SCHEMA[hoofdId] || {}).forEach(([sectieId, defs]) => {
      defs.forEach((def) => {
        if (!def.details) return;
        const bouwdeel = t.bouwkundig[hoofdId] && t.bouwkundig[hoofdId][sectieId] && t.bouwkundig[hoofdId][sectieId][def.key];
        if (!bouwdeel || !bouwdeel.details) return;
        def.details.forEach((d) => { if (d.type === 'jaar') voegToe(bouwdeel.details[d.key]); });
      });
    });
  });
  const scanEnergetischGroep = (obj) => {
    Object.values(obj || {}).forEach((veld) => {
      if (!veld || typeof veld !== 'object') return;
      voegToe(veld.jaar);
      (veld.meerdereJaren || []).forEach(voegToe);
    });
  };
  ['isolatie', 'installaties'].forEach((hoofd) => {
    Object.values(t.energetisch[hoofd] || {}).forEach((sectie) => scanEnergetischGroep(sectie));
  });
  scanEnergetischGroep(t.energetisch.energieopwekking);
  return [...jaren].sort((a, b) => b.localeCompare(a));
}
// Wikkelt renderJaarSelect met snelkeuze-chips voor jaartallen die al elders gekozen zijn — 1 tik
// i.p.v. door tientallen jaren scrollen als hetzelfde jaartal (bv. een verbouwing) meerdere
// onderdelen tegelijk trof. De gewone keuzelijst blijft altijd beschikbaar voor een nieuw jaartal.
// Zelfde aanroepvorm als renderJaarSelect, dus overal 1-op-1 inwisselbaar — LET OP (bug 19-09-2026):
// de meegegeven onChange moet altijd zelf ook render() aanroepen, niet alleen planOpslaan(). Zonder
// render() blijft deze chip-rij na een gewone keuzelijst-selectie de OUDE waarde uitsluiten i.p.v.
// de nieuwe — een chip ernaast klikken zette het jaartal dan stilletjes terug naar de oude waarde.
function renderJaarKeuze(waarde, onChange, klasse) {
  const wrap = el('div', { class: 'jaar-keuze' });
  // Keuzelijst BOVEN de snelkeuze-chips (19-09-2026, tweede ronde: "keuzes jaren boven chips
  // plaatsen") — zelfde "keuze eerst, labels/chips eronder"-volgorde als elders in deze tab.
  wrap.appendChild(renderJaarSelect(waarde, onChange, klasse));
  const gebruikt = alleGebruikteJaartallen().filter((j) => j !== String(waarde || ''));
  if (gebruikt.length) {
    const chipRij = el('div', { class: 'chip-rij jaar-snelkeuze-rij' });
    gebruikt.forEach((jaar) => {
      chipRij.appendChild(el('button', {
        type: 'button', class: 'chip-knop',
        onclick: () => { onChange(jaar); planOpslaan(); render(); },
      }, jaar));
    });
    wrap.appendChild(chipRij);
  }
  return wrap;
}
const ENERGETISCH_SCHEMA = {
  isolatie: {
    gevel: [
      { key: 'gevelisolatie', label: 'Gevelisolatie', type: 'isolatie' },
      { key: 'gevelpanelen', label: 'Gevelpanelen', type: 'isolatie' },
    ],
    daken: [
      { key: 'hellendDak', label: 'Hellend dak aanwezig', type: 'dak' },
      { key: 'platDak', label: 'Plat dak aanwezig', type: 'dak' },
    ],
    vloer: [
      { key: 'vloerisolatie1e', label: 'Vloerisolatie 1e woonlaag', type: 'isolatie' },
      { key: 'vloerisolatie2e', label: 'Vloerisolatie 2e woonlaag', type: 'isolatie' },
      { key: 'vloerisolatie3e', label: 'Vloerisolatie 3e woonlaag', type: 'isolatie' },
      { key: 'vloerisolatieOverige', label: 'Vloerisolatie overige woonlagen', type: 'isolatie' },
      { key: 'kruipruimteisolatie', label: 'Kruipruimteisolatie', type: 'isolatie' },
    ],
    // macroSleutel 'glastypes': opties komen live uit state.macros.glastypes (Arno's verzoek
    // 16-09-2026), GLAS_OPTIES blijft alleen nog de fallback vóórdat de macro's geladen zijn.
    ramen: [
      { key: 'glas1e', label: 'Glas 1e woonlaag', type: 'materiaalTijd', opties: GLAS_OPTIES, macroSleutel: 'glastypes', kenmerkenKoppeling: { macroSleutel: 'glastypes', slot: '1e' } },
      { key: 'glas2e', label: 'Glas 2e woonlaag', type: 'materiaalTijd', opties: GLAS_OPTIES, macroSleutel: 'glastypes', kenmerkenKoppeling: { macroSleutel: 'glastypes', slot: '2e' } },
      { key: 'glas3e', label: 'Glas 3e woonlaag', type: 'materiaalTijd', opties: GLAS_OPTIES, macroSleutel: 'glastypes', kenmerkenKoppeling: { macroSleutel: 'glastypes', slot: '3e' } },
      { key: 'glasOverige', label: 'Glas overige woonlagen', type: 'materiaalTijd', opties: GLAS_OPTIES, macroSleutel: 'glastypes', kenmerkenKoppeling: { macroSleutel: 'glastypes', slot: 'overige' } },
    ],
    overige: [
      { key: 'leidingisolatie', label: 'Leidingisolatie', type: 'isolatie' },
      { key: 'energiezuinigeKozijnen', label: 'Energiezuinige kozijnen, deuren en daarmee gelijk te stellen constructieonderdelen in combinatie met hoog rendement beglazing (tenminste HR++)', type: 'simpel' },
    ],
  },
  installaties: {
    verwarming: [
      { key: 'verwarmingstoestel', label: 'Verwarmingstoestel', type: 'materiaalTijd', opties: ['Airconditioning', 'Biomassaketel', 'Blokverwarming', 'Bodem/water warmtepomp', 'Centrale verwarming', 'Collectieve warmtepomp', 'CV-ketel', 'Elektrische verwarming', 'Gaskachels', 'HR combi ketel', 'Hybride warmtepomp', 'Infrarood', 'Lucht/lucht warmtepomp', 'Lucht/water warmtepomp', 'Micro WKK(HRe-ketel)', 'Moederhaard', 'Open haard/houtkachel', 'Pelletkachel', 'Stadsverwarming', 'Water/water warmtepomp(WKO)', 'Overige'], installatieKoppeling: { sleutel: 'verwarmingstoestel' } },
      { key: 'verwarmingssysteem1e', label: 'Verwarmingssysteem 1e woonlaag', type: 'materiaalTijd', opties: ['Radiatoren', 'Convectoren', 'Vloerverwarming', 'Elektrische vloerverwarming', 'Wandverwarming', 'Infraroodpanelen', 'Overige'], macroSleutel: 'verwarmingssysteem', kenmerkenKoppeling: { macroSleutel: 'verwarmingssysteem', slot: '1e' }, hint: 'Gaat over de afgifte op déze woonlaag. Staat het verwarmingstoestel zelf fysiek op een andere verdieping? Die vul je in bij "Verwarmingstoestel" (huisbreed), niet hier.' },
      { key: 'verwarmingssysteem2e', label: 'Verwarmingssysteem 2e en volgende woonlaag', type: 'materiaalTijd', opties: ['Radiatoren', 'Convectoren', 'Vloerverwarming', 'Elektrische vloerverwarming', 'Wandverwarming', 'Infraroodpanelen', 'Overige'], macroSleutel: 'verwarmingssysteem', kenmerkenKoppeling: { macroSleutel: 'verwarmingssysteem', slot: '2eEnVolgende' }, hint: 'Gaat over de afgifte op déze verdieping(en). Staat het verwarmingstoestel zelf fysiek op een andere verdieping? Die vul je in bij "Verwarmingstoestel" (huisbreed), niet hier.' },
    ],
    warmWater: [
      { key: 'warmwatertoestel', label: 'Warmwater toestel', type: 'materiaalTijd', opties: ['Geiser', 'Boiler', 'Geïntegreerd in cv', 'Doorstroom (stadsverwarming)', 'Zonneboiler', 'Kokend waterkraan', 'Overige'], macroSleutel: 'warmwatertoestel', installatieKoppeling: { sleutel: 'warmwatertoestel' } },
      { key: 'doucheWtw', label: 'Douche-warmteterugwinningssysteem', type: 'simpel' },
      { key: 'zonneboilerInstallatie', label: 'Zonneboiler', type: 'simpel' },
    ],
    ventilatieKoeling: [
      { key: 'ventilatie', label: 'Ventilatie', type: 'materiaalTijd', opties: ['Natuurlijk', 'Mechanisch', 'Gebalanceerd', 'Decentraal mechanisch', 'Vraaggestuurd', 'Overige'], macroSleutel: 'ventilatie', installatieKoppeling: { sleutel: 'ventilatie' } },
      { key: 'koeling', label: 'Koeling', type: 'materiaalTijd', opties: ['Airconditioning', 'Vloerverwarming', 'Radiatoren', 'Ventilatie', 'Overige'], macroSleutel: 'koeling', installatieKoppeling: { sleutel: 'koeling' } },
    ],
  },
  energieopwekking: [
    { key: 'zonnepanelen', label: 'Zonnepanelen', type: 'zonnepanelen' },
    { key: 'wind', label: 'Wind', type: 'simpel' },
    { key: 'overigeEnergieopwekking', label: 'Overige energieopwekking', type: 'simpel' },
  ],
};
const ENERGETISCH_SUBTABS = {
  isolatie: [
    { id: 'gevel', label: 'Gevel' }, { id: 'daken', label: 'Daken' }, { id: 'vloer', label: 'Vloer' },
    { id: 'ramen', label: 'Ramen' }, { id: 'overige', label: 'Overige' },
  ],
  installaties: [
    { id: 'verwarming', label: 'Verwarming' }, { id: 'warmWater', label: 'Warm water' },
    { id: 'ventilatieKoeling', label: 'Ventilatie/Koeling' },
  ],
};
const ENERGETISCH_HOOFDTABS = [
  ['algemeen', 'Algemeen'], ['isolatie', 'Isolatie'], ['installaties', 'Installaties'], ['energieopwekking', 'Energieopwekking'],
];

// meerdereJaren (18-09-2026, Arno's verzoek: "soms meerdere installatiejaren, bv isolatie in fases
// aangebracht") — los, optioneel jaartal-lijstje naast het hoofd-Installatiejaar, zie
// renderMeerdereJarenVeld()/renderInstallatiemomentEnOpmerkingen().
function leegIsolatieVeld() { return { aanwezig: false, gedeeltelijk: null, installatiemoment: '', jaar: '', meerdereJaren: [], opmerkingen: '' }; }
function leegDakVeld() { return { aanwezig: false, geisoleerd: null, gedeeltelijk: null, installatiemoment: '', jaar: '', meerdereJaren: [], opmerkingen: '' }; }
function leegMateriaalTijdVeld() { return { aanwezig: false, materialen: [], overigeTekst: '', installatiemoment: '', jaar: '', meerdereJaren: [], opmerkingen: '' }; }
function leegEnergetischSimpelVeld() { return { aanwezig: false, opmerkingen: '' }; }
// orientaties is een lijst (Taxatieweb toont dit als checkbox-multiselect, geen keuzelijst — live
// geverifieerd 13-09-2026: een dak/installatie kan op meerdere windrichtingen tegelijk liggen).
function leegZonnepanelenVeld() { return { aanwezig: false, metenType: '', aantal: '', orientaties: [], eigendom: '', installatiemoment: '', jaar: '', meerdereJaren: [], opmerkingen: '' }; }
function maakLeegEnergetischVeld(def) {
  if (def.type === 'isolatie') return leegIsolatieVeld();
  if (def.type === 'dak') return leegDakVeld();
  if (def.type === 'materiaalTijd') return leegMateriaalTijdVeld();
  if (def.type === 'zonnepanelen') return leegZonnepanelenVeld();
  return leegEnergetischSimpelVeld();
}
function maakEnergetischGroep(velden) {
  const groep = {};
  velden.forEach(d => { groep[d.key] = maakLeegEnergetischVeld(d); });
  return groep;
}
function leegEnergetisch() {
  return {
    // aantalBouwlagen/weeromstandigheden/woningMetVve (19-09-2026, gevonden bij het vergelijken met
    // Taxatieweb): stonden daar al langer in J.4 > Algemeen (Bouwkundig) — Bouwtype/Hoofddraag-
    // constructie stond zelfs op TWEE plekken (I.4 én J.4, allebei "Algemeen"). Bewust hier bij
    // energetisch.algemeen gehouden i.p.v. een nieuwe aparte plek, want dat blok bestond al en wordt
    // nu het ene gedeelde "Algemeen" voor de samengevoegde Bouwkundig & Energetisch-tab.
    algemeen: { bron: [], bouwtype: [], aantalBouwlagen: '', weeromstandigheden: [], woningMetVve: null },
    isolatie: {
      gevel: maakEnergetischGroep(ENERGETISCH_SCHEMA.isolatie.gevel),
      daken: maakEnergetischGroep(ENERGETISCH_SCHEMA.isolatie.daken),
      vloer: maakEnergetischGroep(ENERGETISCH_SCHEMA.isolatie.vloer),
      ramen: maakEnergetischGroep(ENERGETISCH_SCHEMA.isolatie.ramen),
      overige: maakEnergetischGroep(ENERGETISCH_SCHEMA.isolatie.overige),
    },
    installaties: {
      verwarming: maakEnergetischGroep(ENERGETISCH_SCHEMA.installaties.verwarming),
      warmWater: maakEnergetischGroep(ENERGETISCH_SCHEMA.installaties.warmWater),
      ventilatieKoeling: maakEnergetischGroep(ENERGETISCH_SCHEMA.installaties.ventilatieKoeling),
    },
    energieopwekking: maakEnergetischGroep(ENERGETISCH_SCHEMA.energieopwekking),
  };
}
// Zelfde migratie-patroon als metVolledigBouwkundig() — vult alleen ONTBREKENDE velden aan, past
// nooit al ingevulde data met terugwerkende kracht aan.
function metVolledigEnergetisch(e) {
  const leeg = leegEnergetisch();
  if (!e || typeof e !== 'object') return leeg;
  if (!e.algemeen) e.algemeen = leeg.algemeen;
  if (!Array.isArray(e.algemeen.bron)) e.algemeen.bron = [];
  if (!Array.isArray(e.algemeen.bouwtype)) e.algemeen.bouwtype = [];
  if (e.algemeen.aantalBouwlagen === undefined) e.algemeen.aantalBouwlagen = '';
  if (!Array.isArray(e.algemeen.weeromstandigheden)) e.algemeen.weeromstandigheden = [];
  if (e.algemeen.woningMetVve === undefined) e.algemeen.woningMetVve = null;
  ['isolatie', 'installaties'].forEach(hoofd => {
    if (!e[hoofd]) e[hoofd] = {};
    Object.keys(ENERGETISCH_SCHEMA[hoofd]).forEach(sectie => {
      if (!e[hoofd][sectie]) e[hoofd][sectie] = {};
      ENERGETISCH_SCHEMA[hoofd][sectie].forEach(def => {
        if (!e[hoofd][sectie][def.key]) e[hoofd][sectie][def.key] = leeg[hoofd][sectie][def.key];
      });
    });
  });
  if (!e.energieopwekking) e.energieopwekking = {};
  ENERGETISCH_SCHEMA.energieopwekking.forEach(def => {
    if (!e.energieopwekking[def.key]) e.energieopwekking[def.key] = leeg.energieopwekking[def.key];
  });
  return e;
}

function naarGetal(w) {
  const n = parseFloat(String(w || '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}
function formatM2(n) {
  return (Math.round(n * 100) / 100).toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function woonlaagTotaal(woonlaag) {
  return (woonlaag.blokken || []).reduce((som, b) => {
    if (b.type === 'correctie') return som - naarGetal(b.lengte) * naarGetal(b.breedte);
    if (b.type === 'buitenruimte') return som;
    return som + naarGetal(b.lengte) * naarGetal(b.breedte);
  }, 0);
}

// ----------------------------------------------------------------------------------------------
// MACRO'S — Arno's eigen, over alle taxaties heen herbruikbare keuzelijsten. Bewust GLOBAAL (niet
// per taxatie) opgeslagen, zelfde opzet als taxatieweb-opname.user.js' standaardMacros(). Sinds
// v1.1: toevoegingen/sanitair/keuken zijn drie APARTE lijsten (was eerst één samengevoegde) — Arno:
// "keuken = keuze keukenapparatuur en lijst met andere zaken, badkamer/toilet = sanitair + 2e
// lijst" — dus TWEE losse velden bij die ruimtes i.p.v. samengevoegd, zie categorieVoorRuimte()
// hieronder.
function standaardMacros() {
  return {
    verdiepingen: [
      'Kelder', 'Souterrain', 'Begane grond', 'Eerste verdieping', 'Tweede verdieping',
      'Derde verdieping', 'Vierde verdieping', 'Zolderverdieping', 'Bergzolder', 'Vliering',
    ],
    ruimtes: [
      'Entree/hal', 'Toiletruimte', 'Woonkamer', 'Keuken', 'Overloop', 'Slaapkamer', 'Badkamer',
      'Achterkamer', 'Bergruimte', 'Berging', 'Bijkeuken', 'CV-ruimte', 'Eetkamer', 'Gang',
      'Garage', 'Hal', 'Hobbyruimte', 'Inloopkast', 'Kantoor', 'Kelderruimte', 'Serre',
      'Studeerkamer', 'Technische ruimte', 'Vide', 'Voorzolder', 'Werkkamer', 'Zolderkamer',
    ],
    ruimteblokken: [
      'Basis', 'Aanbouw', 'Erker', 'Bijkeuken', 'Zijbouw', 'Kelder', 'Garage', 'Berging', 'Carport',
      'Veranda', 'Dakkapel', 'Balkon', 'Dakterras',
    ],
    // Algemene toevoegingen — bij élke ruimte gesuggereerd (kasten, ketels, deuren, airco e.d.).
    toevoegingen: [
      'meterkast', 'vaste trap naar de eerste verdieping', 'vaste trap naar de zolderverdieping',
      'vlizotrap naar de zolderverdieping', 'losse trap naar de zolderverdieping',
      'HR combi-ketel', 'C.V.-ketel', 'boiler', 'airconditioning', 'trapkast', 'kelderkast',
      'bergkast', 'walk-in closet', 'inbouwkast', 'inloopkast', 'garderobe', 'garderobekast',
      'kastenwand', 'schuifkastenwand', 'vaste kast', 'gas haard', 'open haard', 'houtkachel',
      'bio ethanol haard', 'speksteenkachel', 'pelletkachel', 'sfeerhaard', 'elektrische haard',
      'allesbrander', 'rookkanaal', 'alarminstallatie', 'centraal stofzuigsysteem', 'convectorput',
      'wasmachine aansluiting', 'wasmachine- en drogeraansluiting', 'elektrisch zonnescherm',
      'zonnescherm', 'zonwering', 'elektrische garagedeur', 'bar', 'bedstee', 'ensuite deuren',
      'entresol', 'erker', 'frans balkon', 'horren', 'kamer-en-suite deuren', 'keukenblok',
      'knieschotten', 'bergruimte achter de knieschotten', 'markiezen', 'pantry', 'rolluik',
      'rolluiken', 'screens', 'sauna', 'schouw', 'serre', 'uitstortgootsteen', 'verlaagd plafond',
      'vide', 'videofoon', 'vloerverwarming', 'dakramen', 'taatsdeuren', 'tuindeur', 'tuindeuren',
      'bergruimte', 'bergvliering', 'bergzolder', 'inbouwspots', 'waterontharder',
    ],
    // Alleen bij badkamer/toiletruimte gesuggereerd (naast de algemene toevoegingen).
    sanitair: [
      'douche', 'douchecabine', 'inloopdouche', 'ligbad', 'douche/ligbad', 'hoekbad', 'whirlpool',
      'jacuzzi', 'staand toilet', 'hangend toilet', 'urinoir', 'fonteintje', 'wastafel',
      'dubbele wastafel', 'wastafelmeubel', 'dubbel wastafelmeubel', 'designradiator',
      'handdoekradiator',
    ],
    // Alleen bij de keuken gesuggereerd (naast de algemene toevoegingen).
    keuken: [
      'gas 4-pits kookplaat', 'gas 5-pits kookplaat', 'keramische kookplaat', 'inductiekookplaat',
      'oven', 'magnetron', 'combi-oven', 'combi-magnetron', 'stoomoven', 'koelkast', 'vriezer',
      'koel-vriescombinatie', 'afzuigkap', 'vaatwasser', 'quooker',
    ],
    // "Kenmerken verdieping" (Indeling, Arno's verzoek 16-09-2026) — dezelfde 5 keuzelijsten worden
    // ook gebruikt als opties bij de bijbehorende bouwkundige/energetische velden (zie
    // BOUWKUNDIG_SCHEMA vloeren/verwarmingssysteem en ENERGETISCH_SCHEMA glas/verwarmingssysteem,
    // via `macroSleutel` op die definities) — dus 1 plek om deze lijsten te beheren.
    // kozijnen: "Beton" toegevoegd (17-09-2026, macro-audit tegen Provadie/Spade 21 — Provadie had
    // dit als 6e materiaaloptie, wij misten 'm).
    vloersoort: ['Beton', 'Hout', 'Kwaaitaal', 'Manta', 'Overige'],
    kozijnen: ['Kunststof', 'Hardhout', 'Hout', 'Aluminium', 'Staal', 'Beton', 'Overige'],
    glastypes: ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas', 'Vacuümglas', 'Glas-in-lood', 'Voorzetramen', 'Overige'],
    verwarmingssysteem: ['Radiatoren', 'Vloerverwarming', 'Airconditioning', 'Convectorput', 'Infraroodpanelen', 'Elektrische radiator', 'Wandverwarming', 'Overige'],
    // installatieKenmerken (17-09-2026, Arno "A. prima") — zelfde idee, nu voor Ventilatie/Koeling/
    // Warmwatertoestel tussen Bouwkundig en Energetisch (samengevoegde optielijst van beide schema's).
    ventilatie: ['Natuurlijk', 'Mechanisch', 'Gebalanceerd', 'Decentraal mechanisch', 'Vraaggestuurd', 'Overige'],
    koeling: ['Airconditioning', 'Radiatoren', 'Vloerverwarming', 'Ventilatie', 'Overige'],
    warmwatertoestel: ['Geiser', 'Boiler', 'Geïntegreerd in cv', 'Doorstroom (stadsverwarming)', 'Kokendwaterkraan', 'Zonneboiler', 'Overige'],
    // Bijgebouwen (17-09-2026, Arno's verzoek: "oplossing voor bijgebouwen zoals Provadie") —
    // bijgebouwTypes 1-op-1 overgenomen uit Provadie's "Bij-/aanbouwen en buitenvoorzieningen"-lijst
    // bij Spade 21 (live nagekeken); Materiaal/Extra's zijn eigen, algemene startlijsten (Provadie's
    // materiaallijst was daar een leeg native <select>, niet uit te lezen zonder data te riskeren).
    bijgebouwTypes: [
      'Atelier', 'Bakhuis', 'Berging', 'Bijkeuken', 'Carport', 'Dierenverblijf', 'Dubbele carport',
      'Fietsenstalling', 'Garage', 'Gastenverblijf', 'Hobbykas', 'Hooiberg', 'Kantoor', 'Kapschuur',
      'Kippenhok', 'Loods', 'Luifel', 'Mantelzorgwoning', 'Multifunctionele buitenruimte',
      'Overkapping', 'Paardenbak', 'Paardenstal', 'Praktijkruimte', 'Schuur', 'Serre', 'Stal',
      'Tuinhuis', 'Werkplaats', 'Zomerhuis', 'Zwembad', 'Overige',
    ],
    bijgebouwMateriaal: ['Hout', 'Metselwerk/steen', 'Kunststof', 'Metaal/staal', 'Beton', 'Overige'],
    bijgebouwExtras: ['Elektra aanwezig', 'Verwarmd', 'Wateraansluiting', 'Verlichting', 'Overige'],
    // vloerafwerking: 17-09-2026 flink uitgebreid — 1-op-1 overgenomen uit Provadie's eigen
    // vloerafwerking-keuzelijst bij Spade 21 (live nagekeken, incl. Arno's eigen eerder toegevoegde
    // extra's als Belgisch hardsteen/Betonciré/Leisteenvloer), was met 8 opties veel te beperkt.
    vloerafwerking: [
      'Laminaat', 'Parket', 'Tapijt', 'Tegelvloer', 'PVC-vloer', 'Vinyl vloer', 'Linoleum vloer',
      'Marmoleum vloer', 'Novilon vloer', 'Zeil', 'Vloerbedekking', 'Gietvloer', 'Betonvloer',
      'Betonciré', 'Houten vloer', 'Eikenhouten vloer', 'Lamelparket', 'Keramisch parket', 'Kurkvloer',
      'Betegelde vloer', 'Plavuizen vloer', 'Terrazzo vloer', 'Granitovloer', 'Natuursteen',
      'Natuursteenvloer', 'Marmeren vloer', 'Hardstenen vloer', 'Belgisch hardsteen', 'Leisteenvloer',
      'Noorse leisteenvloer', 'Grindvloer', 'Siergrindvloer', 'Overige',
    ],
    // Tik-chips per vrije-tekst-bouwdeel in Bouwkundig (13-09-2026, Arno's verzoek: "ook op de
    // overige tekstvelden", en bewerkbaar als macro — zie BOUWDEEL_CHIP_GROEPEN/renderChipEditor
    // hieronder). Sleutel = def.key uit BOUWKUNDIG_SCHEMA. Bewust korte, algemene startlijsten —
    // Arno kan ze zelf aanvullen/herordenen/verwijderen via het ✎-knopje per bouwdeel.
    bouwdeelChips: {
      dakconstructie: ['Houten kap', 'Betonnen kap', 'Systeemkap', 'Doorzakking zichtbaar'],
      dakkapellen: ['Voorzijde', 'Achterzijde', 'Kunststof', 'Hout'],
      schoorstenen: ['In gebruik', 'Buiten gebruik', 'Rookkanaal geveegd'],
      goten: ['Zink', 'Kunststof', 'Verouderd'],
      loodwerk: ['Goed onderhouden', 'Verouderd', 'Lekkage zichtbaar'],
      balkon: ['Frans balkon', 'Vrijstaand balkon', 'Balkonhek verouderd'],
      kozijnen: ['Kunststof', 'Hout', 'Aluminium', 'Onderhoud nodig'],
      buitendeuren: ['Kunststof', 'Hout', 'Aluminium'],
      hangEnSluitwerk: ['Inbraakwerend hang- en sluitwerk', 'Verouderd'],
      buitenschilderwerk: ['Recent geschilderd', 'Onderhoud nodig', 'Verouderd'],
      glas1eWoonlaag: ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas'],
      glas2eWoonlaag: ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas'],
      glas3eWoonlaag: ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas'],
      glasOverigeWoonlagen: ['Enkel glas', 'Dubbel glas', 'HR++ glas', 'Drievoudig glas'],
      schuurBerging: ['Vrijstaande houten berging', 'Aangebouwde berging', 'Stenen berging', 'Fietsenberging', 'Tuinhuisje'],
      garage: ['Vrijstaande stenen garage', 'Aangebouwde garage', 'Elektrische garagedeur', 'Dubbele garage', 'Garage met kap'],
      overigeBijgebouwen: ['Aangebouwde overkapping', 'Vrijstaande overkapping', 'Carport', 'Buitenkeuken', 'Prieel', 'Aanbouw woonruimte', 'Atelier', 'Serre', 'Hobbykas', 'Dierenverblijf', 'Dakterras', 'Zwembad'],
      tuinaanleg: ['Voortuin', 'Achtertuin', 'Zijtuin', 'Verzorgd', 'Eenvoudig'],
      nietStandaardBuitenVoorzieningen: ['Achterom', 'Parkeerplaats op eigen terrein', 'Oprit', 'Schutting', 'Buitenkraan', 'Buitenverlichting'],
      overigeWaarnemingenBuitenzijde: ['Geen bijzonderheden', 'Scheurvorming zichtbaar', 'Vochtplekken zichtbaar'],
      overigeWaarnemingenBijgebouwenEnPerceel: ['Geen bijzonderheden', 'Scheurvorming zichtbaar', 'Vochtplekken zichtbaar'],
      kelder: ['Droog', 'Vochtig', 'In gebruik als bergruimte'],
      kruipruimte: ['Droog', 'Vochtig', 'Slecht bereikbaar'],
      // wandenEnBinnenmuren/plafonds: 17-09-2026 flink uitgebreid — 1-op-1 overgenomen uit Provadie's
      // eigen Muren-/Plafond-keuzelijsten bij Spade 21 (live nagekeken), waren met 3 chips te mager.
      wandenEnBinnenmuren: [
        'Gestucte wanden', 'Behangen wanden', 'Betegelde wanden', 'Geschilderde wanden',
        'Gesausde wanden', 'Gestucte en behangen wanden', 'Deels betegelde wanden',
        'Deels betegelde wanden en deels gestuct', 'Gipsplaten wanden', 'Betonnen wanden',
        'Schoon metselwerk', 'Sierpleister wanden', 'Spachtelputz wanden', 'Spackwerk wanden',
        'Spuitwerk wanden', 'Structuurverf wanden', 'Houten wanden', 'Lambrisering', 'Steenstrips',
        'Kunststof schroten wanden', 'Granol wanden', 'Glasvliesbehangen wanden',
        'Renovliesbehangen wanden', 'Onafgewerkte wanden',
      ],
      plafonds: [
        'Gestuct plafond', 'Spanplafond', 'Verlaagd plafond', 'Systeemplafond', 'Houten plafond',
        'Balkenplafond', 'Gipsplaten plafond', 'Betonnen plafond', 'Spuitwerk plafond',
        'Structuurverf plafond', 'Gespoten plafond', 'Gestuct plafond met ornamenten',
        'Aluminium plafond', 'Kunststof plafond', 'Kunststof schroten plafond', 'MDF plafond',
        'Schroten plafond', 'Zachtboard plafond', 'Onafgewerkt plafond',
      ],
      trappen: ['Vaste trap', 'Vaste trappen', 'Vlizotrap', 'Losse trap'],
      binnenschilderwerk: ['Recent geschilderd', 'Onderhoud nodig'],
      toilet1: ['Hangend toilet', 'Staand toilet', 'Fonteintje aanwezig'],
      toilet2: ['Hangend toilet', 'Staand toilet', 'Fonteintje aanwezig'],
      toilet3: ['Hangend toilet', 'Staand toilet', 'Fonteintje aanwezig'],
      overigeWaarnemingenBinnenzijde: ['Geen bijzonderheden', 'Scheurvorming zichtbaar', 'Vochtplekken zichtbaar'],
      gas: ['Aardgasaansluiting', 'Geen gasaansluiting'],
      water: ['Waterleidingbedrijf-aansluiting'],
      riolering: ['Gemeentelijk riool', 'IBA / septic tank'],
      meterkast: ['In hal', 'In meterkastnis', 'Verouderd'],
      ictDomotica: ['Glasvezel aanwezig', 'Domotica-systeem aanwezig'],
      brandveiligheid: ['Rookmelders aanwezig', 'Brandblusser aanwezig'],
      brandmeldinstallatie: ['Aanwezig', 'Niet aanwezig'],
      overigeWaarnemingenInstallaties: ['Geen bijzonderheden'],
      // Energetisch (I.4) — sinds Arno's verzoek 13-09-2026: "graag ook voor energetisch". Deze
      // velden heten in Taxatieweb "opmerkingen" i.p.v. "omschrijving", maar werken verder identiek.
      gevelisolatie: ['Nagelvouw geïsoleerd', 'Spouwmuurisolatie', 'Buitengevelisolatie'],
      gevelpanelen: ['Recent aangebracht', 'Verouderd'],
      hellendDak: ['Volledig geïsoleerd', 'Gedeeltelijk geïsoleerd', 'Onbekende dikte'],
      platDak: ['Volledig geïsoleerd', 'Gedeeltelijk geïsoleerd', 'Onbekende dikte'],
      vloerisolatie1e: ['Onder de vloer aangebracht', 'Onbekende dikte'],
      vloerisolatie2e: ['Onder de vloer aangebracht', 'Onbekende dikte'],
      vloerisolatie3e: ['Onder de vloer aangebracht', 'Onbekende dikte'],
      vloerisolatieOverige: ['Onder de vloer aangebracht', 'Onbekende dikte'],
      kruipruimteisolatie: ['Bodemisolatie', 'Vloerisolatie vanuit kruipruimte'],
      glas1e: ['Recent vervangen', 'Origineel enkel glas nog aanwezig'],
      glas2e: ['Recent vervangen', 'Origineel enkel glas nog aanwezig'],
      glas3e: ['Recent vervangen', 'Origineel enkel glas nog aanwezig'],
      glasOverige: ['Recent vervangen', 'Origineel enkel glas nog aanwezig'],
      leidingisolatie: ['CV-leidingen geïsoleerd', 'Gedeeltelijk geïsoleerd'],
      energiezuinigeKozijnen: ['Volledig aanwezig', 'Gedeeltelijk aanwezig'],
      verwarmingstoestel: ['Recent geplaatst', 'Einde levensduur'],
      verwarmingssysteem1e: ['Goed werkend', 'Onderhoud nodig'],
      verwarmingssysteem2e: ['Goed werkend', 'Onderhoud nodig'],
      warmwatertoestel: ['Recent geplaatst', 'Einde levensduur'],
      doucheWtw: ['Aanwezig bij douche begane grond', 'Aanwezig bij douche verdieping'],
      zonneboilerInstallatie: ['Op dak gemonteerd', 'Recent geplaatst'],
      ventilatie: ['Goed werkend', 'Onderhoud nodig'],
      koeling: ['Split-unit', 'Centraal systeem'],
      wind: ['Geen windenergie aanwezig'],
      overigeEnergieopwekking: ['Geen bijzonderheden'],
      // Omgeving (H.2) — sinds Arno's verzoek 17-09-2026: "Macro's overnemen van Provadie lijsten" /
      // "kijk naar de macro's van Provadie en Taxatieweb en neem die over". Inhoud 1-op-1 overgenomen
      // uit Taxatieweb's eigen "Toon macro's"-knop bij Spade 21 (live nagekeken 17-09-2026) — dit was
      // de enige plek in de app waar zulke chips nog ontbraken.
      omgevingLocatie: [
        'Gelegen in een rustige straat in een kindvriendelijke woonwijk en nabij vele voorzieningen.',
        'Gelegen in een rustige woonwijk op goede stand.',
        'Gelegen in een rustige woonwijk op goede stand in een straat met alleen bestemmingsverkeer.',
        'Gelegen in een rustige woonwijk aan de rand van de bebouwing.',
        'Gelegen in een rustige woonwijk nabij het centrum.',
        'Gelegen aan een doorgaande straat.',
        'Gelegen in het agrarisch buitengebied nabij de bebouwde kom, op goede stand gelegen.',
      ],
      omgevingGebouwenRondom: [
        'appartementen', 'rijen woningen', '2-onder-1-kapwoningen', 'vrijstaande woningen', 'winkels',
        'woonzorgcomplex', 'Agrarische bedrijven, vrijstaande woningen en woonboerderijen.',
        'geschakelde woningen', 'recreatiewoningen',
      ],
      omgevingBereikbaarheid: [
        'De woning is bereikbaar via bus, trein, N-weg, snelweg en uitvalswegen.',
        '- Goed bereikbare toegangswegen. - .. autominuten van de snelweg gelegen. - Op .. kilometer/meter (fiets)afstand van het centrum gelegen. - Voldoende parkeergelegenheid. - Nabijgelegen bushalte. - Nabijgelegen treinstation.',
        'Goed bereikbare toegangswegen, voldoende parkeergelegenheid, .. autominuten van de snelweg gelegen en op .. kilometer/meter fietsafstand van het centrum gelegen.',
      ],
      omgevingVoorzieningen: [
        'Dicht gelegen bij alle voorzieningen, zoals het centrum, winkelcentrum, gezondheidscentrum, scholen, winkels en uitvalswegen.',
        'In de nabijheid van het getaxeerde zijn veel voorzieningen te vinden, zoals supermarkten, winkels, scholen, diverse zorgfaciliteiten (o.a. huisarts) en (sport)verenigingen.',
      ],
    },
  };
}

// Bepaalt welke macro-lijst(en) een ruimte als toevoeging-suggesties krijgt, op basis van de
// ruimtenaam — Arno: "keuken = keukenapparatuur en lijst met andere zaken, badkamer/toilet =
// sanitair + 2e lijst" — dus TWEE losse velden i.p.v. één samengevoegde lijst, 1-op-1 hetzelfde idee
// als categorieVoorRuimte() in taxatieweb-opname.user.js. Substring-match op de naam (niet exact),
// zodat ook "Toiletruimte" of "Bijkeuken" meetellen.
function categorieVoorRuimte(ruimteNaam) {
  const naam = (ruimteNaam || '').toLowerCase();
  if (naam.includes('badkamer') || naam.includes('toilet')) return 'sanitair';
  if (naam.includes('keuken')) return 'keuken';
  return null;
}
// Voor de ingeklapte ruimte-status (17-09-2026) — zelfde lokaal+cloud-check als renderFotoKnopRij,
// los getrokken zodat de ingeklapte kop 'm ook kan gebruiken zonder de hele fotoknop-rij te tonen.
function heeftFotoVoorRuimte(ruimte) {
  if (fotosVoorLabel(ruimte.naam).length > 0) return true;
  return (state.cloudFotos || []).some((cf) => fotoLabelSleutel(cf.ruimteLabel || cf.categorie) === fotoLabelSleutel(ruimte.naam));
}
// Heeft deze ruimte al minstens 1 toevoeging die uit de keuken-/sanitair-macrolijst komt? — gebruikt
// om in de ingeklapte kop te tonen of "de apparatuur/het sanitair al ingevuld is" (Arno's verzoek
// 17-09-2026), zonder een aparte administratie bij te houden van welke chip uit welke lijst kwam.
function heeftCategorieToevoeging(ruimte, macroSleutel) {
  const lijst = (state.macros[macroSleutel] || []).map((x) => x.toLowerCase());
  return (ruimte.toevoegingen || []).some((t) => lijst.includes(String(t).toLowerCase()));
}

// Vult bewaarde macro's aan met sanitair/keuken als die nog ontbreken — data die vóór v1.1 al eens
// bewaard is (bewaarMacros() sloeg toen nog maar 4 lijsten op) zou anders zonder deze twee komen te
// zitten i.p.v. terug te vallen op de standaardlijst.
function metNieuweMacroCategorieen(m) {
  const standaard = standaardMacros();
  if (!Array.isArray(m.sanitair)) m.sanitair = standaard.sanitair;
  if (!Array.isArray(m.keuken)) m.keuken = standaard.keuken;
  ['vloersoort', 'kozijnen', 'glastypes', 'verwarmingssysteem', 'vloerafwerking', 'ventilatie', 'koeling', 'warmwatertoestel', 'bijgebouwTypes', 'bijgebouwMateriaal', 'bijgebouwExtras'].forEach((sleutel) => {
    if (!Array.isArray(m[sleutel])) m[sleutel] = standaard[sleutel];
  });
  // bouwdeelChips (13-09-2026): per-sleutel aanvullen i.p.v. de hele groep in één keer, zodat een
  // toekomstige NIEUWE bouwdeel-sleutel z'n startlijst alsnog krijgt zonder Arno's eigen eerder
  // bewerkte lijsten (bv. al aangepaste Trappen-chips) te overschrijven.
  if (!m.bouwdeelChips || typeof m.bouwdeelChips !== 'object') m.bouwdeelChips = {};
  Object.keys(standaard.bouwdeelChips).forEach((sleutel) => {
    if (!Array.isArray(m.bouwdeelChips[sleutel])) m.bouwdeelChips[sleutel] = standaard.bouwdeelChips[sleutel];
  });
  // Macro-audit tegen Provadie (17-09-2026, Arno's verzoek "C") — deze 4 lijsten waren AL langer
  // geleden aangemaakt (dus de "ontbreekt nog helemaal"-aanvulling hierboven raakt ze niet meer) en
  // bleken bij live vergelijking met Provadie/Spade 21 te mager. Eenmalig, idempotent en additief:
  // voegt alleen ONTBREKENDE items toe (case-insensitive), verwijdert nooit iets van Arno's eigen
  // lijst, en "Overige" blijft — als 'ie er al stond — achteraan staan. Draait bij elke laadMacros(),
  // maar is vanaf de 2e keer een no-op zodra alles is samengevoegd.
  const voegNieuweOptiesSamen = (huidig, nieuw) => {
    const heeftOverige = huidig.some((x) => x.toLowerCase() === 'overige');
    const zonderOverige = huidig.filter((x) => x.toLowerCase() !== 'overige');
    nieuw.forEach((optie) => {
      if (optie.toLowerCase() === 'overige') return;
      if (!zonderOverige.some((x) => x.toLowerCase() === optie.toLowerCase())) zonderOverige.push(optie);
    });
    if (heeftOverige) zonderOverige.push('Overige');
    return zonderOverige;
  };
  m.kozijnen = voegNieuweOptiesSamen(m.kozijnen, standaard.kozijnen);
  m.vloerafwerking = voegNieuweOptiesSamen(m.vloerafwerking, standaard.vloerafwerking);
  m.bouwdeelChips.wandenEnBinnenmuren = voegNieuweOptiesSamen(m.bouwdeelChips.wandenEnBinnenmuren, standaard.bouwdeelChips.wandenEnBinnenmuren);
  m.bouwdeelChips.plafonds = voegNieuweOptiesSamen(m.bouwdeelChips.plafonds, standaard.bouwdeelChips.plafonds);
  return m;
}

// ----------------------------------------------------------------------------------------------
// STATE
// ----------------------------------------------------------------------------------------------
const state = {
  route: { naam: 'lijst' }, // { naam:'lijst' } | { naam:'opname', rapportId, tab }
  taxatie: null, // huidig geladen taxatie (zelfde vorm als leegTaxatie())
  fotos: [], // foto's van de huidige taxatie (uit IndexedDB), inclusief nog-niet-verzonden
  // Foto's van de huidige taxatie die WEL succesvol geüpload zijn (Airtable-tabel "Opname Foto's")
  // maar niet meer lokaal aanwezig — Arno's melding 16-09-2026 (Grote Bavenkelsweg 27: foto's stonden
  // wel in Taxatieweb, niet meer in de PWA). Op de achtergrond gevuld door laadOpname(), zie
  // haalCloudFotos(). Blijft leeg zolang de fetch nog loopt of zonder verbinding.
  cloudFotos: [],
  taxatielijst: [], // cache voor het homescherm
  vooronderzoekLijst: null, // null = nog niet opgehaald; daarna array records uit Airtable-tabel "Vooronderzoek"
  vooronderzoekLaadFout: false,
  bijlagenLijst: null, // null = nog niet opgehaald; daarna array records uit Airtable-tabel "Bijlagen"
  bijlagenLaadFout: false,
  online: navigator.onLine,
  wachtrijAantal: 0,
  macros: standaardMacros(), // wordt bij init() overschreven met de bewaarde versie, indien aanwezig
  afmetingenWeergave: 'tekening', // 'tekening' | 'lijst' — zelfde standaard als Taxatieweb sinds v0.17.0
  bouwkundigHoofdtab: 'buitenzijde', // 'buitenzijde' | 'binnenzijde' | 'installaties' | 'overigeBijzonderheden'
  bouwkundigSubtab: 'daken', // zie BOUWKUNDIG_SUBTABS[hoofdtab]
  instellingenMenuOpen: false,
  energetischHoofdtab: 'algemeen', // 'algemeen' | 'isolatie' | 'installaties' | 'energieopwekking'
  energetischSubtab: 'gevel', // zie ENERGETISCH_SUBTABS[hoofdtab]
  // bkEnHoofdtab (19-09-2026, Arno's verzoek: "wat tabs aanbrengen, zodat de lijst niet zo lang
  // wordt") — zelfde 3-deling als Bouwkundig's eigen hoofdtabs (Buitenzijde/Binnenzijde/
  // Installaties), zie BKEN_HOOFDTABS hieronder voor welke bouwdeel-secties bij welk hoofdtab horen.
  bkEnHoofdtab: 'buitenzijde', // 'algemeen' | 'buitenzijde' | 'binnenzijde' | 'installaties'
  bkEnSubtab: 'daken', // zie BKEN_SUBTABS[hoofdtab]
};

async function laadMacros() {
  const bewaard = await VeldopnameDB.haalMacros();
  state.macros = bewaard ? metNieuweMacroCategorieen(bewaard) : standaardMacros();
}
function bewaarMacros() {
  VeldopnameDB.bewaarMacros(state.macros);
}

// Eigen suggestie-dropdown i.p.v. native <datalist> — 1-op-1 hetzelfde idee als
// toonEigenSuggesties()/koppelSuggesties() in taxatieweb-opname.user.js: op iOS Safari toont een
// <input list="..."> maar de eerste ~5 opties en kan er niet in gescrold worden ("Keuzelijst iPad
// is te kort, kan niet scrollen" — Arno's bugreport bij het origineel), dus bouwen we de lijst zelf
// als een gepositioneerde <div> die wél normaal scrolt. Eén gedeeld element voor alle velden (i.p.v.
// een exemplaar per input), want elke render() gooit bestaande inputs weg via innerHTML='' en zou
// anders nooit-opgeruimde elementen achterlaten.
const eigenSuggestiesLijst = el('div', { class: 'eigen-suggesties' });
eigenSuggestiesLijst.style.display = 'none';
document.body.appendChild(eigenSuggestiesLijst);
let actieveSuggestieInput = null;

function verbergEigenSuggesties() {
  eigenSuggestiesLijst.style.display = 'none';
  actieveSuggestieInput = null;
}

// Sluit de dropdown zodra er ELDERS gescrold wordt (bv. de ruimtes-lijst in Indeling) — anders blijft
// hij op zijn oude, vastgeklikte positie hangen terwijl het invoerveld er onderdoor wegscrolt, wat
// aanvoelt als "scrollen werkt niet lekker". 'scroll' bubbelt niet naar window, maar met
// capture:true vangt dit elke scroll op elk scrollbaar element in de pagina op — behalve op de
// dropdown zelf, anders zou intern scrollen 'm meteen weer sluiten.
window.addEventListener('scroll', (e) => {
  if (actieveSuggestieInput && e.target !== eigenSuggestiesLijst) verbergEigenSuggesties();
}, true);

// macroSleutel: één sleutel ('ruimtes'), meerdere tegelijk (['sanitair','toevoegingen']), of een
// FUNCTIE die dat teruggeeft (nodig zodra de relevante lijst kan wijzigen ná het bouwen van het
// veld). uitgeslotenFn: optionele functie die de al-gekozen waarden teruggeeft, om die uit de
// suggesties te filteren (alleen toevoegingen: eenmaal gekozen "inloopdouche" heeft binnen dezelfde
// ruimte geen zin om nogmaals te kiezen).
// Verdiepingen/ruimtes/ruimteblokken blijven ongefilterd — dezelfde naam mag daar wél vaker
// voorkomen (twee ruimtes die allebei "Slaapkamer" heten).
function toonEigenSuggesties(input, macroSleutel, uitgeslotenFn, magZelfTypen) {
  const opgelost = typeof macroSleutel === 'function' ? macroSleutel() : macroSleutel;
  const sleutels = Array.isArray(opgelost) ? opgelost : [opgelost];
  let opties = [...new Set(sleutels.flatMap(s => state.macros[s] || []))];
  if (uitgeslotenFn) {
    const uitgesloten = uitgeslotenFn().map(x => x.toLowerCase());
    opties = opties.filter(o => !uitgesloten.includes(o.toLowerCase()));
  }
  const zoekterm = input.value.trim().toLowerCase();
  const gefilterd = opties.filter(o => !zoekterm || o.toLowerCase().includes(zoekterm));
  if (gefilterd.length === 0 && !magZelfTypen) { verbergEigenSuggesties(); return; }
  actieveSuggestieInput = input;
  eigenSuggestiesLijst.innerHTML = '';
  // Arno (13-09-2026): "makkelijker te selecteren... standaard geen toetsenbord in beeld" — dit veld
  // staat via koppelDatalist() standaard op readOnly (zie daar), dus typen kan pas na een expliciete
  // tik op dit item (staTypenToe() haalt readOnly eraf en focust opnieuw, wat het toetsenbord toont).
  if (magZelfTypen) {
    const zelfTypenItem = el('div', { class: 'eigen-suggestie-item eigen-suggestie-typen' }, '✏️ Zelf typen…');
    zelfTypenItem.addEventListener('click', () => { verbergEigenSuggesties(); staTypenToe(input); });
    eigenSuggestiesLijst.appendChild(zelfTypenItem);
  }
  gefilterd.forEach(optie => {
    const item = el('div', { class: 'eigen-suggestie-item' }, optie);
    item.addEventListener('click', () => {
      input.value = optie;
      // Zowel 'input' als 'change' dispatchen — de toevoeging-multiselect bevestigt een gekozen item
      // via een 'change'-listener (net als Enter), niet via 'input'.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // Alleen verbergen als er ondertussen niet al een ANDER (nieuw) veld actief is geworden — de
      // 'change'-dispatch hierboven kan het hele veld opnieuw opbouwen en een nieuw input-element
      // focussen, wat zijn eigen 'focus'-listener (en dus een nieuwe actieveSuggestieInput) afvuurt.
      if (actieveSuggestieInput === input) verbergEigenSuggesties();
    });
    eigenSuggestiesLijst.appendChild(item);
  });

  // Hoogte/positie passen zich aan de daadwerkelijk zichtbare ruimte aan (visualViewport houdt
  // rekening met het schermtoetsenbord, window.innerHeight niet) — anders viel de lijst op iPad deels
  // onder het toetsenbord.
  const rect = input.getBoundingClientRect();
  const viewportHoogte = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const ruimteOnder = viewportHoogte - rect.bottom - 8;
  const ruimteBoven = rect.top - 8;
  const gewensteHoogte = 220;
  eigenSuggestiesLijst.style.left = rect.left + 'px';
  eigenSuggestiesLijst.style.width = rect.width + 'px';
  if (ruimteOnder >= 120 || ruimteOnder >= ruimteBoven) {
    eigenSuggestiesLijst.style.top = (rect.bottom + 2) + 'px';
    eigenSuggestiesLijst.style.bottom = 'auto';
    eigenSuggestiesLijst.style.maxHeight = Math.max(80, Math.min(gewensteHoogte, ruimteOnder)) + 'px';
  } else {
    eigenSuggestiesLijst.style.top = 'auto';
    eigenSuggestiesLijst.style.bottom = (viewportHoogte - rect.top + 2) + 'px';
    eigenSuggestiesLijst.style.maxHeight = Math.max(80, Math.min(gewensteHoogte, ruimteBoven)) + 'px';
  }
  eigenSuggestiesLijst.style.display = 'block';
}

// Zelfde gedeelde dropdown als toonEigenSuggesties(), maar voor een kant-en-klare lijst met eigen
// klik-callback i.p.v. een macroSleutel-lookup — gebruikt door de PDOK-adreszoeker in
// renderNieuweTaxatieScherm(), zodat daar niet een tweede suggestie-element nodig is.
function toonAdresSuggesties(input, items, onKies) {
  actieveSuggestieInput = input;
  eigenSuggestiesLijst.innerHTML = '';
  items.forEach((item) => {
    const el2 = el('div', { class: 'eigen-suggestie-item' }, item);
    el2.addEventListener('click', () => {
      onKies(item);
      if (actieveSuggestieInput === input) verbergEigenSuggesties();
    });
    eigenSuggestiesLijst.appendChild(el2);
  });
  const rect = input.getBoundingClientRect();
  const viewportHoogte = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const ruimteOnder = viewportHoogte - rect.bottom - 8;
  const ruimteBoven = rect.top - 8;
  const gewensteHoogte = 220;
  eigenSuggestiesLijst.style.left = rect.left + 'px';
  eigenSuggestiesLijst.style.width = rect.width + 'px';
  if (ruimteOnder >= 120 || ruimteOnder >= ruimteBoven) {
    eigenSuggestiesLijst.style.top = (rect.bottom + 2) + 'px';
    eigenSuggestiesLijst.style.bottom = 'auto';
    eigenSuggestiesLijst.style.maxHeight = Math.max(80, Math.min(gewensteHoogte, ruimteOnder)) + 'px';
  } else {
    eigenSuggestiesLijst.style.top = 'auto';
    eigenSuggestiesLijst.style.bottom = (viewportHoogte - rect.top + 2) + 'px';
    eigenSuggestiesLijst.style.maxHeight = Math.max(80, Math.min(gewensteHoogte, ruimteBoven)) + 'px';
  }
  eigenSuggestiesLijst.style.display = 'block';
}

// Koppelt een tekstveld aan een macro-lijst mét eigen, overal werkende dropdown — vervangt de eerdere
// plain-<datalist>-aanpak (zie uitleg hierboven).
function koppelDatalist(input, macroSleutel, uitgeslotenFn) {
  // Arno (13-09-2026): "Kun je ook zorgen dat deze makkelijker te selecteren zijn (en standaard geen
  // toetsenbord in beeld)?" — inputMode='none' onderdrukt het schermtoetsenbord voor de normale
  // "kies uit de lijst"-interactie, blijvend (nooit meer teruggezet naar 'text' — zie staTypenToe()
  // hieronder voor hoe vrij typen nu wél werkt, zonder aan deze stand te hoeven sleutelen). Eerdere
  // pogingen om ditzelfde veld tussentijds weer typbaar te maken (readOnly togglen, daarna inputMode
  // togglen) bleken op een iPad in de praktijk onbetrouwbaar: het toetsenbord verscheen dan niet
  // (Arno, herhaaldelijk getest, 13-09-2026).
  input.inputMode = 'none';
  input.addEventListener('focus', () => toonEigenSuggesties(input, macroSleutel, uitgeslotenFn, true));
  input.addEventListener('input', () => toonEigenSuggesties(input, macroSleutel, uitgeslotenFn, true));
  input.addEventListener('blur', () => setTimeout(() => {
    if (actieveSuggestieInput === input) verbergEigenSuggesties();
  }, 150));
}

// Vrij typen voor een via koppelDatalist() beheerd veld — geklikt vanuit het "✏️ Zelf typen…"-item
// bovenaan de suggestielijst (zie toonEigenSuggesties()). Gebruikt bewust een native prompt() i.p.v.
// het veld zelf tijdelijk typbaar te maken: elke poging om diezelfde <input> tussentijds van
// inputMode/readOnly te wisselen bleek op een iPad het toetsenbord niet betrouwbaar te tonen (zie de
// toelichting bij koppelDatalist() hierboven) — een prompt()-dialoog is een native OS-dialoog en
// toont altijd gegarandeerd een toetsenbord, op elk platform.
function staTypenToe(input) {
  const nieuweWaarde = prompt('Zelf typen:', input.value || '');
  if (nieuweWaarde === null) return; // geannuleerd
  input.value = nieuweWaarde;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

let opslaanTimer = null;

// ----------------------------------------------------------------------------------------------
// SYNC — dezelfde CLOUD_WEBHOOK/actie-vorm als taxatieweb-opname.user.js (cloudOpslaan/cloudOphalen)
// ----------------------------------------------------------------------------------------------
async function cloudOphalen(rapportId) {
  const resp = await fetch(CLOUD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actie: 'ophalen', rapport_id: rapportId }),
  });
  if (!resp.ok) throw new Error('Ophalen mislukt (' + resp.status + ')');
  return resp.json(); // { data, vergelijker_data }
}

function berekenTotalen(data) {
  const wonen = data.afmetingen.woonlagen.reduce((som, w) => som + (w.blokken || [])
    .filter(b => b.type !== 'buitenruimte').reduce((s, b) => {
      if (b.type === 'correctie') return s - naarGetal(b.lengte) * naarGetal(b.breedte);
      if (b.type === 'overig') return s; // apart geteld hieronder, niet dubbel
      return s + naarGetal(b.lengte) * naarGetal(b.breedte);
    }, 0), 0);
  const overig = data.afmetingen.woonlagen.reduce((som, w) => som + (w.blokken || [])
    .filter(b => b.type === 'overig').reduce((s, b) => s + naarGetal(b.lengte) * naarGetal(b.breedte), 0), 0);
  const buiten = data.afmetingen.woonlagen.reduce((som, w) => som + (w.blokken || [])
    .filter(b => b.type === 'buitenruimte').reduce((s, b) => s + naarGetal(b.lengte) * naarGetal(b.breedte), 0), 0);
  const extern = (data.externeBergruimte.blokken || []).reduce((s, b) => s + naarGetal(b.lengte) * naarGetal(b.breedte), 0);
  const aantalWoonlagen = data.afmetingen.woonlagen.filter(w => (w.blokken || []).some(b => b.lengte || b.breedte)).length;
  return { wonen, overig, buiten, extern, aantalWoonlagen };
}

// Was een lokale const binnen componeerIndelingTekst() — nu globaal, want ook nodig voor de
// Trappen-"Overnemen"-knop (13-09-2026) die dezelfde en-opsomming-stijl gebruikt.
function nederlandseLijst(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' en ' + items[items.length - 1];
}
// bijgebouwen (17-09-2026): optioneel, standaard [] — komt uit data.bijgebouwen, apart van
// `indeling` omdat het een sibling-veld is, geen onderdeel van indeling zelf. Arno's verzoek: "deze
// teksten komen samengevat terug in de indeling" — vandaar een eigen blok onderaan de tekst.
function componeerIndelingTekst(indeling, bijgebouwen) {
  const componeerRuimteZin = (ruimte) => {
    const items = (ruimte.toevoegingen || []).map(t => t.trim()).filter(Boolean);
    const zin = items.length ? ` met ${nederlandseLijst(items)}` : '';
    return `- ${ruimte.naam || 'Ruimte'}${zin}.`;
  };
  const blokken = (indeling.woonlagen || []).filter(w => (w.naam && w.naam.trim()) || (w.ruimtes || []).some(r => r.naam)).map(w => {
    const naam = (w.naam && w.naam.trim()) || 'Woonlaag';
    const vloerLijst = Array.isArray(w.vloerbeschrijvingen) ? w.vloerbeschrijvingen : [];
    const vloer = vloerLijst.length > 0 ? vloerLijst.join(' en ') : (w.vloerbeschrijving && w.vloerbeschrijving.trim());
    const kop = vloer ? `${naam}: (voorzien van ${vloer})` : `${naam}:`;
    const ruimtes = (w.ruimtes || []).filter(r => r.naam).map(componeerRuimteZin).join('\n');
    return `${kop}\n${ruimtes}`;
  });
  if ((bijgebouwen || []).length) {
    const regels = bijgebouwen.filter(b => b.type).map(b => `- ${samenvatBijgebouw(b)}.`).join('\n');
    if (regels) blokken.push(`Bij-/aanbouwen en buitenvoorzieningen:\n${regels}`);
  }
  return blokken.join('\n\n');
}

async function cloudOpslaan(taxatie) {
  const totalen = berekenTotalen(taxatie.data);
  const payload = {
    actie: 'opslaan',
    rapport_id: taxatie.rapport_id,
    wonen_totaal_m2: totalen.wonen, overig_inpandig_totaal_m2: totalen.overig,
    buitenruimte_totaal_m2: totalen.buiten, externe_bergruimte_totaal_m2: totalen.extern,
    aantal_woonlagen: totalen.aantalWoonlagen,
    indeling_tekst: componeerIndelingTekst(taxatie.data.indeling, taxatie.data.bijgebouwen),
    data: JSON.stringify(taxatie.data),
    vergelijker_data: '{}',
    aantekeningen: taxatie.aantekeningen || '',
    bewoning_data: JSON.stringify(taxatie.bewoning || leegBewoning()),
    bouwkundig_data: JSON.stringify(taxatie.bouwkundig || leegBouwkundig()),
    energetisch_data: JSON.stringify(taxatie.energetisch || leegEnergetisch()),
    omgeving_data: JSON.stringify(taxatie.omgeving || leegOmgeving()),
  };
  // adres/postcode/plaats alleen meesturen als we ze lokaal ECHT kennen — nooit een lege waarde
  // sturen die het bestaande veld in Airtable zou overschrijven. Zonder deze guard overschreef een
  // taxatie zonder lokale kopie (leegTaxatie(), bv. bij een ververste pagina midden in een opname) de
  // eerstvolgende auto-save het bestaande adres met niets (gebeurde 07-09-2026 met "Grote
  // Bavenkelsweg 27" tijdens het testen). laadOpname() vult adres/plaats inmiddels al aan vanuit de
  // taxatielijst-cache, maar dit is de laatste zekerheid.
  if (taxatie.adres) { payload.adres = taxatie.adres; payload.straat = taxatie.adres; }
  if (taxatie.postcode) payload.postcode = taxatie.postcode;
  if (taxatie.plaats) payload.plaats = taxatie.plaats;
  if (taxatie.voorlopig) payload.voorlopig = true;
  if (taxatie.kavelnummer) payload.kavelnummer = taxatie.kavelnummer;
  if (taxatie.bouwplan) payload.bouwplan = taxatie.bouwplan;
  const resp = await fetch(CLOUD_WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error('Opslaan mislukt (' + resp.status + ')');
}

// Debounce bewust omhoog van 1200ms naar 15s (11-09-2026, Arno's vraag "kost dit niet veel Make-
// credits?") — elke cloudOpslaan() kost 4-6 Make-operaties (Airtable search+create/update), en bij
// snel doorklikken door bv. de Bouwkundig-tab (tientallen checkboxes/chips) gaf de oude 1200ms-timer
// tijdens het testen tientallen losse aanroepen in een paar minuten. Data gaat nooit verloren door
// deze verruiming: elke wijziging wordt AL synchroon lokaal bewaard (VeldopnameDB, regel hierboven),
// de cloud-sync is puur voor delen tussen apparaten en mag best 15s achterlopen tijdens actief typen.
const OPSLAAN_DEBOUNCE_MS = 15000;
// Eerste "afgeleide regels"-logica (Arno's verzoek 12-09-2026: "kunnen we nog wat met logica doen
// welke velden wanneer aan en uit staan onder bepaalde voorwaarden") — draait bij ELKE wijziging
// (via planOpslaan hieronder), niet alleen bij de velden die de regel triggeren: goedkoop genoeg om
// gewoon altijd te checken, en dat maakt het vanzelf ook correct als bv. eerst Warmwatertoestel en
// dan pas Verwarmingstoestel wordt ingevuld. Bewust een simpele, uitbreidbare lijst (geen generiek
// "regels-systeem") — Arno wil hier later meer keuzelijstjes/regels aan toevoegen.
function pasAfgeleideRegelsToe() {
  const t = state.taxatie;
  if (!t || !t.bouwkundig) return;
  const installaties = t.bouwkundig.installaties;

  // Bouwjaar > 2021 → geen gasaansluiting meer verplicht/aannemelijk, Gas standaard uitzetten.
  const bouwjaar = parseInt(t.bewoning && t.bewoning.bouwjaar, 10);
  if (!isNaN(bouwjaar) && bouwjaar > 2021) installaties.leidingen.gas.aanwezig = false;

  // Verwarmingstoestel is een (combi-)ketel of hybride warmtepomp → warmwater komt daar ook uit.
  const verwarmingstoestel = installaties.verwarming.verwarmingstoestel;
  const warmwatertoestel = installaties.warmwater.warmwatertoestel;
  const materialenVerwarming = verwarmingstoestel.materialen || [];
  if (['CV-ketel', 'HR combi ketel', 'Hybride warmtepomp'].some(x => materialenVerwarming.includes(x))) {
    warmwatertoestel.materialen = warmwatertoestel.materialen || [];
    if (!warmwatertoestel.materialen.includes('Geïntegreerd in cv')) warmwatertoestel.materialen.push('Geïntegreerd in cv');
  }
  // Bouwjaar overnemen zodra "Geïntegreerd in cv" aan staat — ongeacht OF dat hierboven automatisch
  // gebeurde of handmatig aangevinkt is (Arno's correctie 12-09-2026: de trigger is dit vinkje zelf,
  // niet welk type verwarmingstoestel er staat).
  if ((warmwatertoestel.materialen || []).includes('Geïntegreerd in cv') && verwarmingstoestel.details.bouwjaar) {
    warmwatertoestel.details.bouwjaar = verwarmingstoestel.details.bouwjaar;
  }

  // Verwarmingstoestel heeft ook airco → Koeling-bouwdeel meteen meenemen.
  if (materialenVerwarming.includes('Airconditioning')) {
    const koeling = installaties.ventilatieKoeling.koeling;
    koeling.aanwezig = true;
    koeling.materialen = koeling.materialen || [];
    if (!koeling.materialen.includes('Airconditioning')) koeling.materialen.push('Airconditioning');
  }

  // Zelfde regel als hierboven, nu voor I.4 Energetisch (Arno's verzoek 13-09-2026): daar heeft
  // Warmwatertoestel ook een eigen Installatiemoment (Bouwjaar/Installatiejaar) + jaar-select i.p.v.
  // het platte Bouwjaar-veld van J.4 Bouwkundig — bij "Geïntegreerd in cv" is dat identiek aan het
  // Verwarmingstoestel, dus beide velden overnemen, niet alleen het jaar.
  if (t.energetisch && t.energetisch.installaties) {
    const eVerwarmingstoestel = t.energetisch.installaties.verwarming.verwarmingstoestel;
    const eWarmwatertoestel = t.energetisch.installaties.warmWater.warmwatertoestel;
    const eMaterialenVerwarming = eVerwarmingstoestel.materialen || [];
    if (['CV-ketel', 'HR combi ketel', 'Hybride warmtepomp'].some(x => eMaterialenVerwarming.includes(x))) {
      eWarmwatertoestel.aanwezig = true;
      eWarmwatertoestel.materialen = eWarmwatertoestel.materialen || [];
      if (!eWarmwatertoestel.materialen.includes('Geïntegreerd in cv')) eWarmwatertoestel.materialen.push('Geïntegreerd in cv');
    }
    if ((eWarmwatertoestel.materialen || []).includes('Geïntegreerd in cv') && eVerwarmingstoestel.installatiemoment) {
      eWarmwatertoestel.installatiemoment = eVerwarmingstoestel.installatiemoment;
      eWarmwatertoestel.jaar = eVerwarmingstoestel.jaar;
    }
  }
}
function planOpslaan() {
  if (!state.taxatie) return;
  pasAfgeleideRegelsToe();
  state.taxatie.lokaalGewijzigd = true;
  VeldopnameDB.bewaarTaxatie(state.taxatie);
  werkStatusbalkBij();
  clearTimeout(opslaanTimer);
  opslaanTimer = setTimeout(async () => {
    if (!state.online) return; // blijft lokaalGewijzigd staan, wordt bij "online" event alsnog verstuurd
    try {
      await cloudOpslaan(state.taxatie);
      state.taxatie.lokaalGewijzigd = false;
      await VeldopnameDB.bewaarTaxatie(state.taxatie);
      werkStatusbalkBij();
    } catch (e) {
      // lokaal-eerst: mislukte sync is geen probleem, blijft "lokaalGewijzigd" en probeert later opnieuw
    }
  }, OPSLAAN_DEBOUNCE_MS);
}

async function verwerkWachtrij() {
  if (!state.online) return;
  // taxatie zelf, als die nog niet gesynct is
  if (state.taxatie && state.taxatie.lokaalGewijzigd) {
    try {
      await cloudOpslaan(state.taxatie);
      state.taxatie.lokaalGewijzigd = false;
      await VeldopnameDB.bewaarTaxatie(state.taxatie);
    } catch (e) { /* volgende poging bij eerstvolgende wijziging/online-event */ }
  }
  werkStatusbalkBij();
}

window.addEventListener('online', () => { state.online = true; verwerkWachtrij(); verstuurFotoWachtrij(); werkStatusbalkBij(); });
window.addEventListener('offline', () => { state.online = false; werkStatusbalkBij(); });

// ----------------------------------------------------------------------------------------------
// ROUTER
// ----------------------------------------------------------------------------------------------
function navigeer(route) {
  state.route = route;
  render();
  // Alleen bij binnenkomst op de lijst zelf verversen, NIET vanuit renderLijstScherm() (zie de
  // uitleg bij laadTaxatielijst() hieronder over de credit-runaway die dat veroorzaakte).
  if (route.naam === 'lijst') laadTaxatielijst();
}
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#\/opname\/([^/]+)\/([a-z]+)$/);
  if (m) laadOpname(decodeURIComponent(m[1]), m[2]);
  else navigeer({ naam: 'lijst' });
});

async function laadOpname(rapportId, tab) {
  render(); // toon meteen laadscherm
  let lokaal = await VeldopnameDB.haalTaxatie(rapportId);
  if (!lokaal) {
    lokaal = leegTaxatie(rapportId);
    // Adres/plaats/afspraak vullen vanuit de al opgehaalde taxatielijst — anders blijft dit een
    // helemaal lege taxatie (geen lokale kopie bestond nog, bv. eerste keer openen op dit toestel,
    // her-install, of een ververste pagina middenin een opname op iOS Safari) en zou de eerstvolgende
    // auto-save het bestaande adres in Airtable overschrijven met een LEGE waarde — precies wat er op
    // 07-09-2026 gebeurde met het testrapport "Grote Bavenkelsweg 27" tijdens het testen van deze app.
    if (state.taxatielijst.length === 0) await laadTaxatielijst();
    const uitLijst = state.taxatielijst.find(t => t.rapport_id === rapportId);
    if (uitLijst) {
      lokaal.adres = uitLijst.adres || '';
      lokaal.plaats = uitLijst.plaats || '';
      lokaal.afspraak_datumtijd = uitLijst.afspraak_datumtijd || null;
    }
  }
  if (!lokaal.bewoning) lokaal.bewoning = leegBewoning(); // taxaties van vóór Fase 1 "volledige opname"
  // taxaties van vóór de Objectkenmerken-velden (12-09-2026):
  if (lokaal.bewoning.woningtype === undefined) lokaal.bewoning.woningtype = '';
  if (lokaal.bewoning.bouwjaar === undefined) lokaal.bewoning.bouwjaar = '';
  if (lokaal.bewoning.tuinAanwezig === undefined) lokaal.bewoning.tuinAanwezig = null; // vóór de Tuin-verplichte-foto-logica (13-09-2026)
  if (lokaal.bewoning.grootVerbouwingGeweest === undefined) { lokaal.bewoning.grootVerbouwingGeweest = null; lokaal.bewoning.grootVerbouwingToelichting = ''; }
  lokaal.bouwkundig = metVolledigBouwkundig(lokaal.bouwkundig); // taxaties van vóór Fase 2 "volledige opname"
  lokaal.energetisch = metVolledigEnergetisch(lokaal.energetisch); // taxaties van vóór Fase 3 "volledige opname"
  lokaal.omgeving = metVolledigOmgeving(lokaal.omgeving); // taxaties van vóór de Omgeving-tab (13-09-2026)
  if (!lokaal.begintijdOpname) lokaal.begintijdOpname = new Date().toISOString(); // eerste keer laden = start inspectie
  lokaal.data = synchroniseerWoonlagen(lokaal.data); // Meting/Indeling-woonlagen gelijktrekken (13-09-2026)
  if (!lokaal.data.installatieKenmerken) lokaal.data.installatieKenmerken = leegInstallatieKenmerken(); // taxaties van vóór 17-09-2026
  if (!Array.isArray(lokaal.data.attentieVelden)) lokaal.data.attentieVelden = [];
  if (!Array.isArray(lokaal.data.bijgebouwen)) lokaal.data.bijgebouwen = [];
  state.taxatie = lokaal;
  synchroniseerKenmerken(); // bestaande Vloeren/Kozijnen/Glas/Verwarmingssysteem-keuzes overnemen in Indeling (16-09-2026)
  synchroniseerInstallatieKenmerken(); // bestaande Ventilatie/Koeling/Warmwatertoestel-keuzes samenvoegen (17-09-2026)
  state.fotos = await VeldopnameDB.fotosVoorTaxatie(rapportId);
  state.cloudFotos = [];
  navigeer({ naam: 'opname', rapportId, tab: tab || 'meting' });

  // Op de achtergrond: foto's ophalen die al geüpload zijn maar niet (meer) lokaal aanwezig staan
  // (zie haalCloudFotos hierboven) — bewust NIET blokkerend voor het openen van de taxatie, en
  // alleen 1x per keer openen (niet bij elke render), om onnodige Make-operaties te vermijden.
  if (state.online) {
    haalCloudFotos(rapportId).then((lijst) => {
      state.cloudFotos = lijst;
      if (state.route.naam === 'opname' && state.route.rapportId === rapportId) render();
    });
  }

  // Op de achtergrond: cloud-versie ophalen en overnemen als die recenter/aanwezig is (net als
  // taxatieweb-opname.user.js bij het laden doet) — alleen als er lokaal nog geen wijziging in de
  // wachtrij staat, anders zouden we eigen niet-verzonden werk overschrijven.
  if (state.online && !lokaal.lokaalGewijzigd) {
    try {
      const { data, bewoning_data, bouwkundig_data, energetisch_data, omgeving_data, aantekeningen } = await cloudOphalen(rapportId);
      // Let op: `data` (en sinds Fase 1/2 "volledige opname" ook bewoning_data/bouwkundig_data) komt
      // al als object terug (de Make-respons splitst 'm rechtstreeks in de JSON-body,
      // {"data":{{...}}} zonder quotes) — GEEN JSON.parse() erover heen, dat gaf hier "[object
      // Object] is not valid JSON". Vergelijk taxatieweb-opname.user.js, waar cloudData ook
      // rechtstreeks als object gebruikt wordt.
      let gewijzigd = false;
      if (data && typeof data === 'object') {
        state.taxatie.data = synchroniseerWoonlagen(data);
        if (!state.taxatie.data.installatieKenmerken) state.taxatie.data.installatieKenmerken = leegInstallatieKenmerken();
        if (!Array.isArray(state.taxatie.data.attentieVelden)) state.taxatie.data.attentieVelden = [];
        if (!Array.isArray(state.taxatie.data.bijgebouwen)) state.taxatie.data.bijgebouwen = [];
        gewijzigd = true;
      }
      if (bewoning_data && typeof bewoning_data === 'object') {
        if (bewoning_data.woningtype === undefined) bewoning_data.woningtype = '';
        if (bewoning_data.bouwjaar === undefined) bewoning_data.bouwjaar = '';
        if (bewoning_data.tuinAanwezig === undefined) bewoning_data.tuinAanwezig = null;
        if (bewoning_data.grootVerbouwingGeweest === undefined) { bewoning_data.grootVerbouwingGeweest = null; bewoning_data.grootVerbouwingToelichting = ''; }
        state.taxatie.bewoning = bewoning_data; gewijzigd = true;
      }
      if (bouwkundig_data && typeof bouwkundig_data === 'object') { state.taxatie.bouwkundig = metVolledigBouwkundig(bouwkundig_data); gewijzigd = true; }
      if (energetisch_data && typeof energetisch_data === 'object') { state.taxatie.energetisch = metVolledigEnergetisch(energetisch_data); gewijzigd = true; }
      if (omgeving_data && typeof omgeving_data === 'object') { state.taxatie.omgeving = metVolledigOmgeving(omgeving_data); gewijzigd = true; }
      // aantekeningen alleen overnemen als lokaal nog leeg is — anders zou een cloud-versie die (door
      // de eerder ontbrekende sync) nog leeg is een lokaal wél al ingetypte notitie overschrijven.
      if (aantekeningen && !state.taxatie.aantekeningen) { state.taxatie.aantekeningen = aantekeningen; gewijzigd = true; }
      if (gewijzigd) {
        synchroniseerKenmerken();
        synchroniseerInstallatieKenmerken();
        await VeldopnameDB.bewaarTaxatie(state.taxatie);
        if (state.route.naam === 'opname' && state.route.rapportId === rapportId) render();
      }
    } catch (e) { /* geen verbinding of nog geen cloud-data — lokale (lege) data blijft gewoon staan */ }
  }
}

// ----------------------------------------------------------------------------------------------
// RENDER — algemeen
// ----------------------------------------------------------------------------------------------
const app = document.getElementById('app');

function el(tag, attrs, ...kinderen) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  });
  kinderen.flat().forEach(kind => {
    if (kind === null || kind === undefined) return;
    node.appendChild(typeof kind === 'string' ? document.createTextNode(kind) : kind);
  });
  return node;
}

// Onthoudt op welke tab de vorige render stond, zodat render() de scrollpositie van .inhoud kan
// herstellen bij een re-render van DEZELFDE tab (bv. een checkbox aanklikken) — zonder dit sprong de
// pagina bij elke wijziging terug naar boven, omdat render() steeds app.innerHTML = '' doet en dus
// een compleet NIEUW .inhoud-element maakt (scrollTop altijd 0). Bij een echte tab-wissel (of andere
// route) is terug-naar-boven wél gewenst — dat gebeurt hier vanzelf, want dan wordt niets herstel.
let laatsteRenderTab = null;
function render() {
  const vorigeInhoud = app.querySelector('.inhoud');
  const scrollBehouden = (vorigeInhoud && state.route.naam === 'opname' && state.route.tab === laatsteRenderTab)
    ? vorigeInhoud.scrollTop : null;
  app.innerHTML = '';
  // Sluit een eventueel nog open suggestie-dropdown van vóór deze render (zie koppelDatalist).
  verbergEigenSuggesties();
  laatsteRenderTab = state.route.naam === 'opname' ? state.route.tab : null;
  if (state.route.naam === 'lijst') { app.appendChild(renderLijstScherm()); return; }
  if (state.route.naam === 'nieuw') { app.appendChild(renderNieuweTaxatieScherm()); return; }
  if (!state.taxatie) { app.appendChild(renderLaadscherm()); return; }
  app.appendChild(renderOpnameScherm());
  if (scrollBehouden !== null) {
    const nieuweInhoud = app.querySelector('.inhoud');
    if (nieuweInhoud) nieuweInhoud.scrollTop = scrollBehouden;
  }
}

function renderLaadscherm() {
  return el('div', { class: 'midden-scherm' }, el('div', { class: 'spinner' }), el('p', {}, 'Laden…'));
}

function syncPilTekst() {
  if (!state.online) return { klasse: 'offline', tekst: '📴 Offline' };
  if (state.taxatie && state.taxatie.lokaalGewijzigd) return { klasse: 'wachtend', tekst: '⏳ Wordt gesynchroniseerd…' };
  return { klasse: 'ok', tekst: '✓ Gesynchroniseerd' };
}

function werkStatusbalkBij() {
  const pil = document.querySelector('.sync-pil');
  if (!pil) return;
  const { klasse, tekst } = syncPilTekst();
  pil.className = 'sync-pil ' + klasse;
  pil.textContent = tekst;
}

// ----------------------------------------------------------------------------------------------
// SCHERM: Taxatielijst
// ----------------------------------------------------------------------------------------------
// LET OP (credit-runaway gevonden 07-09-2026): renderLijstScherm() riep dit eerder onvoorwaardelijk
// bij ELKE render aan, en deze functie riep aan het eind zélf weer render() aan zodra de fetch
// klaar was — dat vormde een oneindige render→fetch→render-lus zolang het lijstscherm open stond,
// die binnen enkele uren de hele maand-Make-quota opsoupeerde. Nu alleen nog aangeroepen vanuit
// navigeer()/init() (bij binnenkomst op de lijst), nooit meer vanuit een render-functie zelf, plus
// een expliciete bezig-vlag als laatste vangnet tegen overlappende aanroepen.
let taxatielijstOphalenBezig = false;
async function laadTaxatielijst() {
  if (taxatielijstOphalenBezig) return;
  taxatielijstOphalenBezig = true;
  try {
    const resp = await fetch(LIJST_WEBHOOK, { method: 'POST' });
    if (!resp.ok) throw new Error('lijst ophalen mislukt');
    const json = await resp.json();
    const rijen = json.records || json || [];
    state.taxatielijst = rijen.map(r => ({
      rapport_id: r.fields ? r.fields.rapport_id : r.rapport_id,
      adres: r.fields ? r.fields.adres : r.adres,
      plaats: r.fields ? r.fields.plaats : r.plaats,
      afspraak_datumtijd: r.fields ? r.fields.afspraak_datumtijd : r.afspraak_datumtijd,
      voorlopig: !!(r.fields ? r.fields.voorlopig : r.voorlopig),
    })).filter(t => t.rapport_id);
  } catch (e) {
    // geen verbinding: laat zien wat we nog in IndexedDB hebben staan (lokaal geopende taxaties)
    const lokaal = await VeldopnameDB.alleTaxaties();
    state.taxatielijst = lokaal.map(t => ({ rapport_id: t.rapport_id, adres: t.adres, plaats: t.plaats, afspraak_datumtijd: t.afspraak_datumtijd, voorlopig: !!t.voorlopig }));
  } finally { taxatielijstOphalenBezig = false; }
  if (state.route.naam === 'lijst') render();
}

// ----------------------------------------------------------------------------------------------
// VOORONDERZOEK — leest de Airtable-tabel "Vooronderzoek" (gevuld door de Research-agent) uit, zodat
// Arno tijdens de opname bestemming/bouwjaar/WOZ/kadaster/Funda-link paraat heeft zonder over te
// schakelen naar een ander scherm. Eén keer per sessie de hele (kleine) tabel opgehaald en lokaal
// gefilterd op adres — zelfde eenvoudige aanpak als laadTaxatielijst() hierboven, geen aparte
// zoek-aanroep per taxatie nodig.
async function laadVooronderzoekLijst() {
  state.vooronderzoekLaadFout = false;
  try {
    const resp = await fetch(VOORONDERZOEK_WEBHOOK, { method: 'POST' });
    if (!resp.ok) throw new Error('vooronderzoek ophalen mislukt');
    const json = await resp.json();
    state.vooronderzoekLijst = json.records || [];
  } catch (e) {
    state.vooronderzoekLijst = [];
    state.vooronderzoekLaadFout = true;
  }
  if (state.route.naam === 'opname' && state.route.tab === 'onderzoek') render();
}

// Match op adres_volledig ("straat, postcode plaats") dat begint met de straatnaam+huisnummer uit de
// taxatie — case-insensitive, whitespace genegeerd.
function vindVooronderzoek(adres) {
  if (!adres || !state.vooronderzoekLijst) return null;
  const zoek = adres.trim().toLowerCase();
  return state.vooronderzoekLijst.find(r => (r.fields.adres_volledig || '').trim().toLowerCase().startsWith(zoek)) || null;
}
// Start het ophalen van de vooronderzoekslijst als dat nog niet gebeurd/aan de gang is — gebruikt
// door zowel de Onderzoek-tab als Objectkenmerken (voor de auto-invul van woningtype/bouwjaar),
// zodat het niet uitmaakt in welke volgorde Arno de tabbladen bezoekt.
function zorgVoorVooronderzoek() {
  if (state.vooronderzoekLijst !== null || vooronderzoekOphalenBezig) return;
  vooronderzoekOphalenBezig = true;
  laadVooronderzoekLijst().then(() => { vooronderzoekOphalenBezig = false; });
}

// Bijlagen die Arno vooraf in Taxatieweb plaatst (Q/R > Bijlagen), doorgestuurd via
// taxatieweb-opname.user.js naar Airtable-tabel "Bijlagen" — hier op dezelfde manier als
// vooronderzoek eenmalig per sessie opgehaald en lokaal gefilterd (op taxatie_rapport_id, de
// lookup die Airtable zelf al als tekst-array teruggeeft).
async function laadBijlagenLijst() {
  state.bijlagenLaadFout = false;
  try {
    const resp = await fetch(BIJLAGEN_WEBHOOK, { method: 'POST' });
    if (!resp.ok) throw new Error('bijlagen ophalen mislukt');
    const json = await resp.json();
    state.bijlagenLijst = json.records || [];
  } catch (e) {
    state.bijlagenLijst = [];
    state.bijlagenLaadFout = true;
  }
  if (state.route.naam === 'opname' && state.route.tab === 'onderzoek') render();
}
function vindBijlagen(rapportId) {
  if (!rapportId || !state.bijlagenLijst) return [];
  return state.bijlagenLijst.filter(r => (r.fields.taxatie_rapport_id || []).includes(rapportId));
}

function formatAfspraak(iso) {
  if (!iso) return 'Nog geen afspraak bekend';
  const d = new Date(iso);
  const vandaag = new Date();
  const zelfdeDag = d.toDateString() === vandaag.toDateString();
  const datumTekst = zelfdeDag ? 'Vandaag' : d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
  const tijdTekst = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return `${datumTekst} ${tijdTekst}`;
}

// Vooraanzicht-miniatuur op de taxatielijst (Arno's verzoek 13-09-2026: "voeg de vooraanzicht foto
// toe ... zodra deze bestaat, anders een placeholder"). state.fotos is alleen gevuld voor de
// OPEN taxatie (zie laadOpname), dus hier per kaart een losse IndexedDB-opzoeking — met een cache
// zodat dat maar 1x per taxatie gebeurt en er nooit een render→fetch→render-lus kan ontstaan (zie
// de credit-runaway-waarschuwing bij laadTaxatielijst() hierboven, dezelfde valkuil moet hier
// vermeden worden).
const vooraanzichtCache = {};
function vooraanzichtThumbnailUrl(rapportId) {
  const c = vooraanzichtCache[rapportId];
  if (c) return c.laden ? null : c.url;
  vooraanzichtCache[rapportId] = { laden: true, url: null };
  VeldopnameDB.fotosVoorTaxatie(rapportId).then((fotos) => {
    const foto = fotos.find(f => f.ruimte_label === 'Vooraanzicht' && !f.archief);
    vooraanzichtCache[rapportId] = { laden: false, url: foto ? URL.createObjectURL(foto.blob) : null };
    if (state.route.naam === 'lijst') render();
  }).catch(() => { vooraanzichtCache[rapportId] = { laden: false, url: null }; });
  return null;
}
function renderLijstScherm() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'statusbalk' },
    el('h1', {}, el('span', { class: 'letter' }, 'D&H'), ' Taxatieopname'),
    el('span', { class: 'sync-pil ' + syncPilTekst().klasse }, syncPilTekst().tekst),
  ));
  const inhoud = el('div', { class: 'inhoud' });
  inhoud.appendChild(el('button', {
    class: 'knop', style: 'margin-bottom:14px;',
    onclick: () => { navigeer({ naam: 'nieuw' }); },
  }, '+ Nieuwe taxatie starten'));
  inhoud.appendChild(el('div', { class: 'section-label' }, 'Taxaties'));

  if (state.taxatielijst.length === 0) {
    inhoud.appendChild(el('div', { class: 'lege-lijst' }, 'Nog geen taxaties gevonden. Trek naar beneden om te vernieuwen zodra er verbinding is.'));
  } else {
    state.taxatielijst.forEach(t => {
      const thumbUrl = vooraanzichtThumbnailUrl(t.rapport_id);
      const thumb = thumbUrl
        ? el('img', { src: thumbUrl, class: 'taxatie-thumb', alt: '' })
        : el('div', { class: 'taxatie-thumb taxatie-thumb-placeholder' }, '🏠');
      // Google Maps-link — eigen <a> met stopPropagation, anders opent een klik erop ook meteen de
      // taxatie (de hele kaart heeft al een eigen onclick voor "open taxatie"). Adres+plaats is
      // genoeg voor een betrouwbare route (Google Maps zoekt zelf de exacte locatie op).
      const heeftAdres = !!(t.adres || t.plaats);
      const mapsLink = heeftAdres ? el('a', {
        href: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([t.adres, t.plaats].filter(Boolean).join(', ')),
        target: '_blank', rel: 'noopener', class: 'taxatie-maps-knop',
        onclick: (e) => e.stopPropagation(),
      }, '📍 Route') : null;
      inhoud.appendChild(el('div', {
        class: 'taxatie-kaart',
        onclick: () => { location.hash = '#/opname/' + encodeURIComponent(t.rapport_id) + '/meting'; },
      },
        thumb,
        el('div', { class: 'taxatie-kaart-info' },
          el('div', { class: 'adres' },
            t.adres || '(adres onbekend)',
            t.voorlopig ? el('span', { class: 'badge-voorlopig' }, '⏳ Voorlopig') : null,
          ),
          el('div', { class: 'plaats' }, t.plaats || ''),
          el('div', { class: 'meta' }, el('span', { class: 'afspraak' }, formatAfspraak(t.afspraak_datumtijd)), mapsLink),
        ),
      ));
    });
  }
  wrap.appendChild(inhoud);
  return wrap;
}

// ----------------------------------------------------------------------------------------------
// SCHERM: Nieuwe taxatie starten — Arno's verzoek (10-09-2026): "zelf een opdracht kunnen aanmaken
// in de PWA, adres invoeren op dezelfde manier als het opdrachtformulier (met BAG-gegevens of bij
// nieuwbouw met specifieke velden)". Zelfde live-adreszoeker als opdrachtgegevens-formulier.html
// (PDOK Locatieserver, gratis, geen sleutel), zelfde nieuwbouw-toggle (Kavelnummer/Bouwplan i.p.v.
// een BAG-adres). De taxatie krijgt een ZELF gegenereerde rapport_id (geen Taxatieweb-rapport nodig
// om te beginnen) en wordt gemarkeerd `voorlopig: true` — het Taxatieweb-script herkent 'm later op
// adres en biedt daar een koppelknop, zie taxatieweb-opname.user.js.
const PDOK_SUGGEST_URL = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest';
async function zoekAdresPDOK(zoekterm) {
  const url = PDOK_SUGGEST_URL + '?q=' + encodeURIComponent(zoekterm) + '&fq=type:adres&rows=6';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('PDOK-verzoek mislukt');
  const json = await resp.json();
  return (json.response && json.response.docs || []).map((d) => d.weergavenaam);
}
// "Voorstraat 1, 1234 AB Almelo" → { adres, postcode, plaats }.
function ontleedPdokAdres(weergavenaam) {
  const m = /^(.+?),\s*(\d{4}\s?[A-Z]{2})\s+(.+)$/.exec(weergavenaam || '');
  if (!m) return { adres: weergavenaam || '', postcode: '', plaats: '' };
  return { adres: m[1].trim(), postcode: m[2].trim(), plaats: m[3].trim() };
}

function renderNieuweTaxatieScherm() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'statusbalk' },
    el('button', { class: 'terug', onclick: () => { navigeer({ naam: 'lijst' }); } }, '‹'),
    el('h1', {}, 'Nieuwe taxatie'),
  ));
  const inhoud = el('div', { class: 'inhoud' });
  wrap.appendChild(inhoud);

  let isNieuwbouw = false;
  let gekozenAdres = null; // { adres, postcode, plaats } zodra via PDOK gekozen of handmatig ingevuld
  let handmatigModus = false;

  inhoud.appendChild(el('div', { class: 'section-label' }, 'Betreft dit een nieuwbouwwoning?'));
  const nbRij = el('div', { class: 'weergave-wissel' });
  inhoud.appendChild(nbRij);

  const adresSectie = el('div', {});
  const nieuwbouwSectie = el('div', { style: 'display:none;' });
  inhoud.appendChild(adresSectie);
  inhoud.appendChild(nieuwbouwSectie);

  // --- Adres-sectie (niet-nieuwbouw): live PDOK-zoeker + handmatige terugval — hergebruikt de
  // gedeelde eigenSuggestiesLijst (zie koppelDatalist() hierboven) i.p.v. een eigen dropdown-element,
  // anders zou elk bezoek aan dit scherm een nieuw, nooit-opgeruimd element aan <body> toevoegen.
  const adresInput = el('input', { placeholder: 'Straat en huisnummer (bv. "Voorstraat 1")' });
  const adresStatusEl = el('p', { class: 'macro-uitleg', style: 'margin:4px 0 0;' }, '');
  let pdokTimer = null;
  adresInput.addEventListener('input', () => {
    gekozenAdres = null;
    clearTimeout(pdokTimer);
    const term = adresInput.value.trim();
    if (term.length < 3) { verbergEigenSuggesties(); adresStatusEl.textContent = ''; return; }
    adresStatusEl.textContent = 'zoeken…';
    pdokTimer = setTimeout(async () => {
      try {
        const resultaten = await zoekAdresPDOK(term);
        adresStatusEl.textContent = '';
        if (resultaten.length === 0) { verbergEigenSuggesties(); return; }
        toonAdresSuggesties(adresInput, resultaten, (naam) => {
          adresInput.value = naam;
          gekozenAdres = ontleedPdokAdres(naam);
        });
      } catch (e) { adresStatusEl.textContent = 'Adres opzoeken lukte niet — vul het handmatig in.'; }
    }, 300);
  });
  adresInput.addEventListener('blur', () => setTimeout(() => {
    if (actieveSuggestieInput === adresInput) verbergEigenSuggesties();
  }, 150));
  adresSectie.appendChild(el('div', { class: 'chip-toevoegen' }, adresInput));
  adresSectie.appendChild(adresStatusEl);

  const handmatigVeldenWrap = el('div', { style: 'display:none;margin-top:10px;' });
  const straatVeld = el('input', { placeholder: 'Straat en huisnummer' });
  const postcodeVeld = el('input', { placeholder: 'Postcode' });
  const plaatsVeld = el('input', { placeholder: 'Plaats' });
  [straatVeld, postcodeVeld, plaatsVeld].forEach((veld) => {
    veld.style.marginBottom = '8px';
    handmatigVeldenWrap.appendChild(veld);
  });
  adresSectie.appendChild(handmatigVeldenWrap);
  const handmatigKnop = el('button', { class: 'knop spook klein', style: 'margin-top:8px;' }, 'Adres niet gevonden? Vul zelf in');
  handmatigKnop.addEventListener('click', () => {
    handmatigModus = !handmatigModus;
    handmatigVeldenWrap.style.display = handmatigModus ? 'block' : 'none';
    adresInput.parentElement.style.display = handmatigModus ? 'none' : 'flex';
    adresStatusEl.style.display = handmatigModus ? 'none' : 'block';
    handmatigKnop.textContent = handmatigModus ? '← Terug naar adres opzoeken' : 'Adres niet gevonden? Vul zelf in';
  });
  adresSectie.appendChild(handmatigKnop);

  // --- Nieuwbouw-sectie: Kavelnummer/Bouwplan i.p.v. een (nog niet bestaand) BAG-adres ---
  const kavelVeld = el('input', { placeholder: 'Kavelnummer' });
  const bouwplanVeld = el('input', { placeholder: 'Bouwplan / projectnaam' });
  const nbPlaatsVeld = el('input', { placeholder: 'Plaats' });
  [kavelVeld, bouwplanVeld, nbPlaatsVeld].forEach((veld) => { veld.style.marginBottom = '8px'; nieuwbouwSectie.appendChild(veld); });

  [['nee', 'Nee'], ['ja', 'Ja']].forEach(([val, label]) => {
    const knop = el('button', { class: 'klein' + (val === 'nee' ? ' actief' : '') }, label);
    knop.addEventListener('click', () => {
      isNieuwbouw = val === 'ja';
      nbRij.querySelectorAll('button').forEach((b) => b.classList.remove('actief'));
      knop.classList.add('actief');
      adresSectie.style.display = isNieuwbouw ? 'none' : 'block';
      nieuwbouwSectie.style.display = isNieuwbouw ? 'block' : 'none';
    });
    nbRij.appendChild(knop);
  });

  const foutEl = el('p', { class: 'macro-uitleg', style: 'color:var(--danger);margin-top:10px;' }, '');
  inhoud.appendChild(foutEl);

  const startKnop = el('button', { class: 'knop', style: 'margin-top:14px;' }, 'Taxatie starten');
  startKnop.addEventListener('click', async () => {
    foutEl.textContent = '';
    let adres = '', postcode = '', plaats = '', kavelnummer = '', bouwplan = '';
    if (isNieuwbouw) {
      kavelnummer = kavelVeld.value.trim();
      bouwplan = bouwplanVeld.value.trim();
      plaats = nbPlaatsVeld.value.trim();
      if (!bouwplan && !kavelnummer) { foutEl.textContent = 'Vul kavelnummer en/of bouwplan in.'; return; }
      adres = [bouwplan, kavelnummer].filter(Boolean).join(' — kavel ');
    } else if (handmatigModus) {
      adres = straatVeld.value.trim(); postcode = postcodeVeld.value.trim(); plaats = plaatsVeld.value.trim();
      if (!adres) { foutEl.textContent = 'Vul een adres in.'; return; }
    } else {
      if (!gekozenAdres) { foutEl.textContent = 'Kies een adres uit de suggesties (of vul het handmatig in).'; return; }
      ({ adres, postcode, plaats } = gekozenAdres);
    }

    startKnop.disabled = true;
    startKnop.textContent = 'Aanmaken…';
    const rapportId = crypto.randomUUID();
    const taxatie = leegTaxatie(rapportId);
    taxatie.adres = adres; taxatie.postcode = postcode; taxatie.plaats = plaats;
    taxatie.voorlopig = true; taxatie.kavelnummer = kavelnummer; taxatie.bouwplan = bouwplan;
    await VeldopnameDB.bewaarTaxatie(taxatie);
    try { await cloudOpslaan(taxatie); } catch (e) { /* blijft lokaal staan, wachtrij pakt 'm later op via planOpslaan */ }
    state.taxatielijst.push({ rapport_id: rapportId, adres, plaats, afspraak_datumtijd: null, voorlopig: true });
    location.hash = '#/opname/' + encodeURIComponent(rapportId) + '/meting';
  });
  inhoud.appendChild(startKnop);
  return wrap;
}

// ----------------------------------------------------------------------------------------------
// SCHERM: Opname (Meting / Indeling / Foto's / Aantekeningen)
// ----------------------------------------------------------------------------------------------
// Volgorde op Arno's verzoek (12-09-2026): Onderzoek helemaal rechts (was vooraan — dat blijkt in de
// praktijk niet de tab waarmee de opname begint); Macro's is GEEN eigen tabblad meer, verhuisd naar
// het Instellingen-menu rechtsboven (zie renderOpnameScherm/renderInstellingenMenu).
const TABS = [
  { id: 'objectkenmerken', icon: '🔑', label: 'Objectkenmerken' },
  // Omgeving naar voren (13-09-2026, Arno: "Omgeving inderdaad naar voren") — buitenkant/fundering/
  // asbest bekijk je in de praktijk bij aankomst, vóórdat je naar binnen gaat voor Meting/Indeling.
  { id: 'omgeving', icon: '🏞️', label: 'Omgeving' },
  { id: 'meting', icon: '📐', label: 'Meting' },
  { id: 'indeling', icon: '🏠', label: 'Indeling' },
  { id: 'bouwkundig', icon: '🧱', label: 'Bouwkundig' },
  { id: 'energetisch', icon: '♻️', label: 'Energetisch' },
  // Nieuwe, EXTRA tab (18-09-2026, Arno's verzoek) — bewust NAAST Bouwkundig/Energetisch i.p.v.
  // die twee te vervangen ("zodat we niet de boel overhoop trekken"), een eerste proefopzet om te
  // zien of samengevoegde bouwdeel-kaarten (conditie+materiaal+foto uit Bouwkundig, isolatie+
  // installatiejaar uit Energetisch, in 1 kaart) sneller/overzichtelijker werken op locatie. Puur
  // een ANDERE weergave van dezelfde twee objecten — er wordt niets nieuws opgeslagen, dus de data
  // blijft vanzelf gesplitst en compleet richting Taxatieweb.
  // let op: id MOET kleine letters zijn — de hashchange-route-regex is /^#\/opname\/...\/([a-z]+)$/
  { id: 'bouwkundigenergetisch', icon: '🧩', label: 'Bouwkundig & Energetisch' },
  { id: 'fotos', icon: '📷', label: "Foto's" },
  { id: 'aantekeningen', icon: '📝', label: 'Notities' },
  { id: 'onderzoek', icon: '🔍', label: 'Onderzoek' },
  { id: 'controle', icon: '✅', label: 'Controle' },
];

// Instellingen-menu rechtsboven (12-09-2026): Macro's is geen eigen tabblad meer (Arno: "mag naar
// een submenuknop in nieuwe knop Instellingen"). Eén gedeelde open/dicht-status; een document-brede
// klik-listener (hieronder, module-scope — zelfde reden als de bestaande hashchange-listener: één
// keer registreren, niet per render) sluit het menu bij een klik erbuiten.
function renderInstellingenMenu(rapportId) {
  const knop = el('button', {
    class: 'instellingen-knop', title: 'Instellingen',
    onclick: (e) => { e.stopPropagation(); state.instellingenMenuOpen = !state.instellingenMenuOpen; render(); },
  }, '⚙️');
  if (!state.instellingenMenuOpen) return el('div', { class: 'instellingen-wrap' }, knop);
  const menu = el('div', { class: 'instellingen-menu' },
    el('button', {
      onclick: () => { state.instellingenMenuOpen = false; location.hash = '#/opname/' + encodeURIComponent(rapportId) + '/macros'; },
    }, "⚙️ Macro's"),
  );
  return el('div', { class: 'instellingen-wrap' }, knop, menu);
}
window.addEventListener('click', (e) => {
  if (!state.instellingenMenuOpen) return;
  const binnen = e.composedPath().some(el => el.classList && el.classList.contains('instellingen-wrap'));
  if (!binnen) { state.instellingenMenuOpen = false; render(); }
});

function renderOpnameScherm() {
  const t = state.taxatie;
  const wrap = el('div', { class: 'opname-scherm' });
  wrap.appendChild(el('div', { class: 'statusbalk' },
    el('button', { class: 'terug', onclick: () => { location.hash = ''; } }, '‹'),
    el('h1', {}, t.adres || t.rapport_id),
    el('span', { class: 'sync-pil ' + syncPilTekst().klasse }, syncPilTekst().tekst),
    renderInstellingenMenu(t.rapport_id),
  ));

  const inhoud = el('div', { class: 'inhoud' });
  if (state.route.tab === 'meting') inhoud.appendChild(renderMetingTab());
  else if (state.route.tab === 'indeling') inhoud.appendChild(renderIndelingTab());
  else if (state.route.tab === 'onderzoek') inhoud.appendChild(renderOnderzoekTab());
  else if (state.route.tab === 'objectkenmerken') inhoud.appendChild(renderObjectkenmerkenTab());
  else if (state.route.tab === 'bouwkundig') inhoud.appendChild(renderBouwkundigTab());
  else if (state.route.tab === 'energetisch') inhoud.appendChild(renderEnergetischTab());
  else if (state.route.tab === 'bouwkundigenergetisch') inhoud.appendChild(renderBouwkundigEnergetischTab());
  else if (state.route.tab === 'omgeving') inhoud.appendChild(renderOmgevingTab());
  else if (state.route.tab === 'fotos') inhoud.appendChild(renderFotosTab());
  else if (state.route.tab === 'aantekeningen') inhoud.appendChild(renderAantekeningenTab());
  else if (state.route.tab === 'macros') inhoud.appendChild(renderMacrosTab());
  else if (state.route.tab === 'controle') inhoud.appendChild(renderControleTab());
  wrap.appendChild(inhoud);

  const tabbalk = el('div', { class: 'tabbalk' });
  TABS.forEach(tab => {
    const actief = state.route.tab === tab.id;
    const verplichtNogNietKlaar = (tab.id === 'fotos' && bepaalVerplichteFotos().some(v => !v.klaar))
      || (tab.id === 'controle' && berekenControleResultaten().some(g => g.items.some(i => !i.ok)));
    tabbalk.appendChild(el('button', {
      class: (actief ? 'actief ' : '') + (verplichtNogNietKlaar ? 'badge-stip' : ''),
      onclick: () => { location.hash = '#/opname/' + encodeURIComponent(t.rapport_id) + '/' + tab.id; },
    }, el('span', { class: 'icon' }, tab.icon), tab.label));
  });
  wrap.appendChild(tabbalk);
  // Op een smalle telefoon scrolt de tabbalk nu horizontaal i.p.v. 10 tabs samen te persen (zie
  // style.css) — zorg dat de actieve tab bij het wisselen altijd meteen in beeld staat i.p.v. dat
  // Arno zelf moet zoeken/scrollen naar waar hij net op tikte.
  const actiefKnop = tabbalk.querySelector('button.actief');
  if (actiefKnop) requestAnimationFrame(() => actiefKnop.scrollIntoView({ inline: 'center', block: 'nearest' }));
  return wrap;
}

// --- Meting ---
// Sinds Arno's verzoek (07-09-2026): "ik wil de plattegronden ook kunnen tekenen net zoals in
// Taxatieweb" — poort van de Plattegrondschetser uit taxatieweb-opname.user.js (sinds v0.17.0
// daar): blokken als rechthoeken op een SVG-rooster, slepen om te verplaatsen, een grijpertje
// rechtsonder om te schalen. Schrijft rechtstreeks in blok.lengte/breedte/x/y — DEZELFDE velden
// als de klassieke lijst-weergave, dus wisselen tussen Tekenen/Lijst is altijd veilig en beide
// bewerken exact dezelfde data. Breedte = horizontale as, lengte = verticale as (zelfde keuze als
// het origineel, op Arno's eigen correctie destijds).
const BLOK_SCHAAL = 26; // pixels per meter
const BLOK_KLEUREN = {
  wonen: { rand: '#2d4a7c', vlak: 'rgba(45,74,124,0.16)' },
  overig: { rand: '#a06a1f', vlak: 'rgba(160,106,31,0.16)' },
  buitenruimte: { rand: '#3f6f47', vlak: 'rgba(63,111,71,0.16)' },
  correctie: { rand: '#9a3b3b', vlak: 'rgba(154,59,59,0.14)' },
};
function svgEl(tag, attrs) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
  return e;
}
function autoPlaatsBlok(woonlaag, blok) {
  if (blok.x !== null && blok.x !== undefined && blok.y !== null && blok.y !== undefined) return;
  const idx = woonlaag.blokken.indexOf(blok);
  blok.x = 0.5 + (idx % 4) * 3.5;
  blok.y = 0.5 + Math.floor(idx / 4) * 4.5;
}

function renderMetingTab() {
  const t = state.taxatie;
  const wrap = el('div', {});

  // Eigen 'meting-wissel'-klasse naast de gedeelde 'weergave-wissel'-styling (J.4/I.4 gebruiken die
  // laatste óók voor hun hoofd-/subtabbladen) — anders raakt de "beide naast elkaar op brede
  // schermen"-CSS hieronder per ongeluk ook die tabbladen (live gemeld door Arno: "Tabs (en subtabs)
  // in bouwkundige en energetische opnamestaat zijn verdwenen").
  const wissel = el('div', { class: 'weergave-wissel meting-wissel' });
  [['tekening', '✏️ Tekenen'], ['lijst', '📋 Lijst']].forEach(([modus, label]) => {
    wissel.appendChild(el('button', {
      class: state.afmetingenWeergave === modus ? 'actief' : '',
      onclick: () => { state.afmetingenWeergave = modus; render(); },
    }, label));
  });
  wrap.appendChild(wissel);

  wrap.appendChild(el('div', { class: 'section-label' }, 'Woonlagen'));
  t.data.afmetingen.woonlagen.forEach((woonlaag, wIdx) => {
    const kaart = el('div', { class: 'woonlaag-kaart modus-' + state.afmetingenWeergave });
    const naamInput = el('input', {
      value: woonlaag.naam || `${wIdx + 1}e woonlaag`, placeholder: `${wIdx + 1}e woonlaag`,
      oninput: (e) => {
        woonlaag.naam = e.target.value;
        zorgVoorIndelingWoonlaag(t.data, wIdx).naam = e.target.value; // gelijk houden met Indeling
        planOpslaan();
      },
    });
    koppelDatalist(naamInput, 'verdiepingen');
    kaart.appendChild(el('div', { class: 'woonlaag-titel' },
      el('span', { class: 'woonlaag-nummer' }, String(wIdx + 1)),
      pictogramVoorWoonlaag(woonlaag.naam),
      naamInput,
      el('span', { class: 'totaal' }, formatM2(woonlaagTotaal(woonlaag)) + ' m²'),
    ));

    // Arno (13-09-2026): "in Meting het tekenvenster en lijst naast elkaar zetten als de
    // schermbreedte voldoende is (vanaf iPhone in liggende stand)" — beide weergaven worden nu altijd
    // allebei gebouwd (ze bewerken toch al dezelfde blok-data); CSS bepaalt of alleen de actieve
    // weergave zichtbaar is (smal scherm, zie de 'modus-'-klasse op .woonlaag-kaart hierboven) of
    // beide naast elkaar (vanaf 650px, ruim genoeg voor de smalste iPhone in liggende stand).
    const lijstKolom = el('div', { class: 'weergave-kolom weergave-lijst' });
    (woonlaag.blokken || []).forEach((blok, bIdx) => {
      const blokNaamInput = el('input', { value: blok.naam || '', placeholder: 'Basis', oninput: (e) => { blok.naam = e.target.value; planOpslaan(); } });
      koppelDatalist(blokNaamInput, 'ruimteblokken');
      const rij = el('div', { class: 'blok-rij' },
        blokNaamInput,
        el('input', { value: blok.lengte || '', placeholder: '0,00', inputmode: 'decimal', oninput: (e) => { blok.lengte = e.target.value; planOpslaan(); renderZonderReload(); } }),
        el('span', { class: 'maal' }, '×'),
        el('input', { value: blok.breedte || '', placeholder: '0,00', inputmode: 'decimal', oninput: (e) => { blok.breedte = e.target.value; planOpslaan(); renderZonderReload(); } }),
        (() => {
          const sel = el('select', { onchange: (e) => { blok.type = e.target.value; planOpslaan(); } });
          [['wonen', 'Wonen'], ['overig', 'Overig inpandig'], ['buitenruimte', 'Buitenruimte'], ['correctie', 'Correctie']].forEach(([val, label]) => {
            const optie = el('option', { value: val }, label);
            if (blok.type === val) optie.selected = true;
            sel.appendChild(optie);
          });
          return sel;
        })(),
        el('button', { class: 'verwijder', onclick: () => { woonlaag.blokken.splice(bIdx, 1); planOpslaan(); render(); } }, '✕'),
      );
      lijstKolom.appendChild(rij);
    });
    const tekenKolom = el('div', { class: 'weergave-kolom weergave-tekening' }, renderTekenkader(woonlaag, wIdx));
    kaart.appendChild(el('div', { class: 'meting-weergaven' }, tekenKolom, lijstKolom));
    kaart.appendChild(el('button', { class: 'knop spook klein', onclick: () => { woonlaag.blokken.push(leegBlok()); planOpslaan(); render(); } }, '+ Blok toevoegen'));
    wrap.appendChild(kaart);
  });
  wrap.appendChild(el('button', {
    class: 'knop spook', style: 'margin-bottom:14px;',
    onclick: () => {
      t.data.afmetingen.woonlagen.push(leegWoonlaag());
      t.data.indeling.woonlagen.push(leegIndelingWoonlaag()); // gelijk houden met Indeling
      planOpslaan(); render();
    },
  }, '+ Woonlaag toevoegen'));

  wrap.appendChild(el('div', { class: 'section-label' }, 'Externe bergruimte'));
  (t.data.externeBergruimte.blokken || []).forEach((blok, i) => {
    wrap.appendChild(el('div', { class: 'blok-rij', style: 'grid-template-columns:1fr 60px 14px 60px 28px;margin-bottom:8px;' },
      el('input', { value: blok.naam || '', placeholder: 'Garage/berging', oninput: (e) => { blok.naam = e.target.value; planOpslaan(); } }),
      el('input', { value: blok.lengte || '', placeholder: '0,00', inputmode: 'decimal', oninput: (e) => { blok.lengte = e.target.value; planOpslaan(); } }),
      el('span', { class: 'maal' }, '×'),
      el('input', { value: blok.breedte || '', placeholder: '0,00', inputmode: 'decimal', oninput: (e) => { blok.breedte = e.target.value; planOpslaan(); } }),
      el('button', { class: 'verwijder', onclick: () => { t.data.externeBergruimte.blokken.splice(i, 1); planOpslaan(); render(); } }, '✕'),
    ));
  });
  wrap.appendChild(el('button', {
    class: 'knop spook',
    onclick: () => { t.data.externeBergruimte.blokken.push(leegExternBlok()); planOpslaan(); render(); },
  }, '+ Externe bergruimte toevoegen'));
  return wrap;
}

// Bouwt het tekenkader (SVG-rooster + rechthoeken) voor één woonlaag. Elk blok blijft hetzelfde
// object (blok.naam/type/lengte/breedte/x/y) als de lijst-weergave — alleen de manier van
// bewerken verandert. Zie taxatieweb-opname.user.js (Plattegrondschetser, sinds v0.17.0) voor het
// origineel waar dit 1-op-1 op gebaseerd is.
function renderTekenkader(woonlaag, wIdx) {
  woonlaag.blokken.forEach(b => autoPlaatsBlok(woonlaag, b));
  const kader = el('div', { class: 'tekenkader' });
  const svg = svgEl('svg', {});
  kader.appendChild(svg);

  function afmeting() {
    let maxX = 8, maxY = 12;
    woonlaag.blokken.forEach(b => {
      maxX = Math.max(maxX, b.x + naarGetal(b.breedte || 3) + 1);
      maxY = Math.max(maxY, b.y + naarGetal(b.lengte || 3) + 1);
    });
    return { breedteM: maxX, hoogteM: maxY };
  }

  function tekenRooster() {
    const { breedteM, hoogteM } = afmeting();
    const w = breedteM * BLOK_SCHAAL, h = hoogteM * BLOK_SCHAAL;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    Array.from(svg.querySelectorAll('g.rooster')).forEach(n => n.remove());
    const rooster = svgEl('g', { class: 'rooster' });
    for (let i = 0; i <= Math.ceil(breedteM); i++) {
      rooster.appendChild(svgEl('line', { x1: i * BLOK_SCHAAL, y1: 0, x2: i * BLOK_SCHAAL, y2: h, stroke: i % 5 === 0 ? '#d1d5db' : '#eef0f2', 'stroke-width': 1 }));
    }
    for (let j = 0; j <= Math.ceil(hoogteM); j++) {
      rooster.appendChild(svgEl('line', { x1: 0, y1: j * BLOK_SCHAAL, x2: w, y2: j * BLOK_SCHAAL, stroke: j % 5 === 0 ? '#d1d5db' : '#eef0f2', 'stroke-width': 1 }));
    }
    svg.insertBefore(rooster, svg.firstChild);
  }

  function hertekenBlokken() {
    Array.from(svg.querySelectorAll('g.blok')).forEach(el => el.remove());
    woonlaag.blokken.forEach((blok, bIdx) => tekenBlok(blok, bIdx));
  }

  function tekenBlok(blok, bIdx) {
    const kleur = BLOK_KLEUREN[blok.type] || BLOK_KLEUREN.wonen;
    const x = blok.x * BLOK_SCHAAL, y = blok.y * BLOK_SCHAAL;
    const w = Math.max(naarGetal(blok.breedte || 3) * BLOK_SCHAAL, 14);
    const h = Math.max(naarGetal(blok.lengte || 3) * BLOK_SCHAAL, 14);
    const g = svgEl('g', { class: 'blok' });
    const rect = svgEl('rect', { class: 'blok-rect', x, y, width: w, height: h, fill: kleur.vlak, stroke: kleur.rand, 'stroke-width': 1.6, rx: 3 });
    g.appendChild(rect);
    const label = svgEl('text', { class: 'blok-label', x: x + w / 2, y: y + h / 2 - 4, 'text-anchor': 'middle' });
    label.textContent = blok.naam || 'Blok ' + (bIdx + 1);
    g.appendChild(label);
    const maat = svgEl('text', { class: 'blok-maat', x: x + w / 2, y: y + h / 2 + 11, 'text-anchor': 'middle' });
    maat.textContent = formatM2(naarGetal(blok.lengte)) + ' × ' + formatM2(naarGetal(blok.breedte)) + ' m';
    g.appendChild(maat);
    const greep = svgEl('rect', { class: 'blok-greep', x: x + w - 9, y: y + h - 9, width: 11, height: 11, rx: 2 });
    g.appendChild(greep);
    svg.appendChild(g);
    rect.addEventListener('pointerdown', (e) => beginSlepen(e, blok));
    greep.addEventListener('pointerdown', (e) => beginSchalen(e, blok, bIdx));
  }

  function beginSlepen(e, blok) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY, x0 = blok.x, y0 = blok.y;
    function verplaatsen(ev) {
      blok.x = Math.max(0, x0 + (ev.clientX - startX) / BLOK_SCHAAL);
      blok.y = Math.max(0, y0 + (ev.clientY - startY) / BLOK_SCHAAL);
      tekenRooster(); hertekenBlokken();
    }
    function loslaten() {
      window.removeEventListener('pointermove', verplaatsen);
      window.removeEventListener('pointerup', loslaten);
      planOpslaan();
    }
    window.addEventListener('pointermove', verplaatsen);
    window.addEventListener('pointerup', loslaten);
  }

  function beginSchalen(e, blok, bIdx) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const breedte0 = naarGetal(blok.breedte || 3), lengte0 = naarGetal(blok.lengte || 3);
    function schalen(ev) {
      blok.breedte = Math.max(0.5, breedte0 + (ev.clientX - startX) / BLOK_SCHAAL).toFixed(2);
      blok.lengte = Math.max(0.5, lengte0 + (ev.clientY - startY) / BLOK_SCHAAL).toFixed(2);
      tekenRooster(); hertekenBlokken();
    }
    function loslaten() {
      window.removeEventListener('pointermove', schalen);
      window.removeEventListener('pointerup', loslaten);
      planOpslaan();
      renderZonderReload();
    }
    window.addEventListener('pointermove', schalen);
    window.addEventListener('pointerup', loslaten);
  }

  tekenRooster();
  hertekenBlokken();
  return kader;
}

function renderZonderReload() {
  // lichte update van alleen de m²-totalen, zonder de focus in de invoervelden te verliezen
  document.querySelectorAll('.woonlaag-kaart .totaal').forEach((elm, i) => {
    const woonlaag = state.taxatie.data.afmetingen.woonlagen[i];
    if (woonlaag) elm.textContent = formatM2(woonlaagTotaal(woonlaag)) + ' m²';
  });
}

// --- Indeling ---
function alleRuimtes() {
  const t = state.taxatie;
  const lijst = [];
  (t.data.indeling.woonlagen || []).forEach(w => (w.ruimtes || []).forEach(r => { if (r.naam) lijst.push(r); }));
  (t.data.indeling.extern || []).forEach(r => { if (r.naam) lijst.push(r); });
  return lijst;
}

// Ingeklapt-status per woonlaag — bewust NIET in taxatie.data (puur schermstatus, geen opnamedata),
// zelfde soort los UI-state-object als bouwdeelChipEditorOpen elders in dit bestand. Sleutel = index
// in woonlagen[], gereset bij een herlaadbeurt (allemaal weer uitgeklapt, dat is de veilige default).
const indelingIngeklapt = new Set();
// Zelfde soort los ingeklapt-statusje, maar dan voor het "Kenmerken verdieping"-blok specifiek
// (Arno's verzoek 16-09-2026) — onafhankelijk van indelingIngeklapt, zodat je de ruimtes van een
// verdieping kunt zien terwijl de kenmerken zelf ingeklapt blijven, of andersom.
const kenmerkenIngeklapt = new Set();
// Zelfde ephemere status, maar per RUIMTE (17-09-2026, Arno's verzoek: "ruimtes per verdieping ook
// inklapbaar maken en kunnen verslepen") — sleutel "wIdx:rIdx", dus gekoppeld aan de huidige positie
// in de array (net als hierboven bij woonlagen); na een sleep-herordening kan dit dus een ander item
// betreffen dan waar de gebruiker 'm oorspronkelijk voor opende, een bewust geaccepteerd klein
// bijeffect van een puur visuele, niet-opgeslagen status.
const ruimteIngeklapt = new Set();

// Arno's verzoek 16-09-2026: verdiepingnamen groter/dikgedrukt, elke verdieping inklapbaar en in een
// eigen visueel "blok" met alle ruimtes erin — voor herkenbaarheid bij een opname met veel woonlagen.
// "Kenmerken verdieping" (Arno's verzoek 16-09-2026) — 5 multiselect-velden bovenaan elke woonlaag,
// opties uit de gelijknamige (bewerkbare) macro's, zelfde uiterlijk als een bouwkundig materiaal-
// multiselect (.bouwdeel-materiaal-grid) voor visuele consistentie met de rest van de opname.
const KENMERKEN_VERDIEPING_VELDEN = [
  { sleutel: 'vloersoort', label: 'Vloersoort' },
  { sleutel: 'kozijnen', label: 'Kozijnen' },
  { sleutel: 'glastypes', label: 'Glastypes' },
  { sleutel: 'verwarmingssysteem', label: 'Verwarmingssysteem' },
  { sleutel: 'vloerafwerking', label: 'Vloerafwerking' },
];
function renderWoonlaagKenmerken(woonlaag, wIdx) {
  if (!woonlaag.kenmerken) woonlaag.kenmerken = leegWoonlaagKenmerken();
  const ingeklapt = kenmerkenIngeklapt.has(wIdx);
  const kaart = el('div', { class: 'bouwdeel-kaart kenmerken-verdieping-kaart' });
  kaart.appendChild(el('div', {
    class: 'woonlaag-kop kenmerken-kop',
    onclick: () => { if (ingeklapt) kenmerkenIngeklapt.delete(wIdx); else kenmerkenIngeklapt.add(wIdx); render(); },
  },
    el('button', { type: 'button', class: 'woonlaag-toggle' }, ingeklapt ? '▸' : '▾'),
    el('div', { class: 'bouwdeel-titel' }, 'Kenmerken verdieping'),
  ));
  if (ingeklapt) return kaart;
  KENMERKEN_VERDIEPING_VELDEN.forEach(({ sleutel, label }) => {
    if (!Array.isArray(woonlaag.kenmerken[sleutel])) woonlaag.kenmerken[sleutel] = [];
    const gekozen = woonlaag.kenmerken[sleutel];
    kaart.appendChild(el('div', { class: 'bouwdeel-veld-label kenmerken-veld-label' }, label));
    const grid = el('div', { class: 'bouwdeel-materiaal-grid' });
    (state.macros[sleutel] || []).forEach((optie) => {
      grid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
        el('input', {
          type: 'checkbox', checked: gekozen.includes(optie) ? 'checked' : null,
          onchange: () => {
            const i = gekozen.indexOf(optie);
            if (i >= 0) gekozen.splice(i, 1); else gekozen.push(optie);
            planOpslaan(); render();
          },
        }), optie));
    });
    kaart.appendChild(grid);
  });
  return kaart;
}
// Kleine pictogrammen per bouwlaagtype (18-09-2026, Arno's verzoek n.a.v. de taXapi-vergelijking:
// "leuk idee, kun je dat ontwerpen in eenzelfde look") — puur decoratief, voor snellere oriëntatie
// bij een opname met veel verdiepingen. Losse SVG-strings i.p.v. el(), want el() bouwt via
// document.createElement() (geen SVG-namespace) — hier bewust een vaste, eigen tekststring (geen
// gebruikersinvoer) dus veilig via innerHTML.
const WOONLAAG_ICOON_SVG = {
  zolder: '<path d="M4 13 12 5 20 13"/><path d="M12 9v3"/><circle cx="12" cy="15.5" r="1.8"/>',
  beganeGrond: '<path d="M4 20V10l8-6 8 6v10"/><path d="M10 20v-6h4v6"/>',
  verdieping: '<rect x="5" y="5" width="14" height="14" rx="1.5"/><path d="M12 5v14M5 12h14"/>',
  kelder: '<path d="M3 9h18"/><path d="M5 9v10h14V9"/><path d="M8 13l2 2M8 17l2 2M13 13l2 2M13 17l2 2"/>',
};
function pictogramVoorWoonlaag(naam) {
  const n = (naam || '').toLowerCase();
  const sleutel = n.includes('kelder') ? 'kelder' : n.includes('zolder') ? 'zolder' : n.includes('begane grond') ? 'beganeGrond' : 'verdieping';
  const wrap = el('span', { class: 'woonlaag-icoon' });
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${WOONLAAG_ICOON_SVG[sleutel]}</svg>`;
  return wrap;
}
function renderIndelingTab() {
  const t = state.taxatie;
  const wrap = el('div', {});
  t.data.indeling.woonlagen.forEach((woonlaag, wIdx) => {
    const ingeklapt = indelingIngeklapt.has(wIdx);
    const blok = el('div', { class: 'woonlaag-blok' });

    const naamInput = el('input', {
      class: 'woonlaag-naam-invoer',
      value: woonlaag.naam || '', placeholder: `Naam woonlaag (bv. "Begane grond")`,
      oninput: (e) => {
        woonlaag.naam = e.target.value;
        zorgVoorAfmetingenWoonlaag(t.data, wIdx).naam = e.target.value; // gelijk houden met Meting
        planOpslaan();
      },
    });
    koppelDatalist(naamInput, 'verdiepingen');
    blok.appendChild(el('div', { class: 'woonlaag-kop' },
      el('button', {
        type: 'button', class: 'woonlaag-toggle',
        onclick: () => { if (ingeklapt) indelingIngeklapt.delete(wIdx); else indelingIngeklapt.add(wIdx); render(); },
      }, ingeklapt ? '▸' : '▾'),
      el('span', { class: 'woonlaag-nummer' }, String(wIdx + 1)),
      pictogramVoorWoonlaag(woonlaag.naam),
      naamInput,
    ));

    if (!ingeklapt) {
      const inhoud = el('div', { class: 'woonlaag-inhoud' });
      inhoud.appendChild(renderWoonlaagKenmerken(woonlaag, wIdx));
      // "Alles in-/uitklappen" (17-09-2026, Arno's verzoek) — 1 knop bovenaan de ruimtelijst i.p.v.
      // elke ruimte los te moeten in-/uitklappen bij een verdieping met veel ruimtes. Label/actie
      // hangt af van de HUIDIGE staat: zodra minstens 1 ruimte nog openstaat, klapt de knop ALLES
      // dicht; pas als alles al dicht staat, klapt 'ie alles weer open.
      const ruimtes = woonlaag.ruimtes || [];
      if (ruimtes.length > 1) {
        const alleKeys = ruimtes.map((_, rIdx) => wIdx + ':' + rIdx);
        const allemaalIngeklapt = alleKeys.every((k) => ruimteIngeklapt.has(k));
        inhoud.appendChild(el('button', {
          type: 'button', class: 'knop spook klein', style: 'margin-bottom:8px;',
          onclick: () => {
            if (allemaalIngeklapt) alleKeys.forEach((k) => ruimteIngeklapt.delete(k));
            else alleKeys.forEach((k) => ruimteIngeklapt.add(k));
            render();
          },
        }, allemaalIngeklapt ? '▾ Alle ruimtes uitklappen' : '▸ Alle ruimtes inklappen'));
      }
      (woonlaag.ruimtes || []).forEach((ruimte, rIdx) => {
        inhoud.appendChild(renderRuimteKaart(ruimte, () => {
          if (!confirm(`"${ruimte.naam || 'deze ruimte'}" verwijderen? Dit kan niet ongedaan gemaakt worden.`)) return;
          woonlaag.ruimtes.splice(rIdx, 1); planOpslaan(); render();
        }, {
          collapseKey: wIdx + ':' + rIdx, ruimtesArray: woonlaag.ruimtes, index: rIdx,
        }));
      });
      inhoud.appendChild(el('button', {
        class: 'knop spook klein',
        onclick: () => { woonlaag.ruimtes.push(leegRuimte()); planOpslaan(); render(); },
      }, '+ Ruimte toevoegen'));
      blok.appendChild(inhoud);
    }
    wrap.appendChild(blok);
  });
  wrap.appendChild(el('button', {
    class: 'knop spook', style: 'margin-bottom:16px;',
    onclick: () => {
      t.data.indeling.woonlagen.push(leegIndelingWoonlaag());
      t.data.afmetingen.woonlagen.push(leegWoonlaag()); // gelijk houden met Meting
      planOpslaan(); render();
    },
  }, '+ Woonlaag toevoegen'));

  wrap.appendChild(renderBijgebouwenSectie());
  return wrap;
}

// sleepInfo: { collapseKey, ruimtesArray, index } — undefined zolang renderRuimteKaart nog voor
// een niet-versleepbare/niet-inklapbare lijst gebruikt zou worden (momenteel niet meer het geval,
// maar zo blijft de functie ook bruikbaar zonder sleepInfo).
function renderRuimteKaart(ruimte, verwijder, sleepInfo) {
  const ingeklapt = sleepInfo && ruimteIngeklapt.has(sleepInfo.collapseKey);
  const kaart = el('div', { class: 'ruimte-kaart' + (ingeklapt ? ' ruimte-kaart-ingeklapt' : '') });
  // Sleepbaar herordenen binnen dezelfde woonlaag (17-09-2026, Arno's verzoek "kunnen verslepen"),
  // zelfde HTML5-drag-patroon als renderChipEditor() elders in dit bestand.
  if (sleepInfo) {
    kaart.draggable = true;
    kaart.classList.add('ruimte-kaart-sleepbaar');
    kaart.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(sleepInfo.index)); });
    kaart.addEventListener('dragover', (e) => e.preventDefault());
    kaart.addEventListener('drop', (e) => {
      e.preventDefault();
      const van = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (isNaN(van) || van === sleepInfo.index) return;
      const [verplaatst] = sleepInfo.ruimtesArray.splice(van, 1);
      sleepInfo.ruimtesArray.splice(sleepInfo.index, 0, verplaatst);
      planOpslaan(); render();
    });
  }
  const rijBoven = el('div', { class: 'ruimte-rij-boven' });
  if (sleepInfo) rijBoven.appendChild(el('span', { class: 'ruimte-sleepgreep' }, '⠿'));
  if (sleepInfo) {
    rijBoven.appendChild(el('button', {
      type: 'button', class: 'woonlaag-toggle',
      onclick: () => { if (ingeklapt) ruimteIngeklapt.delete(sleepInfo.collapseKey); else ruimteIngeklapt.add(sleepInfo.collapseKey); render(); },
    }, ingeklapt ? '▸' : '▾'));
  }
  if (ingeklapt) {
    // Ingeklapt: alleen naam + status tonen, geen bewerkbaar invoerveld (voorkomt per ongeluk typen
    // in een niet-zichtbare rest van de kaart). Status (17-09-2026, Arno's verzoek): foto-status
    // altijd, plus bij keuken/toilet/badkamer een aparte apparatuur-/sanitair-status — zodat je ook
    // ingeklapt in 1 oogopslag ziet of er nog iets ontbreekt, zonder elke ruimte te moeten openen.
    const aantal = (ruimte.toevoegingen || []).length;
    const naamSpan = el('span', { class: 'ruimte-naam-ingeklapt' },
      ruimte.naam || 'Ruimte', aantal ? ` — ${aantal} toevoeging${aantal === 1 ? '' : 'en'}` : '');
    rijBoven.appendChild(naamSpan);
    const statusRij = el('span', { class: 'ruimte-status-ingeklapt' });
    statusRij.appendChild(el('span', { class: 'ruimte-status-badge' + (heeftFotoVoorRuimte(ruimte) ? ' ok' : '') }, '📷'));
    const categorie = categorieVoorRuimte(ruimte.naam);
    if (categorie === 'keuken') {
      statusRij.appendChild(el('span', {
        class: 'ruimte-status-badge' + (heeftCategorieToevoeging(ruimte, 'keuken') ? ' ok' : ''),
        title: 'Keukenapparatuur ingevuld',
      }, '🍳'));
    } else if (categorie === 'sanitair') {
      statusRij.appendChild(el('span', {
        class: 'ruimte-status-badge' + (heeftCategorieToevoeging(ruimte, 'sanitair') ? ' ok' : ''),
        title: 'Sanitair ingevuld',
      }, '🚿'));
    }
    rijBoven.appendChild(statusRij);
    rijBoven.appendChild(el('button', { class: 'verwijder', onclick: verwijder }, '✕'));
    kaart.appendChild(rijBoven);
    return kaart;
  }
  const ruimteNaamInput = el('input', {
    value: ruimte.naam || '', placeholder: 'Ruimte (bv. "Woonkamer")',
    oninput: (e) => { ruimte.naam = e.target.value; planOpslaan(); },
  });
  koppelDatalist(ruimteNaamInput, 'ruimtes');
  rijBoven.appendChild(ruimteNaamInput);
  rijBoven.appendChild(el('button', { class: 'verwijder', onclick: verwijder }, '✕'));
  kaart.appendChild(rijBoven);
  // Arno (13-09-2026): "Graag in de app de foto waar ie gemaakt is gelijk als miniatuur daar
  // weergeven. En optie voor nog een foto toevoegen." — zelfde bouwsteen als bij Bouwkundig/
  // Energetisch (renderFotoKnopRij): toont meteen miniaturen van al gemaakte foto's bij DEZE ruimte
  // plus een knop om er nog een te maken/toevoegen. Vervangt het oude losse camera-icoontje, dat geen
  // enkele terugkoppeling gaf of er al een foto stond.
  kaart.appendChild(renderFotoKnopRij(ruimte.naam, bepaalQRCategorieVoorRuimte(ruimte.naam) || 'Anders', false));
  const chipRij = el('div', { class: 'chip-rij' });
  (ruimte.toevoegingen || []).forEach((tekst, i) => {
    chipRij.appendChild(el('span', { class: 'chip' }, tekst,
      el('button', { onclick: () => { ruimte.toevoegingen.splice(i, 1); planOpslaan(); render(); } }, '✕'),
    ));
  });
  kaart.appendChild(chipRij);

  // Twee LOSSE invoervelden bij keuken/badkamer/toilet (eigen categorielijst + de algemene lijst,
  // apart — niet samengevoegd), één veld bij overige ruimtes — zelfde opzet als
  // renderToevoegingVeld() in taxatieweb-opname.user.js (Arno: "Bij keuken, toilet en badkamer 2
  // keuzelijsten, namelijk de standaardlijst en respectievelijk de lijst voor de keuken en sanitair
  // voor toilet en badkamer").
  const maakToevoegVeld = (macroSleutel, placeholder) => {
    const invoer = el('input', { placeholder });
    koppelDatalist(invoer, macroSleutel, () => ruimte.toevoegingen || []);
    const bevestigToevoeging = () => {
      if (!invoer.value.trim()) return;
      if (!Array.isArray(ruimte.toevoegingen)) ruimte.toevoegingen = [];
      ruimte.toevoegingen.push(invoer.value.trim());
      planOpslaan(); render();
    };
    invoer.addEventListener('keydown', (e) => { if (e.key === 'Enter') bevestigToevoeging(); });
    // 'change' wordt door de suggestie-dropdown gedispatcht (zie koppelDatalist/toonEigenSuggesties)
    // — zonder dit luistert een klik op een suggestie alleen naar Enter en blijft de chip onbevestigd.
    invoer.addEventListener('change', bevestigToevoeging);
    return invoer;
  };

  const invoerWrap = el('div', { class: 'toevoeging-invoeren' });
  const categorie = categorieVoorRuimte(ruimte.naam);
  if (categorie === 'sanitair') {
    invoerWrap.appendChild(maakToevoegVeld('sanitair', 'Sanitair (bv. "inloopdouche")'));
    invoerWrap.appendChild(maakToevoegVeld('toevoegingen', 'Standaard (bv. "meterkast")'));
  } else if (categorie === 'keuken') {
    invoerWrap.appendChild(maakToevoegVeld('keuken', 'Keuken (bv. "inductiekookplaat")'));
    invoerWrap.appendChild(maakToevoegVeld('toevoegingen', 'Standaard (bv. "meterkast")'));
  } else {
    invoerWrap.appendChild(maakToevoegVeld('toevoegingen', 'Toevoeging (bv. "meterkast")'));
  }
  kaart.appendChild(el('div', { class: 'chip-toevoegen' }, invoerWrap));
  return kaart;
}

// --- Bij-/aanbouwen en buitenvoorzieningen (17-09-2026, Arno's verzoek: "een oplossing voor
// bijgebouwen ... zoals Provadie's Bij-/aanbouwen en buitenvoorzieningen") ---
// Generieke N-weg keuzeknoppenrij, zelfde opbouw als renderJaNeeToggle hierboven maar met vrij te
// kiezen labels/waarden — hergebruikt voor Soort (2-weg) en Isolatie (3-weg) hieronder.
function renderKeuzeknoppenRij(labelText, huidigeWaarde, opties, onChange) {
  const wissel = el('div', { class: 'weergave-wissel' });
  opties.forEach(([waarde, tekst]) => {
    wissel.appendChild(el('button', {
      type: 'button', class: 'klein' + (huidigeWaarde === waarde ? ' actief' : ''),
      onclick: () => { onChange(waarde); planOpslaan(); render(); },
    }, tekst));
  });
  return el('div', { class: 'bouwdeel-conditie-rij' }, el('span', { class: 'bouwdeel-veld-label' }, labelText), wissel);
}
// Multiselect-chipgrid, zelfde bouwsteen als de materiaal-grid bij Bouwkundig/Energetisch — hier
// losstaand omdat een bijgebouw geen def/kenmerkenKoppeling heeft, alleen een array + macro-lijst.
function renderMultiselectGrid(lijst, opties) {
  const grid = el('div', { class: 'bouwdeel-materiaal-grid' });
  opties.forEach((optie) => {
    const aan = lijst.includes(optie);
    grid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
      el('input', {
        type: 'checkbox', checked: aan ? 'checked' : null,
        onchange: () => {
          const i = lijst.indexOf(optie);
          if (i >= 0) lijst.splice(i, 1); else lijst.push(optie);
          planOpslaan(); render();
        },
      }), optie));
  });
  return grid;
}
// Eén-regel-samenvatting van een bijgebouw — gebruikt in de Indeling-tekst (componeerIndelingTekst,
// dus ook in H.1.C-sync/PDF) én als bron voor de "↺ Overnemen uit Indeling"-knop bij Bouwkundig's
// Schuur/berging, Garage en Overige bijgebouwen (Arno: "deze teksten komen samengevat terug in de
// indeling en Bouwkundige opnamestaat").
function samenvatBijgebouw(item) {
  const delen = [item.type || 'Bijgebouw'];
  const soortTekst = item.soort === true ? 'aangebouwd' : item.soort === false ? 'vrijstaand' : null;
  const details = [soortTekst, ...(item.materialen || []).map(m => m.toLowerCase())].filter(Boolean);
  if (details.length) delen.push(`(${details.join(', ')})`);
  if (item.isolatie) delen.push(`— isolatie: ${item.isolatie.toLowerCase()}`);
  if ((item.extras || []).length) delen.push(`— ${item.extras.join(', ').toLowerCase()}`);
  delen.push(`— conditie ${(CONDITIE_LABELS[item.conditie] || '').toLowerCase()}`);
  return delen.join(' ');
}
// Bepaalt welk Bouwkundig-veld (Schuur/berging, Garage of Overige bijgebouwen) bij een bijgebouw-type
// hoort, voor de "↺ Overnemen"-knop — zelfde substring-matchidee als categorieVoorRuimte() hierboven.
function bouwkundigVeldVoorBijgebouwType(type) {
  const naam = (type || '').toLowerCase();
  if (naam.includes('garage') || naam.includes('carport')) return 'garage';
  if (naam.includes('schuur') || naam.includes('berging') || naam.includes('loods') || naam.includes('kapschuur')) return 'schuurBerging';
  return 'overigeBijgebouwen';
}
// Klein ✎-knopje dat de bewerk-editor voor 1 macro-lijst open/dicht klapt — zelfde bouwsteen als
// renderBouwdeelChips gebruikt (bouwdeelChipEditorOpen/renderChipEditor), hier losstaand aanroepbaar
// omdat Bijgebouwen geen def/bouwdeel-object heeft om dat via het bestaande pad te hergebruiken
// (17-09-2026, Arno's verzoek: Type/Extra's/Materiaal "als macrolijst weergeven, uitbreidbaar en
// aanpasbaar" — rechtstreeks vanuit Indeling i.p.v. via het aparte Macros-tabblad).
function renderMacroBewerkKnop(macroSleutel) {
  return el('button', {
    type: 'button', class: 'chip-bewerk-knop', title: 'Lijst bewerken',
    onclick: (e) => { e.stopPropagation(); bouwdeelChipEditorOpen[macroSleutel] = !bouwdeelChipEditorOpen[macroSleutel]; render(); },
  }, '✎');
}
function renderBijgebouwKaart(item, idx, verwijder) {
  const ingeklapt = bijgebouwIngeklapt.has(idx);
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  const kop = el('div', {
    class: 'bouwdeel-kop',
    onclick: () => { if (ingeklapt) bijgebouwIngeklapt.delete(idx); else bijgebouwIngeklapt.add(idx); render(); },
  },
    el('button', { type: 'button', class: 'woonlaag-toggle' }, ingeklapt ? '▸' : '▾'),
    el('span', { class: 'bouwdeel-titel' }, item.type || 'Nieuw bijgebouw'));
  kaart.appendChild(kop);
  if (ingeklapt) {
    // Ingeklapt: samenvatting + foto-status, zelfde idee als de ingeklapte ruimte-kaart hierboven
    // (Arno's verzoek 17-09-2026: "inklapbaar maken met kenmerken foto info ed., zelfde als
    // verdiepingen").
    const infoRij = el('div', { class: 'bijgebouw-info-ingeklapt' },
      el('span', { class: 'ruimte-naam-ingeklapt' }, item.type ? samenvatBijgebouw(item) : 'Nog geen type gekozen'),
      el('span', { class: 'ruimte-status-badge' + (heeftFotoVoorRuimte({ naam: item.type }) ? ' ok' : '') }, '📷'),
      el('button', { class: 'verwijder', onclick: verwijder }, '✕'));
    kaart.appendChild(infoRij);
    return kaart;
  }

  const typeRij = el('div', { class: 'ruimte-rij-boven' });
  const typeInput = el('input', {
    value: item.type || '', placeholder: 'Type (bv. "Garage", "Overkapping")',
    onclick: (e) => e.stopPropagation(),
    oninput: (e) => { item.type = e.target.value; planOpslaan(); },
  });
  koppelDatalist(typeInput, 'bijgebouwTypes');
  typeRij.appendChild(typeInput);
  typeRij.appendChild(renderMacroBewerkKnop('bijgebouwTypes'));
  typeRij.appendChild(el('button', { class: 'verwijder', onclick: verwijder }, '✕'));
  kaart.appendChild(typeRij);
  if (bouwdeelChipEditorOpen.bijgebouwTypes) kaart.appendChild(renderChipEditor(state.macros.bijgebouwTypes, bewaarMacros));

  kaart.appendChild(renderKeuzeknoppenRij('Soort', item.soort, [[false, 'Vrijstaand'], [true, 'Aangebouwd']], (w) => { item.soort = w; }));

  kaart.appendChild(el('div', { class: 'bouwdeel-veld-label-rij' },
    el('span', { class: 'bouwdeel-veld-label' }, 'Materiaal'), renderMacroBewerkKnop('bijgebouwMateriaal')));
  if (!Array.isArray(item.materialen)) item.materialen = [];
  kaart.appendChild(renderMultiselectGrid(item.materialen, state.macros.bijgebouwMateriaal || []));
  if (bouwdeelChipEditorOpen.bijgebouwMateriaal) kaart.appendChild(renderChipEditor(state.macros.bijgebouwMateriaal, bewaarMacros));

  kaart.appendChild(renderKeuzeknoppenRij('Isolatie', item.isolatie, [['Geen', 'Geen'], ['Deels', 'Deels'], ['Volledig', 'Volledig']], (w) => { item.isolatie = w; }));

  kaart.appendChild(el('div', { class: 'bouwdeel-veld-label-rij' },
    el('span', { class: 'bouwdeel-veld-label' }, "Extra's"), renderMacroBewerkKnop('bijgebouwExtras')));
  if (!Array.isArray(item.extras)) item.extras = [];
  kaart.appendChild(renderMultiselectGrid(item.extras, state.macros.bijgebouwExtras || []));
  if (bouwdeelChipEditorOpen.bijgebouwExtras) kaart.appendChild(renderChipEditor(state.macros.bijgebouwExtras, bewaarMacros));

  kaart.appendChild(conditieRij(item));
  // Foto per bijgebouw (17-09-2026, zelfde idee als bij een ruimte/bouwdeel) — categorie op het
  // type gebaseerd, zodat elk bijgebouw z'n eigen foto('s) krijgt i.p.v. alles onder "Anders".
  const naam = item.type || 'Bijgebouw';
  kaart.appendChild(renderFotoKnopRij(naam, naam, false));
  // Achterstallig onderhoud (18-09-2026, zelfde regel als bij Bouwkundig) — eigen verplicht
  // foto-slot zodra de conditie slecht of matig is.
  if (item.conditie === 2 || item.conditie === 3) {
    kaart.appendChild(renderFotoKnopRij('Achterstallig onderhoud ' + naam, 'Achterstallig onderhoud ' + naam, true));
  }
  return kaart;
}
// bijgebouwIngeklapt: ephemere UI-status (net als indelingIngeklapt/ruimteIngeklapt), sleutel = index
// in data.bijgebouwen[]. bijgebouwenSectieIngeklapt: ephemere status voor de HELE sectie-kop.
const bijgebouwIngeklapt = new Set();
let bijgebouwenSectieIngeklapt = false;
function renderBijgebouwenSectie() {
  const t = state.taxatie;
  if (!Array.isArray(t.data.bijgebouwen)) t.data.bijgebouwen = [];
  // Zelfde look + inklapbaarheid als een woonlaag-blok hierboven (Arno's verzoek 17-09-2026: "zelfde
  // look ... ook inklapbaar"), met een grotere titel dan het vorige kleine "Extern"-kopje.
  const blok = el('div', { class: 'woonlaag-blok' });
  blok.appendChild(el('div', {
    class: 'woonlaag-kop',
    onclick: () => { bijgebouwenSectieIngeklapt = !bijgebouwenSectieIngeklapt; render(); },
  },
    el('button', { type: 'button', class: 'woonlaag-toggle' }, bijgebouwenSectieIngeklapt ? '▸' : '▾'),
    el('span', { class: 'woonlaag-naam-invoer' }, 'Bij-/aanbouwen en buitenvoorzieningen')));
  if (!bijgebouwenSectieIngeklapt) {
    const inhoud = el('div', { class: 'woonlaag-inhoud' });
    t.data.bijgebouwen.forEach((item, idx) => {
      inhoud.appendChild(renderBijgebouwKaart(item, idx, () => {
        if (!confirm(`"${item.type || 'dit bijgebouw'}" verwijderen? Dit kan niet ongedaan gemaakt worden.`)) return;
        t.data.bijgebouwen.splice(idx, 1); planOpslaan(); render();
      }));
    });
    inhoud.appendChild(el('button', {
      type: 'button', class: 'knop spook klein',
      onclick: () => { t.data.bijgebouwen.push(leegBijgebouw()); planOpslaan(); render(); },
    }, '+ Bijgebouw toevoegen'));
    blok.appendChild(inhoud);
  }
  return blok;
}

// --- Foto's ---
function bepaalQRCategorieVoorRuimte(ruimteNaam) {
  const kaal = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const doel = kaal(ruimteNaam);
  if (!doel) return null;
  const treffer = QR_CATEGORIEEN.find(c => { const kc = kaal(c); return doel === kc || doel.startsWith(kc) || doel.includes(kc); });
  return treffer || null;
}

// Arno (13-09-2026): "Zolderfoto is ook verplicht als de zolder aanwezig is" — een zolder kan een
// WOONLAAG zijn (Meting/Indeling) zonder dat er per se een losse "ruimte" voor is aangemaakt, dus
// niet alleen via alleRuimtes() (die alleen Indeling-ruimtes ziet) maar ook de woonlaagnamen zelf
// checken.
function heeftZolder() {
  const t = state.taxatie;
  const bevatZolder = (naam) => /zolder/i.test(naam || '');
  const woonlagen = [...(t.data.afmetingen.woonlagen || []), ...(t.data.indeling.woonlagen || [])];
  if (woonlagen.some(w => bevatZolder(w.naam))) return true;
  return alleRuimtes().some(r => bevatZolder(r.naam));
}

function bepaalVerplichteFotos() {
  const t = state.taxatie;
  const items = VASTE_VERPLICHTE_FOTOS.map(naam => ({ naam, categorie: naam }));
  // Arno (13-09-2026): "Tuinfoto is ook verplicht als tuin geselecteerd is" — tuinAanwezig===null
  // (nog geen woningtype/keuze) telt ook als verplicht, alleen een expliciete "Nee" sluit 'm uit.
  if (t.bewoning.tuinAanwezig !== false) items.push({ naam: 'Tuin', categorie: 'Tuin' });
  // per ruimte-instantie uit Indeling — gegroepeerd per categorie zodat "3 slaapkamers" ook echt
  // 3 losse verplichte foto's oplevert i.p.v. 1.
  const groepen = {};
  alleRuimtes().forEach(r => {
    const cat = bepaalQRCategorieVoorRuimte(r.naam) || r.naam;
    if (!groepen[cat]) groepen[cat] = [];
    groepen[cat].push(r.naam);
  });
  Object.entries(groepen).forEach(([cat, namen]) => {
    if ((VASTE_VERPLICHTE_FOTOS.includes(cat) || cat === 'Tuin') && namen.length <= 1) return; // al gedekt
    namen.forEach((naam, i) => {
      items.push({ naam: namen.length > 1 ? `${cat} ${i + 1}/${namen.length}` : cat, categorie: cat, instantie: i });
    });
  });
  // Zolder: alleen aanvullen als er nog geen "Zolder"-item via de ruimte-groepering hierboven bij zit
  // (bv. een ruimte die letterlijk "Zolder" heet levert dat al op).
  if (heeftZolder() && !items.some(i => i.categorie === 'Zolder')) items.push({ naam: 'Zolder', categorie: 'Zolder' });
  // Foto's die als "eigen archief" gemarkeerd zijn tellen niet mee voor de checklist — dat zijn
  // bewust extra opnamen voor Arno's eigen naslag, niet bedoeld voor Q/R. Cloud-only foto's (wél
  // geüpload, niet meer lokaal) tellen WEL mee — anders lijkt de checklist onterecht onvolledig na
  // een cache-leging/ander toestel (Arno's melding 16-09-2026).
  const cloudAlsFotos = (state.cloudFotos || []).map(cf => ({ categorie: cf.categorie, ruimte_label: cf.ruimteLabel, instantie: 0 }));
  const relevanteFotos = state.fotos.filter(f => !f.archief).concat(cloudAlsFotos);
  const gemaakt = relevanteFotos.map(f => f.categorie + '::' + (f.instantie || 0));
  return items.map((item, i) => ({ ...item, klaar: gemaakt.includes((item.categorie) + '::' + (item.instantie || 0)) || relevanteFotos.some(f => f.ruimte_label === item.naam) }));
}

// --- Controle ---
// Arno (13-09-2026): "knop Controle toevoegen aan app. Hiermee wordt gecontroleerd of alle verplichte
// velden zijn ingevuld in de app. Velden isolatie, bouw-/installatiejaren, verplichte foto's ed.
// Breiden we later nog uit" — bewust een lijst van {titel, items:[{tekst,ok,tab}]}-groepen, zodat een
// volgende sessie makkelijk een nieuwe groep kan toevoegen zonder de rest te hoeven aanpassen.
function berekenControleResultaten() {
  const t = state.taxatie;
  const groepen = [];

  groepen.push({
    titel: 'Objectkenmerken',
    items: [
      { tekst: 'Woningtype ingevuld', ok: !!(t.bewoning.woningtype && t.bewoning.woningtype.trim()), tab: 'objectkenmerken' },
      { tekst: 'Bouwjaar ingevuld', ok: !!(t.bewoning.bouwjaar && String(t.bewoning.bouwjaar).trim()), tab: 'objectkenmerken' },
    ],
  });

  // Bouwkundig: elk AANWEZIG bouwdeel met een 'jaar'-detail (Verwarmings-/Warmwatertoestel) moet dat
  // jaartal ingevuld hebben.
  const bouwkundigItems = [];
  ['buitenzijde', 'binnenzijde', 'installaties'].forEach(hoofdId => {
    Object.entries(BOUWKUNDIG_SCHEMA[hoofdId] || {}).forEach(([sectieId, defs]) => {
      defs.forEach(def => {
        if (!def.details || !def.details.some(d => d.type === 'jaar')) return;
        const bouwdeel = t.bouwkundig[hoofdId] && t.bouwkundig[hoofdId][sectieId] && t.bouwkundig[hoofdId][sectieId][def.key];
        if (!bouwdeel || !bouwdeel.aanwezig) return;
        def.details.filter(d => d.type === 'jaar').forEach(d => {
          const waarde = bouwdeel.details && bouwdeel.details[d.key];
          bouwkundigItems.push({ tekst: `${def.label} — ${d.label}`, ok: !!(waarde && String(waarde).trim()), tab: 'bouwkundig' });
        });
      });
    });
  });
  if (bouwkundigItems.length) groepen.push({ titel: 'Bouwkundig — bouwjaren', items: bouwkundigItems });

  // Energetisch: elk AANWEZIG veld met een Installatiemoment-keuze (isolatie/installaties/
  // energieopwekking delen allemaal hetzelfde installatiemoment/jaar-patroon) moet dat ingevuld
  // hebben — en bij "Installatiejaar" ook het jaartal zelf.
  const energetischItems = [];
  const checkEnergetischVeld = (label, veld) => {
    if (!veld || !veld.aanwezig || veld.installatiemoment === undefined) return;
    const momentOk = !!(veld.installatiemoment && veld.installatiemoment.trim());
    energetischItems.push({ tekst: `${label} — Installatiemoment`, ok: momentOk, tab: 'energetisch' });
    if (veld.installatiemoment === 'Installatiejaar') {
      energetischItems.push({ tekst: `${label} — Installatiejaar`, ok: !!(veld.jaar && String(veld.jaar).trim()), tab: 'energetisch' });
    }
  };
  ['isolatie', 'installaties'].forEach(hoofdId => {
    Object.entries(ENERGETISCH_SCHEMA[hoofdId] || {}).forEach(([sectieId, defs]) => {
      defs.forEach(def => checkEnergetischVeld(def.label, t.energetisch[hoofdId] && t.energetisch[hoofdId][sectieId] && t.energetisch[hoofdId][sectieId][def.key]));
    });
  });
  ENERGETISCH_SCHEMA.energieopwekking.forEach(def => checkEnergetischVeld(def.label, t.energetisch.energieopwekking && t.energetisch.energieopwekking[def.key]));
  if (energetischItems.length) groepen.push({ titel: 'Energetisch — isolatie/installaties', items: energetischItems });

  // Verplichte foto's — bestaande checklist hergebruikt.
  groepen.push({ titel: "Verplichte foto's", items: bepaalVerplichteFotos().map(f => ({ tekst: f.naam, ok: f.klaar, tab: 'fotos' })) });

  // Met ! gemarkeerde velden (17-09-2026, Arno's verzoek) — apart bovenaan-achtig groepje zodat
  // expliciet als belangrijk gemarkeerde onderdelen nooit stilzwijgend leeg kunnen blijven.
  const attentieItems = berekenAttentieResultaten();
  if (attentieItems.length) groepen.unshift({ titel: '! Gemarkeerd als belangrijk', items: attentieItems });

  return groepen;
}

// ================================================================================================
// PDF-OPNAMERAPPORT (Arno's verzoek 16-09-2026): "een PDF-rapportage met de gehele opname incl.
// foto's en aantekeningen" — een eerste opzet, gegenereerd met jsPDF (via CDN, zie index.html).
// Bewust GEEN poging om Taxatieweb's eigen rapportopmaak na te bootsen — dit is Arno's eigen
// werkexemplaar/archiefkopie van de ruwe opname, geen extern op te leveren stuk. Loopt de bestaande
// schema's (BOUWKUNDIG_SCHEMA/ENERGETISCH_SCHEMA) generiek langs zodat een later toegevoegd
// bouwdeel automatisch meekomt, zonder deze functie te hoeven aanpassen.
// ================================================================================================

// camelCase-veldnaam → leesbaar label, voor de vlakke Objectkenmerken/Omgeving-data die (anders dan
// Bouwkundig/Energetisch) geen eigen schema met labels heeft. Een paar veelgebruikte velden krijgen
// hieronder een handgeschreven label; de rest valt terug op deze automatische omzetting.
function vriendelijkeLabel(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}
const OBJECTKENMERKEN_LABELS = {
  woningtype: 'Woningtype', bouwjaar: 'Bouwjaar', tuinAanwezig: 'Tuin aanwezig',
  grootVerbouwingGeweest: 'Grote verbouwing/uitbreiding geweest',
  gezochtEigenaarBewoner: 'Contact gezocht met eigenaar/bewoner',
  gezochtMakelaar: 'Contact gezocht met makelaar',
  gezochtAndereBronnen: 'Contact gezocht met andere bronnen',
  volledigGeinspecteerd: 'Volledig geïnspecteerd', situatie: 'Situatie van de woning',
  situatieAnders: 'Situatie (nadere omschrijving)', aanvragerWoontAl: 'Aanvrager woont er al',
  aanvragerBlijftWonen: 'Aanvrager blijft wonen', andereInfoOntdekt: 'Andere relevante info ontdekt',
};
const OMGEVING_LABELS = {
  weersomstandigheden: 'Weersomstandigheden', aanwezigenInspectie: 'Aanwezigen bij inspectie',
  begintijdInspectie: 'Begintijd inspectie', eindtijdInspectie: 'Eindtijd inspectie',
  locatie: 'Locatie', gebouwenRondom: 'Gebouwen rondom', bereikbaarheid: 'Bereikbaarheid',
  voorzieningen: 'Voorzieningen', bijzonderhedenOmgeving: 'Bijzonderheden omgeving',
  funderingEigenaarBewoner: 'Fundering — info via eigenaar/bewoner',
  funderingOnderzoeksrapport: 'Fundering — onderzoeksrapport aanwezig',
  funderingAndereBronnen: 'Fundering — andere bronnen geraadpleegd',
  funderingProblemen: 'Funderingsproblemen', risicoVervuildeGrond: 'Risico vervuilde grond',
  asbestGezien: 'Asbest gezien', asbestAanwezigDenken: 'Asbest vermoed aanwezig',
};
// Een plat data-object (Objectkenmerken/Omgeving) omzetten naar "Label: waarde"-regels — slaat lege
// velden over, en voegt een bijbehorend "...Toelichting"-veld achter de hoofdwaarde aan.
function dumpFlatObject(obj, labelMap) {
  const regels = [];
  Object.keys(obj).forEach((key) => {
    if (key.endsWith('Toelichting')) return; // hieronder al meegenomen bij het hoofdveld
    const waarde = obj[key];
    if (waarde === null || waarde === undefined || waarde === '') return;
    if (Array.isArray(waarde) && waarde.length === 0) return;
    const label = (labelMap && labelMap[key]) || vriendelijkeLabel(key);
    let tekst = Array.isArray(waarde) ? waarde.join(', ') : waarde === true ? 'Ja' : waarde === false ? 'Nee' : String(waarde);
    if (obj[key + 'Toelichting']) tekst += ' — ' + obj[key + 'Toelichting'];
    regels.push(label + ': ' + tekst);
  });
  return regels;
}
// Eén bouwkundig bouwdeel samenvatten tot een tekstregel — null als het bouwdeel niet aanwezig is
// (dan hoort het niet in het rapport thuis).
function samenvatBouwdeel(bd, def) {
  if (!bd || !bd.aanwezig) return null;
  if (def.type === 'risico') {
    const regels = [];
    if (bd.risico === true) regels.push('risico geconstateerd');
    else if (bd.risico === false) regels.push('geen risico geconstateerd');
    if (bd.omschrijving) regels.push(bd.omschrijving);
    return regels.length ? regels.join(' — ') : 'aanwezig';
  }
  const regels = [];
  if (def.type !== 'simpel' && typeof bd.conditie === 'number' && CONDITIE_LABELS[bd.conditie]) {
    regels.push('conditie ' + CONDITIE_LABELS[bd.conditie]);
  }
  if (Array.isArray(bd.materialen) && bd.materialen.length) {
    regels.push(bd.materialen.join(', ') + (bd.overigeTekst ? ' (' + bd.overigeTekst + ')' : ''));
  }
  if (bd.omschrijving) regels.push(bd.omschrijving);
  if (def.details && bd.details) {
    def.details.forEach((d) => {
      const w = bd.details[d.key];
      if (w === '' || w === null || w === undefined) return;
      regels.push(d.label + ': ' + (w === true ? 'ja' : w === false ? 'nee' : w));
    });
  }
  if (bd.aandachtspuntenAanwezig && bd.aandachtspuntenToelichting) regels.push('aandachtspunt: ' + bd.aandachtspuntenToelichting);
  return regels.length ? regels.join(' — ') : 'aanwezig';
}
// Eén energetisch veld samenvatten — de velden-vorm verschilt per def.type (zie leegIsolatieVeld/
// leegDakVeld/leegMateriaalTijdVeld/leegZonnepanelenVeld hierboven).
function samenvatEnergetischVeld(veld, def) {
  if (!veld || !veld.aanwezig) return null;
  const regels = [];
  if (def.type === 'dak') {
    if (veld.geisoleerd === true) regels.push('geïsoleerd' + (veld.gedeeltelijk ? ' (gedeeltelijk)' : ''));
    else if (veld.geisoleerd === false) regels.push('niet geïsoleerd');
  } else if (def.type === 'isolatie') {
    regels.push('geïsoleerd' + (veld.gedeeltelijk ? ' (gedeeltelijk)' : ''));
  } else if (def.type === 'materiaalTijd' && veld.materialen && veld.materialen.length) {
    regels.push(veld.materialen.join(', ') + (veld.overigeTekst ? ' (' + veld.overigeTekst + ')' : ''));
  } else if (def.type === 'zonnepanelen') {
    const stukjes = [];
    if (veld.aantal) stukjes.push(veld.aantal + (veld.metenType ? ' (' + veld.metenType + ')' : ''));
    if (veld.orientaties && veld.orientaties.length) stukjes.push('oriëntatie ' + veld.orientaties.join(', '));
    if (veld.eigendom) stukjes.push(veld.eigendom);
    if (stukjes.length) regels.push(stukjes.join(', '));
  }
  if (veld.installatiemoment) regels.push(veld.installatiemoment + (veld.jaar ? ' ' + veld.jaar : ''));
  if (veld.opmerkingen) regels.push(veld.opmerkingen);
  return regels.length ? regels.join(' — ') : 'aanwezig';
}

// Foto-blob → data-URL, geschaald voor gebruik in de PDF (aspect-ratio is het enige dat telt, jsPDF
// tekent op de opgegeven mm-afmeting ongeacht bron-resolutie).
async function fotoNaarPdfAfbeelding(blob, maxBreedtePx = 1000) {
  const bitmap = await createImageBitmap(blob);
  const schaal = Math.min(1, maxBreedtePx / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * schaal);
  canvas.height = Math.round(bitmap.height * schaal);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.82), breedtePx: canvas.width, hoogtePx: canvas.height };
}
// Zelfde als hierboven, maar vanaf een (Airtable-)URL i.p.v. een lokale blob.
async function urlNaarPdfAfbeelding(url, maxBreedtePx = 1000) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('kon foto niet ophalen (' + resp.status + ')');
  return fotoNaarPdfAfbeelding(await resp.blob(), maxBreedtePx);
}

// Normaliseert een label/categorie voor VERGELIJKING (dedup lokaal vs. cloud) — live productiedata
// bleek al eens een trailing space te bevatten ("Woonkamer "), vandaar trim() naast lowerCase().
function fotoLabelSleutel(x) {
  return String(x || 'Anders').trim().toLowerCase();
}

// Foto's die WEL succesvol geüpload zijn maar niet (meer) lokaal op dit toestel staan (zie
// FOTOS_OPHALEN_WEBHOOK hierboven) — geeft een lege lijst terug bij een netwerkfout of zonder
// verbinding, zodat zowel het PDF-rapport als de galerij dan gewoon met alléén de lokale foto's
// doorgaan. `bron:'cloud'` markeert deze objecten voor openLightbox().
async function haalCloudFotos(rapportId) {
  try {
    const resp = await fetch(FOTOS_OPHALEN_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actie: 'ophalen' }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    // taxatie_rapport_id is een Airtable-linked-record-veld, dus altijd een array (live gecontroleerd
    // 16-09-2026 — géén platte string zoals de andere *_WEBHOOK's).
    const hoortBijDitRapport = (r) => {
      const veld = r.fields && r.fields.taxatie_rapport_id;
      return Array.isArray(veld) ? veld.includes(rapportId) : veld === rapportId;
    };
    return (data.records || [])
      .filter((r) => hoortBijDitRapport(r) && Array.isArray(r.fields.bestand) && r.fields.bestand.length)
      .map((r) => {
        const bestand = r.fields.bestand[0];
        return {
          bron: 'cloud',
          id: r.id,
          ruimteLabel: r.fields.ruimte_label || '',
          categorie: r.fields.categorie || 'Anders',
          url: bestand.url,
          thumbUrl: (bestand.thumbnails && bestand.thumbnails.large && bestand.thumbnails.large.url) || bestand.url,
        };
      });
  } catch (e) {
    return [];
  }
}

async function genereerRapportPdf(knop) {
  if (!window.jspdf) {
    alert('De PDF-bibliotheek kon niet geladen worden — controleer de internetverbinding en probeer het opnieuw.');
    return;
  }
  const oorspronkelijkeTekst = knop.textContent;
  knop.disabled = true;
  knop.textContent = 'Rapport wordt gemaakt…';
  try {
    const t = state.taxatie;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const breedte = doc.internal.pageSize.getWidth();
    const hoogte = doc.internal.pageSize.getHeight();
    const marge = 16;
    let y = marge;

    const nieuwePaginaIndienNodig = (nodig) => { if (y + nodig > hoogte - marge) { doc.addPage(); y = marge; } };
    const schrijfKop = (tekst) => {
      nieuwePaginaIndienNodig(14);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(4, 42, 67);
      doc.text(tekst, marge, y);
      y += 5;
      doc.setDrawColor(221, 226, 229); doc.line(marge, y, breedte - marge, y);
      y += 6;
    };
    const schrijfSubkop = (tekst) => {
      nieuwePaginaIndienNodig(9);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(20, 24, 27);
      doc.text(tekst, marge, y);
      y += 5.5;
    };
    const schrijfRegels = (regels) => {
      if (!regels || !regels.length) return;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(60, 66, 71);
      regels.forEach((regel) => {
        const gewrapt = doc.splitTextToSize('•  ' + regel, breedte - marge * 2 - 2);
        nieuwePaginaIndienNodig(gewrapt.length * 4.6);
        doc.text(gewrapt, marge + 2, y);
        y += gewrapt.length * 4.6 + 1.3;
      });
      y += 2.5;
    };
    const schrijfParagraaf = (tekst) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(60, 66, 71);
      const gewrapt = doc.splitTextToSize(tekst, breedte - marge * 2);
      nieuwePaginaIndienNodig(gewrapt.length * 4.6);
      doc.text(gewrapt, marge, y);
      y += gewrapt.length * 4.6 + 5;
    };

    // Kop
    doc.setFillColor(4, 42, 67);
    doc.rect(0, 0, breedte, 36, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text(t.adres || 'Taxatieopname', marge, 18);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    doc.text([t.postcode, t.plaats].filter(Boolean).join(' ') || ' ', marge, 26);
    doc.setFontSize(8.5);
    doc.text('Opnamerapport — gegenereerd op ' + new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }), marge, 32);
    y = 46;

    schrijfKop('Objectkenmerken');
    const objectkenmerkenRegels = dumpFlatObject(t.bewoning || {}, OBJECTKENMERKEN_LABELS);
    schrijfRegels(objectkenmerkenRegels.length ? objectkenmerkenRegels : ['Niets ingevuld.']);

    schrijfKop('Omgeving');
    const omgevingRegels = dumpFlatObject(t.omgeving || {}, OMGEVING_LABELS);
    schrijfRegels(omgevingRegels.length ? omgevingRegels : ['Niets ingevuld.']);

    schrijfKop('Indeling');
    schrijfParagraaf(componeerIndelingTekst((t.data && t.data.indeling) || {}, t.data && t.data.bijgebouwen) || 'Geen indeling ingevoerd.');

    schrijfKop('Bouwkundige opname');
    let bouwkundigHeeftInhoud = false;
    ['buitenzijde', 'binnenzijde', 'installaties'].forEach((hoofd) => {
      Object.keys(BOUWKUNDIG_SCHEMA[hoofd]).forEach((sectie) => {
        const regels = [];
        BOUWKUNDIG_SCHEMA[hoofd][sectie].forEach((def) => {
          const samenvatting = samenvatBouwdeel(t.bouwkundig[hoofd][sectie][def.key], def);
          if (samenvatting) regels.push(def.label + ' — ' + samenvatting);
        });
        if (regels.length) {
          bouwkundigHeeftInhoud = true;
          const subtabDef = (BOUWKUNDIG_SUBTABS[hoofd] || []).find((s) => s.id === sectie);
          schrijfSubkop(subtabDef ? subtabDef.label : sectie);
          schrijfRegels(regels);
        }
      });
    });
    {
      const regels = [];
      BOUWKUNDIG_SCHEMA.overigeBijzonderheden.forEach((def) => {
        const samenvatting = samenvatBouwdeel(t.bouwkundig.overigeBijzonderheden[def.key], def);
        if (samenvatting) regels.push(def.label + ' — ' + samenvatting);
      });
      if (regels.length) { bouwkundigHeeftInhoud = true; schrijfSubkop('Overige bijzonderheden'); schrijfRegels(regels); }
    }
    if (!bouwkundigHeeftInhoud) schrijfRegels(['Niets ingevuld.']);

    schrijfKop('Energetische opname');
    let energetischHeeftInhoud = false;
    const algemeen = t.energetisch.algemeen || {};
    if ((algemeen.bron || []).length || (algemeen.bouwtype || []).length) {
      energetischHeeftInhoud = true;
      schrijfSubkop('Algemeen');
      const regels = [];
      if ((algemeen.bron || []).length) regels.push('Bron: ' + algemeen.bron.join(', '));
      if ((algemeen.bouwtype || []).length) regels.push('Bouwtype: ' + algemeen.bouwtype.join(', '));
      schrijfRegels(regels);
    }
    ['isolatie', 'installaties'].forEach((hoofd) => {
      Object.keys(ENERGETISCH_SCHEMA[hoofd]).forEach((sectie) => {
        const regels = [];
        ENERGETISCH_SCHEMA[hoofd][sectie].forEach((def) => {
          const samenvatting = samenvatEnergetischVeld(t.energetisch[hoofd][sectie][def.key], def);
          if (samenvatting) regels.push(def.label + ' — ' + samenvatting);
        });
        if (regels.length) {
          energetischHeeftInhoud = true;
          const subtabDef = (ENERGETISCH_SUBTABS[hoofd] || []).find((s) => s.id === sectie);
          schrijfSubkop(subtabDef ? subtabDef.label : sectie);
          schrijfRegels(regels);
        }
      });
    });
    {
      const regels = [];
      ENERGETISCH_SCHEMA.energieopwekking.forEach((def) => {
        const samenvatting = samenvatEnergetischVeld(t.energetisch.energieopwekking[def.key], def);
        if (samenvatting) regels.push(def.label + ' — ' + samenvatting);
      });
      if (regels.length) { energetischHeeftInhoud = true; schrijfSubkop('Energieopwekking'); schrijfRegels(regels); }
    }
    if (!energetischHeeftInhoud) schrijfRegels(['Niets ingevuld.']);

    schrijfKop('Aantekeningen');
    schrijfParagraaf(t.aantekeningen && t.aantekeningen.trim() ? t.aantekeningen : 'Geen aantekeningen.');

    const lokaleFotos = state.fotos.filter((f) => !f.archief);
    // Ook foto's ophalen die wél succesvol geüpload zijn (staan al in Taxatieweb) maar niet meer
    // lokaal op dit toestel — bv. na een cache-leging of op een ander apparaat geopend (Arno's
    // melding 16-09-2026 over Grote Bavenkelsweg 27). Bewust GEEN dedup op label/categorie (die
    // eerdere versie verborg ALLE cloud-foto's van bv. "Keuken" zodra er lokaal nog 1 Keuken-foto
    // stond) — vaak zijn er meerdere foto's per ruimte, dus liever een enkele dubbele foto in het
    // rapport dan een echte foto ten onrechte weglaten.
    knop.textContent = "Foto's ophalen…";
    const cloudFotos = await haalCloudFotos(t.rapport_id);
    knop.textContent = 'Rapport wordt gemaakt…';

    const alleFotos = [
      ...lokaleFotos.map((f) => ({ label: f.ruimte_label || f.categorie || 'Anders', laadAfbeelding: () => fotoNaarPdfAfbeelding(f.blob) })),
      ...cloudFotos.map((cf) => ({ label: (cf.ruimteLabel || cf.categorie || 'Anders') + ' (uit cloud-archief)', laadAfbeelding: () => urlNaarPdfAfbeelding(cf.url) })),
    ];
    if (alleFotos.length) {
      doc.addPage(); y = marge;
      schrijfKop("Foto's en schetsen (" + alleFotos.length + ')');
      // 2 foto's per rij (Arno's verzoek 16-09-2026) — reserveert bij het begin van elke rij altijd
      // de maximale hoogte (i.p.v. de werkelijke hoogte van de eerste foto), zodat een pagina-
      // afbreking klopt ongeacht of de LINKER of de RECHTER foto van de rij het hoogst uitvalt.
      const kolomGap = 6;
      const kolomBreedte = (breedte - marge * 2 - kolomGap) / 2;
      const rijMaxH = 75;
      let kolom = 0;
      let rijStartY = y;
      let rijHoogte = 0;
      for (const item of alleFotos) {
        let plaatje;
        try {
          plaatje = await item.laadAfbeelding();
        } catch (e) {
          continue; // 1 onbereikbare foto (bv. verlopen cloud-link) mag de rest van het rapport niet blokkeren
        }
        const { dataUrl, breedtePx, hoogtePx } = plaatje;
        let w = kolomBreedte, h = w * (hoogtePx / breedtePx);
        if (h > rijMaxH) { h = rijMaxH; w = h * (breedtePx / hoogtePx); }
        if (kolom === 0) {
          nieuwePaginaIndienNodig(rijMaxH + 12);
          rijStartY = y;
          rijHoogte = 0;
        }
        const kolomX = marge + kolom * (kolomBreedte + kolomGap);
        const x = kolomX + (kolomBreedte - w) / 2; // horizontaal centreren binnen de kolom
        doc.addImage(dataUrl, 'JPEG', x, rijStartY, w, h);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(120, 128, 133);
        doc.text(item.label, kolomX, rijStartY + h + 4, { maxWidth: kolomBreedte });
        rijHoogte = Math.max(rijHoogte, h + 8);
        if (kolom === 0) {
          kolom = 1;
        } else {
          kolom = 0;
          y = rijStartY + rijHoogte;
        }
      }
      if (kolom === 1) y = rijStartY + rijHoogte; // de laatste rij had maar 1 foto — y alsnog bijwerken
    }

    // Paginanummers, achteraf toegevoegd (nu pas is het totaal aantal pagina's bekend).
    const totaalPaginas = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totaalPaginas; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140, 145, 150);
      doc.text(String(p) + ' / ' + totaalPaginas, breedte - marge, hoogte - 8, { align: 'right' });
    }

    const bestandsnaam = (t.adres || 'Taxatieopname').replace(/[^a-z0-9]+/gi, '_') + '_opnamerapport.pdf';
    doc.save(bestandsnaam);
  } finally {
    knop.disabled = false;
    knop.textContent = oorspronkelijkeTekst;
  }
}

function renderControleTab() {
  const t = state.taxatie;
  const wrap = el('div', {});
  const rapportKnop = el('button', { type: 'button', class: 'rapport-knop' }, '📄 Rapport genereren (PDF)');
  rapportKnop.addEventListener('click', () => genereerRapportPdf(rapportKnop));
  wrap.appendChild(rapportKnop);
  const groepen = berekenControleResultaten();
  const totaalOntbrekend = groepen.reduce((som, g) => som + g.items.filter(i => !i.ok).length, 0);
  wrap.appendChild(el('div', { class: 'controle-samenvatting' + (totaalOntbrekend === 0 ? ' klaar' : '') },
    totaalOntbrekend === 0 ? '✓ Alle gecontroleerde velden zijn ingevuld' : `⚠ ${totaalOntbrekend} veld(en) nog niet ingevuld`));
  groepen.forEach(groep => {
    wrap.appendChild(el('div', { class: 'section-label' }, groep.titel));
    if (groep.items.length === 0) {
      wrap.appendChild(el('div', { class: 'checklist-item klaar' }, el('span', { class: 'vinkje' }, '—'), el('span', { class: 'naam' }, 'Niets van toepassing')));
      return;
    }
    const kaart = el('div', { class: 'checklist-kaart' });
    groep.items.forEach(item => {
      kaart.appendChild(el('button', {
        type: 'button', class: 'checklist-item checklist-item-knop' + (item.ok ? ' klaar' : ''),
        onclick: () => { location.hash = '#/opname/' + encodeURIComponent(t.rapport_id) + '/' + item.tab; },
      },
        el('span', { class: 'vinkje' }, item.ok ? '✓' : '⚠'),
        el('span', { class: 'naam' }, item.tekst),
      ));
    });
    wrap.appendChild(kaart);
  });
  return wrap;
}

function renderFotosTab() {
  const wrap = el('div', {});
  const checklist = el('div', { class: 'checklist-kaart' });
  checklist.appendChild(el('div', { class: 'section-label' }, 'Verplichte foto\'s'));
  bepaalVerplichteFotos().forEach(item => {
    // Rood markeren zolang niet gemaakt (18-09-2026, Arno's verzoek: "Foto's van verplichte
    // ruimtes markeren als deze nog niet genomen is") — ✕ i.p.v. een lege vinkje, zodat het ook
    // zonder kleur (bv. print/screenshot) duidelijk "nog niet gedaan" is.
    checklist.appendChild(el('div', { class: 'checklist-item foto-verplicht-item' + (item.klaar ? ' klaar' : '') },
      el('span', { class: 'vinkje' }, item.klaar ? '✓' : '✕'),
      el('span', { class: 'naam' }, item.naam),
    ));
  });
  wrap.appendChild(checklist);

  wrap.appendChild(el('div', { class: 'section-label' }, "Alle foto's — tik om te vergroten"));
  const grid = el('div', { class: 'foto-grid' });
  state.fotos.forEach(f => {
    const badgeKlasse = f.archief ? 'archief' : (f.status === 'verzonden' ? 'ok' : 'wachtend');
    const badgeTekst = f.archief ? '📦' : (f.status === 'verzonden' ? '✓' : '⏳');
    const tegel = el('button', { type: 'button', class: 'foto-tegel', onclick: () => openLightbox(f) },
      el('img', { src: URL.createObjectURL(f.blob) }),
      el('span', { class: 'badge ' + badgeKlasse }, badgeTekst),
      el('span', { class: 'label' }, f.ruimte_label || f.categorie || 'Anders'),
    );
    grid.appendChild(tegel);
  });
  // Cloud-only foto's (wél geüpload, niet meer lokaal — zie haalCloudFotos) erbij tonen. Bewust GEEN
  // dedup op label/categorie meer (die eerdere versie verborg ALLE cloud-foto's van bv. "Keuken"
  // zodra er lokaal nog maar 1 Keuken-foto stond) — Arno maakt vaak meerdere foto's van dezelfde
  // ruimte, dus liever een enkele dubbele tegel tonen dan een echte foto ten onrechte verbergen.
  state.cloudFotos.forEach(cf => {
    grid.appendChild(el('button', {
      type: 'button', class: 'foto-tegel foto-tegel-cloud', title: 'Uit cloud-archief — niet meer lokaal op dit toestel',
      onclick: () => openLightbox(cf),
    },
      el('img', { src: cf.thumbUrl }),
      el('span', { class: 'badge cloud' }, '☁'),
      el('span', { class: 'label' }, cf.ruimteLabel || cf.categorie || 'Anders'),
    ));
  });
  const toevoegen = el('div', { class: 'foto-add' },
    el('span', { class: 'plus' }, '+'), "Foto",
    el('input', {
      type: 'file', accept: 'image/*', capture: 'environment',
      onchange: (e) => verwerkGekozenFoto(e.target.files[0], null),
    }),
  );
  grid.appendChild(toevoegen);
  wrap.appendChild(grid);
  return wrap;
}

// Sinds Arno's verzoek: foto's vergroten in een lightbox, en per foto uitschakelbaar maken voor
// de verplichte-foto's-check ("eigen archief" — bv. een extra herinneringsfoto die niet naar Q/R
// hoeft en niet als 'verplicht' meetelt).
// `foto` is óf een lokale IndexedDB-foto (heeft .blob/.id/.archief), óf een genormaliseerde
// cloud-only foto (bron:'cloud', url/thumbUrl/ruimteLabel — zie haalCloudFotos) die WEL succesvol
// geüpload is maar niet meer lokaal op dit toestel staat. Voor die laatste is er geen lokale DB-rij
// om te verwijderen/archiveren of om als achtergrond in Tekenen te laden (het volledige-resolutie-
// bestand zou eerst gedownload moeten worden) — vandaar de vertakking hieronder.
function openLightbox(foto) {
  const bestaand = document.querySelector('.lightbox');
  if (bestaand) bestaand.remove();
  const isCloud = foto.bron === 'cloud';
  const titel = (isCloud ? foto.ruimteLabel : foto.ruimte_label) || foto.categorie || 'Anders';
  const beeldSrc = isCloud ? (foto.url || foto.thumbUrl) : URL.createObjectURL(foto.blob);

  let onderdeel;
  if (isCloud) {
    onderdeel = el('div', { class: 'lightbox-onder' },
      el('span', { style: 'color:rgba(255,255,255,.75);font-size:12px;' }, '☁ Uit cloud-archief — niet meer lokaal op dit toestel, alleen hier te bekijken'));
  } else {
    const toggle = el('input', { type: 'checkbox' });
    toggle.checked = !!foto.archief;
    toggle.addEventListener('change', async () => {
      foto.archief = toggle.checked;
      await VeldopnameDB.werkFotoBij(foto.id, { archief: foto.archief });
    });
    onderdeel = el('div', { class: 'lightbox-onder' },
      el('label', { class: 'archief-toggle' }, toggle, 'Eigen archief (niet verplicht, niet naar Q/R)'),
      el('button', {
        class: 'verwijder-foto-knop',
        onclick: async () => {
          if (!confirm('Deze foto verwijderen?')) return;
          await VeldopnameDB.verwijderFoto(foto.id);
          state.fotos = state.fotos.filter(f => f.id !== foto.id);
          overlay.remove();
          if (state.route.tab === 'fotos') render();
        },
      }, '🗑 Verwijderen'),
    );
  }

  const overlay = el('div', { class: 'lightbox' },
    el('div', { class: 'lightbox-top' },
      el('span', { class: 'lightbox-titel' }, titel + (isCloud ? ' (cloud)' : '')),
      el('button', { onclick: () => overlay.remove() }, '✕'),
    ),
    el('div', { class: 'lightbox-beeld' }, el('img', { src: beeldSrc })),
    onderdeel,
  );
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ================================================================================================
// TEKENEN — vrije aantekeningen/markeringen en vormen (pen/markeerstift/gum/lijn/rechthoek/cirkel/
// driehoek/selecteren), incl. 2-vinger zoomen/pannen en rotatie/verslepen/vergroten van vormen.
// Volle-scherm overlay net als openLightbox hierboven, met een eigen werkbalk. Het resultaat wordt
// bij "Opslaan" gewoon als foto weggeschreven via slaFotoOp() — dus automatisch mee in de bestaande
// foto-sync/wachtrij, geen aparte opslagvorm nodig.
// Uitgebreid getest door Arno op een losse testpagina vóór inbouw (15-09-2026), incl. een paar
// niet-voor-de-hand-liggende iOS-eigenaardigheden die hieronder zijn opgelost:
//  - Palmafwijzing: zodra de Apple Pencil één keer is gezien, wordt vingercontact genegeerd.
//  - Incrementeel tekenen (alleen het nieuwe stukje, niet het hele blad opnieuw) i.p.v. volledige
//    hertekening per beweging — dat laatste werd merkbaar trager naarmate er meer op het blad stond,
//    met haperende/wegvallende losse letters bij snel schrijven tot gevolg.
//  - Markeerstift als één doorlopend pad i.p.v. per-segment getekend — anders stapelt de
//    semi-transparante overlap bij elke ronde lijn-cap zich op, waardoor geel geleidelijk naar
//    rood/bruin verkleurt bij snel schrijven.
//  - Expliciete preventDefault() op de ruwe touch-events: Safari/WebKit blijft anders bij twee
//    snelle tikken op dezelfde plek ~300-500ms wachten om een dubbeltik-zoomgebaar te herkennen,
//    waardoor de pen na snel optillen en weer neerzetten soms niet meteen reageert.
function openTekenScherm(opties) {
  const { ruimteLabel = null, categorie = 'Anders', achtergrondBlob = null } = opties || {};
  const bestaand = document.querySelector('.tekenscherm');
  if (bestaand) bestaand.remove();

  // --- DOM-opbouw ---
  const canvas = el('canvas', {});
  const voorbeeldCanvas = el('canvas', { class: 'teken-voorbeeld' });
  const ctx = canvas.getContext('2d');
  const voorbeeldCtx = voorbeeldCanvas.getContext('2d');

  const leegUploadKnop = el('button', { type: 'button' }, 'Afbeelding kiezen');
  const leegmelding = el('div', { class: 'teken-leegmelding' },
    el('p', {}, 'Kies een plattegrond of foto om op te tekenen.'), leegUploadKnop);
  leegmelding.style.display = 'none';

  const zoomPil = el('button', { type: 'button', class: 'teken-zoompil' }, '100%');
  const wrap = el('div', { class: 'teken-canvaswrap blad' }, canvas, voorbeeldCanvas, leegmelding, zoomPil);

  const modeBladKnop = el('button', { type: 'button', class: 'actief' }, 'Blanco blad');
  const modeFotoKnop = el('button', { type: 'button' }, 'Plattegrond / foto');
  const bestandInvoer = el('input', { type: 'file', accept: 'image/*' });
  bestandInvoer.style.display = 'none';
  const uploadTrigger = el('button', { type: 'button', class: 'teken-uploadknop' }, 'Andere afbeelding kiezen');
  uploadTrigger.style.display = 'none';
  const opslaanKnop = el('button', { type: 'button', class: 'teken-opslaan-knop' }, 'Opslaan');
  const sluitKnop = el('button', { type: 'button', class: 'teken-sluitknop' }, '✕');

  const top = el('div', { class: 'teken-top' },
    el('div', { class: 'teken-titelblok' },
      el('h2', {}, achtergrondBlob ? 'Tekenen op foto' : 'Tekenen'),
      el('div', { class: 'teken-sub' }, ruimteLabel || categorie),
    ),
    el('div', { class: 'teken-modewissel' }, modeBladKnop, modeFotoKnop),
    uploadTrigger, bestandInvoer, opslaanKnop, sluitKnop,
  );

  const KLEUREN = ['#000000', '#ec1c24', '#0b6dff', '#12b34c', '#ffd400'];
  const kleurKnoppen = KLEUREN.map((hex, i) => {
    const knop = el('button', { type: 'button', class: 'teken-kleur' + (i === 0 ? ' actief' : '') },
      el('span', { class: 'stip', style: `background:${hex};` }));
    knop.dataset.kleur = hex;
    if (i === 0) knop.style.borderColor = hex;
    return knop;
  });
  const kleurGroep = el('div', { class: 'teken-groep' }, el('span', { class: 'teken-groep-label' }, 'Kleur'), ...kleurKnoppen);

  const diktestip = el('span', { style: 'display:block;width:3px;height:3px;border-radius:50%;background:var(--text);' });
  const diktevoorbeeld = el('div', {
    style: 'width:30px;height:30px;border-radius:8px;background:var(--surface-2);border:1px solid var(--divider);display:grid;place-items:center;',
  }, diktestip);
  const dikteSlider = el('input', { type: 'range', min: '1', max: '14', value: '3', step: '1' });
  const dikteGroep = el('div', { class: 'teken-groep' }, el('span', { class: 'teken-groep-label' }, 'Dikte'), diktevoorbeeld, dikteSlider);

  const penTool = el('button', { type: 'button', class: 'teken-toolknop actief', title: 'Pen' }, '✏️');
  const markeerTool = el('button', { type: 'button', class: 'teken-toolknop', title: 'Markeerstift' }, '🖍️');
  const gumTool = el('button', { type: 'button', class: 'teken-toolknop', title: 'Gum' }, '🧽');
  const toolGroep = el('div', { class: 'teken-groep' }, penTool, markeerTool, gumTool);

  const selecterenTool = el('button', { type: 'button', class: 'teken-toolknop', title: 'Selecteren (verplaatsen/vergroten/roteren)' }, '👆');
  const lijnTool = el('button', { type: 'button', class: 'teken-toolknop', title: 'Lijn' }, '📏');
  const rechthoekTool = el('button', { type: 'button', class: 'teken-toolknop', title: 'Rechthoek' }, '🟦');
  const cirkelTool = el('button', { type: 'button', class: 'teken-toolknop', title: 'Cirkel' }, '⚪');
  const driehoekTool = el('button', { type: 'button', class: 'teken-toolknop', title: 'Driehoek' }, '🔺');
  const vormGroep = el('div', { class: 'teken-groep' },
    el('span', { class: 'teken-groep-label' }, 'Vormen'), selecterenTool, lijnTool, rechthoekTool, cirkelTool, driehoekTool);

  const ongedaanKnop = el('button', { type: 'button', class: 'teken-tekstknop' }, 'Ongedaan maken');
  ongedaanKnop.disabled = true;
  const wisKnop = el('button', { type: 'button', class: 'teken-tekstknop gevaar' }, 'Alles wissen');
  const actieGroep = el('div', { class: 'teken-groep' }, ongedaanKnop, wisKnop);

  const palmSchakelaar = el('input', { type: 'checkbox' });
  palmSchakelaar.checked = true;
  const palmGroep = el('div', { class: 'teken-groep' },
    el('label', { class: 'teken-wisselaar' }, palmSchakelaar, el('span', {}, 'Handpalm negeren')));

  const werkbalk = el('div', { class: 'teken-werkbalk' }, kleurGroep, dikteGroep, toolGroep, vormGroep, actieGroep, palmGroep);

  const overlay = el('div', { class: 'tekenscherm' }, top, wrap, werkbalk);
  document.body.appendChild(overlay);

  // --- staat ---
  let modus = achtergrondBlob ? 'foto' : 'blad'; // 'blad' | 'foto'
  let achtergrondAfbeelding = null;
  let gereedschap = 'pen';
  let kleur = KLEUREN[0];
  let dikte = 3;
  let tekenend = false;
  let huidigeStreek = null;
  let streken = []; // vrije streken (tool:'pen'|'markeerstift'|'gum', punten:[...]) + vormen (tool:'vorm', vormType, x0,y0,x1,y1,rotatie)
  let heeftPenGebruikt = false;
  let actievePointerId = null;

  let zoom = 1, panX = 0, panY = 0;
  const aanrakingen = new Map();
  let pinchStart = null;

  const VORM_GEREEDSCHAPPEN = ['lijn', 'rechthoek', 'cirkel', 'driehoek'];
  const isVormGereedschap = (g) => VORM_GEREEDSCHAPPEN.includes(g);
  let geselecteerdeVormIndex = null;
  let vormBewerking = null; // { modus:'nieuw'|'hoek'|'verplaatsen'|'rotatie', ... }
  const VORM_GREEP_STRAAL = 16;
  const VORM_ROTATIE_AFSTAND = 34;

  const GEREEDSCHAP_KNOP_EL = {
    pen: penTool, markeerstift: markeerTool, gum: gumTool,
    selecteren: selecterenTool, lijn: lijnTool, rechthoek: rechthoekTool, cirkel: cirkelTool, driehoek: driehoekTool,
  };

  function zetZoomTransform() {
    const transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    canvas.style.transform = transform;
    voorbeeldCanvas.style.transform = transform;
    zoomPil.classList.toggle('zichtbaar', Math.abs(zoom - 1) > 0.02 || Math.abs(panX) > 1 || Math.abs(panY) > 1);
    zoomPil.textContent = Math.round(zoom * 100) + '%';
  }
  function resetZoom() { zoom = 1; panX = 0; panY = 0; zetZoomTransform(); }
  zoomPil.addEventListener('click', resetZoom);

  function updateDiktestip() {
    const grootte = Math.max(3, Math.min(20, dikte * 1.3));
    diktestip.style.width = grootte + 'px';
    diktestip.style.height = grootte + 'px';
  }

  function pasCanvasGrootteAan() {
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    voorbeeldCanvas.width = canvas.width;
    voorbeeldCanvas.height = canvas.height;
    voorbeeldCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    resetZoom();
    deselecteerVorm();
    herteken();
  }

  function tekenAchtergrond() {
    const rect = wrap.getBoundingClientRect();
    if (modus === 'blad') {
      // Een ECHTE ondoorzichtige laag op het canvas zelf — niet alleen de witte CSS-achtergrond van
      // de wrapper erachter. Zonder dit blijft het canvas transparant, en de JPEG-export bij Opslaan
      // (die geen transparantie kent) vult dat dan met zwart in, waardoor zowel het blad als de
      // zwarte pen-lijnen zelf onzichtbaar worden — alles verdwijnt in een egale zwarte foto.
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.restore();
      return;
    }
    if (modus !== 'foto' || !achtergrondAfbeelding) return;
    // Ook hier eerst een opaque bodem: de foto wordt geschaald met behouden beeldverhouding, dus er
    // blijft vaak een rand over (boven/onder of links/rechts) — zonder deze vulling is DIE rand
    // transparant en dus (zie hierboven) zwart bij het opslaan als er in die rand getekend is.
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.restore();
    const schaal = Math.min(rect.width / achtergrondAfbeelding.width, rect.height / achtergrondAfbeelding.height);
    const w = achtergrondAfbeelding.width * schaal, h = achtergrondAfbeelding.height * schaal;
    ctx.drawImage(achtergrondAfbeelding, (rect.width - w) / 2, (rect.height - h) / 2, w, h);
  }

  function zetStijl(ctxDoel, streek) {
    ctxDoel.lineJoin = 'round';
    ctxDoel.lineCap = 'round';
    if (streek.tool === 'gum') {
      ctxDoel.globalCompositeOperation = 'destination-out';
      ctxDoel.strokeStyle = 'rgba(0,0,0,1)'; ctxDoel.fillStyle = 'rgba(0,0,0,1)';
    } else if (streek.tool === 'markeerstift') {
      ctxDoel.globalCompositeOperation = 'multiply';
      ctxDoel.strokeStyle = streek.kleur; ctxDoel.fillStyle = streek.kleur; ctxDoel.globalAlpha = 0.35;
    } else {
      ctxDoel.globalCompositeOperation = 'source-over';
      ctxDoel.strokeStyle = streek.kleur; ctxDoel.fillStyle = streek.kleur;
    }
  }

  function effectieveDikte(streek) {
    const factor = streek.tool === 'gum' ? 8 : streek.tool === 'pen' ? 0.4 : streek.tool === 'markeerstift' ? 14 : 1;
    return streek.dikte * factor;
  }

  function tekenPunt(ctxDoel, streek, p) {
    ctxDoel.save();
    zetStijl(ctxDoel, streek);
    ctxDoel.beginPath();
    ctxDoel.arc(p.x, p.y, effectieveDikte(streek) / 2, 0, Math.PI * 2);
    ctxDoel.fill();
    ctxDoel.restore();
  }

  function tekenSegment(ctxDoel, streek, a, b) {
    ctxDoel.save();
    zetStijl(ctxDoel, streek);
    ctxDoel.lineWidth = effectieveDikte(streek);
    ctxDoel.beginPath();
    ctxDoel.moveTo(a.x, a.y); ctxDoel.lineTo(b.x, b.y);
    ctxDoel.stroke();
    ctxDoel.restore();
  }

  // Eén hele streek als ÉÉN doorlopend pad (zie toelichting bovenaan dit blok — voorkomt
  // kleurvervorming bij de markeerstift).
  function tekenVolledigPad(ctxDoel, streek) {
    if (streek.punten.length < 1) return;
    if (streek.punten.length === 1) { tekenPunt(ctxDoel, streek, streek.punten[0]); return; }
    ctxDoel.save();
    zetStijl(ctxDoel, streek);
    ctxDoel.lineWidth = effectieveDikte(streek);
    ctxDoel.beginPath();
    ctxDoel.moveTo(streek.punten[0].x, streek.punten[0].y);
    for (let i = 1; i < streek.punten.length; i++) ctxDoel.lineTo(streek.punten[i].x, streek.punten[i].y);
    ctxDoel.stroke();
    ctxDoel.restore();
  }

  function vormCentrum(vorm) { return { cx: (vorm.x0 + vorm.x1) / 2, cy: (vorm.y0 + vorm.y1) / 2 }; }
  function roteerPunt(p, c, hoek) {
    const s = Math.sin(hoek), co = Math.cos(hoek);
    const dx = p.x - c.cx, dy = p.y - c.cy;
    return { x: c.cx + dx * co - dy * s, y: c.cy + dx * s + dy * co };
  }

  function tekenVormPad(ctxDoel, vorm) {
    ctxDoel.save();
    if (vorm.rotatie) {
      const c = vormCentrum(vorm);
      ctxDoel.translate(c.cx, c.cy); ctxDoel.rotate(vorm.rotatie); ctxDoel.translate(-c.cx, -c.cy);
    }
    zetStijl(ctxDoel, vorm);
    ctxDoel.lineWidth = effectieveDikte(vorm);
    const x0 = Math.min(vorm.x0, vorm.x1), x1 = Math.max(vorm.x0, vorm.x1);
    const y0 = Math.min(vorm.y0, vorm.y1), y1 = Math.max(vorm.y0, vorm.y1);
    ctxDoel.beginPath();
    if (vorm.vormType === 'lijn') {
      ctxDoel.moveTo(vorm.x0, vorm.y0); ctxDoel.lineTo(vorm.x1, vorm.y1);
    } else if (vorm.vormType === 'rechthoek') {
      ctxDoel.rect(x0, y0, Math.max(x1 - x0, 0.01), Math.max(y1 - y0, 0.01));
    } else if (vorm.vormType === 'cirkel') {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      ctxDoel.ellipse(cx, cy, Math.max((x1 - x0) / 2, 0.01), Math.max((y1 - y0) / 2, 0.01), 0, 0, Math.PI * 2);
    } else if (vorm.vormType === 'driehoek') {
      // Rechthoekige driehoek, rechte hoek linksonder (Arno's verzoek: "2 rechte zijdes").
      ctxDoel.moveTo(x0, y0); ctxDoel.lineTo(x0, y1); ctxDoel.lineTo(x1, y1); ctxDoel.closePath();
    }
    ctxDoel.stroke();
    ctxDoel.restore();
  }

  function tekenItem(ctxDoel, item) {
    if (item.vormType) tekenVormPad(ctxDoel, item);
    else tekenVolledigPad(ctxDoel, item);
  }

  function vormHoeken(vorm) {
    const c = vormCentrum(vorm);
    const hoek = vorm.rotatie || 0;
    const ruw = vorm.vormType === 'lijn'
      ? { start: { x: vorm.x0, y: vorm.y0 }, eind: { x: vorm.x1, y: vorm.y1 } }
      : {
          x0y0: { x: vorm.x0, y: vorm.y0 }, x1y0: { x: vorm.x1, y: vorm.y0 },
          x0y1: { x: vorm.x0, y: vorm.y1 }, x1y1: { x: vorm.x1, y: vorm.y1 },
        };
    const resultaat = {};
    Object.entries(ruw).forEach(([naam, p]) => { resultaat[naam] = roteerPunt(p, c, hoek); });
    return resultaat;
  }
  function vormRotatieGreep(vorm) {
    const c = vormCentrum(vorm);
    const y0 = Math.min(vorm.y0, vorm.y1);
    return roteerPunt({ x: c.cx, y: y0 - VORM_ROTATIE_AFSTAND }, c, vorm.rotatie || 0);
  }
  function vindHoekBijPunt(vorm, p) {
    const rotatieGreep = vormRotatieGreep(vorm);
    if (Math.hypot(rotatieGreep.x - p.x, rotatieGreep.y - p.y) <= VORM_GREEP_STRAAL) return 'rotatie';
    const hoeken = vormHoeken(vorm);
    for (const naam in hoeken) {
      if (Math.hypot(hoeken[naam].x - p.x, hoeken[naam].y - p.y) <= VORM_GREEP_STRAAL) return naam;
    }
    return null;
  }
  function puntBinnenVorm(vorm, p) {
    const lokaal = vorm.rotatie ? roteerPunt(p, vormCentrum(vorm), -vorm.rotatie) : p;
    const marge = Math.max(effectieveDikte(vorm), 18) / 2 + 10;
    const x0 = Math.min(vorm.x0, vorm.x1) - marge, x1 = Math.max(vorm.x0, vorm.x1) + marge;
    const y0 = Math.min(vorm.y0, vorm.y1) - marge, y1 = Math.max(vorm.y0, vorm.y1) + marge;
    return lokaal.x >= x0 && lokaal.x <= x1 && lokaal.y >= y0 && lokaal.y <= y1;
  }
  function zetHoekVanVorm(vorm, hoek, p, centrum, rotatie) {
    const lokaal = rotatie ? roteerPunt(p, centrum, -rotatie) : p;
    if (vorm.vormType === 'lijn') {
      if (hoek === 'start') { vorm.x0 = lokaal.x; vorm.y0 = lokaal.y; } else { vorm.x1 = lokaal.x; vorm.y1 = lokaal.y; }
      return;
    }
    if (hoek === 'x0y0') { vorm.x0 = lokaal.x; vorm.y0 = lokaal.y; }
    else if (hoek === 'x1y0') { vorm.x1 = lokaal.x; vorm.y0 = lokaal.y; }
    else if (hoek === 'x0y1') { vorm.x0 = lokaal.x; vorm.y1 = lokaal.y; }
    else if (hoek === 'x1y1') { vorm.x1 = lokaal.x; vorm.y1 = lokaal.y; }
  }

  function verversSelectie() {
    const rect = wrap.getBoundingClientRect();
    voorbeeldCtx.clearRect(0, 0, rect.width, rect.height);
    if (geselecteerdeVormIndex === null) return;
    const vorm = streken[geselecteerdeVormIndex];
    if (!vorm) return;
    voorbeeldCtx.save();
    voorbeeldCtx.globalCompositeOperation = 'source-over';
    voorbeeldCtx.globalAlpha = 1;
    const hoeken = Object.values(vormHoeken(vorm));
    const c = vormCentrum(vorm);
    const rotatieGreep = vormRotatieGreep(vorm);
    const bovenMidden = roteerPunt({ x: c.cx, y: Math.min(vorm.y0, vorm.y1) }, c, vorm.rotatie || 0);
    voorbeeldCtx.setLineDash([3, 3]);
    voorbeeldCtx.strokeStyle = '#8b959b';
    voorbeeldCtx.lineWidth = 1.5;
    voorbeeldCtx.beginPath();
    voorbeeldCtx.moveTo(bovenMidden.x, bovenMidden.y); voorbeeldCtx.lineTo(rotatieGreep.x, rotatieGreep.y);
    voorbeeldCtx.stroke();
    voorbeeldCtx.setLineDash([]);
    const tekenGreep = (p, greepKleur) => {
      voorbeeldCtx.beginPath();
      voorbeeldCtx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      voorbeeldCtx.fillStyle = '#ffffff'; voorbeeldCtx.fill();
      voorbeeldCtx.lineWidth = 2; voorbeeldCtx.strokeStyle = greepKleur; voorbeeldCtx.stroke();
    };
    hoeken.forEach((h) => tekenGreep(h, '#042a43'));
    tekenGreep(rotatieGreep, '#ecb006');
    voorbeeldCtx.restore();
  }

  function deselecteerVorm() {
    if (geselecteerdeVormIndex === null && !vormBewerking) return;
    geselecteerdeVormIndex = null;
    vormBewerking = null;
    const rect = wrap.getBoundingClientRect();
    voorbeeldCtx.clearRect(0, 0, rect.width, rect.height);
  }

  function herteken() {
    const rect = wrap.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    voorbeeldCtx.clearRect(0, 0, rect.width, rect.height);
    tekenAchtergrond();
    streken.forEach((s) => tekenItem(ctx, s));
    ongedaanKnop.disabled = streken.length === 0;
  }

  function positieUitEvent(e) {
    const rect = wrap.getBoundingClientRect();
    return { x: (e.clientX - rect.left - panX) / zoom, y: (e.clientY - rect.top - panY) / zoom, druk: 1 };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (modus === 'foto' && !achtergrondAfbeelding) return;
    if (palmSchakelaar.checked && e.pointerType === 'touch' && heeftPenGebruikt) return;
    if (actievePointerId !== null) {
      if (e.pointerType !== 'pen') return;
      beeindigStreek();
    }
    e.preventDefault();
    if (e.pointerType === 'pen') heeftPenGebruikt = true;
    const p = positieUitEvent(e);

    function probeerSelectieSlepen() {
      if (geselecteerdeVormIndex === null) return false;
      const geselecteerd = streken[geselecteerdeVormIndex];
      const hoek = vindHoekBijPunt(geselecteerd, p);
      if (hoek) {
        actievePointerId = e.pointerId; canvas.setPointerCapture(e.pointerId); tekenend = true;
        if (hoek === 'rotatie') {
          const c = vormCentrum(geselecteerd);
          vormBewerking = { modus: 'rotatie', centrum: c, hoekBijStart: Math.atan2(p.y - c.cy, p.x - c.cx), rotatieBijStart: geselecteerd.rotatie || 0 };
        } else {
          vormBewerking = { modus: 'hoek', hoek, centrum: vormCentrum(geselecteerd), rotatieBijStart: geselecteerd.rotatie || 0 };
        }
        return true;
      }
      if (puntBinnenVorm(geselecteerd, p)) {
        actievePointerId = e.pointerId; canvas.setPointerCapture(e.pointerId); tekenend = true;
        vormBewerking = { modus: 'verplaatsen', startPunt: p, orig: { x0: geselecteerd.x0, y0: geselecteerd.y0, x1: geselecteerd.x1, y1: geselecteerd.y1 } };
        return true;
      }
      deselecteerVorm();
      return false;
    }

    if (isVormGereedschap(gereedschap)) {
      if (probeerSelectieSlepen()) return;
      actievePointerId = e.pointerId; canvas.setPointerCapture(e.pointerId); tekenend = true;
      huidigeStreek = { tool: 'vorm', vormType: gereedschap, kleur, dikte, x0: p.x, y0: p.y, x1: p.x, y1: p.y, rotatie: 0 };
      vormBewerking = { modus: 'nieuw' };
      return;
    }

    if (gereedschap === 'selecteren') {
      if (probeerSelectieSlepen()) return;
      for (let i = streken.length - 1; i >= 0; i--) {
        const item = streken[i];
        if (item.vormType && puntBinnenVorm(item, p)) {
          geselecteerdeVormIndex = i;
          verversSelectie();
          actievePointerId = e.pointerId; canvas.setPointerCapture(e.pointerId); tekenend = true;
          vormBewerking = { modus: 'verplaatsen', startPunt: p, orig: { x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1 } };
          return;
        }
      }
      return;
    }

    actievePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    tekenend = true;
    huidigeStreek = { tool: gereedschap, kleur, dikte, punten: [p] };
    if (gereedschap === 'markeerstift') tekenPunt(voorbeeldCtx, huidigeStreek, p);
    else tekenPunt(ctx, huidigeStreek, p);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!tekenend || e.pointerId !== actievePointerId) return;
    e.preventDefault();

    if (vormBewerking) {
      const p = positieUitEvent(e);
      if (vormBewerking.modus === 'nieuw' && huidigeStreek) {
        huidigeStreek.x1 = p.x; huidigeStreek.y1 = p.y;
        const rect = wrap.getBoundingClientRect();
        voorbeeldCtx.clearRect(0, 0, rect.width, rect.height);
        tekenVormPad(voorbeeldCtx, huidigeStreek);
      } else if (geselecteerdeVormIndex !== null) {
        const vorm = streken[geselecteerdeVormIndex];
        if (vormBewerking.modus === 'hoek') {
          zetHoekVanVorm(vorm, vormBewerking.hoek, p, vormBewerking.centrum, vormBewerking.rotatieBijStart);
        } else if (vormBewerking.modus === 'verplaatsen') {
          const dx = p.x - vormBewerking.startPunt.x, dy = p.y - vormBewerking.startPunt.y;
          vorm.x0 = vormBewerking.orig.x0 + dx; vorm.y0 = vormBewerking.orig.y0 + dy;
          vorm.x1 = vormBewerking.orig.x1 + dx; vorm.y1 = vormBewerking.orig.y1 + dy;
        } else if (vormBewerking.modus === 'rotatie') {
          const c = vormBewerking.centrum;
          const hoekNu = Math.atan2(p.y - c.cy, p.x - c.cx);
          vorm.rotatie = vormBewerking.rotatieBijStart + (hoekNu - vormBewerking.hoekBijStart);
        }
        herteken();
        verversSelectie();
      }
      return;
    }

    if (!huidigeStreek) return;
    const deelevents = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    (deelevents.length ? deelevents : [e]).forEach((deel) => {
      const vorige = huidigeStreek.punten[huidigeStreek.punten.length - 1];
      const nieuw = positieUitEvent(deel);
      huidigeStreek.punten.push(nieuw);
      if (huidigeStreek.tool !== 'markeerstift') tekenSegment(ctx, huidigeStreek, vorige, nieuw);
    });
    if (huidigeStreek.tool === 'markeerstift') {
      const rect = wrap.getBoundingClientRect();
      voorbeeldCtx.clearRect(0, 0, rect.width, rect.height);
      tekenVolledigPad(voorbeeldCtx, huidigeStreek);
    }
  });

  function beeindigStreek(e) {
    if (e && e.pointerId !== actievePointerId) return;

    if (vormBewerking) {
      if (vormBewerking.modus === 'nieuw' && huidigeStreek) {
        streken.push(huidigeStreek);
        geselecteerdeVormIndex = streken.length - 1;
        huidigeStreek = null;
        herteken();
        verversSelectie();
      }
      vormBewerking = null;
      tekenend = false;
      actievePointerId = null;
      return;
    }

    if (tekenend && huidigeStreek) {
      if (huidigeStreek.tool === 'markeerstift') {
        tekenVolledigPad(ctx, huidigeStreek);
        const rect = wrap.getBoundingClientRect();
        voorbeeldCtx.clearRect(0, 0, rect.width, rect.height);
      }
      streken.push(huidigeStreek);
      huidigeStreek = null;
      ongedaanKnop.disabled = streken.length === 0;
    }
    tekenend = false;
    actievePointerId = null;
  }
  canvas.addEventListener('pointerup', beeindigStreek);
  canvas.addEventListener('pointercancel', beeindigStreek);
  canvas.addEventListener('pointerleave', beeindigStreek);
  canvas.addEventListener('pointerout', beeindigStreek);

  ['touchstart', 'touchmove', 'touchend'].forEach((naam) => {
    canvas.addEventListener(naam, (e) => e.preventDefault(), { passive: false });
  });

  function afstandTussen(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function middenTussen(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    aanrakingen.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (aanrakingen.size === 2) {
      if (tekenend) { huidigeStreek = null; tekenend = false; actievePointerId = null; deselecteerVorm(); herteken(); }
      const [a, b] = Array.from(aanrakingen.values());
      pinchStart = { afstand: afstandTussen(a, b), midden: middenTussen(a, b), zoom, panX, panY };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || !aanrakingen.has(e.pointerId)) return;
    aanrakingen.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (aanrakingen.size === 2 && pinchStart) {
      const [a, b] = Array.from(aanrakingen.values());
      const schaal = afstandTussen(a, b) / pinchStart.afstand;
      const nieuwMidden = middenTussen(a, b);
      zoom = Math.min(4, Math.max(1, pinchStart.zoom * schaal));
      panX = pinchStart.panX + (nieuwMidden.x - pinchStart.midden.x);
      panY = pinchStart.panY + (nieuwMidden.y - pinchStart.midden.y);
      zetZoomTransform();
    }
  });
  function beeindigAanraking(e) {
    if (e.pointerType !== 'touch') return;
    aanrakingen.delete(e.pointerId);
    if (aanrakingen.size < 2) pinchStart = null;
  }
  canvas.addEventListener('pointerup', beeindigAanraking);
  canvas.addEventListener('pointercancel', beeindigAanraking);
  canvas.addEventListener('pointerleave', beeindigAanraking);
  canvas.addEventListener('pointerout', beeindigAanraking);

  function zetKleur(hex) {
    kleur = hex;
    kleurKnoppen.forEach((k) => {
      const actief = k.dataset.kleur === hex;
      k.classList.toggle('actief', actief);
      k.style.borderColor = actief ? hex : 'transparent';
    });
  }
  kleurKnoppen.forEach((knop) => {
    knop.addEventListener('click', () => {
      zetKleur(knop.dataset.kleur);
      if (gereedschap === 'gum') setGereedschap('pen');
    });
  });

  dikteSlider.addEventListener('input', () => { dikte = Number(dikteSlider.value); updateDiktestip(); });

  function setGereedschap(naam) {
    gereedschap = naam;
    deselecteerVorm();
    Object.entries(GEREEDSCHAP_KNOP_EL).forEach(([g, elRef]) => elRef.classList.toggle('actief', naam === g));
    canvas.style.cursor = naam === 'gum' ? 'cell' : naam === 'selecteren' ? 'default' : 'crosshair';
    if (naam === 'markeerstift') zetKleur('#ffd400');
  }
  Object.entries(GEREEDSCHAP_KNOP_EL).forEach(([g, elRef]) => elRef.addEventListener('click', () => setGereedschap(g)));

  ongedaanKnop.addEventListener('click', () => { streken.pop(); deselecteerVorm(); herteken(); });
  wisKnop.addEventListener('click', () => {
    if (streken.length && !confirm('Alles wissen?')) return;
    streken = []; huidigeStreek = null; deselecteerVorm(); herteken();
  });

  function zetModus(nieuw) {
    modus = nieuw;
    modeBladKnop.classList.toggle('actief', nieuw === 'blad');
    modeFotoKnop.classList.toggle('actief', nieuw === 'foto');
    wrap.classList.toggle('blad', nieuw === 'blad');
    uploadTrigger.style.display = nieuw === 'foto' ? '' : 'none';
    leegmelding.style.display = (nieuw === 'foto' && !achtergrondAfbeelding) ? 'flex' : 'none';
    resetZoom(); deselecteerVorm(); herteken();
  }
  modeBladKnop.addEventListener('click', () => zetModus('blad'));
  modeFotoKnop.addEventListener('click', () => zetModus('foto'));

  function afbeeldingKiezen() { bestandInvoer.click(); }
  uploadTrigger.addEventListener('click', afbeeldingKiezen);
  leegUploadKnop.addEventListener('click', afbeeldingKiezen);
  bestandInvoer.addEventListener('change', () => {
    const bestand = bestandInvoer.files[0];
    if (!bestand) return;
    laadAfbeeldingAlsAchtergrond(bestand);
  });

  function laadAfbeeldingAlsAchtergrond(blobOfFile) {
    const url = URL.createObjectURL(blobOfFile);
    const img = new Image();
    img.onload = () => {
      achtergrondAfbeelding = img;
      streken = [];
      leegmelding.style.display = 'none';
      resetZoom(); deselecteerVorm(); herteken();
    };
    img.src = url;
  }

  const observer = new ResizeObserver(() => pasCanvasGrootteAan());
  // Zonder deze opruiming blijft de resize-listener op window na sluiten hangen — een geheugenlek
  // dat bovendien een fout kan geven zodra 'ie een niet meer bestaand canvas probeert te herschalen.
  function sluitOverlay() {
    window.removeEventListener('resize', pasCanvasGrootteAan);
    observer.disconnect();
    overlay.remove();
  }

  sluitKnop.addEventListener('click', () => {
    if (streken.length && !confirm('Sluiten zonder op te slaan? Je tekening gaat dan verloren.')) return;
    sluitOverlay();
  });

  opslaanKnop.addEventListener('click', () => {
    if (!streken.length) { sluitOverlay(); return; }
    opslaanKnop.disabled = true;
    opslaanKnop.textContent = 'Opslaan…';
    canvas.toBlob(async (blob) => {
      if (blob) await slaFotoOp(blob, ruimteLabel, categorie);
      sluitOverlay();
      render();
    }, 'image/png');
  });

  window.addEventListener('resize', pasCanvasGrootteAan);
  observer.observe(wrap);

  pasCanvasGrootteAan();
  updateDiktestip();
  if (achtergrondBlob) laadAfbeeldingAlsAchtergrond(achtergrondBlob);
  zetModus(modus);
}

// Verkleint een foto vóór opslag/verzending (max. lange zijde 1600px, JPEG kwaliteit 0.82) — een
// telefoonfoto is vaak 10+ MB, wat het IndexedDB-gebruik onnodig opblaast en de webhook-upload traag/
// foutgevoelig maakt op locatie met wisselend bereik. Valt terug op het origineel bij problemen (bv.
// een HEIC-variant die createImageBitmap niet aankan).
async function verkleinFoto(file, maxAfmeting = 1600, kwaliteit = 0.82) {
  try {
    const bitmap = await createImageBitmap(file);
    const schaal = Math.min(1, maxAfmeting / Math.max(bitmap.width, bitmap.height));
    if (schaal >= 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * schaal);
    canvas.height = Math.round(bitmap.height * schaal);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const verkleind = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', kwaliteit));
    return verkleind || file;
  } catch (e) { return file; }
}

// Gedeelde opslagroutine achter verwerkGekozenFoto() (Foto's-tab/Indeling) EN de bouwkundig-
// fotoknoppen (verplichte foto's bij Meterkast/Verwarmingstoestel, "Aandachtspunt <bouwdeel>" bij
// een slechte/matige conditie) — zelfde foto-object-vorm, alleen het label/categorie verschilt.
async function slaFotoOp(file, ruimteLabel, categorie) {
  if (!file) return null;
  const foto = {
    rapport_id: state.taxatie.rapport_id,
    blob: await verkleinFoto(file),
    ruimte_label: ruimteLabel || null,
    categorie,
    gemaaktOp: new Date().toISOString(),
    status: 'lokaal',
    archief: false,
  };
  const id = await VeldopnameDB.bewaarFoto(foto);
  foto.id = id;
  state.fotos.push(foto);
  await VeldopnameDB.voegWachtrijItemToe({ type: 'foto', fotoId: id });
  verstuurFotoWachtrij();
  // De taxatielijst cachet de Vooraanzicht-miniatuur per rapport_id (zie vooraanzichtThumbnailUrl) —
  // ongeldig maken zodra er een nieuwe/eerste Vooraanzicht-foto bijkomt, anders blijft de lijst de
  // oude placeholder tonen totdat de hele pagina herladen wordt.
  if (ruimteLabel === 'Vooraanzicht') delete vooraanzichtCache[foto.rapport_id];
  return foto;
}
async function verwerkGekozenFoto(file, ruimteNaam) {
  if (!file) return;
  const categorie = ruimteNaam ? (bepaalQRCategorieVoorRuimte(ruimteNaam) || 'Anders') : 'Anders';
  await slaFotoOp(file, ruimteNaam, categorie);
  if (state.route.tab === 'fotos') render();
}
// Foto('s) voor een bouwkundig-fotoknop, bv. alle niet-gearchiveerde foto's met ruimte_label
// "Meterkast" of "Aandachtspunt Dakconstructie".
function fotosVoorLabel(label) {
  return state.fotos.filter(f => f.ruimte_label === label && !f.archief);
}
// Compacte fotoknop + eventuele al-gemaakte-foto-miniaturen, voor gebruik ín een bouwdeel-kaart.
// `verplicht` bepaalt alleen het label/uiterlijk van de knop zolang er nog geen foto is — de foto
// zelf is altijd optioneel om te VERWIJDEREN (via de bestaande lightbox), nooit hard afgedwongen.
// Toont ook cloud-only foto's (wél geüpload, niet meer lokaal) van dit label — samen met de lokale,
// zonder dedup (Arno maakt vaak meerdere foto's van dezelfde ruimte; die willen we niet verbergen).
function renderFotoKnopRij(label, categorie, verplicht) {
  const lokaleFotos = fotosVoorLabel(label);
  const cloudFotos = state.cloudFotos.filter(cf => fotoLabelSleutel(cf.ruimteLabel || cf.categorie) === fotoLabelSleutel(label));
  const totaalAantal = lokaleFotos.length + cloudFotos.length;
  const rij = el('div', { class: 'bouwdeel-foto-rij' });
  lokaleFotos.forEach(f => {
    rij.appendChild(el('button', {
      type: 'button', class: 'bouwdeel-foto-mini', onclick: () => openLightbox(f),
    }, el('img', { src: URL.createObjectURL(f.blob) })));
  });
  cloudFotos.forEach(cf => {
    rij.appendChild(el('button', {
      type: 'button', class: 'bouwdeel-foto-mini bouwdeel-foto-mini-cloud', title: "Uit cloud-archief — niet meer lokaal op dit toestel",
      onclick: () => openLightbox(cf),
    }, el('img', { src: cf.thumbUrl })));
  });
  rij.appendChild(el('label', { class: 'bouwdeel-foto-knop' + (totaalAantal ? '' : verplicht ? ' verplicht' : '') },
    totaalAantal ? '📷 Nog een foto' : (verplicht ? '📷 Foto verplicht' : '📷 Foto toevoegen'),
    el('input', {
      type: 'file', accept: 'image/*', capture: 'environment',
      onchange: async (e) => { await slaFotoOp(e.target.files[0], label, categorie); render(); },
    })));
  return rij;
}

// Blob → kale base64 (zonder de "data:image/jpeg;base64," voorloop) voor de JSON-webhook-body.
function fotoNaarBase64(blob) {
  return new Promise((resolve, reject) => {
    const lezer = new FileReader();
    lezer.onload = () => resolve(String(lezer.result).split(',')[1] || '');
    lezer.onerror = () => reject(lezer.error);
    lezer.readAsDataURL(blob);
  });
}

// Namen mogen geen \ / : * ? " < > | bevatten in een OneDrive/SharePoint-pad of -bestandsnaam.
function veiligVoorPad(tekst) {
  return String(tekst || '').replace(/[\\/:*?"<>|]/g, '-').trim();
}

let fotoWachtrijBezig = false;
async function verstuurFotoWachtrij() {
  if (!FOTO_WEBHOOK || !state.online || fotoWachtrijBezig) return;
  fotoWachtrijBezig = true;
  try {
    const items = (await VeldopnameDB.alleWachtrijItems()).filter((i) => i.type === 'foto');
    let watGewijzigd = false;
    for (const item of items) {
      try {
        const foto = await VeldopnameDB.haalFoto(item.fotoId);
        if (!foto || foto.status === 'verzonden') { await VeldopnameDB.verwijderWachtrijItem(item.id); continue; }
        const taxatie = await VeldopnameDB.haalTaxatie(foto.rapport_id);
        const adres = veiligVoorPad((taxatie && taxatie.adres) || foto.rapport_id);
        const bestandNaam = `${veiligVoorPad(foto.categorie)}-${foto.id}-${Date.now()}.jpg`;
        const payload = {
          rapport_id: foto.rapport_id, adres, ruimte_label: foto.ruimte_label || '',
          categorie: foto.categorie, opgenomen_op: foto.gemaaktOp,
          bestand_naam: bestandNaam, bestand_base64: await fotoNaarBase64(foto.blob),
        };
        const resp = await fetch(FOTO_WEBHOOK, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error('upload mislukt (' + resp.status + ')');
        await VeldopnameDB.werkFotoBij(foto.id, { status: 'verzonden' });
        await VeldopnameDB.verwijderWachtrijItem(item.id);
        const inState = state.fotos.find((f) => f.id === foto.id);
        if (inState) inState.status = 'verzonden';
        watGewijzigd = true;
      } catch (e) { /* blijft in de wachtrij staan, volgende poging bij eerstvolgende online-event/foto */ }
    }
    if (watGewijzigd && state.route.naam === 'opname' && state.route.tab === 'fotos') render();
  } finally { fotoWachtrijBezig = false; }
}

// --- Aantekeningen ---
// --- Onderzoek (vooronderzoeksdata + Funda-link) ---
let vooronderzoekOphalenBezig = false;
const ONDERZOEK_VELDEN = [
  { veld: 'bestemming', label: 'Bestemming' },
  { veld: 'woningtype_funda', label: 'Woningtype' },
  { veld: 'bouwjaar', label: 'Bouwjaar' },
  { veld: 'gebruiksoppervlakte_m2', label: 'Gebruiksoppervlakte', suffix: ' m²' },
  { veld: 'perceeloppervlakte_m2', label: 'Perceeloppervlakte', suffix: ' m²' },
  { veld: 'kadastrale_aanduiding', label: 'Kadastrale aanduiding' },
  { veld: 'wijk', label: 'Wijk' },
  { veld: 'buurt', label: 'Buurt' },
  { veld: 'gemeente', label: 'Gemeente' },
  { veld: 'woz_waarde', label: 'WOZ-waarde', format: (n) => '€ ' + Number(n).toLocaleString('nl-NL') },
  { veld: 'woz_peildatum', label: 'WOZ-peildatum' },
  { veld: 'cv_ketel_eigendom', label: 'C.V.-ketel' },
  { veld: 'cv_ketel_bouwjaar', label: 'C.V.-ketel bouwjaar' },
  { veld: 'zonnepanelen_aanwezig', label: 'Zonnepanelen', format: (v) => v ? 'Ja' : 'Nee' },
];

function renderOnderzoekTab() {
  const t = state.taxatie;
  const wrap = el('div', {});
  const kopRij = el('div', { class: 'onderzoek-koprij' },
    el('p', { class: 'macro-uitleg', style: 'margin:0;' }, 'Vooronderzoeksdata van de Research-agent.'),
    el('button', {
      class: 'knop spook klein', onclick: () => { if (!vooronderzoekOphalenBezig) { vooronderzoekOphalenBezig = true; laadVooronderzoekLijst().then(() => { vooronderzoekOphalenBezig = false; }); render(); } },
    }, '⟳ Vernieuwen'),
  );
  wrap.appendChild(kopRij);

  if (state.vooronderzoekLijst === null) {
    if (!vooronderzoekOphalenBezig) { vooronderzoekOphalenBezig = true; laadVooronderzoekLijst().then(() => { vooronderzoekOphalenBezig = false; }); }
    wrap.appendChild(el('p', { class: 'macro-uitleg' }, 'Laden…'));
    wrap.appendChild(renderBijlagenSectie(t));
    return wrap;
  }
  if (state.vooronderzoekLaadFout) {
    wrap.appendChild(el('p', { class: 'macro-uitleg' }, 'Kon vooronderzoeksdata niet ophalen (geen verbinding?). Probeer het opnieuw met "Vernieuwen".'));
    wrap.appendChild(renderBijlagenSectie(t));
    return wrap;
  }

  const record = vindVooronderzoek(t.adres);
  if (!record) {
    wrap.appendChild(el('p', { class: 'macro-uitleg' }, `Nog geen vooronderzoek gevonden voor "${t.adres || '(adres onbekend)'}". Nog niet compleet, of pas net gestart door de Research-agent? Probeer "Vernieuwen".`));
    wrap.appendChild(renderBijlagenSectie(t));
    return wrap;
  }
  const f = record.fields;

  if (f.funda_url) {
    wrap.appendChild(el('a', { href: f.funda_url, target: '_blank', rel: 'noopener', class: 'knop funda-knop' }, '🏠 Bekijk op Funda ↗'));
  } else {
    wrap.appendChild(el('p', { class: 'macro-uitleg' }, 'Geen Funda-link bekend (niet gevonden, of de woning stond niet online).'));
  }

  if (f.status_onderzoek) {
    const ok = f.status_onderzoek === 'COMPLEET';
    wrap.appendChild(el('span', { class: 'sync-pil ' + (ok ? 'ok' : 'wachtend') }, f.status_onderzoek));
  }

  const kaart = el('div', { class: 'macro-groep' });
  ONDERZOEK_VELDEN.forEach(({ veld, label, suffix, format }) => {
    const waarde = f[veld];
    if (waarde === undefined || waarde === null || waarde === '') return;
    const tekst = format ? format(waarde) : (waarde + (suffix || ''));
    kaart.appendChild(el('div', { class: 'onderzoek-rij' },
      el('span', { class: 'onderzoek-label' }, label),
      el('span', { class: 'onderzoek-waarde' }, String(tekst)),
    ));
  });
  wrap.appendChild(kaart);

  // Sinds Arno's verzoek (12-09-2026): _Makelaarsinformatie.txt (documenten van de makelaar/
  // notaris/VvE, samengevat door de scheduled task makelaarsinformatie-verwerken) gesynchroniseerd
  // naar hetzelfde Vooronderzoek-record door een aparte scheduled task
  // (makelaarsinformatie-naar-airtable) — hier alleen RAADPLEGEN, ruwe tekst, geen parsing/invoer.
  if (f.makelaarsinformatie_tekst) {
    const makelaarsKaart = el('div', { class: 'macro-groep' });
    makelaarsKaart.appendChild(el('h3', {}, '📋 Makelaarsinformatie'));
    makelaarsKaart.appendChild(el('pre', { class: 'makelaarsinformatie-tekst' }, f.makelaarsinformatie_tekst));
    wrap.appendChild(makelaarsKaart);
  }

  wrap.appendChild(renderBijlagenSectie(t));
  return wrap;
}

// Sinds Arno's verzoek (11-09-2026): "een knop waarin je bijlagen en vooronderzoeksgegevens kan
// raadplegen op locatie" — bewust in hetzelfde (nu vooraan staande) Onderzoek-tabblad, niet een
// apart tabblad: allebei is informatie die je ALLEEN raadpleegt tijdens de opname, geen invoer.
let bijlagenOphalenBezig = false;
function renderBijlagenSectie(t) {
  const kaart = el('div', { class: 'macro-groep' });
  const kop = el('div', { class: 'onderzoek-koprij' },
    el('h3', {}, '📎 Bijlagen'),
    el('button', {
      class: 'knop spook klein',
      onclick: () => { if (!bijlagenOphalenBezig) { bijlagenOphalenBezig = true; laadBijlagenLijst().then(() => { bijlagenOphalenBezig = false; }); render(); } },
    }, '⟳ Vernieuwen'),
  );
  kaart.appendChild(kop);

  if (state.bijlagenLijst === null) {
    if (!bijlagenOphalenBezig) { bijlagenOphalenBezig = true; laadBijlagenLijst().then(() => { bijlagenOphalenBezig = false; }); }
    kaart.appendChild(el('p', { class: 'macro-uitleg' }, 'Laden…'));
    return kaart;
  }
  if (state.bijlagenLaadFout) {
    kaart.appendChild(el('p', { class: 'macro-uitleg' }, 'Kon bijlagen niet ophalen (geen verbinding?). Probeer het opnieuw met "Vernieuwen".'));
    return kaart;
  }
  const bijlagen = vindBijlagen(t.rapport_id);
  if (bijlagen.length === 0) {
    kaart.appendChild(el('p', { class: 'macro-uitleg', style: 'margin-bottom:0;' }, 'Geen bijlagen doorgestuurd voor dit adres. Plaats ze vooraf in Taxatieweb (Q/R > Bijlagen) — Arno stuurt ze vandaar door met de "Bijlagen doorsturen"-knop.'));
    return kaart;
  }
  bijlagen.forEach((record) => {
    const bestand = (record.fields.bestand || [])[0];
    if (!bestand) return;
    kaart.appendChild(el('a', {
      href: bestand.url, target: '_blank', rel: 'noopener', class: 'bijlage-rij',
    }, el('span', { class: 'bijlage-icoon' }, '📄'), el('span', {}, record.fields.naam || bestand.filename || 'Bijlage')));
  });
  return kaart;
}

// --- Bewoning (L, Fase 1 van "volledige opname") ---
// Herbruikbaar bouwsteentje: een Ja/Nee-vraag, met een toelichting-tekstveld dat verschijnt zodra
// "Ja, toelichten" gekozen is — exact het patroon dat Taxatieweb's L. Bewoning zelf overal gebruikt.
function renderJaNeeVraag(label, taxatie, veld, toelichtingVeld, { toelichtBij = true } = {}) {
  const wrap = el('div', { class: 'bewoning-vraag' });
  wrap.appendChild(el('div', { class: 'bewoning-label' }, label));
  const wissel = el('div', { class: 'weergave-wissel' });
  [[false, toelichtBij === false ? 'Nee, toelichten' : 'Nee'], [true, toelichtBij === true ? 'Ja, toelichten' : 'Ja']].forEach(([waarde, tekst]) => {
    wissel.appendChild(el('button', {
      class: 'klein' + (taxatie.bewoning[veld] === waarde ? ' actief' : ''),
      onclick: () => { taxatie.bewoning[veld] = waarde; planOpslaan(); render(); },
    }, tekst));
  });
  wrap.appendChild(wissel);
  if (taxatie.bewoning[veld] === toelichtBij && toelichtingVeld) {
    const veldEl = el('textarea', {
      class: 'bewoning-toelichting', placeholder: 'Toelichting…',
      oninput: (e) => { taxatie.bewoning[toelichtingVeld] = e.target.value; planOpslaan(); },
    });
    veldEl.value = taxatie.bewoning[toelichtingVeld] || '';
    wrap.appendChild(veldEl);
  }
  return wrap;
}

// "Bewoning" hernoemd naar "Objectkenmerken" (Arno's verzoek 12-09-2026) met twee nieuwe velden
// vooraan: Woningtype (Taxatieweb's C. Object) en Bouwjaar (H. Object/Omgeving). Worden automatisch
// voorgevuld vanuit het vooronderzoek zodra ze nog leeg zijn — nooit een handmatige invoer
// overschrijven. De rest van de tab (A/B/F/G/H/J) is de bestaande L. Bewoning-data, ongewijzigd.
function renderObjectkenmerkenTab() {
  const t = state.taxatie;
  const wrap = el('div', {});
  zorgVoorVooronderzoek();
  const vo = vindVooronderzoek(t.adres);
  if (vo) {
    if (!t.bewoning.woningtype && vo.fields.woningtype_funda) { t.bewoning.woningtype = vo.fields.woningtype_funda; planOpslaan(); }
    if (!t.bewoning.bouwjaar && vo.fields.bouwjaar) { t.bewoning.bouwjaar = String(vo.fields.bouwjaar); planOpslaan(); }
  }
  // Arno (13-09-2026): "Selecteer tuin automatisch als het geen appartement betreft" — alleen de
  // ALLEREERSTE keer (tuinAanwezig nog null, dus nooit eerder gezet/aangeraakt); een handmatige
  // correctie via de toggle hieronder wordt nooit stilzwijgend teruggedraaid.
  if (t.bewoning.tuinAanwezig === null && t.bewoning.woningtype) {
    t.bewoning.tuinAanwezig = !APPARTEMENTACHTIGE_WONINGTYPES.includes(t.bewoning.woningtype);
    planOpslaan();
  }

  const groepKenmerken = el('div', { class: 'macro-groep' });
  groepKenmerken.appendChild(el('h3', {}, 'Objectkenmerken'));
  const kenmerkenRij = el('div', { class: 'objectkenmerken-rij' });
  // Beide velden zijn keuzelijsten i.p.v. vrije tekst/getal sinds 13-09-2026 (Arno: "Woningtype lijst
  // overnemen" + "Bouwjaar met keuzelijst"), exact de opties van Taxatieweb's C. Object/eigen
  // bouwjaar-aanpak — een auto-ingevulde waarde die niet exact matcht (bv. rechtstreeks uit Funda)
  // toont dan gewoon "Selecteer", de taxateur kiest zelf de juiste.
  const woningtypeVeld = el('select', {
    class: 'energetisch-select',
    onchange: (e) => {
      t.bewoning.woningtype = e.target.value;
      if (t.bewoning.tuinAanwezig === null && e.target.value) t.bewoning.tuinAanwezig = !APPARTEMENTACHTIGE_WONINGTYPES.includes(e.target.value);
      planOpslaan(); render();
    },
  },
    el('option', { value: '' }, 'Selecteer'),
    ...WONINGTYPE_OPTIES.map(o => el('option', { value: o, selected: t.bewoning.woningtype === o ? 'selected' : null }, o)));
  const bouwjaarVeld = renderJaarKeuze(t.bewoning.bouwjaar, (w) => { t.bewoning.bouwjaar = w; planOpslaan(); render(); });
  kenmerkenRij.appendChild(el('label', { class: 'objectkenmerken-veld' }, 'Woningtype', woningtypeVeld));
  kenmerkenRij.appendChild(el('label', { class: 'objectkenmerken-veld' }, 'Bouwjaar', bouwjaarVeld));
  groepKenmerken.appendChild(kenmerkenRij);
  groepKenmerken.appendChild(renderJaNeeToggle('Tuin aanwezig', t.bewoning.tuinAanwezig, (w) => { t.bewoning.tuinAanwezig = w; }));
  // Taxatieweb H.1.D (live bevestigd 13-09-2026) — een eigen Ja/Nee+toelichting-veld, i.t.t.
  // Tuin-detailvelden die toch alleen in vrije tekst terecht zouden komen wel de moeite waard.
  groepKenmerken.appendChild(jaNeeMetToelichtingRij(
    'Zijn er grote verbouwingen of uitbreidingen geweest?',
    t.bewoning.grootVerbouwingGeweest, (w) => { t.bewoning.grootVerbouwingGeweest = w; planOpslaan(); },
    t.bewoning.grootVerbouwingToelichting, (v) => { t.bewoning.grootVerbouwingToelichting = v; planOpslaan(); },
    'Toelichting verbouwing/uitbreiding…',
  ));
  wrap.appendChild(groepKenmerken);

  // Arno (13-09-2026): "Voeg de fotoknoppen toe aan objectkenmerken" — Vooraanzicht/Achtergevel/
  // Straatbeeld zijn altijd verplicht (zie VASTE_VERPLICHTE_FOTOS) maar hadden nergens een eigen
  // maakknop; Tuin idem, maar alleen als "Tuin aanwezig" op Ja staat.
  const groepFotos = el('div', { class: 'macro-groep' });
  groepFotos.appendChild(el('h3', {}, "Verplichte foto's"));
  // In kolommen i.p.v. elk een eigen volle-breedte regel (Arno: "compacter, bijv. kolommen",
  // 13-09-2026) — 2 op telefoon, meer op een bredere iPad (zie .foto-knop-grid in style.css).
  const fotoGrid = el('div', { class: 'foto-knop-grid' });
  const fotoMetNaam = (naam, categorie) => el('div', { class: 'foto-knop-met-naam' },
    el('span', { class: 'foto-knop-naam' }, naam), renderFotoKnopRij(naam, categorie, true));
  fotoGrid.appendChild(fotoMetNaam('Vooraanzicht', 'Vooraanzicht'));
  fotoGrid.appendChild(fotoMetNaam('Achtergevel', 'Achtergevel'));
  fotoGrid.appendChild(fotoMetNaam('Straatbeeld', 'Straatbeeld'));
  if (t.bewoning.tuinAanwezig) fotoGrid.appendChild(fotoMetNaam('Tuin', 'Tuin'));
  groepFotos.appendChild(fotoGrid);
  wrap.appendChild(groepFotos);

  const groepA = el('div', { class: 'macro-groep' });
  groepA.appendChild(el('h3', {}, 'A. Waar heb ik gezocht naar informatie?'));
  groepA.appendChild(renderJaNeeVraag('Bij de eigenaar of de bewoner', t, 'gezochtEigenaarBewoner', 'gezochtEigenaarBewonerToelichting'));
  groepA.appendChild(renderJaNeeVraag('Bij de verkopende makelaar', t, 'gezochtMakelaar', 'gezochtMakelaarToelichting'));
  groepA.appendChild(renderJaNeeVraag('Andere bronnen', t, 'gezochtAndereBronnen', 'gezochtAndereBronnenToelichting'));
  wrap.appendChild(groepA);

  const groepF = el('div', { class: 'macro-groep' });
  groepF.appendChild(el('h3', {}, 'F. Wat is de situatie van de woning?'));
  const select = el('select', {
    class: 'bewoning-select',
    onchange: (e) => { t.bewoning.situatie = e.target.value; planOpslaan(); render(); },
  }, el('option', { value: '' }, 'Selecteer'),
    ...BEWONING_SITUATIE_OPTIES.map(optie => el('option', { value: optie, selected: t.bewoning.situatie === optie ? 'selected' : null }, optie)));
  groepF.appendChild(select);
  if (t.bewoning.situatie === 'Anders, namelijk:') {
    const anders = el('textarea', {
      class: 'bewoning-toelichting', placeholder: 'Namelijk…',
      oninput: (e) => { t.bewoning.situatieAnders = e.target.value; planOpslaan(); },
    });
    anders.value = t.bewoning.situatieAnders || '';
    groepF.appendChild(anders);
  }
  wrap.appendChild(groepF);

  const groepGH = el('div', { class: 'macro-groep' });
  groepGH.appendChild(renderJaNeeVraag('G. Woont de aanvrager van de lening al in de woning?', t, 'aanvragerWoontAl', 'aanvragerWoontAlToelichting', { toelichtBij: false }));
  groepGH.appendChild(el('div', { style: 'height:10px' }));
  groepGH.appendChild(renderJaNeeVraag('H. Gaat of blijft de aanvrager van de lening zelf in de woning wonen?', t, 'aanvragerBlijftWonen', 'aanvragerBlijftWonenToelichting', { toelichtBij: false }));
  wrap.appendChild(groepGH);

  const groepJ = el('div', { class: 'macro-groep' });
  groepJ.appendChild(renderJaNeeVraag('J. Heb ik andere informatie ontdekt dan de informatie die hierboven staat?', t, 'andereInfoOntdekt', 'andereInfoOntdektToelichting'));
  wrap.appendChild(groepJ);

  return wrap;
}

// Kleine hint-tekst (18-09-2026, Arno n.a.v. de taXapi-vergelijking: waarschuwing dat een
// verwarmingsbron op een andere verdieping daar zelf ingevuld moet worden) — generiek via def.hint,
// zodat hetzelfde patroon later ook bij andere velden hergebruikt kan worden.
function renderBouwdeelHint(tekst) {
  return el('div', { class: 'bouwdeel-hint' }, '💡 ', tekst);
}
// --- Bouwkundig (Fase 2 "volledige opname", J.4 Bouwkundige opnamestaat) ---
// Compact: label + chips op ÉÉN regel (i.p.v. label erboven, chips op een eigen regel eronder) —
// Arno: "conditie keuzes bijvoorbeeld naast veld conditie (scheelt een regel)".
function conditieRij(bouwdeel) {
  const chips = el('div', { class: 'conditie-chips' });
  CONDITIE_LABELS.forEach((label, waarde) => {
    chips.appendChild(el('button', {
      class: 'klein' + (bouwdeel.conditie === waarde ? ' actief' : ''),
      onclick: () => { bouwdeel.conditie = waarde; planOpslaan(); render(); },
    }, label));
  });
  return el('div', { class: 'bouwdeel-conditie-rij' }, el('span', { class: 'bouwdeel-veld-label' }, 'Conditie'), chips);
}
// Compact: label+Ja/Nee-knoppen in een smalle linker kolom, toelichtingsveld ernaast i.p.v.
// eronder — Arno: "Aandachtspunten ja/nee met opmerkingenveld ernaast" (scheelt hoogte).
function jaNeeMetToelichtingRij(waardeLabel, huidigeWaarde, onWaarde, huidigeToelichting, onToelichting, placeholder) {
  const wissel = el('div', { class: 'weergave-wissel' });
  [[false, 'Nee'], [true, 'Ja']].forEach(([waarde, tekst]) => {
    wissel.appendChild(el('button', {
      class: 'klein' + (huidigeWaarde === waarde ? ' actief' : ''),
      onclick: () => { onWaarde(waarde); render(); },
    }, tekst));
  });
  const links = el('div', { class: 'bouwdeel-aandacht-links' }, el('span', { class: 'bouwdeel-veld-label' }, waardeLabel), wissel);
  const rij = el('div', { class: 'bouwdeel-aandacht-rij' }, links);
  if (huidigeWaarde === true) {
    const toelichting = el('textarea', {
      class: 'bouwdeel-omschrijving bouwdeel-omschrijving-naast', placeholder,
      oninput: (e) => onToelichting(e.target.value),
    });
    toelichting.value = huidigeToelichting || '';
    rij.appendChild(toelichting);
  }
  return rij;
}
// Type 'risico': geen conditie/materiaal/aandachtspunten — alleen "Risico: Ja/Nee" + vrije
// omschrijving, exact zoals Taxatieweb's eigen Overige bijzonderheden-velden (Houtaantasters e.d.).
// Zelfde compacte Ja/Nee-naast-tekstveld-opzet als de gewone aandachtspunten-rij.
function renderRisicoBouwdeelKaart(bouwdeel, def) {
  const attentieIdVeld = attentieId('bouwkundig', def.key);
  const kaart = el('div', { class: 'bouwdeel-kaart' + (attentieActief(attentieIdVeld) ? ' bouwdeel-kaart-attentie' : '') });
  const kop = el('div', {
    class: 'bouwdeel-kop',
    onclick: () => { bouwdeel.aanwezig = !bouwdeel.aanwezig; planOpslaan(); render(); },
  },
    el('input', { type: 'checkbox', checked: bouwdeel.aanwezig ? 'checked' : null }),
    el('span', { class: 'bouwdeel-titel' }, def.label),
    renderAttentieKnop(attentieIdVeld));
  kaart.appendChild(kop);
  if (!bouwdeel.aanwezig) return kaart;

  kaart.appendChild(jaNeeMetToelichtingRij(
    'Risico', bouwdeel.risico, (w) => { bouwdeel.risico = w; planOpslaan(); },
    bouwdeel.omschrijving, (v) => { bouwdeel.omschrijving = v; planOpslaan(); },
    'Omschrijving ' + def.label.toLowerCase() + '…',
  ));
  // Foto per onderdeel, verplicht zodra Risico op Ja staat (17-09-2026, zelfde idee als de andere
  // bouwdeel-kaarten hierboven — bij een risico-bouwdeel is "Risico: Ja" het equivalent van
  // "Aandachtspunten: Ja").
  kaart.appendChild(renderFotoKnopRij(def.label, def.fotoCategorie || def.label, bouwdeel.risico === true));
  // Bij Risico "Nee" toont Taxatieweb de omschrijving nog steeds (het is geen aandachtspunt-detail
  // maar de hoofdomschrijving van dit bouwdeel) — dus hier altijd tonen, niet alleen bij Ja.
  if (bouwdeel.risico !== true) {
    const omschrijvingVeld = el('textarea', {
      class: 'bouwdeel-omschrijving', placeholder: 'Omschrijving ' + def.label.toLowerCase() + '…',
      oninput: (e) => { bouwdeel.omschrijving = e.target.value; planOpslaan(); },
    });
    omschrijvingVeld.value = bouwdeel.omschrijving || '';
    kaart.appendChild(omschrijvingVeld);
  }
  return kaart;
}
// Renderfunctie per detail-veldtype (Bouwjaar/Eigendom bij Verwarmings-/Warmwatertoestel, Aantal
// groepen/aardlekschakelaars/Krachtstroom/Oplaadpunt bij Meterkast — live nagekeken in Taxatieweb).
function renderDetailVeld(bouwdeel, d) {
  const waarde = bouwdeel.details[d.key];
  if (d.type === 'select') {
    return el('label', { class: 'bouwdeel-detail-veld' }, d.label,
      el('select', {
        class: 'bouwdeel-detail-select',
        onchange: (e) => { bouwdeel.details[d.key] = e.target.value; planOpslaan(); },
      },
        el('option', { value: '' }, 'Selecteer'),
        ...d.opties.map(o => el('option', { value: o, selected: waarde === o ? 'selected' : null }, o))));
  }
  if (d.type === 'ja_nee') {
    const wissel = el('div', { class: 'weergave-wissel' });
    [[false, 'Nee'], [true, 'Ja']].forEach(([w, tekst]) => {
      wissel.appendChild(el('button', {
        class: 'klein' + (waarde === w ? ' actief' : ''),
        onclick: () => { bouwdeel.details[d.key] = w; planOpslaan(); render(); },
      }, tekst));
    });
    return el('div', { class: 'bouwdeel-detail-veld' }, el('span', {}, d.label), wissel);
  }
  if (d.type === 'jaar') {
    return el('label', { class: 'bouwdeel-detail-veld' }, d.label,
      renderJaarKeuze(waarde, (w) => { bouwdeel.details[d.key] = w; planOpslaan(); render(); }, 'bouwdeel-detail-select'));
  }
  // 'getal'
  const input = el('input', {
    type: 'number', placeholder: '0',
    oninput: (e) => { bouwdeel.details[d.key] = e.target.value; planOpslaan(); },
  });
  input.value = waarde || '';
  return el('label', { class: 'bouwdeel-detail-veld' }, d.label, input);
}
// Chips die met 1 tik een kant-en-klaar zinsdeel toevoegen aan het omschrijvingsveld van een
// vrije-tekst-bouwdeel — Arno's verzoek 13-09-2026, n.a.v. de vergelijking met Taxatieweb's eigen
// "Toon macro's": deze bouwdelen hebben in Taxatieweb GEEN checkbox-multiselect (in tegenstelling
// tot bv. Keuken/Badkamer, die al hun eigen materialen-lijst hebben), alleen een vrij tekstveld —
// dus is een eigen, snellere manier om dat veld te vullen op locatie de enige optie. Sinds Arno's
// vervolgverzoek (13-09-2026, "graag ook op de overige tekstvelden... en als macro's bewerkbaar")
// zitten deze lijsten nu in state.macros.bouwdeelChips (zie standaardMacros()) i.p.v. een vaste
// constante — per bouwdeel aanpasbaar/herordenbaar via het ✎-knopje, zie renderChipEditor().
// bouwdeelChipEditorOpen: welk bouwdeel z'n editor nu openstaat — bewust NIET in state/opgeslagen,
// puur een tijdelijke UI-schakelaar die bij een paginaherlaad weer dichtklapt.
const bouwdeelChipEditorOpen = {};
function renderChipEditor(lijst, opslaanFn) {
  const wrap = el('div', { class: 'chip-editor' });
  const chipRij = el('div', { class: 'chip-rij' });
  lijst.forEach((item, i) => {
    const chip = el('span', { class: 'chip chip-sleepbaar', draggable: 'true' },
      el('span', { class: 'chip-handvat' }, '⠿'),
      item,
      el('button', {
        onclick: () => {
          if (!confirm(`"${item}" verwijderen uit deze macro-lijst?`)) return;
          lijst.splice(i, 1); opslaanFn(); render();
        },
      }, '✕'),
    );
    // Zelfde sleep-herorden-patroon als gevraagd ("de mogelijkheden zoals verplaatsen"): een echte
    // HTML5-drag i.p.v. ↑/↓-knoppen — bewust hier apart gebouwd (i.t.t. de userscript-variant) want
    // dit is de eerste plek in de PWA zelf waar chip-volgorde ertoe doet.
    chip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); });
    chip.addEventListener('dragover', (e) => e.preventDefault());
    chip.addEventListener('drop', (e) => {
      e.preventDefault();
      const van = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (isNaN(van) || van === i) return;
      const [verplaatst] = lijst.splice(van, 1);
      lijst.splice(i, 0, verplaatst);
      opslaanFn(); render();
    });
    chipRij.appendChild(chip);
  });
  wrap.appendChild(chipRij);
  const invoer = el('input', { placeholder: 'Nieuwe macro toevoegen…' });
  invoer.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !invoer.value.trim()) return;
    lijst.push(invoer.value.trim());
    opslaanFn(); render();
  });
  wrap.appendChild(el('div', { class: 'chip-toevoegen' }, invoer));
  return wrap;
}
// Sinds 13-09-2026 (Arno's verzoek): een chip voegt een NIEUWE opsommingsregel toe ("- tekst")
// i.p.v. achter de bestaande tekst te plakken — elke tik is dus een eigen regel, net als de
// "- Ruimte met toevoeging." opsomming die componeerIndelingTekst() ook al gebruikt.
// veldNaam: 'omschrijving' (Bouwkundig) of 'opmerkingen' (Energetisch) — zelfde bouwsteen voor
// beide hoofdstukken, want Taxatieweb noemt het veld daar nu eenmaal anders.
function voegOmschrijvingChipToe(veld, tekst, veldNaam = 'omschrijving') {
  const huidig = (veld[veldNaam] || '').replace(/\n+$/, '');
  const regel = '- ' + tekst;
  veld[veldNaam] = huidig.trim() ? huidig + '\n' + regel : regel;
  planOpslaan(); render();
}
// Chip-rij + ✎-bewerkknopje voor één bouwdeel/energetisch-veld — gedeelde bouwsteen voor zowel
// Bouwkundig (renderBouwdeelKaart, veldNaam 'omschrijving') als Energetisch (renderInstallatiemoment-
// EnOpmerkingen/renderEnergetischSimpelKaart, veldNaam 'opmerkingen'), sinds Arno's verzoek
// 13-09-2026: "graag ook voor energetisch". Geeft een lege wrapper terug (geen zichtbaar effect)
// als dit def.key geen chip-lijst heeft — zo hoeft de aanroeper zelf niet te controleren of er iets
// te tonen valt.
function renderBouwdeelChips(veld, def, veldNaam) {
  const wrap = el('div', {});
  const chipLijst = state.macros.bouwdeelChips && state.macros.bouwdeelChips[def.key];
  if (!chipLijst) return wrap;
  const header = el('div', { class: 'bouwdeel-chip-header' });
  const chipRij = el('div', { class: 'chip-rij bouwdeel-chip-rij' });
  chipLijst.forEach(tekst => {
    chipRij.appendChild(el('button', {
      type: 'button', class: 'chip-knop',
      onclick: () => voegOmschrijvingChipToe(veld, tekst, veldNaam),
    }, tekst));
  });
  header.appendChild(chipRij);
  // ✎-knopje (Arno's verzoek 13-09-2026: "net zoiets als in Provadie") — klapt een editor open/dicht
  // voor PRECIES deze ene chip-lijst, i.p.v. naar een aparte instellingenpagina te moeten.
  header.appendChild(el('button', {
    type: 'button', class: 'chip-bewerk-knop', title: 'Chips bewerken',
    onclick: () => { bouwdeelChipEditorOpen[def.key] = !bouwdeelChipEditorOpen[def.key]; render(); },
  }, '✎'));
  wrap.appendChild(header);
  if (bouwdeelChipEditorOpen[def.key]) {
    wrap.appendChild(renderChipEditor(chipLijst, bewaarMacros));
  }
  return wrap;
}
// "Overnemen"-knop bij Trappen (13-09-2026, Arno's verzoek): leest de trap-toevoegingen die al bij
// losse ruimtes in Indeling staan (bv. "vaste trap naar de eerste verdieping" bij Hal, "vlizotrap
// naar de zolderverdieping" bij Overloop — dezelfde toevoegingen-macro's als hierboven) en zet er
// één samengevatte, en-opgesomde zin van in het Trappen-omschrijvingsveld ("Vaste trap en
// vlizotrap"). Herkent bewust dezelfde woorden als de TRAPPEN-chips hierboven, zodat "Overnemen"
// en de chips altijd hetzelfde vocabulaire gebruiken. Vervangt de omschrijving (i.p.v. toe te
// voegen) — dit is een samenvatting van wat er al elders staat, geen aanvulling.
function bepaalTrapTypesUitIndeling() {
  const woonlagen = (state.taxatie && state.taxatie.data && state.taxatie.data.indeling.woonlagen) || [];
  const gevonden = [];
  const voegToe = (label) => { if (!gevonden.includes(label)) gevonden.push(label); };
  woonlagen.forEach(w => (w.ruimtes || []).forEach(r => (r.toevoegingen || []).forEach(t => {
    const tekst = (t || '').toLowerCase();
    if (tekst.includes('vlizotrap')) voegToe('Vlizotrap');
    else if (tekst.includes('losse trap')) voegToe('Losse trap');
    else if (tekst.includes('vaste trappen')) voegToe('Vaste trappen');
    else if (tekst.includes('vaste trap')) voegToe('Vaste trap');
  })));
  return gevonden;
}
// Een def kan `macroSleutel` hebben (bv. 'vloersoort', 'glastypes', 'verwarmingssysteem') — dan
// komen de keuze-opties LIVE uit state.macros (door Arno zelf bewerkbaar in de Macros-tab en het
// nieuwe "Kenmerken verdieping"-blok in Indeling), met def.opties alleen als fallback zolang de
// macro's nog niet geladen zijn. Zonder macroSleutel werkt een def exact als voorheen.
function bepaalOpties(def) {
  if (def.macroSleutel && Array.isArray(state.macros[def.macroSleutel]) && state.macros[def.macroSleutel].length) {
    return state.macros[def.macroSleutel];
  }
  return def.opties;
}

// Een def kan óók `kenmerkenKoppeling: { macroSleutel, slot }` hebben (Arno's verzoek 16-09-2026:
// "kenmerken moeten automatisch op beide plekken identiek zijn, ook de aangevinkte keuzes") — dan is
// dit veld GEEN eigen los opgeslagen keuze meer, maar leest/schrijft rechtstreeks de "Kenmerken
// verdieping"-selectie(s) in Indeling. Dat maakt de twee plekken identiek by DESIGN (1 opslagplek)
// i.p.v. via een foutgevoelige synchronisatiestap. `slot` bepaalt welke woonlaag/woonlagen erbij
// horen — bij een gecombineerd slot ('overige'/'2eEnVolgende'/'alle') geldt een vinkje als "aan"
// zodra minstens 1 van de betrokken woonlagen 'm heeft, en een klik zet 'm op ALLE betrokken
// woonlagen tegelijk aan/uit (1 vinkje kan geen verschil per woonlaag tonen).
function woonlagenVoorSlot(slot) {
  const woonlagen = (state.taxatie && state.taxatie.data && state.taxatie.data.indeling.woonlagen) || [];
  if (slot === 'alle') return woonlagen;
  if (slot === '1e') return woonlagen.slice(0, 1);
  if (slot === '2e') return woonlagen.slice(1, 2);
  if (slot === '3e') return woonlagen.slice(2, 3);
  if (slot === 'overige') return woonlagen.slice(3);
  if (slot === '2eEnVolgende') return woonlagen.slice(1);
  return [];
}
function kenmerkGeselecteerd(koppeling, optie) {
  return woonlagenVoorSlot(koppeling.slot).some((w) => {
    if (!w.kenmerken) w.kenmerken = leegWoonlaagKenmerken();
    return (w.kenmerken[koppeling.macroSleutel] || []).includes(optie);
  });
}
function kenmerkWissel(koppeling, optie) {
  const nieuweStatus = !kenmerkGeselecteerd(koppeling, optie);
  woonlagenVoorSlot(koppeling.slot).forEach((w) => {
    if (!w.kenmerken) w.kenmerken = leegWoonlaagKenmerken();
    const lijst = w.kenmerken[koppeling.macroSleutel];
    const i = lijst.indexOf(optie);
    if (nieuweStatus && i < 0) lijst.push(optie);
    if (!nieuweStatus && i >= 0) lijst.splice(i, 1);
  });
}
// Eenmalige (idempotente) overname bij het laden van een taxatie: bestaande Vloeren/Kozijnen/Glas/
// Verwarmingssysteem-keuzes die vóór de kenmerkenKoppeling hierboven al los per bouwdeel waren
// aangevinkt, samenvoegen in de bijbehorende Indeling-woonlaag(en) — zodat niets ineens verdwenen
// lijkt nu deze velden hun aangevinkte keuzes rechtstreeks uit Indeling lezen (Arno's verzoek
// 16-09-2026: "automatisch op beide plekken identiek, ook de aangevinkte keuzes"). Draait bij elke
// laadOpname() maar is een no-op zodra alles al is samengevoegd (bestaande materialen-velden worden
// hierna niet meer bijgewerkt, dus dit blijft veilig herhaalbaar).
function synchroniseerKenmerken() {
  const t = state.taxatie;
  (t.data.indeling.woonlagen || []).forEach((w) => { if (!w.kenmerken) w.kenmerken = leegWoonlaagKenmerken(); });
  const voegSamen = (bouwdeel, koppeling) => {
    const materialen = bouwdeel && bouwdeel.materialen;
    if (!Array.isArray(materialen) || !materialen.length) return;
    woonlagenVoorSlot(koppeling.slot).forEach((w) => {
      materialen.forEach((optie) => {
        if (!w.kenmerken[koppeling.macroSleutel].includes(optie)) w.kenmerken[koppeling.macroSleutel].push(optie);
      });
    });
  };
  voegSamen(t.bouwkundig.buitenzijde.gevel.kozijnen, { macroSleutel: 'kozijnen', slot: 'alle' });
  voegSamen(t.bouwkundig.binnenzijde.vloeren.woonlaag1, { macroSleutel: 'vloersoort', slot: '1e' });
  voegSamen(t.bouwkundig.binnenzijde.vloeren.woonlaag2, { macroSleutel: 'vloersoort', slot: '2e' });
  voegSamen(t.bouwkundig.binnenzijde.vloeren.woonlaag3, { macroSleutel: 'vloersoort', slot: '3e' });
  voegSamen(t.bouwkundig.binnenzijde.vloeren.woonlaagOverige, { macroSleutel: 'vloersoort', slot: 'overige' });
  voegSamen(t.bouwkundig.installaties.verwarming.verwarmingssysteem1eWoonlaag, { macroSleutel: 'verwarmingssysteem', slot: '1e' });
  voegSamen(t.bouwkundig.installaties.verwarming.verwarmingssysteem2eEnVolgendeWoonlaag, { macroSleutel: 'verwarmingssysteem', slot: '2eEnVolgende' });
  voegSamen(t.energetisch.isolatie.ramen.glas1e, { macroSleutel: 'glastypes', slot: '1e' });
  voegSamen(t.energetisch.isolatie.ramen.glas2e, { macroSleutel: 'glastypes', slot: '2e' });
  voegSamen(t.energetisch.isolatie.ramen.glas3e, { macroSleutel: 'glastypes', slot: '3e' });
  voegSamen(t.energetisch.isolatie.ramen.glasOverige, { macroSleutel: 'glastypes', slot: 'overige' });
  // Bouwkundig's eigen Glas 1e/2e/3e/overige woonlaag (18-09-2026 omgezet van tekst naar dezelfde
  // gedeelde koppeling — zie migreerGlasWoonlaagVelden hierboven voor de tekst-naar-Overige-migratie).
  voegSamen(t.bouwkundig.buitenzijde.gevel.glas1eWoonlaag, { macroSleutel: 'glastypes', slot: '1e' });
  voegSamen(t.bouwkundig.buitenzijde.gevel.glas2eWoonlaag, { macroSleutel: 'glastypes', slot: '2e' });
  voegSamen(t.bouwkundig.buitenzijde.gevel.glas3eWoonlaag, { macroSleutel: 'glastypes', slot: '3e' });
  voegSamen(t.bouwkundig.buitenzijde.gevel.glasOverigeWoonlagen, { macroSleutel: 'glastypes', slot: 'overige' });
  voegSamen(t.energetisch.installaties.verwarming.verwarmingssysteem1e, { macroSleutel: 'verwarmingssysteem', slot: '1e' });
  voegSamen(t.energetisch.installaties.verwarming.verwarmingssysteem2e, { macroSleutel: 'verwarmingssysteem', slot: '2eEnVolgende' });
}

// installatieKoppeling (17-09-2026, Arno "A. prima") — zelfde 1-opslagplek-principe als
// kenmerkenKoppeling hierboven, maar dan huisbreed (geen woonlaag-slot): Ventilatie, Koeling en
// Warmwatertoestel stonden dubbel in Bouwkundig én Energetisch. `sleutel` wijst naar
// data.installatieKenmerken (en de gelijknamige macro-lijst uit state.macros).
// LET OP (19-09-2026, gevonden bij het toevoegen van de 'verwarmingstoestel'-sleutel): een bestaande
// taxatie kan data.installatieKenmerken al hebben zonder de NIEUWSTE sleutel erin (leegInstallatieKenmerken()
// is alleen ooit toegepast op een volledig ontbrekend object, niet op ontbrekende sub-sleutels
// daarbinnen) — vandaar hier alsnog een fallback naar een lege array i.p.v. rechtstreeks .indexOf()
// op undefined aan te roepen.
function installatieGeselecteerd(sleutel, optie) {
  if (!state.taxatie.data.installatieKenmerken) state.taxatie.data.installatieKenmerken = leegInstallatieKenmerken();
  return (state.taxatie.data.installatieKenmerken[sleutel] || []).includes(optie);
}
function installatieWissel(sleutel, optie) {
  if (!state.taxatie.data.installatieKenmerken) state.taxatie.data.installatieKenmerken = leegInstallatieKenmerken();
  if (!Array.isArray(state.taxatie.data.installatieKenmerken[sleutel])) state.taxatie.data.installatieKenmerken[sleutel] = [];
  const lijst = state.taxatie.data.installatieKenmerken[sleutel];
  const i = lijst.indexOf(optie);
  if (i >= 0) lijst.splice(i, 1); else lijst.push(optie);
}
// Eenmalige (idempotente) overname, analoog aan synchroniseerKenmerken() hierboven: bestaande
// Ventilatie/Koeling/Warmwatertoestel-keuzes die vóór installatieKoppeling al los per bouwdeel waren
// aangevinkt (in Bouwkundig ÉN Energetisch), samenvoegen in de gedeelde installatieKenmerken-store.
function synchroniseerInstallatieKenmerken() {
  const t = state.taxatie;
  if (!t.data.installatieKenmerken) t.data.installatieKenmerken = leegInstallatieKenmerken();
  const voegSamen = (bouwdeel, sleutel) => {
    const materialen = bouwdeel && bouwdeel.materialen;
    if (!Array.isArray(materialen) || !materialen.length) return;
    if (!Array.isArray(t.data.installatieKenmerken[sleutel])) t.data.installatieKenmerken[sleutel] = [];
    materialen.forEach((optie) => {
      if (!t.data.installatieKenmerken[sleutel].includes(optie)) t.data.installatieKenmerken[sleutel].push(optie);
    });
  };
  voegSamen(t.bouwkundig.installaties.ventilatieKoeling.ventilatie, 'ventilatie');
  voegSamen(t.bouwkundig.installaties.ventilatieKoeling.koeling, 'koeling');
  voegSamen(t.bouwkundig.installaties.warmwater.warmwatertoestel, 'warmwatertoestel');
  voegSamen(t.bouwkundig.installaties.verwarming.verwarmingstoestel, 'verwarmingstoestel');
  voegSamen(t.energetisch.installaties.ventilatieKoeling.ventilatie, 'ventilatie');
  voegSamen(t.energetisch.installaties.ventilatieKoeling.koeling, 'koeling');
  voegSamen(t.energetisch.installaties.warmWater.warmwatertoestel, 'warmwatertoestel');
  voegSamen(t.energetisch.installaties.verwarming.verwarmingstoestel, 'verwarmingstoestel');
}

// --- Attentiewaarde (17-09-2026, Arno's verzoek: "bepaalde onderdelen extra attentiewaarde geven
// ... door een !-knopje toe te voegen ... dan kun je dit meteen meenemen onder Controle zodat geen
// opname zaken/velden gemist worden") ---
// `sectie` is 'bouwkundig' of 'energetisch' (de enige twee plekken met een !-knop, zie
// renderBouwdeelKaart/renderRisicoBouwdeelKaart/renderEnergetischKop) — nodig omdat def.key niet
// overal uniek is TUSSEN de twee schema's (bv. 'ventilatie' bestaat in allebei).
function attentieId(sectie, defKey) {
  return sectie + ':' + defKey;
}
function attentieActief(id) {
  return (state.taxatie.data.attentieVelden || []).includes(id);
}
function wisselAttentie(id) {
  if (!Array.isArray(state.taxatie.data.attentieVelden)) state.taxatie.data.attentieVelden = [];
  const lijst = state.taxatie.data.attentieVelden;
  const i = lijst.indexOf(id);
  if (i >= 0) lijst.splice(i, 1); else lijst.push(id);
  planOpslaan(); render();
}
// Klein "!"-knopje naast een bouwdeel-titel — klik toggelt de markering, stopPropagation voorkomt
// dat de klik ook de kaart zelf open/dicht klapt (die kop heeft al een eigen onclick).
function renderAttentieKnop(id) {
  const actief = attentieActief(id);
  return el('button', {
    type: 'button', class: 'bouwdeel-attentie-knop' + (actief ? ' actief' : ''),
    title: actief ? 'Attentiewaarde verwijderen' : 'Markeren met hoge attentiewaarde',
    onclick: (e) => { e.stopPropagation(); wisselAttentie(id); },
  }, '!');
}
// Generieke "is dit AANWEZIGE bouwdeel/veld ook echt ingevuld"-check, hergebruikt door de
// Controle-tab om gemarkeerde (!) velden te waarschuwen als ze nog leeg zijn. Staat een bouwdeel op
// "niet aanwezig", dan is dat een complete keuze (geen waarschuwing) — alleen een AANWEZIG bouwdeel
// zonder materiaal-/tekstinhoud telt als "nog niet ingevuld".
// LET OP (19-09-2026, Arno's vraag "wanneer is iets compleet, hoe bepaal je dat?"): hierbij gevonden
// dat dit voorheen niet klopte met wat Taxatieweb zelf verplicht stelt — een materiaalTijd/isolatie/
// dak-veld liet zich al "compleet" noemen zodra er een materiaal was aangevinkt / geïsoleerd op Ja
// stond, ZONDER het Installatiemoment te checken — terwijl Taxatieweb dat veld zelf al sinds het
// begin als "Dit veld is verplicht" toont zodra dat blok zichtbaar wordt (live bevestigd op De
// Wiersse 25). Nu dus consistent: materiaal/isolatie-keuze EN (als van toepassing) een gekozen
// Installatiemoment moeten allebei kloppen voor "compleet".
function bouwdeelVeldOk(def, bouwdeel) {
  if (!bouwdeel || !bouwdeel.aanwezig) return true;
  if (def.type === 'materiaal' || def.type === 'materiaalTijd') {
    const materiaalGekozen = def.kenmerkenKoppeling ? bepaalOpties(def).some((o) => kenmerkGeselecteerd(def.kenmerkenKoppeling, o))
      : def.installatieKoppeling ? bepaalOpties(def).some((o) => installatieGeselecteerd(def.installatieKoppeling.sleutel, o))
      : !!(bouwdeel.materialen && bouwdeel.materialen.length);
    if (!materiaalGekozen) return false;
    return def.type !== 'materiaalTijd' || !!bouwdeel.installatiemoment;
  }
  if (def.type === 'risico') return !!(bouwdeel.omschrijving && bouwdeel.omschrijving.trim());
  // isolatie: 'aanwezig' hierboven is hier al gegarandeerd true (= "geïsoleerd: ja"), dus compleet
  // betekent hier alleen nog: is het Installatiemoment ingevuld.
  if (def.type === 'isolatie') return !!bouwdeel.installatiemoment;
  // dak: 'aanwezig' betekent hier "dit daktype bestaat" — dat is LOS van 'geisoleerd'. Geen isolatie
  // (of nog niet gekozen) is een complete keuze op zich; wél isolatie vereist ook een Installatiemoment.
  if (def.type === 'dak') return bouwdeel.geisoleerd !== true || !!bouwdeel.installatiemoment;
  if (bouwdeel.omschrijving !== undefined) return !!(bouwdeel.omschrijving && bouwdeel.omschrijving.trim());
  if (bouwdeel.opmerkingen !== undefined) return !!(bouwdeel.opmerkingen && bouwdeel.opmerkingen.trim());
  return true;
}
// Loopt alle BOUWKUNDIG_SCHEMA- en ENERGETISCH_SCHEMA-velden af op zoek naar de met ! gemarkeerde
// velden (attentieId in data.attentieVelden), voor de Controle-tab.
function berekenAttentieResultaten() {
  const t = state.taxatie;
  const items = [];
  ['buitenzijde', 'binnenzijde', 'installaties', 'overigeBijzonderheden'].forEach((hoofdId) => {
    const groep = BOUWKUNDIG_SCHEMA[hoofdId];
    if (Array.isArray(groep)) {
      groep.forEach((def) => {
        const id = attentieId('bouwkundig', def.key);
        if (attentieActief(id)) items.push({ tekst: def.label, ok: bouwdeelVeldOk(def, t.bouwkundig.overigeBijzonderheden && t.bouwkundig.overigeBijzonderheden[def.key]), tab: 'bouwkundig' });
      });
      return;
    }
    Object.entries(groep || {}).forEach(([sectieId, defs]) => {
      defs.forEach((def) => {
        const id = attentieId('bouwkundig', def.key);
        if (!attentieActief(id)) return;
        const bouwdeel = t.bouwkundig[hoofdId] && t.bouwkundig[hoofdId][sectieId] && t.bouwkundig[hoofdId][sectieId][def.key];
        items.push({ tekst: def.label, ok: bouwdeelVeldOk(def, bouwdeel), tab: 'bouwkundig' });
      });
    });
  });
  ['isolatie', 'installaties'].forEach((hoofdId) => {
    Object.entries(ENERGETISCH_SCHEMA[hoofdId] || {}).forEach(([sectieId, defs]) => {
      defs.forEach((def) => {
        const id = attentieId('energetisch', def.key);
        if (!attentieActief(id)) return;
        const veld = t.energetisch[hoofdId] && t.energetisch[hoofdId][sectieId] && t.energetisch[hoofdId][sectieId][def.key];
        items.push({ tekst: def.label, ok: bouwdeelVeldOk(def, veld), tab: 'energetisch' });
      });
    });
  });
  (ENERGETISCH_SCHEMA.energieopwekking || []).forEach((def) => {
    const id = attentieId('energetisch', def.key);
    if (!attentieActief(id)) return;
    items.push({ tekst: def.label, ok: bouwdeelVeldOk(def, t.energetisch.energieopwekking && t.energetisch.energieopwekking[def.key]), tab: 'energetisch' });
  });
  return items;
}
function renderBouwdeelKaart(sectieObj, def) {
  const bouwdeel = sectieObj[def.key];
  if (def.type === 'risico') return renderRisicoBouwdeelKaart(bouwdeel, def);
  const ingeklapt = !bouwdeel.aanwezig; // niet-aanwezige bouwdelen tonen alleen de kop, zelfde als Taxatieweb
  const attentieIdVeld = attentieId('bouwkundig', def.key);
  const kaart = el('div', { class: 'bouwdeel-kaart' + (attentieActief(attentieIdVeld) ? ' bouwdeel-kaart-attentie' : '') });
  const kop = el('div', {
    class: 'bouwdeel-kop',
    onclick: () => { bouwdeel.aanwezig = !bouwdeel.aanwezig; planOpslaan(); render(); },
  },
    el('input', { type: 'checkbox', checked: bouwdeel.aanwezig ? 'checked' : null }),
    el('span', { class: 'bouwdeel-titel' }, def.label),
    renderAttentieKnop(attentieIdVeld));
  kaart.appendChild(kop);
  if (ingeklapt) return kaart;
  if (def.hint) kaart.appendChild(renderBouwdeelHint(def.hint));

  if (def.type !== 'simpel') kaart.appendChild(conditieRij(bouwdeel));

  if (def.type === 'materiaal') {
    const grid = el('div', { class: 'bouwdeel-materiaal-grid' });
    bepaalOpties(def).forEach(optie => {
      const aan = def.kenmerkenKoppeling ? kenmerkGeselecteerd(def.kenmerkenKoppeling, optie)
        : def.installatieKoppeling ? installatieGeselecteerd(def.installatieKoppeling.sleutel, optie)
        : (bouwdeel.materialen || []).includes(optie);
      grid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
        el('input', {
          type: 'checkbox', checked: aan ? 'checked' : null,
          onchange: () => {
            if (def.kenmerkenKoppeling) {
              kenmerkWissel(def.kenmerkenKoppeling, optie);
            } else if (def.installatieKoppeling) {
              installatieWissel(def.installatieKoppeling.sleutel, optie);
            } else {
              bouwdeel.materialen = bouwdeel.materialen || [];
              const i = bouwdeel.materialen.indexOf(optie);
              if (i >= 0) bouwdeel.materialen.splice(i, 1); else bouwdeel.materialen.push(optie);
            }
            planOpslaan(); render();
          },
        }), optie));
    });
    kaart.appendChild(grid);
    // "Overige" toont net als in Taxatieweb een vrij tekstveld ernaast (Arno's verzoek 12-09-2026).
    // Dit tekstveld blijft bewust LOKAAL per veld (niet gekoppeld) — alleen de aangevinkte keuzes
    // zelf moeten identiek zijn tussen Indeling en Bouwkundig/Energetisch (Arno's verzoek 16-09-2026).
    const overigeAan = def.kenmerkenKoppeling ? kenmerkGeselecteerd(def.kenmerkenKoppeling, 'Overige')
      : def.installatieKoppeling ? installatieGeselecteerd(def.installatieKoppeling.sleutel, 'Overige')
      : (bouwdeel.materialen || []).includes('Overige');
    if (overigeAan) {
      const overigeVeld = el('input', {
        type: 'text', class: 'bouwdeel-overige-tekst', placeholder: 'Namelijk…',
        oninput: (e) => { bouwdeel.overigeTekst = e.target.value; planOpslaan(); },
      });
      overigeVeld.value = bouwdeel.overigeTekst || '';
      kaart.appendChild(overigeVeld);
    }
  } else {
    kaart.appendChild(renderBouwdeelChips(bouwdeel, def, 'omschrijving'));
    if (def.key === 'trappen') {
      const trapTypes = bepaalTrapTypesUitIndeling();
      if (trapTypes.length) {
        kaart.appendChild(el('button', {
          type: 'button', class: 'knop spook klein',
          style: 'margin-bottom:8px;',
          onclick: () => { bouwdeel.omschrijving = nederlandseLijst(trapTypes); planOpslaan(); render(); },
        }, `↺ Overnemen uit Indeling (${nederlandseLijst(trapTypes)})`));
      }
    }
    // Schuur/berging, Garage en Overige bijgebouwen: zelfde "↺ Overnemen"-idee, nu vanuit de nieuwe
    // Bij-/aanbouwen-editor in Indeling (17-09-2026, Arno: "deze teksten komen samengevat terug in
    // de indeling en Bouwkundige opnamestaat") — gematcht op bijgebouw-type via
    // bouwkundigVeldVoorBijgebouwType(), zodat een garage bij Garage terechtkomt en een schuur bij
    // Schuur/berging, i.p.v. alles in 1 veld te proppen.
    if (['schuurBerging', 'garage', 'overigeBijgebouwen'].includes(def.key)) {
      const passendeBijgebouwen = (state.taxatie.data.bijgebouwen || []).filter(b => b.type && bouwkundigVeldVoorBijgebouwType(b.type) === def.key);
      if (passendeBijgebouwen.length) {
        kaart.appendChild(el('button', {
          type: 'button', class: 'knop spook klein', style: 'margin-bottom:8px;',
          onclick: () => {
            bouwdeel.omschrijving = passendeBijgebouwen.map(b => '- ' + samenvatBijgebouw(b) + '.').join('\n');
            planOpslaan(); render();
          },
        }, `↺ Overnemen uit Indeling (${passendeBijgebouwen.length})`));
      }
    }
    const omschrijvingVeld = el('textarea', {
      class: 'bouwdeel-omschrijving', placeholder: 'Omschrijving ' + def.label.toLowerCase() + '…',
      oninput: (e) => { bouwdeel.omschrijving = e.target.value; planOpslaan(); },
    });
    omschrijvingVeld.value = bouwdeel.omschrijving || '';
    kaart.appendChild(omschrijvingVeld);
  }

  if (def.details) {
    const grid = el('div', { class: 'bouwdeel-details-grid' });
    def.details.forEach(d => grid.appendChild(renderDetailVeld(bouwdeel, d)));
    kaart.appendChild(grid);
  }

  // Foto per onderdeel (17-09-2026, Arno's verzoek: "moeten ook foto's kunnen worden toegevoegd per
  // onderdeel", naar Taxatieweb's opzet waar élk bouwdeel een eigen upload-vak heeft) — nu bij ELK
  // bouwdeel zichtbaar i.p.v. alleen Meterkast/Verwarmingstoestel (def.verplichteFoto). Verplicht
  // zodra Aandachtspunten op Ja staat of het bouwdeel z'n eigen vaste verplichteFoto-vlag heeft.
  // Bij een slechte/matige conditie komt er DAARNAAST (18-09-2026, Arno's verzoek) een eigen,
  // apart verplicht foto-slot "Achterstallig onderhoud <bouwdeel>" bij — 1-op-1 herkenbaar in de
  // Foto's-tab/het archief, los van een eventuele Aandachtspunten-foto van hetzelfde bouwdeel.
  if (def.type !== 'simpel') {
    const verplichtNodig = !!def.verplichteFoto || bouwdeel.aandachtspuntenAanwezig === true;
    kaart.appendChild(renderFotoKnopRij(def.label, def.fotoCategorie || def.label, verplichtNodig));
    const slechteConditie = bouwdeel.conditie === 2 || bouwdeel.conditie === 3; // slecht/matig
    if (slechteConditie) {
      kaart.appendChild(renderFotoKnopRij('Achterstallig onderhoud ' + def.label, 'Achterstallig onderhoud ' + def.label, true));
    }
  }

  if (def.type !== 'simpel') {
    kaart.appendChild(jaNeeMetToelichtingRij(
      'Aandachtspunten', bouwdeel.aandachtspuntenAanwezig, (w) => { bouwdeel.aandachtspuntenAanwezig = w; planOpslaan(); },
      bouwdeel.aandachtspuntenToelichting, (v) => { bouwdeel.aandachtspuntenToelichting = v; planOpslaan(); },
      'Toelichting aandachtspunt…',
    ));
  }
  return kaart;
}
const BOUWKUNDIG_HOOFDTABS = [
  ['buitenzijde', 'Buitenzijde'], ['binnenzijde', 'Binnenzijde'], ['installaties', 'Installaties'],
  ['overigeBijzonderheden', 'Overige bijzonderheden'],
];
function renderBouwkundigTab() {
  const t = state.taxatie;
  const wrap = el('div', {});

  const hoofdtabs = el('div', { class: 'weergave-wissel bouwkundig-hoofdtabs' });
  BOUWKUNDIG_HOOFDTABS.forEach(([id, label]) => {
    hoofdtabs.appendChild(el('button', {
      class: 'klein' + (state.bouwkundigHoofdtab === id ? ' actief' : ''),
      onclick: () => { state.bouwkundigHoofdtab = id; render(); },
    }, label));
  });
  wrap.appendChild(hoofdtabs);

  // Overige bijzonderheden heeft geen sub-tabbladen in Taxatieweb — direct de (risico-)bouwdelen.
  if (state.bouwkundigHoofdtab === 'overigeBijzonderheden') {
    const lijst = el('div', { class: 'bouwdeel-lijst' });
    BOUWKUNDIG_SCHEMA.overigeBijzonderheden.forEach(def => lijst.appendChild(renderBouwdeelKaart(t.bouwkundig.overigeBijzonderheden, def)));
    wrap.appendChild(lijst);
    return wrap;
  }

  const subtabsSchema = BOUWKUNDIG_SUBTABS[state.bouwkundigHoofdtab];
  // Bij het wisselen van hoofdtab kan de vorige subtab hier niet bestaan (bv. 'daken' bestaat niet
  // onder Installaties) — val dan terug op de eerste subtab van de nieuwe hoofdtab.
  if (!subtabsSchema.some(s => s.id === state.bouwkundigSubtab)) state.bouwkundigSubtab = subtabsSchema[0].id;

  const subtabs = el('div', { class: 'weergave-wissel bouwkundig-subtabs' });
  subtabsSchema.forEach(sub => {
    subtabs.appendChild(el('button', {
      class: 'klein' + (state.bouwkundigSubtab === sub.id ? ' actief' : ''),
      onclick: () => { state.bouwkundigSubtab = sub.id; render(); },
    }, sub.label));
  });
  wrap.appendChild(subtabs);

  const sectieObj = t.bouwkundig[state.bouwkundigHoofdtab][state.bouwkundigSubtab];
  const defs = BOUWKUNDIG_SCHEMA[state.bouwkundigHoofdtab][state.bouwkundigSubtab];
  const lijst = el('div', { class: 'bouwdeel-lijst' });
  defs.forEach(def => lijst.appendChild(renderBouwdeelKaart(sectieObj, def)));
  wrap.appendChild(lijst);
  return wrap;
}

// --- Energetisch (Fase 2 "volledige opname", I.4 Energetische opnamestaat) ---
// Generieke Ja/Nee-rij zonder toelichtingsveld (voor Gedeeltelijk/Geïsoleerd — dit zijn simpele
// vlaggen, geen aandachtspunt-toelichting zoals bij Bouwkundig).
// Losgetrokken van renderJaNeeToggle (19-09-2026) zodat 2 Ja/Nee-vragen op 1 rij kunnen (zie
// renderIsolatieBlok: "Gedeeltelijk geïsoleerd" achter "Isolatie" i.p.v. een eigen rij).
function renderJaNeeWissel(huidigeWaarde, onChange) {
  const wissel = el('div', { class: 'weergave-wissel' });
  [[false, 'Nee'], [true, 'Ja']].forEach(([waarde, tekst]) => {
    wissel.appendChild(el('button', {
      class: 'klein' + (huidigeWaarde === waarde ? ' actief' : ''),
      onclick: () => { onChange(waarde); planOpslaan(); render(); },
    }, tekst));
  });
  return wissel;
}
function renderJaNeeToggle(labelText, huidigeWaarde, onChange) {
  return el('div', { class: 'bouwdeel-conditie-rij' }, el('span', { class: 'energetisch-veld-label' }, labelText), renderJaNeeWissel(huidigeWaarde, onChange));
}
function renderSelectVeld(labelText, waarde, opties, onChange) {
  return el('label', { class: 'bouwdeel-detail-veld' }, el('span', { class: 'energetisch-veld-label' }, labelText),
    el('select', {
      class: 'energetisch-select',
      onchange: (e) => { onChange(e.target.value); planOpslaan(); render(); },
    },
      el('option', { value: '' }, 'Selecteer'),
      ...opties.map(o => el('option', { value: o, selected: waarde === o ? 'selected' : null }, o))));
}
// Installatiemoment (Bouwjaar/Installatiejaar/Onbekend) + vrij opmerkingenveld — komt terug bij
// vrijwel elk I.4-onderdeel in Taxatieweb.
// Los, optioneel jaartal-lijstje (18-09-2026) — géén vaste checkbox-grid van 100+ jaren (onbruikbaar
// groot), maar dezelfde "kies + voeg toe → verwijderbare chip"-opzet als de rest van de app. De
// "↺ Samenvoegen"-knop zet de jaren als tekst in opmerkingen — een expliciete actie (net als de
// andere "↺ Overnemen"-knoppen elders), nooit een automatische/stille overschrijving.
// Zelfde look als het Installatiejaar-veld ernaast — een compacte .bouwdeel-detail-veld i.p.v. een
// eigen volle-breedte blok (19-09-2026), geplaatst in dezelfde .installatiemoment-stapel (zie
// renderInstallatiemomentEnOpmerkingen).
function renderMeerdereJarenVeld(veld) {
  if (!Array.isArray(veld.meerdereJaren)) veld.meerdereJaren = [];
  const wrap = el('label', { class: 'bouwdeel-detail-veld meerdere-jaren-veld' },
    el('span', { class: 'energetisch-veld-label' }, 'Meerdere jaartallen'),
    // Geen eigen klasse meesturen (19-09-2026, was "look niet goed") — gewoon de standaard
    // 'energetisch-select'-stijl van renderJaarSelect, exact zoals Installatiejaar ernaast.
    renderJaarKeuze('', (w) => {
      if (w && !veld.meerdereJaren.includes(w)) { veld.meerdereJaren.push(w); planOpslaan(); render(); }
    }));
  if (veld.meerdereJaren.length) {
    const chipRij = el('div', { class: 'chip-rij' });
    veld.meerdereJaren.forEach((jaar, i) => {
      chipRij.appendChild(el('span', { class: 'chip' }, jaar,
        el('button', { onclick: () => { veld.meerdereJaren.splice(i, 1); planOpslaan(); render(); } }, '✕')));
    });
    wrap.appendChild(chipRij);
    wrap.appendChild(el('button', {
      type: 'button', class: 'knop spook klein', style: 'margin-top:4px;',
      onclick: () => {
        const jarenOplopend = [...veld.meerdereJaren].sort();
        const regel = 'Jaartallen: ' + nederlandseLijst(jarenOplopend) + '.';
        veld.opmerkingen = (veld.opmerkingen || '').trim() ? veld.opmerkingen.trim() + '\n' + regel : regel;
        planOpslaan(); render();
      },
    }, '↺ Samenvoegen'));
  }
  return wrap;
}
function renderInstallatiemomentEnOpmerkingen(veld, def) {
  const wrap = el('div', { class: 'installatiemoment-stapel' });
  // Vroeger een 4-koloms-grid (Installatiemoment/Installatiejaar/Meerdere jaartallen naast elkaar) —
  // paste prima op een breed desktopscherm, maar kwam op een smallere kolom (iPad, of de
  // samengevoegde tab se rechterkolom) "op elkaar gepropt" te staan (19-09-2026, Arno's melding).
  // Nu gewoon onder elkaar: eerst de keuze (Installatiemoment), dan pas het jaar-veld met z'n eigen
  // opgeslagen labels eronder — werkt op elke breedte, geen media-query meer nodig.
  wrap.appendChild(renderSelectVeld('Installatiemoment', veld.installatiemoment, INSTALLATIEMOMENT_OPTIES, (w) => { veld.installatiemoment = w; }));
  // Jaar-keuzelijst, alleen bij "Installatiejaar" (Arno's verzoek 13-09-2026 — bij "Bouwjaar" staat
  // dat al bij Objectkenmerken, dus een los jaartal hier is dan overbodig).
  if (veld.installatiemoment === 'Installatiejaar') {
    wrap.appendChild(el('label', { class: 'bouwdeel-detail-veld' },
      el('span', { class: 'energetisch-veld-label' }, veld.installatiemoment),
      renderJaarKeuze(veld.jaar, (w) => { veld.jaar = w; planOpslaan(); render(); })));
    // Meerdere jaartallen (18-09-2026, Arno's verzoek): sommige onderdelen zijn in fases aangebracht/
    // vervangen (bv. isolatie), dus 1 hoofdjaar hierboven is soms niet genoeg.
    wrap.appendChild(renderMeerdereJarenVeld(veld));
  }
  if (def) wrap.appendChild(renderBouwdeelChips(veld, def, 'opmerkingen'));
  const opmerkingen = el('textarea', {
    class: 'bouwdeel-omschrijving', placeholder: 'Opmerkingen…',
    oninput: (e) => { veld.opmerkingen = e.target.value; planOpslaan(); },
  });
  opmerkingen.value = veld.opmerkingen || '';
  wrap.appendChild(opmerkingen);
  return wrap;
}
function renderEnergetischKop(veld, def, kaart) {
  const attentieIdVeld = attentieId('energetisch', def.key);
  if (kaart && attentieActief(attentieIdVeld)) kaart.classList.add('bouwdeel-kaart-attentie');
  return el('div', {
    class: 'bouwdeel-kop',
    onclick: () => { veld.aanwezig = !veld.aanwezig; planOpslaan(); render(); },
  },
    el('input', { type: 'checkbox', checked: veld.aanwezig ? 'checked' : null }),
    el('span', { class: 'bouwdeel-titel' }, def.label),
    renderAttentieKnop(attentieIdVeld));
}
function renderIsolatieKaart(veld, def) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderEnergetischKop(veld, def, kaart));
  if (!veld.aanwezig) return kaart;
  kaart.appendChild(renderJaNeeToggle('Gedeeltelijk', veld.gedeeltelijk, (w) => { veld.gedeeltelijk = w; }));
  kaart.appendChild(renderInstallatiemomentEnOpmerkingen(veld, def));
  return kaart;
}
function renderDakKaart(veld, def) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderEnergetischKop(veld, def, kaart));
  if (!veld.aanwezig) return kaart;
  kaart.appendChild(renderJaNeeToggle('Geïsoleerd', veld.geisoleerd, (w) => { veld.geisoleerd = w; }));
  kaart.appendChild(renderJaNeeToggle('Gedeeltelijk', veld.gedeeltelijk, (w) => { veld.gedeeltelijk = w; }));
  kaart.appendChild(renderInstallatiemomentEnOpmerkingen(veld, def));
  return kaart;
}
function renderMateriaalTijdKaart(veld, def) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderEnergetischKop(veld, def, kaart));
  if (!veld.aanwezig) return kaart;
  if (def.hint) kaart.appendChild(renderBouwdeelHint(def.hint));
  const grid = el('div', { class: 'bouwdeel-materiaal-grid' });
  bepaalOpties(def).forEach(optie => {
    const aan = def.kenmerkenKoppeling ? kenmerkGeselecteerd(def.kenmerkenKoppeling, optie)
      : def.installatieKoppeling ? installatieGeselecteerd(def.installatieKoppeling.sleutel, optie)
      : (veld.materialen || []).includes(optie);
    grid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
      el('input', {
        type: 'checkbox', checked: aan ? 'checked' : null,
        onchange: () => {
          if (def.kenmerkenKoppeling) {
            kenmerkWissel(def.kenmerkenKoppeling, optie);
          } else if (def.installatieKoppeling) {
            installatieWissel(def.installatieKoppeling.sleutel, optie);
          } else {
            veld.materialen = veld.materialen || [];
            const i = veld.materialen.indexOf(optie);
            if (i >= 0) veld.materialen.splice(i, 1); else veld.materialen.push(optie);
          }
          planOpslaan(); render();
        },
      }), optie));
  });
  kaart.appendChild(grid);
  const overigeAan = def.kenmerkenKoppeling ? kenmerkGeselecteerd(def.kenmerkenKoppeling, 'Overige')
    : def.installatieKoppeling ? installatieGeselecteerd(def.installatieKoppeling.sleutel, 'Overige')
    : (veld.materialen || []).includes('Overige');
  if (overigeAan) {
    const overigeVeld = el('input', {
      type: 'text', class: 'bouwdeel-overige-tekst', placeholder: 'Namelijk…',
      oninput: (e) => { veld.overigeTekst = e.target.value; planOpslaan(); },
    });
    overigeVeld.value = veld.overigeTekst || '';
    kaart.appendChild(overigeVeld);
  }
  kaart.appendChild(renderInstallatiemomentEnOpmerkingen(veld, def));
  return kaart;
}
function renderEnergetischSimpelKaart(veld, def) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderEnergetischKop(veld, def, kaart));
  if (!veld.aanwezig) return kaart;
  kaart.appendChild(renderBouwdeelChips(veld, def, 'opmerkingen'));
  const opmerkingen = el('textarea', {
    class: 'bouwdeel-omschrijving', placeholder: 'Opmerkingen…',
    oninput: (e) => { veld.opmerkingen = e.target.value; planOpslaan(); },
  });
  opmerkingen.value = veld.opmerkingen || '';
  kaart.appendChild(opmerkingen);
  return kaart;
}
function renderZonnepanelenKaart(veld, def) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderEnergetischKop(veld, def, kaart));
  if (!veld.aanwezig) return kaart;
  // Compacter in 2 kolommen (19-09-2026, Arno's verzoek) — Omschrijving+Aantal naast elkaar
  // bovenaan links, Oriëntatie eronder; Eigendom + Bouw-/installatiejaar rechts.
  const aantalInput = el('input', {
    type: 'number', placeholder: '0',
    oninput: (e) => { veld.aantal = e.target.value; planOpslaan(); },
  });
  aantalInput.value = veld.aantal || '';
  // "Omschrijving zonnepanelen": Taxatieweb laat je kiezen of je Wattpiek of aantal panelen invult
  // (Arno's verzoek 13-09-2026), i.p.v. altijd een kaal getalveld "Aantal".
  const omschrijvingAantalRij = el('div', { class: 'rij-2koloms' },
    renderSelectVeld('Omschrijving zonnepanelen', veld.metenType, ENERGETISCH_METEN_TYPE_OPTIES, (w) => { veld.metenType = w; }),
    el('label', { class: 'bouwdeel-detail-veld' }, veld.metenType || 'Aantal Wattpiek of aantal panelen', aantalInput),
  );
  // Oriëntatie is in Taxatieweb een checkbox-multiselect (meerdere windrichtingen tegelijk mogelijk),
  // geen keuzelijst — zelfde grid-patroon als een materiaal-multiselect.
  const orientatieGrid = el('div', { class: 'bouwdeel-materiaal-grid' });
  ENERGETISCH_ORIENTATIE_OPTIES.forEach(optie => {
    const aan = (veld.orientaties || []).includes(optie);
    orientatieGrid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
      el('input', {
        type: 'checkbox', checked: aan ? 'checked' : null,
        onchange: () => {
          veld.orientaties = veld.orientaties || [];
          const i = veld.orientaties.indexOf(optie);
          if (i >= 0) veld.orientaties.splice(i, 1); else veld.orientaties.push(optie);
          planOpslaan(); render();
        },
      }), optie));
  });
  const linkerKolom = el('div', {},
    omschrijvingAantalRij,
    el('span', { class: 'energetisch-veld-label' }, 'Oriëntatie'),
    orientatieGrid,
    renderSelectVeld('Eigendom', veld.eigendom, ENERGETISCH_EIGENDOM_OPTIES, (w) => { veld.eigendom = w; }),
  );
  const rechterKolom = el('div', {},
    el('div', { class: 'bouwdeel-veld-label bouwdeel-veld-kop' }, 'Bouw-/installatiejaar'),
    renderInstallatiemomentEnOpmerkingen(veld, def),
  );
  kaart.appendChild(el('div', { class: 'gecombineerd-hoofdkolommen' }, linkerKolom, rechterKolom));
  return kaart;
}
function renderEnergetischKaart(sectieObj, def) {
  const veld = sectieObj[def.key];
  if (def.type === 'isolatie') return renderIsolatieKaart(veld, def);
  if (def.type === 'dak') return renderDakKaart(veld, def);
  if (def.type === 'materiaalTijd') return renderMateriaalTijdKaart(veld, def);
  if (def.type === 'zonnepanelen') return renderZonnepanelenKaart(veld, def);
  return renderEnergetischSimpelKaart(veld, def);
}
function renderMultiselectGroep(titel, opties, geselecteerd, onToggle) {
  const groep = el('div', { class: 'macro-groep' });
  groep.appendChild(el('h3', {}, titel));
  const grid = el('div', { class: 'bouwdeel-materiaal-grid' });
  opties.forEach(optie => {
    const aan = geselecteerd.includes(optie);
    grid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
      el('input', {
        type: 'checkbox', checked: aan ? 'checked' : null,
        onchange: () => { onToggle(optie); planOpslaan(); render(); },
      }), optie));
  });
  groep.appendChild(grid);
  return groep;
}
// "Aantal bouwlagen" (19-09-2026, gevonden bij het vergelijken met Taxatieweb) — staat daar in
// zowel I.4 als J.4 Algemeen als HETZELFDE getal met een "overnemen uit Afmetingen"-knop; hier maar
// 1x opgeslagen (energetisch.algemeen.aantalBouwlagen) en gedeeld door beide kanten.
function renderAantalBouwlagenVeld() {
  const t = state.taxatie;
  const alg = t.energetisch.algemeen;
  const wrap = el('div', { class: 'macro-groep' });
  wrap.appendChild(el('h3', {}, 'Aantal bouwlagen'));
  const input = el('input', {
    type: 'number', placeholder: '0', class: 'bouwdeel-overige-tekst', style: 'max-width:160px;',
    oninput: (e) => { alg.aantalBouwlagen = e.target.value; planOpslaan(); },
  });
  input.value = alg.aantalBouwlagen || '';
  wrap.appendChild(input);
  const aantalWoonlagen = (t.data.afmetingen.woonlagen || []).length;
  if (aantalWoonlagen) {
    wrap.appendChild(el('button', {
      type: 'button', class: 'knop spook klein', style: 'margin-left:8px;',
      onclick: () => { alg.aantalBouwlagen = String(aantalWoonlagen); planOpslaan(); render(); },
    }, `↺ Overnemen uit Afmetingen (${aantalWoonlagen})`));
  }
  return wrap;
}
function renderBronVeld() {
  const alg = state.taxatie.energetisch.algemeen;
  return renderMultiselectGroep('Bron van de informatie', ENERGETISCH_BRON_OPTIES, alg.bron, (optie) => {
    const i = alg.bron.indexOf(optie);
    if (i >= 0) alg.bron.splice(i, 1); else alg.bron.push(optie);
  });
}
function renderBouwtypeVeld() {
  const alg = state.taxatie.energetisch.algemeen;
  return renderMultiselectGroep('Bouwtype', ENERGETISCH_BOUWTYPE_OPTIES, alg.bouwtype, (optie) => {
    const i = alg.bouwtype.indexOf(optie);
    if (i >= 0) alg.bouwtype.splice(i, 1); else alg.bouwtype.push(optie);
  });
}
function renderEnergetischAlgemeen() {
  return el('div', {}, renderAantalBouwlagenVeld(), renderBronVeld(), renderBouwtypeVeld());
}
// Algemeen voor de samengevoegde Bouwkundig & Energetisch-tab: hergebruikt dezelfde bouwstenen als
// renderEnergetischAlgemeen (Aantal bouwlagen/Bron/Bouwtype — die gelden voor beide kanten) plus de 2
// velden die ALLEEN in Bouwkundig's eigen J.4 Algemeen bestaan (Weeromstandigheden, Woning met VvE).
// In 2 kolommen (19-09-2026, Arno's verzoek) — links "over het gebouw" (Aantal bouwlagen/Bouwtype,
// gedeeld met Energetisch), rechts "over de opname" (Bron/Weeromstandigheden/VvE).
function renderBkEnAlgemeen() {
  const alg = state.taxatie.energetisch.algemeen;
  const linkerKolom = el('div', {}, renderAantalBouwlagenVeld(), renderBouwtypeVeld());
  const vveGroep = el('div', { class: 'macro-groep' });
  vveGroep.appendChild(el('h3', {}, 'Is het een woning met VvE?'));
  vveGroep.appendChild(renderJaNeeWissel(alg.woningMetVve, (w) => { alg.woningMetVve = w; }));
  const rechterKolom = el('div', {},
    renderBronVeld(),
    renderMultiselectGroep('Weeromstandigheden', WEEROMSTANDIGHEDEN_OPTIES, alg.weeromstandigheden, (optie) => {
      const i = alg.weeromstandigheden.indexOf(optie);
      if (i >= 0) alg.weeromstandigheden.splice(i, 1); else alg.weeromstandigheden.push(optie);
    }),
    vveGroep,
  );
  return el('div', { class: 'gecombineerd-hoofdkolommen' }, linkerKolom, rechterKolom);
}
function renderEnergetischTab() {
  const t = state.taxatie;
  const wrap = el('div', {});

  const hoofdtabs = el('div', { class: 'weergave-wissel bouwkundig-hoofdtabs' });
  ENERGETISCH_HOOFDTABS.forEach(([id, label]) => {
    hoofdtabs.appendChild(el('button', {
      class: 'klein' + (state.energetischHoofdtab === id ? ' actief' : ''),
      onclick: () => { state.energetischHoofdtab = id; render(); },
    }, label));
  });
  wrap.appendChild(hoofdtabs);

  if (state.energetischHoofdtab === 'algemeen') {
    wrap.appendChild(renderEnergetischAlgemeen());
    return wrap;
  }
  if (state.energetischHoofdtab === 'energieopwekking') {
    const lijst = el('div', { class: 'bouwdeel-lijst' });
    ENERGETISCH_SCHEMA.energieopwekking.forEach(def => lijst.appendChild(renderEnergetischKaart(t.energetisch.energieopwekking, def)));
    wrap.appendChild(lijst);
    return wrap;
  }

  const subtabsSchema = ENERGETISCH_SUBTABS[state.energetischHoofdtab];
  if (!subtabsSchema.some(s => s.id === state.energetischSubtab)) state.energetischSubtab = subtabsSchema[0].id;

  const subtabs = el('div', { class: 'weergave-wissel bouwkundig-subtabs' });
  subtabsSchema.forEach(sub => {
    subtabs.appendChild(el('button', {
      class: 'klein' + (state.energetischSubtab === sub.id ? ' actief' : ''),
      onclick: () => { state.energetischSubtab = sub.id; render(); },
    }, sub.label));
  });
  wrap.appendChild(subtabs);

  const sectieObj = t.energetisch[state.energetischHoofdtab][state.energetischSubtab];
  const defs = ENERGETISCH_SCHEMA[state.energetischHoofdtab][state.energetischSubtab];
  const lijst = el('div', { class: 'bouwdeel-lijst' });
  defs.forEach(def => lijst.appendChild(renderEnergetischKaart(sectieObj, def)));
  wrap.appendChild(lijst);
  return wrap;
}

// --- Bouwkundig & Energetisch samengevoegd (18-09-2026, Arno's verzoek: "je kunt de bouwkundige en
// energetische opnamestaat prima samensmelten... maak eerst een extra knop zodat we niet de boel
// overhoop trekken") ---
// Puur een ANDERE weergave op dezelfde twee objecten (bouwkundig-bouwdeel + energetisch-veld) — er
// wordt hier NIETS nieuws opgeslagen. Een aangevinkt vakje, ingevulde conditie of gekozen materiaal
// is dus automatisch ook meteen zichtbaar op de originele Bouwkundig/Energetisch-tabbladen, en komt
// vanzelf op de juiste, gesplitste plek in Taxatieweb terecht (dezelfde bouwkundig_data/
// energetisch_data-velden als altijd).
// Vindt een def op key binnen een BOUWKUNDIG_SCHEMA/ENERGETISCH_SCHEMA-groep-array.
function vindDef(defs, key) {
  return defs.find((d) => d.key === key);
}
// "Aanwezig" stuurt in de samengevoegde kaart BEIDE kanten tegelijk aan (Arno's hele punt: 1x
// aanvinken i.p.v. 2x) — bouwkundig is daarbij leidend voor de weergave van het vinkje zelf.
// syncEnAanwezig (18-09-2026, Arno's verzoek): bij Glas betekent "aanwezig" hetzelfde aan beide
// kanten ("is hier glas"), dus 1 vinkje mag allebei sturen. Bij Gevel betekent energetisch's
// "aanwezig" iets heel anders ("is dit geïsoleerd") — dat mag dus NOOIT meesturen met het
// bouwkundige "is er gevelwerk"-vinkje, anders klap je de kaart dicht en verlies je per ongeluk de
// isolatie-keuze. Default true (bestaand gedrag), expliciet false bij Gevel hieronder.
function renderGecombineerdeKop(titel, bkVeld, enVeld, syncEnAanwezig = true) {
  return el('div', {
    class: 'bouwdeel-kop',
    onclick: () => {
      const nieuw = !bkVeld.aanwezig;
      bkVeld.aanwezig = nieuw;
      if (syncEnAanwezig) enVeld.aanwezig = nieuw;
      planOpslaan(); render();
    },
  },
    el('input', { type: 'checkbox', checked: bkVeld.aanwezig ? 'checked' : null }),
    el('span', { class: 'bouwdeel-titel' }, titel));
}
// Conditie, dan Aandachtspunten/foto eronder (18-09-2026 eerst naast elkaar, 19-09-2026 weer onder
// elkaar gezet — zie .gecombineerd-conditie-stapel in style.css).
function renderConditieEnAandachtRij(bkDef, bkVeld) {
  const slechteConditie = bkVeld.conditie === 2 || bkVeld.conditie === 3;
  // Foto-knop + Aandachtspunten op 1 rij (19-09-2026, "scheelt een rij"), maar weer ONDER de
  // conditie i.p.v. ernaast (19-09-2026, tweede ronde: "zet fotoknop en aandachtspunten in deze
  // opmaak weer onder conditie") — nu de kaart al een eigen linker/rechterkolom heeft
  // (.gecombineerd-hoofdkolommen), maakte een TWEEDE kolommenpaar hierbinnen het juist drukker.
  const fotoEnAandachtRij = el('div', { class: 'gecombineerd-foto-aandacht-rij' },
    renderFotoKnopRij(bkDef.label, bkDef.fotoCategorie || bkDef.label, bkVeld.aandachtspuntenAanwezig === true),
    el('div', { class: 'bouwdeel-aandacht-links' },
      el('span', { class: 'bouwdeel-veld-label' }, 'Aandachtspunten'),
      renderJaNeeWissel(bkVeld.aandachtspuntenAanwezig, (w) => { bkVeld.aandachtspuntenAanwezig = w; })),
  );
  const wrap = el('div', { class: 'gecombineerd-conditie-stapel' }, conditieRij(bkVeld), fotoEnAandachtRij);
  if (slechteConditie) wrap.appendChild(renderFotoKnopRij('Achterstallig onderhoud ' + bkDef.label, 'Achterstallig onderhoud ' + bkDef.label, true));
  if (bkVeld.aandachtspuntenAanwezig === true) {
    const toelichting = el('textarea', {
      class: 'bouwdeel-omschrijving', placeholder: 'Toelichting aandachtspunt…',
      oninput: (e) => { bkVeld.aandachtspuntenToelichting = e.target.value; planOpslaan(); },
    });
    toelichting.value = bkVeld.aandachtspuntenToelichting || '';
    wrap.appendChild(toelichting);
  }
  return wrap;
}
// Generieke samengevoegde kaart voor materiaal-achtige velden waarvan de aangevinkte keuzes AL
// gedeeld zijn tussen Bouwkundig en Energetisch (kenmerkenKoppeling of installatieKoppeling) — Glas,
// Verwarmingssysteem, Verwarmingstoestel, Warmwatertoestel, Ventilatie, Koeling delen allemaal
// precies dit patroon: conditie+aandachtspunt, de gedeelde materiaal-multiselect, dan Energetisch's
// eigen bouw-/installatiejaar (dat blijft wél apart, want dat kent Bouwkundig niet in dit type veld).
function renderGecombineerdMateriaalKaart(titel, materiaalLabel, bkDef, bkVeld, enDef, enVeld) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderGecombineerdeKop(titel, bkVeld, enVeld, true));
  if (!bkVeld.aanwezig) return kaart;
  // Verwarmingssysteem 1e/2e woonlaag heeft een hint (afgifte op déze woonlaag vs. de bron elders) —
  // zie BOUWKUNDIG_SCHEMA.installaties.verwarming, dezelfde tekst als in het losse Bouwkundig-tabblad.
  if (bkDef.hint) kaart.appendChild(renderBouwdeelHint(bkDef.hint));
  // 2 kolommen (19-09-2026, Arno's verzoek): links conditie + kenmerken (bouwkundig), rechts de
  // energetische kant (hier: bouw-/installatiejaar) — op smal scherm valt dit vanzelf terug op 1
  // kolom, zie .gecombineerd-hoofdkolommen in style.css.
  const linkerKolom = el('div', {},
    renderConditieEnAandachtRij(bkDef, bkVeld),
    el('div', { class: 'bouwdeel-veld-label' }, materiaalLabel),
    renderMultiselectGridGekoppeld(bkDef, bkVeld, enVeld),
  );
  const rechterKolom = el('div', {},
    el('div', { class: 'bouwdeel-veld-label bouwdeel-veld-kop' }, 'Bouw-/installatiejaar'),
    renderInstallatiemomentEnOpmerkingen(enVeld, enDef),
  );
  kaart.appendChild(el('div', { class: 'gecombineerd-hoofdkolommen' }, linkerKolom, rechterKolom));
  return kaart;
}
// Voorbeeld 1 van Arno: "Glas 1e woonlaag: conditie (evt. foto en aandachtspunt), glassoorten en
// bouw-/installatiejaar" — glassoorten is al gedeeld tussen Bouwkundig/Energetisch/Indeling
// (kenmerkenKoppeling), dus die multiselect hoeft hier maar 1x getekend te worden.
function renderGecombineerdGlasKaart(labelSuffix, bkDef, bkVeld, enDef, enVeld) {
  return renderGecombineerdMateriaalKaart('Glas ' + labelSuffix, 'Glassoorten', bkDef, bkVeld, enDef, enVeld);
}
// Multiselect-grid voor een def met kenmerkenKoppeling ÓF installatieKoppeling — zelfde renderlogica
// als in renderBouwdeelKaart/renderMateriaalTijdKaart, hier losgetrokken zodat de samengevoegde
// kaart 'm maar 1x hoeft te tekenen i.p.v. voor zowel de bouwkundige als de energetische kant apart.
// bkVeld/enVeld (19-09-2026, "rest van de opnamestaat"-uitbreiding): het "Overige"-tekstveld zelf is
// GEEN gedeelde waarde (zie renderBouwdeelKaart/renderMateriaalTijdKaart — bewust lokaal per veld),
// dus schrijft deze ene tekstveld-instantie naar BEIDE kanten tegelijk zodat niets ineens leeg lijkt
// zodra je terugschakelt naar het losse Bouwkundig- of Energetisch-tabblad. enVeld is optioneel —
// bij een bouwdeel zonder materiaal-tegenhanger aan de andere kant (bv. Vloersoort, waar Energetisch
// alleen isolatie kent) volstaat alleen bkVeld. opmerkingenVeld (19-09-2026, "samenvoegen naar
// opmerkingen"): los van enVeld omdat dat er niet altijd is (Vloersoort) of geen opmerkingenveld
// heeft — valt terug op enVeld zelf zodra het niet apart wordt meegegeven.
function renderMultiselectGridGekoppeld(def, bkVeld, enVeld, opmerkingenVeld) {
  const koppelingGeselecteerd = (optie) => def.kenmerkenKoppeling
    ? kenmerkGeselecteerd(def.kenmerkenKoppeling, optie)
    : installatieGeselecteerd(def.installatieKoppeling.sleutel, optie);
  const koppelingWissel = (optie) => def.kenmerkenKoppeling
    ? kenmerkWissel(def.kenmerkenKoppeling, optie)
    : installatieWissel(def.installatieKoppeling.sleutel, optie);
  const grid = el('div', { class: 'bouwdeel-materiaal-grid' });
  bepaalOpties(def).forEach((optie) => {
    grid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
      el('input', {
        type: 'checkbox', checked: koppelingGeselecteerd(optie) ? 'checked' : null,
        onchange: () => { koppelingWissel(optie); planOpslaan(); render(); },
      }), optie));
  });
  const wrap = el('div', {}, grid);
  if (bkVeld && koppelingGeselecteerd('Overige')) {
    const overigeVeld = el('input', {
      type: 'text', class: 'bouwdeel-overige-tekst', placeholder: 'Namelijk…',
      oninput: (e) => { bkVeld.overigeTekst = e.target.value; if (enVeld) enVeld.overigeTekst = e.target.value; planOpslaan(); },
    });
    overigeVeld.value = bkVeld.overigeTekst || (enVeld && enVeld.overigeTekst) || '';
    wrap.appendChild(overigeVeld);
  }
  // "↺ Samenvoegen naar opmerkingen" (19-09-2026, Arno's verzoek: "geselecteerde labels markeren en
  // later bij het overzetten in Taxatieweb in het opmerkingenveld samenvoegen") — zelfde idee als de
  // bestaande jaartallen-samenvoegknop, nu voor de aangevinkte materiaal-labels zelf. Schrijft naar
  // enVeld.opmerkingen (dat veld gaat toch al 1-op-1 als tekst over naar Taxatieweb), niet naar de
  // checkbox-status zelf — puur een kopieerbare tekstregel als geheugensteun voor Arno.
  const doelOpmerkingen = opmerkingenVeld || enVeld;
  if (doelOpmerkingen && doelOpmerkingen.opmerkingen !== undefined) {
    const gekozen = bepaalOpties(def).filter((o) => koppelingGeselecteerd(o));
    if (gekozen.length) {
      wrap.appendChild(el('button', {
        type: 'button', class: 'knop spook klein', style: 'margin-top:6px;',
        onclick: () => {
          const regel = def.label + ': ' + nederlandseLijst(gekozen) + '.';
          doelOpmerkingen.opmerkingen = (doelOpmerkingen.opmerkingen || '').trim() ? doelOpmerkingen.opmerkingen.trim() + '\n' + regel : regel;
          planOpslaan(); render();
        },
      }, '↺ Samenvoegen naar opmerkingen'));
    }
  }
  return wrap;
}
// Isolatie-type velden (18-09-2026, Arno's verzoek): "je moet opnemen OF iets geïsoleerd is per
// onderdeel, pas als dit 'ja' is de rest laten zien" — precies hoe Taxatieweb dit zelf ook doet
// (de isolatie-kaart z'n eigen "aanwezig"-vinkje = "geïsoleerd: ja/nee"). In de samengevoegde kaart
// is dat een LOS, EXPLICIET Ja/Nee-veld — bewust GEEN hergebruik van de gedeelde "aanwezig" van de
// kop, want dat zou "is er gevelwerk" en "is de gevel geïsoleerd" door elkaar halen (zie
// renderGecombineerdeKop). Geen isolatie ⇒ Gedeeltelijk/installatiejaar/opmerkingen niet tonen.
function renderIsolatieBlok(labelPrefix, enVeld, enDef) {
  // Overzichtelijkere look (19-09-2026, tweede ronde): "Gedeeltelijk geïsoleerd" stond op dezelfde
  // rij als "Isolatie" gepropt — nu weer een eigen rij eronder (renderJaNeeToggle), en het geheel in
  // een lichte kaart (.isolatieblok) zodat het duidelijk als 1 samenhangend blokje oogt naast de
  // bouwkundige kolom.
  const wrap = el('div', { class: 'isolatieblok' });
  wrap.appendChild(renderJaNeeToggle(labelPrefix + ' geïsoleerd', enVeld.aanwezig, (w) => { enVeld.aanwezig = w; }));
  if (enVeld.aanwezig !== true) return wrap;
  wrap.appendChild(renderJaNeeToggle('Gedeeltelijk geïsoleerd', enVeld.gedeeltelijk, (w) => { enVeld.gedeeltelijk = w; }));
  wrap.appendChild(el('div', { class: 'bouwdeel-veld-label bouwdeel-veld-kop' }, 'Bouw-/installatiejaar'));
  wrap.appendChild(renderInstallatiemomentEnOpmerkingen(enVeld, enDef));
  return wrap;
}
// Materiaal-grid voor een NIET-gekoppeld bouwkundig veld (geen kenmerkenKoppeling/
// installatieKoppeling) — losgetrokken uit de vroegere Gevel-kaart zodat Dak 'm ook kan hergebruiken.
function renderPlainMateriaalGrid(bkDef, bkVeld) {
  const grid = el('div', { class: 'bouwdeel-materiaal-grid' });
  bepaalOpties(bkDef).forEach((optie) => {
    const aan = (bkVeld.materialen || []).includes(optie);
    grid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
      el('input', {
        type: 'checkbox', checked: aan ? 'checked' : null,
        onchange: () => {
          bkVeld.materialen = bkVeld.materialen || [];
          const i = bkVeld.materialen.indexOf(optie);
          if (i >= 0) bkVeld.materialen.splice(i, 1); else bkVeld.materialen.push(optie);
          planOpslaan(); render();
        },
      }), optie));
  });
  return grid;
}
// Generiek voor bouwdelen waar Bouwkundig het materiaal opneemt en Energetisch los de isolatie
// (Gevel, Vloer per woonlaag): dat zijn GEEN gedeelde waarden (andere vraag), dus tonen we ze allebei
// elk vanuit hun eigen veld — vandaar syncEnAanwezig=false op de kop (zie renderIsolatieBlok).
function renderGecombineerdMateriaalIsolatieKaart(titel, materiaalLabel, isolatieLabelPrefix, bkDef, bkVeld, enDef, enVeld) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderGecombineerdeKop(titel, bkVeld, enVeld, false));
  if (!bkVeld.aanwezig) return kaart;
  const linkerKolom = el('div', {},
    renderConditieEnAandachtRij(bkDef, bkVeld),
    el('div', { class: 'bouwdeel-veld-label' }, materiaalLabel),
    bkDef.kenmerkenKoppeling ? renderMultiselectGridGekoppeld(bkDef, bkVeld, null, enVeld) : renderPlainMateriaalGrid(bkDef, bkVeld),
  );
  // Geen aparte "Isolatie X"-label meer boven het isolatieblok (19-09-2026, overzichtelijkere
  // look) — het blokje zelf begint al met "X geïsoleerd", dat was dubbelop.
  const rechterKolom = el('div', {}, renderIsolatieBlok(isolatieLabelPrefix, enVeld, enDef));
  kaart.appendChild(el('div', { class: 'gecombineerd-hoofdkolommen' }, linkerKolom, rechterKolom));
  return kaart;
}
// Voorbeeld 2 van Arno: "Gevel(werk): conditie (evt. foto en aandachtspunt), materialen gevel,
// isolatie gevel en bouw-/installatiejaar" — materialen gevel (Bouwkundig) en isolatie (Energetisch)
// zijn HIER geen gedeelde waarde (andere vraag), dus die tonen we allebei, elk vanuit hun eigen veld.
function renderGecombineerdGevelKaart(bkDef, bkVeld, enDef, enVeld) {
  return renderGecombineerdMateriaalIsolatieKaart('Gevel(werk)', 'Materialen gevel', 'Gevel', bkDef, bkVeld, enDef, enVeld);
}
// Dak-isolatie heeft, anders dan de gewone 'isolatie'-velden (renderIsolatieBlok), een EXTRA laag:
// "aanwezig" betekent hier "bestaat dit daktype (hellend/plat) op deze woning" en staat LOS van
// "geïsoleerd" — zie leegDakVeld()/renderDakKaart. Vandaar een eigen blok i.p.v. renderIsolatieBlok.
function renderDakIsolatieBlok(label, enVeld, enDef) {
  const wrap = el('div', { class: 'isolatieblok' });
  wrap.appendChild(renderJaNeeToggle(label, enVeld.aanwezig, (w) => { enVeld.aanwezig = w; }));
  if (enVeld.aanwezig !== true) return wrap;
  wrap.appendChild(renderJaNeeToggle('Geïsoleerd', enVeld.geisoleerd, (w) => { enVeld.geisoleerd = w; }));
  if (enVeld.geisoleerd !== true) return wrap;
  wrap.appendChild(renderJaNeeToggle('Gedeeltelijk geïsoleerd', enVeld.gedeeltelijk, (w) => { enVeld.gedeeltelijk = w; }));
  wrap.appendChild(el('div', { class: 'bouwdeel-veld-label bouwdeel-veld-kop' }, 'Bouw-/installatiejaar'));
  wrap.appendChild(renderInstallatiemomentEnOpmerkingen(enVeld, enDef));
  return wrap;
}
// Dak wijkt af van Gevel/Vloer: Bouwkundig kent maar 1 dak-bouwdeel (Materiaal dak), terwijl
// Energetisch het dak in TWEE losse isolatie-vragen opsplitst (Hellend dak / Plat dak — een woning
// kan beide hebben). Daarom geen 1-op-1 syncEnAanwezig-kop zoals bij Glas: de kop stuurt alleen
// bkVeld.aanwezig aan, en beide dak-isolatievragen staan daaronder los naast elkaar.
function renderGecombineerdDakKaart(bkDef, bkVeld, hellendDef, hellendVeld, platDef, platVeld) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderGecombineerdeKop('Dak', bkVeld, null, false));
  if (!bkVeld.aanwezig) return kaart;
  const linkerKolom = el('div', {},
    renderConditieEnAandachtRij(bkDef, bkVeld),
    el('div', { class: 'bouwdeel-veld-label' }, 'Materiaal dak'),
    renderPlainMateriaalGrid(bkDef, bkVeld),
  );
  const rechterKolom = el('div', { class: 'isolatieblokken-stapel' },
    el('div', { class: 'bouwdeel-veld-label' }, 'Isolatie dak'),
    renderDakIsolatieBlok('Hellend dak aanwezig', hellendVeld, hellendDef),
    renderDakIsolatieBlok('Plat dak aanwezig', platVeld, platDef),
  );
  kaart.appendChild(el('div', { class: 'gecombineerd-hoofdkolommen' }, linkerKolom, rechterKolom));
  return kaart;
}
// Kruipruimte (19-09-2026, "check of je niets mist"): Bouwkundig heeft dit als vrij-tekstveld
// (funderingen.kruipruimte), Energetisch kent los een Kruipruimteisolatie (isolatie.vloer) — zelfde
// materiaal-versus-isolatie-scheiding als Gevel/Vloer/Dak hierboven, nu voor een tekst-bouwdeel i.p.v.
// een materiaal-bouwdeel.
function renderGecombineerdKruipruimteKaart(bkDef, bkVeld, enDef, enVeld) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderGecombineerdeKop('Kruipruimte', bkVeld, null, false));
  if (!bkVeld.aanwezig) return kaart;
  const omschrijvingVeld = el('textarea', {
    class: 'bouwdeel-omschrijving', placeholder: 'Omschrijving kruipruimte…',
    oninput: (e) => { bkVeld.omschrijving = e.target.value; planOpslaan(); },
  });
  omschrijvingVeld.value = bkVeld.omschrijving || '';
  const linkerKolom = el('div', {},
    renderConditieEnAandachtRij(bkDef, bkVeld),
    el('div', { class: 'bouwdeel-veld-label' }, 'Omschrijving kruipruimte'),
    renderBouwdeelChips(bkVeld, bkDef, 'omschrijving'),
    omschrijvingVeld,
  );
  const rechterKolom = el('div', {}, renderIsolatieBlok('Kruipruimte', enVeld, enDef));
  kaart.appendChild(el('div', { class: 'gecombineerd-hoofdkolommen' }, linkerKolom, rechterKolom));
  return kaart;
}
// --- Inklapbaar + status (19-09-2026, Arno's verzoek: "maak alle elementen inklapbaar en meld in
// de ingeklapte versie of alles compleet is, net zoiets als bij Indeling") ---
// bkEnKaartIngeklapt onthoudt WELKE kaarten dichtgeklapt zijn (op basis van een stabiele key, zie de
// entry-helpers hieronder). pasInklapbaarToe herbruikt gewoon de bestaande kaart-DOM (van
// renderBouwdeelKaart/renderEnergetischKaart/renderGecombineerd*Kaart) i.p.v. een aparte inklapbare
// variant van elke kaartsoort te moeten bouwen: de kop is altijd het eerste kind (elke kaart-functie
// in dit bestand appendChild't 'm als eerste), dus daar hoeft alleen een toggle-knopje bij; dichtgeklapt
// vervangen we de rest van de inhoud door 1 compacte statusregel.
const bkEnKaartIngeklapt = new Set();
function pasInklapbaarToe(kaart, key, aanwezig, compleet) {
  if (!aanwezig) return kaart; // niet-aanwezig toont toch al alleen de kop, geen apart toggle nodig
  const ingeklapt = bkEnKaartIngeklapt.has(key);
  const kop = kaart.firstChild;
  if (kop) {
    kop.insertBefore(el('button', {
      type: 'button', class: 'woonlaag-toggle',
      onclick: (e) => { e.stopPropagation(); if (ingeklapt) bkEnKaartIngeklapt.delete(key); else bkEnKaartIngeklapt.add(key); render(); },
    }, ingeklapt ? '▸' : '▾'), kop.firstChild);
    // Compleet/Nog niet compleet IN de titelrij, rechts uitgelijnd (19-09-2026, Arno's verzoek) —
    // i.p.v. een aparte statusregel eronder; zichtbaar zowel open als dichtgeklapt, want een
    // compleetheids-check is net zo nuttig zonder de kaart open te klappen.
    kop.appendChild(el('span', { class: 'compleet-badge compleet-badge-kop' + (compleet ? ' ok' : '') }, compleet ? '✓ Compleet' : '⚠ Nog niet compleet'));
  }
  if (ingeklapt) {
    while (kaart.children.length > 1) kaart.removeChild(kaart.lastChild);
    kaart.classList.add('ruimte-kaart-ingeklapt');
  }
  return kaart;
}
// Entry-helpers: bouwen {key, aanwezig, compleet, kaart} — hergebruiken bouwdeelVeldOk() (dezelfde
// compleetheids-check als de Controle-tab) zodat "compleet" hier en daar altijd hetzelfde betekent.
function bkStandaloneEntry(sectieObj, def) {
  const veld = sectieObj[def.key];
  return { key: 'bk:' + def.key, aanwezig: veld.aanwezig, compleet: bouwdeelVeldOk(def, veld), kaart: renderBouwdeelKaart(sectieObj, def) };
}
function enStandaloneEntry(sectieObj, def) {
  const veld = sectieObj[def.key];
  return { key: 'en:' + def.key, aanwezig: veld.aanwezig, compleet: bouwdeelVeldOk(def, veld), kaart: renderEnergetischKaart(sectieObj, def) };
}
function combiEntry(key, kaart, bkDef, bkVeld, enDef, enVeld) {
  const compleet = bouwdeelVeldOk(bkDef, bkVeld) && (enDef ? bouwdeelVeldOk(enDef, enVeld) : true);
  return { key: 'combi:' + key, aanwezig: bkVeld.aanwezig, compleet, kaart };
}
function combiEntryDak(key, kaart, bkDef, bkVeld, hellendDef, hellendVeld, platDef, platVeld) {
  const compleet = bouwdeelVeldOk(bkDef, bkVeld) && bouwdeelVeldOk(hellendDef, hellendVeld) && bouwdeelVeldOk(platDef, platVeld);
  return { key: 'combi:' + key, aanwezig: bkVeld.aanwezig, compleet, kaart };
}
// Bouwt de kaart-lijst van een subtab uit een reeks entries — geen "section-label" meer nodig per
// bouwdeel-groep (19-09-2026: sinds subtabs is de subtab-knop zelf al de titel, zelfde opzet als de
// losse Bouwkundig/Energetisch-tabbladen).
function renderBkEnLijst(entries) {
  const lijst = el('div', { class: 'bouwdeel-lijst' });
  entries.forEach(entry => lijst.appendChild(pasInklapbaarToe(entry.kaart, entry.key, entry.aanwezig, entry.compleet)));
  return lijst;
}
const BKEN_SUBTABS = {
  buitenzijde: [
    { id: 'daken', label: 'Daken' }, { id: 'gevel', label: 'Gevel' }, { id: 'glas', label: 'Glas' },
    { id: 'perceel', label: 'Perceel/tuin' }, { id: 'overigeWaarnemingen', label: 'Overige waarnemingen' },
  ],
  binnenzijde: [
    { id: 'funderingen', label: 'Funderingen' }, { id: 'vloeren', label: 'Vloeren' }, { id: 'wanden', label: 'Wanden' },
    { id: 'plafonds', label: 'Plafonds' }, { id: 'inrichting', label: 'Inrichting' },
    { id: 'overigeWaarnemingen', label: 'Overige waarnemingen' },
  ],
  installaties: [
    { id: 'leidingen', label: 'Leidingen' }, { id: 'verwarming', label: 'Verwarming' }, { id: 'warmwater', label: 'Warmwater' },
    { id: 'ventilatieKoeling', label: 'Ventilatie/Koeling' }, { id: 'elektrotechnisch', label: 'Electrotechnisch' },
    { id: 'overigeWaarnemingen', label: 'Overige waarnemingen' }, { id: 'energieopwekking', label: 'Energieopwekking' },
  ],
};
// Buitenzijde: Daken, Gevel, Glas, Perceel/tuin, Overige waarnemingen (Arno's indeling 19-09-2026) —
// Bijgebouwen is HIER bewust weggelaten: dat blok wordt voortaan uitsluitend via Indeling's
// Bijgebouwen-editor ingevuld en met de bestaande "↺ Overnemen"-knop naar Bouwkundig's eigen
// schuurBerging/garage/overigeBijgebouwen-velden gehaald (renderBouwkundigTab, ongewijzigd) — geen
// aparte plek hiervoor nodig in de samengevoegde tab.
function renderBkEnBuitenzijdeSubtab(t) {
  const gevelDefs = BOUWKUNDIG_SCHEMA.buitenzijde.gevel;
  const dakenDefs = BOUWKUNDIG_SCHEMA.buitenzijde.daken;
  const perceelDefs = BOUWKUNDIG_SCHEMA.buitenzijde.perceel;
  const bkOverigeDefs = BOUWKUNDIG_SCHEMA.buitenzijde.overigeWaarnemingen;
  const ramenDefs = ENERGETISCH_SCHEMA.isolatie.ramen;
  const gevelIsolatieDefs = ENERGETISCH_SCHEMA.isolatie.gevel;
  const dakIsolatieDefs = ENERGETISCH_SCHEMA.isolatie.daken;
  const bkDaken = t.bouwkundig.buitenzijde.daken;
  const bkGevel = t.bouwkundig.buitenzijde.gevel;

  if (state.bkEnSubtab === 'daken') {
    return renderBkEnLijst([
      bkStandaloneEntry(bkDaken, vindDef(dakenDefs, 'dakconstructie')),
      combiEntryDak('dak',
        renderGecombineerdDakKaart(
          vindDef(dakenDefs, 'materiaalDak'), bkDaken.materiaalDak,
          vindDef(dakIsolatieDefs, 'hellendDak'), t.energetisch.isolatie.daken.hellendDak,
          vindDef(dakIsolatieDefs, 'platDak'), t.energetisch.isolatie.daken.platDak,
        ),
        vindDef(dakenDefs, 'materiaalDak'), bkDaken.materiaalDak,
        vindDef(dakIsolatieDefs, 'hellendDak'), t.energetisch.isolatie.daken.hellendDak,
        vindDef(dakIsolatieDefs, 'platDak'), t.energetisch.isolatie.daken.platDak,
      ),
      bkStandaloneEntry(bkDaken, vindDef(dakenDefs, 'dakkapellen')),
      bkStandaloneEntry(bkDaken, vindDef(dakenDefs, 'schoorstenen')),
      bkStandaloneEntry(bkDaken, vindDef(dakenDefs, 'goten')),
      bkStandaloneEntry(bkDaken, vindDef(dakenDefs, 'loodwerk')),
    ]);
  }
  if (state.bkEnSubtab === 'gevel') {
    const gevelwerkDef = vindDef(gevelDefs, 'gevelwerk');
    const gevelisolatieDef = vindDef(gevelIsolatieDefs, 'gevelisolatie');
    return renderBkEnLijst([
      combiEntry('gevelwerk',
        renderGecombineerdGevelKaart(gevelwerkDef, bkGevel.gevelwerk, gevelisolatieDef, t.energetisch.isolatie.gevel.gevelisolatie),
        gevelwerkDef, bkGevel.gevelwerk, gevelisolatieDef, t.energetisch.isolatie.gevel.gevelisolatie),
      enStandaloneEntry(t.energetisch.isolatie.gevel, vindDef(gevelIsolatieDefs, 'gevelpanelen')),
      bkStandaloneEntry(bkGevel, vindDef(gevelDefs, 'balkon')),
      bkStandaloneEntry(bkGevel, vindDef(gevelDefs, 'kozijnen')),
      bkStandaloneEntry(bkGevel, vindDef(gevelDefs, 'buitendeuren')),
      bkStandaloneEntry(bkGevel, vindDef(gevelDefs, 'hangEnSluitwerk')),
      bkStandaloneEntry(bkGevel, vindDef(gevelDefs, 'buitenschilderwerk')),
    ]);
  }
  if (state.bkEnSubtab === 'glas') {
    return renderBkEnLijst([
      ['1e woonlaag', 'glas1eWoonlaag', 'glas1e'],
      ['2e woonlaag', 'glas2eWoonlaag', 'glas2e'],
      ['3e woonlaag', 'glas3eWoonlaag', 'glas3e'],
      ['overige woonlagen', 'glasOverigeWoonlagen', 'glasOverige'],
    ].map(([label, bkKey, enKey]) => {
      const bkDef = vindDef(gevelDefs, bkKey), enDef = vindDef(ramenDefs, enKey);
      const bkVeld = bkGevel[bkKey], enVeld = t.energetisch.isolatie.ramen[enKey];
      return combiEntry(bkKey, renderGecombineerdGlasKaart(label, bkDef, bkVeld, enDef, enVeld), bkDef, bkVeld, enDef, enVeld);
    }));
  }
  if (state.bkEnSubtab === 'perceel') {
    const bkPerceel = t.bouwkundig.buitenzijde.perceel;
    return renderBkEnLijst(perceelDefs.map(def => bkStandaloneEntry(bkPerceel, def)));
  }
  const bkOverige = t.bouwkundig.buitenzijde.overigeWaarnemingen;
  return renderBkEnLijst(bkOverigeDefs.map(def => bkStandaloneEntry(bkOverige, def)));
}
// Binnenzijde: Funderingen, Vloeren, Wanden, Plafonds, Inrichting, Overige waarnemingen — exact
// dezelfde 6-deling als Taxatieweb's eigen J.4 > Binnenzijde (Arno's verzoek 19-09-2026).
function renderBkEnBinnenzijdeSubtab(t) {
  const funderingenDefs = BOUWKUNDIG_SCHEMA.binnenzijde.funderingen;
  const vloerenDefs = BOUWKUNDIG_SCHEMA.binnenzijde.vloeren;
  const wandenDefs = BOUWKUNDIG_SCHEMA.binnenzijde.wanden;
  const plafondsDefs = BOUWKUNDIG_SCHEMA.binnenzijde.plafonds;
  const inrichtingDefs = BOUWKUNDIG_SCHEMA.binnenzijde.inrichting;
  const bkOverigeDefs = BOUWKUNDIG_SCHEMA.binnenzijde.overigeWaarnemingen;
  const vloerIsolatieDefs = ENERGETISCH_SCHEMA.isolatie.vloer;
  const bkFunderingen = t.bouwkundig.binnenzijde.funderingen;

  if (state.bkEnSubtab === 'funderingen') {
    const kruipruimteDef = vindDef(funderingenDefs, 'kruipruimte');
    const kruipruimteisolatieDef = vindDef(vloerIsolatieDefs, 'kruipruimteisolatie');
    return renderBkEnLijst([
      bkStandaloneEntry(bkFunderingen, vindDef(funderingenDefs, 'fundering')),
      combiEntry('kruipruimte',
        renderGecombineerdKruipruimteKaart(kruipruimteDef, bkFunderingen.kruipruimte, kruipruimteisolatieDef, t.energetisch.isolatie.vloer.kruipruimteisolatie),
        kruipruimteDef, bkFunderingen.kruipruimte, kruipruimteisolatieDef, t.energetisch.isolatie.vloer.kruipruimteisolatie),
      bkStandaloneEntry(bkFunderingen, vindDef(funderingenDefs, 'kelder')),
    ]);
  }
  if (state.bkEnSubtab === 'vloeren') {
    return renderBkEnLijst([
      ['1e woonlaag', 'woonlaag1', 'vloerisolatie1e'],
      ['2e woonlaag', 'woonlaag2', 'vloerisolatie2e'],
      ['3e woonlaag', 'woonlaag3', 'vloerisolatie3e'],
      ['overige woonlagen', 'woonlaagOverige', 'vloerisolatieOverige'],
    ].map(([label, bkKey, enKey]) => {
      const bkDef = vindDef(vloerenDefs, bkKey), enDef = vindDef(vloerIsolatieDefs, enKey);
      const bkVeld = t.bouwkundig.binnenzijde.vloeren[bkKey], enVeld = t.energetisch.isolatie.vloer[enKey];
      return combiEntry(bkKey, renderGecombineerdMateriaalIsolatieKaart('Vloer ' + label, 'Vloersoort', 'Vloer ' + label, bkDef, bkVeld, enDef, enVeld), bkDef, bkVeld, enDef, enVeld);
    }));
  }
  if (state.bkEnSubtab === 'wanden') {
    return renderBkEnLijst(wandenDefs.map(def => bkStandaloneEntry(t.bouwkundig.binnenzijde.wanden, def)));
  }
  if (state.bkEnSubtab === 'plafonds') {
    return renderBkEnLijst(plafondsDefs.map(def => bkStandaloneEntry(t.bouwkundig.binnenzijde.plafonds, def)));
  }
  if (state.bkEnSubtab === 'inrichting') {
    return renderBkEnLijst(inrichtingDefs.map(def => bkStandaloneEntry(t.bouwkundig.binnenzijde.inrichting, def)));
  }
  return renderBkEnLijst(bkOverigeDefs.map(def => bkStandaloneEntry(t.bouwkundig.binnenzijde.overigeWaarnemingen, def)));
}
// Installaties: Leidingen, Verwarming, Warmwater, Ventilatie/Koeling, Electrotechnische installaties,
// Overige waarnemingen — exact als Taxatieweb — plus Energieopwekking als 7e subtab (Arno's eigen
// keuze: Taxatieweb houdt dat als los I.4-hoofdstuk, hier voegen we het toe onder Installaties zodat
// het ook een plek heeft in deze samengevoegde tab).
function renderBkEnInstallatiesSubtab(t) {
  const leidingenDefs = BOUWKUNDIG_SCHEMA.installaties.leidingen;
  const verwarmingDefs = BOUWKUNDIG_SCHEMA.installaties.verwarming;
  const warmwaterDefs = BOUWKUNDIG_SCHEMA.installaties.warmwater;
  const ventilatieKoelingDefs = BOUWKUNDIG_SCHEMA.installaties.ventilatieKoeling;
  const elektrotechnischDefs = BOUWKUNDIG_SCHEMA.installaties.elektrotechnisch;
  const bkOverigeDefs = BOUWKUNDIG_SCHEMA.installaties.overigeWaarnemingen;
  const enVerwarmingDefs = ENERGETISCH_SCHEMA.installaties.verwarming;
  const enWarmWaterDefs = ENERGETISCH_SCHEMA.installaties.warmWater;
  const enVentilatieKoelingDefs = ENERGETISCH_SCHEMA.installaties.ventilatieKoeling;
  const enIsolatieOverigeDefs = ENERGETISCH_SCHEMA.isolatie.overige;

  if (state.bkEnSubtab === 'leidingen') {
    return renderBkEnLijst(leidingenDefs.map(def => bkStandaloneEntry(t.bouwkundig.installaties.leidingen, def)));
  }
  if (state.bkEnSubtab === 'verwarming') {
    const entries = [
      ['1e woonlaag', 'verwarmingssysteem1eWoonlaag', 'verwarmingssysteem1e'],
      ['2e en volgende woonlaag', 'verwarmingssysteem2eEnVolgendeWoonlaag', 'verwarmingssysteem2e'],
    ].map(([label, bkKey, enKey]) => {
      const bkDef = vindDef(verwarmingDefs, bkKey), enDef = vindDef(enVerwarmingDefs, enKey);
      const bkVeld = t.bouwkundig.installaties.verwarming[bkKey], enVeld = t.energetisch.installaties.verwarming[enKey];
      return combiEntry(bkKey, renderGecombineerdMateriaalKaart('Verwarmingssysteem ' + label, 'Type afgifte', bkDef, bkVeld, enDef, enVeld), bkDef, bkVeld, enDef, enVeld);
    });
    const vDef = vindDef(verwarmingDefs, 'verwarmingstoestel'), enVDef = vindDef(enVerwarmingDefs, 'verwarmingstoestel');
    const vVeld = t.bouwkundig.installaties.verwarming.verwarmingstoestel, enVVeld = t.energetisch.installaties.verwarming.verwarmingstoestel;
    entries.unshift(combiEntry('verwarmingstoestel', renderGecombineerdMateriaalKaart('Verwarmingstoestel', 'Type verwarmingstoestel', vDef, vVeld, enVDef, enVVeld), vDef, vVeld, enVDef, enVVeld));
    return renderBkEnLijst(entries);
  }
  if (state.bkEnSubtab === 'warmwater') {
    const wDef = vindDef(warmwaterDefs, 'warmwatertoestel'), enWDef = vindDef(enWarmWaterDefs, 'warmwatertoestel');
    const wVeld = t.bouwkundig.installaties.warmwater.warmwatertoestel, enWVeld = t.energetisch.installaties.warmWater.warmwatertoestel;
    return renderBkEnLijst([
      combiEntry('warmwatertoestel', renderGecombineerdMateriaalKaart('Warmwatertoestel', 'Type warmwatertoestel', wDef, wVeld, enWDef, enWVeld), wDef, wVeld, enWDef, enWVeld),
      enStandaloneEntry(t.energetisch.installaties.warmWater, vindDef(enWarmWaterDefs, 'doucheWtw')),
      enStandaloneEntry(t.energetisch.installaties.warmWater, vindDef(enWarmWaterDefs, 'zonneboilerInstallatie')),
    ]);
  }
  if (state.bkEnSubtab === 'ventilatieKoeling') {
    return renderBkEnLijst(['ventilatie', 'koeling'].map((sleutel) => {
      const bkDef = vindDef(ventilatieKoelingDefs, sleutel), enDef = vindDef(enVentilatieKoelingDefs, sleutel);
      const bkVeld = t.bouwkundig.installaties.ventilatieKoeling[sleutel], enVeld = t.energetisch.installaties.ventilatieKoeling[sleutel];
      return combiEntry(sleutel, renderGecombineerdMateriaalKaart(bkDef.label, 'Type ' + bkDef.label.toLowerCase(), bkDef, bkVeld, enDef, enVeld), bkDef, bkVeld, enDef, enVeld);
    }));
  }
  if (state.bkEnSubtab === 'elektrotechnisch') {
    return renderBkEnLijst(elektrotechnischDefs.map(def => bkStandaloneEntry(t.bouwkundig.installaties.elektrotechnisch, def)));
  }
  if (state.bkEnSubtab === 'energieopwekking') {
    return renderBkEnLijst(ENERGETISCH_SCHEMA.energieopwekking.map(def => enStandaloneEntry(t.energetisch.energieopwekking, def)));
  }
  // overigeWaarnemingen: bouwkundig's eigen "Overige waarnemingen installaties" + energetisch's
  // Isolatie>Overige (Leidingisolatie/Energiezuinige kozijnen) — die 2 horen bij geen enkel ander
  // bouwdeel-paar hierboven, dus krijgen hier een plek zodat ECHT alles gedekt is.
  return renderBkEnLijst([
    ...bkOverigeDefs.map(def => bkStandaloneEntry(t.bouwkundig.installaties.overigeWaarnemingen, def)),
    ...enIsolatieOverigeDefs.map(def => enStandaloneEntry(t.energetisch.isolatie.overige, def)),
  ]);
}
const BKEN_HOOFDTABS = [
  ['algemeen', 'Algemeen'], ['buitenzijde', 'Buitenzijde'], ['binnenzijde', 'Binnenzijde'], ['installaties', 'Installaties'],
];
function renderBouwkundigEnergetischTab() {
  const t = state.taxatie;
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'bouwdeel-hint', style: 'margin-bottom:10px;' },
    '💡 Dit tabblad toont dezelfde gegevens als Bouwkundig en Energetisch, alleen per bouwdeel samengevoegd. Wijzigen hier wijzigt ook die twee tabbladen (en andersom) — er wordt niets dubbel opgeslagen.'));

  const hoofdtabs = el('div', { class: 'weergave-wissel bouwkundig-hoofdtabs' });
  BKEN_HOOFDTABS.forEach(([id, label]) => {
    hoofdtabs.appendChild(el('button', {
      class: 'klein' + (state.bkEnHoofdtab === id ? ' actief' : ''),
      onclick: () => { state.bkEnHoofdtab = id; render(); },
    }, label));
  });
  wrap.appendChild(hoofdtabs);

  if (state.bkEnHoofdtab === 'algemeen') {
    wrap.appendChild(renderBkEnAlgemeen());
    return wrap;
  }

  // Subtabs (19-09-2026, Arno's verzoek: "misschien verstandig om subtabs op te nemen" — de lijst
  // per hoofdtab werd te lang) — zelfde patroon als Bouwkundig/Energetisch's eigen subtabs: bij het
  // wisselen van hoofdtab valt een niet-bestaande subtab terug op de eerste van de nieuwe hoofdtab.
  const subtabsSchema = BKEN_SUBTABS[state.bkEnHoofdtab];
  if (!subtabsSchema.some(s => s.id === state.bkEnSubtab)) state.bkEnSubtab = subtabsSchema[0].id;
  const subtabs = el('div', { class: 'weergave-wissel bouwkundig-subtabs' });
  subtabsSchema.forEach(sub => {
    subtabs.appendChild(el('button', {
      class: 'klein' + (state.bkEnSubtab === sub.id ? ' actief' : ''),
      onclick: () => { state.bkEnSubtab = sub.id; render(); },
    }, sub.label));
  });
  wrap.appendChild(subtabs);

  if (state.bkEnHoofdtab === 'binnenzijde') wrap.appendChild(renderBkEnBinnenzijdeSubtab(t));
  else if (state.bkEnHoofdtab === 'installaties') wrap.appendChild(renderBkEnInstallatiesSubtab(t));
  else wrap.appendChild(renderBkEnBuitenzijdeSubtab(t));

  return wrap;
}

// --- Omgeving (H.2 Omgeving, H.3 Fundering, K. Verontreiniging/Asbest zichtbaar-deel) ---
// chipSleutel: key in state.macros.bouwdeelChips (17-09-2026, Arno "B./C.") — de 4 Omgeving-velden
// hadden als enige plek nog GEEN macro-chips terwijl elk ander tekstveld in Bouwkundig/Energetisch
// dat al had; content is 1-op-1 overgenomen uit Taxatieweb's eigen "Toon macro's" bij Spade 21.
// Zelfde bouwsteen (renderBouwdeelChips) als de rest van de app, met een fake def {key: chipSleutel}
// zodat renderBouwdeelChips ongewijzigd hergebruikt kan worden.
function renderOmgevingVrijeTekst(o, sleutel, labelText, chipSleutel) {
  const wrap = el('div', { class: 'omgeving-veld' }, el('div', { class: 'bouwdeel-veld-label' }, labelText));
  if (chipSleutel) wrap.appendChild(renderBouwdeelChips(o, { key: chipSleutel }, sleutel));
  const veld = el('textarea', {
    class: 'bouwdeel-omschrijving', placeholder: labelText + '…',
    oninput: (e) => { o[sleutel] = e.target.value; planOpslaan(); },
  });
  veld.value = o[sleutel] || '';
  wrap.appendChild(veld);
  return wrap;
}
// HH:MM, zelfde notatie als een <input type="time">-veld verwacht.
function formatTijdHHMM(datum) {
  return datum.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}
function renderOmgevingTab() {
  const t = state.taxatie;
  const o = t.omgeving;
  const wrap = el('div', {});

  // Inspectie (Arno's verzoek 13-09-2026, naar analogie van Provadie's "Aanwezig bij inspectie" +
  // "Weersomstandigheden" + begin-/eindtijd) — begin-/eindtijd worden eenmalig voorgesteld vanuit
  // het moment dat deze taxatie voor het eerst op locatie geopend werd (begintijdOpname),
  // eindtijd = begintijd + 45 minuten (Arno's eigen inschatting van een gemiddelde opnameduur).
  // Blijven daarna gewoon los aanpasbaar — dit is alleen een voorstel, geen vaste waarde.
  if (o.begintijdInspectie === null && t.begintijdOpname) {
    const start = new Date(t.begintijdOpname);
    o.begintijdInspectie = formatTijdHHMM(start);
    o.eindtijdInspectie = formatTijdHHMM(new Date(start.getTime() + 45 * 60000));
    planOpslaan();
  }
  // Compacter (13-09-2026, Arno: "Inspectie ... kan compacter, bijv. kolommen") — Weersomstandigheden
  // + Begintijd + Eindtijd op één regel i.p.v. 3 losse regels; de aanwezigen-checkboxes blijven een
  // eigen grid (die stonden al compact) met een kleiner toelichtingsveld eronder, alleen zichtbaar
  // zodra er iets is aangevinkt — een lege toelichting nam anders altijd 60px in.
  const groepInspectie = el('div', { class: 'macro-groep' });
  groepInspectie.appendChild(el('h3', {}, 'Inspectie'));
  const inspectieRij = el('div', { class: 'objectkenmerken-rij' });
  const weerVeld = el('select', {
    class: 'energetisch-select', onchange: (e) => { o.weersomstandigheden = e.target.value; planOpslaan(); },
  }, el('option', { value: '' }, 'Selecteer'),
    ...['Droog', 'Regen', 'Sneeuw'].map(w => el('option', { value: w, selected: o.weersomstandigheden === w ? 'selected' : null }, w)));
  const begintijdVeld = el('input', { type: 'time', onchange: (e) => { o.begintijdInspectie = e.target.value; planOpslaan(); } });
  begintijdVeld.value = o.begintijdInspectie || '';
  const eindtijdVeld = el('input', { type: 'time', onchange: (e) => { o.eindtijdInspectie = e.target.value; planOpslaan(); } });
  eindtijdVeld.value = o.eindtijdInspectie || '';
  inspectieRij.appendChild(el('label', { class: 'objectkenmerken-veld' }, 'Weersomstandigheden', weerVeld));
  inspectieRij.appendChild(el('label', { class: 'objectkenmerken-veld' }, 'Begintijd', begintijdVeld));
  inspectieRij.appendChild(el('label', { class: 'objectkenmerken-veld' }, 'Eindtijd', eindtijdVeld));
  groepInspectie.appendChild(inspectieRij);
  // Exacte checkbox-opties van Taxatieweb's B. Inspectie > "Anderen aanwezig bij inspectie" (live
  // bevestigd 13-09-2026), zodat dit later 1-op-1 door "Vul in bij Taxatieweb" over te nemen is.
  groepInspectie.appendChild(el('div', { class: 'bouwdeel-veld-label bouwdeel-veld-label-compact' }, 'Aanwezig bij inspectie'));
  const aanwezigenGrid = el('div', { class: 'bouwdeel-materiaal-grid' });
  ['Verkopende makelaar', 'Aankopende makelaar', 'Eigenaar', 'Huurder/gebruiker', 'Anderen'].forEach(optie => {
    const aan = (o.aanwezigenInspectie || []).includes(optie);
    aanwezigenGrid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
      el('input', {
        type: 'checkbox', checked: aan ? 'checked' : null,
        onchange: () => {
          o.aanwezigenInspectie = o.aanwezigenInspectie || [];
          const i = o.aanwezigenInspectie.indexOf(optie);
          if (i >= 0) o.aanwezigenInspectie.splice(i, 1); else o.aanwezigenInspectie.push(optie);
          planOpslaan(); render();
        },
      }), optie));
  });
  groepInspectie.appendChild(aanwezigenGrid);
  if ((o.aanwezigenInspectie || []).length > 0) {
    const aanwezigenToelichtingVeld = el('textarea', {
      class: 'bouwdeel-omschrijving bouwdeel-omschrijving-compact', placeholder: 'Toelichting aanwezigen…',
      oninput: (e) => { o.aanwezigenInspectieToelichting = e.target.value; planOpslaan(); },
    });
    aanwezigenToelichtingVeld.value = o.aanwezigenInspectieToelichting || '';
    groepInspectie.appendChild(aanwezigenToelichtingVeld);
  }
  wrap.appendChild(groepInspectie);

  const groepOmgeving = el('div', { class: 'macro-groep' });
  groepOmgeving.appendChild(el('h3', {}, 'H.2 Omgeving'));
  // 2 kolommen vanaf tablet-breedte (zelfde grid-aanpak als elders) — 4 losse volle-breedte
  // tekstvelden onder elkaar was onnodig veel scrollwerk op een iPad (Arno: "compacter, bijv.
  // kolommen", 13-09-2026).
  const omgevingTekstGrid = el('div', { class: 'omgeving-tekst-grid' });
  omgevingTekstGrid.appendChild(renderOmgevingVrijeTekst(o, 'locatie', 'A. Locatie', 'omgevingLocatie'));
  omgevingTekstGrid.appendChild(renderOmgevingVrijeTekst(o, 'gebouwenRondom', 'B. Gebouwen rondom', 'omgevingGebouwenRondom'));
  omgevingTekstGrid.appendChild(renderOmgevingVrijeTekst(o, 'bereikbaarheid', 'C. Bereikbaarheid', 'omgevingBereikbaarheid'));
  omgevingTekstGrid.appendChild(renderOmgevingVrijeTekst(o, 'voorzieningen', 'D. Voorzieningen', 'omgevingVoorzieningen'));
  groepOmgeving.appendChild(omgevingTekstGrid);
  groepOmgeving.appendChild(jaNeeMetToelichtingRij(
    'E. Bijzonderheden in de omgeving die veel invloed kunnen hebben op de waarde?',
    o.bijzonderhedenOmgeving, (w) => { o.bijzonderhedenOmgeving = w; planOpslaan(); },
    o.bijzonderhedenOmgevingToelichting, (v) => { o.bijzonderhedenOmgevingToelichting = v; planOpslaan(); },
    'Toelichting bijzonderheden omgeving…',
  ));
  wrap.appendChild(groepOmgeving);

  const groepFundering = el('div', { class: 'macro-groep' });
  groepFundering.appendChild(el('h3', {}, 'H.3 Fundering'));
  groepFundering.appendChild(renderJaNeeToggle('A. Eigenaar of bewoner geraadpleegd', o.funderingEigenaarBewoner, (w) => { o.funderingEigenaarBewoner = w; }));
  groepFundering.appendChild(renderJaNeeToggle('B. Funderingsonderzoeksrapport (KCAF/F3O) geraadpleegd', o.funderingOnderzoeksrapport, (w) => { o.funderingOnderzoeksrapport = w; }));
  groepFundering.appendChild(renderJaNeeToggle('C. Andere bronnen en rapportages geraadpleegd', o.funderingAndereBronnen, (w) => { o.funderingAndereBronnen = w; }));
  groepFundering.appendChild(jaNeeMetToelichtingRij(
    'D. Weet ik van problemen of heb ik problemen gezien?',
    o.funderingProblemen, (w) => { o.funderingProblemen = w; planOpslaan(); },
    o.funderingProblemenToelichting, (v) => { o.funderingProblemenToelichting = v; planOpslaan(); },
    'Toelichting funderingsproblemen…',
  ));
  wrap.appendChild(groepFundering);

  const groepVerontreiniging = el('div', { class: 'macro-groep' });
  groepVerontreiniging.appendChild(el('h3', {}, 'K. Verontreiniging / Asbest'));
  groepVerontreiniging.appendChild(jaNeeMetToelichtingRij(
    'Zie ik een risico dat er vervuilde grond of grondwater is (bij de woning of in de buurt)?',
    o.risicoVervuildeGrond, (w) => { o.risicoVervuildeGrond = w; planOpslaan(); },
    o.risicoVervuildeGrondToelichting, (v) => { o.risicoVervuildeGrondToelichting = v; planOpslaan(); },
    'Toelichting risico vervuilde grond…',
  ));
  groepVerontreiniging.appendChild(jaNeeMetToelichtingRij(
    'Heb ik asbest gezien?',
    o.asbestGezien, (w) => { o.asbestGezien = w; planOpslaan(); },
    o.asbestGezienToelichting, (v) => { o.asbestGezienToelichting = v; planOpslaan(); },
    'Toelichting asbest gezien…',
  ));
  groepVerontreiniging.appendChild(jaNeeMetToelichtingRij(
    'Denk ik dat er asbest aanwezig is?',
    o.asbestAanwezigDenken, (w) => { o.asbestAanwezigDenken = w; planOpslaan(); },
    o.asbestAanwezigDenkenToelichting, (v) => { o.asbestAanwezigDenkenToelichting = v; planOpslaan(); },
    'Toelichting asbest aanwezig…',
  ));
  wrap.appendChild(groepVerontreiniging);

  return wrap;
}

// Losse schetsen/markeringen horen hier bij de vrije aantekeningen thuis, niet bij de (verplichte)
// foto-checklist — vandaar de "Tekenen"-tegel hier i.p.v. in de Foto's-tab (Arno's verzoek
// 16-09-2026). Bewaard onder categorie 'Tekening' zodat ze hier apart getoond kunnen worden, maar
// ze blijven gewoon gewone foto's (zelfde opslag/sync/lightbox) en staan dus ook mee in "Alle foto's".
function renderAantekeningenTab() {
  const t = state.taxatie;
  const wrap = el('div', {});

  const veld = el('textarea', {
    class: 'aantekeningen-veld', placeholder: 'Aantekeningen tijdens de opname…',
    oninput: (e) => { t.aantekeningen = e.target.value; planOpslaan(); },
  });
  veld.value = t.aantekeningen || '';
  wrap.appendChild(veld);

  wrap.appendChild(el('div', { class: 'section-label', style: 'margin-top:16px;' }, 'Schetsen en markeringen'));
  const grid = el('div', { class: 'foto-grid' });
  state.fotos.filter(f => f.categorie === 'Tekening' && !f.archief).forEach(f => {
    const badgeKlasse = f.status === 'verzonden' ? 'ok' : 'wachtend';
    const badgeTekst = f.status === 'verzonden' ? '✓' : '⏳';
    grid.appendChild(el('button', { type: 'button', class: 'foto-tegel', onclick: () => openLightbox(f) },
      el('img', { src: URL.createObjectURL(f.blob) }),
      el('span', { class: 'badge ' + badgeKlasse }, badgeTekst),
    ));
  });
  // Cloud-only schetsen (wél geüpload, niet meer lokaal) — bewust GEEN label-dedup zoals bij de
  // "gewone" foto's/bouwdelen: elke schets deelt hier dezelfde categorie ('Tekening'), dus die regel
  // zou bij 1 lokale schets meteen ALLE cloud-schetsen verbergen. Een enkele dubbele tegel is
  // onschuldiger dan een gemiste schets.
  state.cloudFotos.filter(cf => fotoLabelSleutel(cf.categorie) === fotoLabelSleutel('Tekening')).forEach(cf => {
    grid.appendChild(el('button', {
      type: 'button', class: 'foto-tegel foto-tegel-cloud', title: 'Uit cloud-archief — niet meer lokaal op dit toestel',
      onclick: () => openLightbox(cf),
    },
      el('img', { src: cf.thumbUrl }),
      el('span', { class: 'badge cloud' }, '☁'),
    ));
  });
  grid.appendChild(el('div', {
    class: 'foto-add', onclick: () => openTekenScherm({ ruimteLabel: null, categorie: 'Tekening' }),
  }, el('span', { class: 'plus' }, '✏️'), 'Tekenen'));
  wrap.appendChild(grid);

  return wrap;
}

// --- Macro's ---
const MACRO_GROEPEN = [
  { sleutel: 'verdiepingen', titel: 'Verdiepingen', uitleg: 'Suggesties bij de naam van een woonlaag (Indeling).' },
  { sleutel: 'ruimtes', titel: 'Ruimtes', uitleg: 'Suggesties bij de naam van een ruimte (Indeling).' },
  { sleutel: 'ruimteblokken', titel: 'Ruimteblokken', uitleg: 'Suggesties bij de naam van een meetblok (Meting).' },
  { sleutel: 'toevoegingen', titel: 'Toevoegingen (algemeen)', uitleg: 'Suggesties bij het toevoegen van een element — bij élke ruimte, naast de lijst hieronder indien van toepassing.' },
  { sleutel: 'sanitair', titel: 'Sanitair', uitleg: 'Extra suggesties bij een ruimte met "badkamer", "toilet" of "douche" in de naam.' },
  { sleutel: 'keuken', titel: 'Keuken', uitleg: 'Extra suggesties bij een ruimte met "keuken" in de naam.' },
  { sleutel: 'vloersoort', titel: 'Vloersoort', uitleg: 'Keuzeopties bij "Kenmerken verdieping" (Indeling) en bij Bouwkundig > Vloeren.' },
  { sleutel: 'kozijnen', titel: 'Kozijnen', uitleg: 'Keuzeopties bij "Kenmerken verdieping" (Indeling) en tik-suggesties bij Bouwkundig > Kozijnen.' },
  { sleutel: 'glastypes', titel: 'Glastypes', uitleg: 'Keuzeopties bij "Kenmerken verdieping" (Indeling) en bij Energetisch > Glas.' },
  { sleutel: 'verwarmingssysteem', titel: 'Verwarmingssysteem', uitleg: 'Keuzeopties bij "Kenmerken verdieping" (Indeling) en bij Bouwkundig/Energetisch > Verwarmingssysteem.' },
  { sleutel: 'vloerafwerking', titel: 'Vloerafwerking', uitleg: 'Keuzeopties bij "Kenmerken verdieping" (Indeling).' },
  { sleutel: 'ventilatie', titel: 'Ventilatie', uitleg: 'Keuzeopties bij Bouwkundig én Energetisch > Ventilatie (1 gedeelde selectie).' },
  { sleutel: 'koeling', titel: 'Koeling', uitleg: 'Keuzeopties bij Bouwkundig én Energetisch > Koeling (1 gedeelde selectie).' },
  { sleutel: 'warmwatertoestel', titel: 'Warmwatertoestel', uitleg: 'Keuzeopties bij Bouwkundig én Energetisch > Warmwatertoestel (1 gedeelde selectie).' },
  { sleutel: 'bijgebouwTypes', titel: 'Bijgebouwen — type', uitleg: 'Keuzelijst bij "Bij-/aanbouwen en buitenvoorzieningen" (Indeling).' },
  { sleutel: 'bijgebouwMateriaal', titel: 'Bijgebouwen — materiaal', uitleg: 'Keuzeopties bij "Bij-/aanbouwen en buitenvoorzieningen" (Indeling).' },
  { sleutel: 'bijgebouwExtras', titel: "Bijgebouwen — extra's", uitleg: 'Keuzeopties bij "Bij-/aanbouwen en buitenvoorzieningen" (Indeling).' },
];

function renderMacrosTab() {
  const wrap = el('div', {});
  wrap.appendChild(el('p', { class: 'macro-uitleg' }, 'Eigen keuzelijsten — gelden voor alle taxaties. Pas ze hier aan; de suggesties bij Meting en Indeling volgen automatisch mee.'));
  MACRO_GROEPEN.forEach(({ sleutel, titel, uitleg }) => {
    const groep = el('div', { class: 'macro-groep' });
    groep.appendChild(el('h3', {}, titel));
    groep.appendChild(el('p', { class: 'macro-uitleg', style: 'margin-bottom:8px;' }, uitleg));
    const chipRij = el('div', { class: 'chip-rij' });
    (state.macros[sleutel] || []).forEach((item, i) => {
      chipRij.appendChild(el('span', { class: 'chip' }, item,
        el('button', { onclick: () => { state.macros[sleutel].splice(i, 1); bewaarMacros(); render(); } }, '✕'),
      ));
    });
    groep.appendChild(chipRij);
    const invoer = el('input', { placeholder: 'Nieuw item toevoegen…' });
    invoer.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !invoer.value.trim()) return;
      if (!state.macros[sleutel]) state.macros[sleutel] = [];
      state.macros[sleutel].push(invoer.value.trim());
      bewaarMacros(); render();
    });
    groep.appendChild(el('div', { class: 'chip-toevoegen' }, invoer));
    wrap.appendChild(groep);
  });
  return wrap;
}

// ----------------------------------------------------------------------------------------------
// INIT
// ----------------------------------------------------------------------------------------------
(async function init() {
  await laadMacros();
  const m = location.hash.match(/^#\/opname\/([^/]+)\/([a-z]+)$/);
  if (m) laadOpname(decodeURIComponent(m[1]), m[2]);
  else { render(); laadTaxatielijst(); }
  verstuurFotoWachtrij(); // eventuele foto's die vorige keer nog niet weg konden, alsnog proberen

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
