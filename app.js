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

// Zelfde 19 categorieën als QR_CATEGORIEEN in taxatieweb-opname.user.js (v0.54.0) — dezelfde lijst
// als Taxatieweb's eigen Q/R-categorieselectie, plus "Anders" als vangnet.
const QR_CATEGORIEEN = [
  'Vooraanzicht', 'Straatbeeld', 'Achtergevel', 'Tuin', 'Badkamer', 'Keuken', 'Woonkamer',
  'Slaapkamer', 'Toilet', 'Zolder', 'Berging', 'Kelder', 'Meterkast', 'C.V.-ketel', 'Balkon',
  'Dakterras', 'Verbouwing', 'Achterstallig onderhoud',
];
// Verplichte vaste foto's (uit Q/R's eigen instructietekst) — altijd op de checklist, ongeacht Indeling.
const VASTE_VERPLICHTE_FOTOS = [
  'Vooraanzicht', 'Straatbeeld', 'Achtergevel', 'Tuin', 'Badkamer', 'Keuken', 'Woonkamer',
  'Toilet', 'Meterkast',
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
function leegIndelingWoonlaag() {
  return { naam: '', vloerbeschrijving: '', vloerbeschrijvingen: [], ruimtes: [leegRuimte()] };
}
function leegData() {
  return {
    afmetingen: { woonlagen: [leegWoonlaag()] },
    externeBergruimte: { blokken: [] },
    indeling: { woonlagen: [], extern: [] },
  };
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
    data: leegData(),
    bewoning: leegBewoning(),
    bouwkundig: leegBouwkundig(),
    lokaalGewijzigd: false,
  };
}

// Sinds Arno's verzoek (11-09-2026): "de app afbouwen voor een volledige opname zoals Provadie" —
// Fase 1 = Bewoning, 1-op-1 dezelfde velden/volgorde als Taxatieweb's L. Bewoning (live nagekeken op
// een testrapport), zodat een latere "Vul in bij Taxatieweb"-knop (taxatieweb-opname.user.js) deze
// waarden zonder vertaalslag kan overnemen. ja_nee-velden: null (nog niet ingevuld) | true | false.
function leegBewoning() {
  return {
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
function leegBouwdeel() {
  return {
    aanwezig: false, conditie: 5,
    omschrijving: '', materialen: [],
    aandachtspuntenAanwezig: null, aandachtspuntenToelichting: '',
  };
}
function leegBouwkundig() {
  const maakGroep = (bouwdelen) => {
    const groep = {};
    bouwdelen.forEach(b => { groep[b.key] = leegBouwdeel(); });
    return groep;
  };
  return {
    buitenzijde: {
      daken: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.daken),
      gevel: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.gevel),
      bijgebouwen: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.bijgebouwen),
      perceel: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.perceel),
      overigeWaarnemingen: maakGroep(BOUWKUNDIG_SCHEMA.buitenzijde.overigeWaarnemingen),
    },
  };
}
// Vult ontbrekende groepen/bouwdelen aan bij bestaande data (nieuwe bouwdelen later toegevoegd, of
// data van vóór Fase 2) — zelfde migratie-patroon als metExterneBergruimte()/metNieuweMacroCategorieen().
function metVolledigBouwkundig(bk) {
  const leeg = leegBouwkundig();
  if (!bk || typeof bk !== 'object') return leeg;
  if (!bk.buitenzijde) bk.buitenzijde = {};
  Object.keys(leeg.buitenzijde).forEach(sectie => {
    if (!bk.buitenzijde[sectie]) bk.buitenzijde[sectie] = {};
    Object.keys(leeg.buitenzijde[sectie]).forEach(key => {
      if (!bk.buitenzijde[sectie][key]) bk.buitenzijde[sectie][key] = leegBouwdeel();
    });
  });
  return bk;
}
const CONDITIE_LABELS = ['niet waarneembaar', 'nader onderzoek nodig', 'slecht', 'matig', 'redelijk', 'goed'];
const BOUWKUNDIG_SCHEMA = {
  buitenzijde: {
    daken: [
      { key: 'dakconstructie', label: 'Dakconstructie', type: 'tekst' },
      { key: 'materiaalDak', label: 'Materiaal dak', type: 'materiaal', opties: ['Pannen', 'Leien', 'Riet', 'Bitumineus', 'EPDM', 'Sedum', 'Overige'] },
      { key: 'dakkapellen', label: 'Dakkapel(len)', type: 'tekst' },
      { key: 'schoorstenen', label: 'Schoorste(e)n(en)', type: 'tekst' },
      { key: 'goten', label: 'Goten (incl. hemelwaterafvoeren)', type: 'tekst' },
      { key: 'loodwerk', label: 'Loodwerk', type: 'tekst' },
    ],
    gevel: [
      { key: 'gevelwerk', label: 'Gevelwerk', type: 'materiaal', opties: ['Metselwerk', 'Gevelbetimmering', 'Gevelcement', 'Stucwerk', 'Composiet', 'Overige'] },
      { key: 'balkon', label: 'Balkon', type: 'tekst' },
      { key: 'kozijnen', label: 'Kozijnen', type: 'tekst' },
      { key: 'buitendeuren', label: 'Buitendeuren', type: 'tekst' },
      { key: 'hangEnSluitwerk', label: 'Hang- en sluitwerk', type: 'tekst' },
      { key: 'buitenschilderwerk', label: 'Buitenschilderwerk', type: 'tekst' },
      { key: 'glas1eWoonlaag', label: 'Glas 1e woonlaag', type: 'tekst' },
      { key: 'glas2eWoonlaag', label: 'Glas 2e woonlaag', type: 'tekst' },
      { key: 'glas3eWoonlaag', label: 'Glas 3e woonlaag', type: 'tekst' },
      { key: 'glasOverigeWoonlagen', label: 'Glas overige woonlagen', type: 'tekst' },
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
};
const BUITENZIJDE_SUBTABS = [
  { id: 'daken', label: 'Daken' },
  { id: 'gevel', label: 'Gevel' },
  { id: 'bijgebouwen', label: 'Bijgebouwen' },
  { id: 'perceel', label: 'Perceel/tuin' },
  { id: 'overigeWaarnemingen', label: 'Overige waarnemingen' },
];

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
      'bergruimte', 'bergvliering', 'bergzolder',
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

// Vult bewaarde macro's aan met sanitair/keuken als die nog ontbreken — data die vóór v1.1 al eens
// bewaard is (bewaarMacros() sloeg toen nog maar 4 lijsten op) zou anders zonder deze twee komen te
// zitten i.p.v. terug te vallen op de standaardlijst.
function metNieuweMacroCategorieen(m) {
  const standaard = standaardMacros();
  if (!Array.isArray(m.sanitair)) m.sanitair = standaard.sanitair;
  if (!Array.isArray(m.keuken)) m.keuken = standaard.keuken;
  return m;
}

// ----------------------------------------------------------------------------------------------
// STATE
// ----------------------------------------------------------------------------------------------
const state = {
  route: { naam: 'lijst' }, // { naam:'lijst' } | { naam:'opname', rapportId, tab }
  taxatie: null, // huidig geladen taxatie (zelfde vorm als leegTaxatie())
  fotos: [], // foto's van de huidige taxatie (uit IndexedDB), inclusief nog-niet-verzonden
  taxatielijst: [], // cache voor het homescherm
  vooronderzoekLijst: null, // null = nog niet opgehaald; daarna array records uit Airtable-tabel "Vooronderzoek"
  vooronderzoekLaadFout: false,
  bijlagenLijst: null, // null = nog niet opgehaald; daarna array records uit Airtable-tabel "Bijlagen"
  bijlagenLaadFout: false,
  online: navigator.onLine,
  wachtrijAantal: 0,
  macros: standaardMacros(), // wordt bij init() overschreven met de bewaarde versie, indien aanwezig
  afmetingenWeergave: 'tekening', // 'tekening' | 'lijst' — zelfde standaard als Taxatieweb sinds v0.17.0
  bouwkundigHoofdtab: 'buitenzijde', // 'buitenzijde' | 'binnenzijde' | 'installaties' — nu alleen buitenzijde uitgewerkt
  bouwkundigSubtab: 'daken', // zie BUITENZIJDE_SUBTABS
  ingeklaptBouwdelen: new Set(), // sleutel 'sectie.key' — welke bouwdeel-kaarten ingeklapt zijn
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
function toonEigenSuggesties(input, macroSleutel, uitgeslotenFn) {
  const opgelost = typeof macroSleutel === 'function' ? macroSleutel() : macroSleutel;
  const sleutels = Array.isArray(opgelost) ? opgelost : [opgelost];
  let opties = [...new Set(sleutels.flatMap(s => state.macros[s] || []))];
  if (uitgeslotenFn) {
    const uitgesloten = uitgeslotenFn().map(x => x.toLowerCase());
    opties = opties.filter(o => !uitgesloten.includes(o.toLowerCase()));
  }
  const zoekterm = input.value.trim().toLowerCase();
  const gefilterd = opties.filter(o => !zoekterm || o.toLowerCase().includes(zoekterm));
  if (gefilterd.length === 0) { verbergEigenSuggesties(); return; }
  actieveSuggestieInput = input;
  eigenSuggestiesLijst.innerHTML = '';
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
  input.addEventListener('focus', () => toonEigenSuggesties(input, macroSleutel, uitgeslotenFn));
  input.addEventListener('input', () => toonEigenSuggesties(input, macroSleutel, uitgeslotenFn));
  input.addEventListener('blur', () => setTimeout(() => {
    if (actieveSuggestieInput === input) verbergEigenSuggesties();
  }, 150));
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

function componeerIndelingTekst(indeling) {
  const nederlandseLijst = (items) => {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    return items.slice(0, -1).join(', ') + ' en ' + items[items.length - 1];
  };
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
    indeling_tekst: componeerIndelingTekst(taxatie.data.indeling),
    data: JSON.stringify(taxatie.data),
    vergelijker_data: '{}',
    aantekeningen: taxatie.aantekeningen || '',
    bewoning_data: JSON.stringify(taxatie.bewoning || leegBewoning()),
    bouwkundig_data: JSON.stringify(taxatie.bouwkundig || leegBouwkundig()),
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
function planOpslaan() {
  if (!state.taxatie) return;
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
  lokaal.bouwkundig = metVolledigBouwkundig(lokaal.bouwkundig); // taxaties van vóór Fase 2 "volledige opname"
  state.taxatie = lokaal;
  state.fotos = await VeldopnameDB.fotosVoorTaxatie(rapportId);
  navigeer({ naam: 'opname', rapportId, tab: tab || 'meting' });

  // Op de achtergrond: cloud-versie ophalen en overnemen als die recenter/aanwezig is (net als
  // taxatieweb-opname.user.js bij het laden doet) — alleen als er lokaal nog geen wijziging in de
  // wachtrij staat, anders zouden we eigen niet-verzonden werk overschrijven.
  if (state.online && !lokaal.lokaalGewijzigd) {
    try {
      const { data, bewoning_data, bouwkundig_data, aantekeningen } = await cloudOphalen(rapportId);
      // Let op: `data` (en sinds Fase 1/2 "volledige opname" ook bewoning_data/bouwkundig_data) komt
      // al als object terug (de Make-respons splitst 'm rechtstreeks in de JSON-body,
      // {"data":{{...}}} zonder quotes) — GEEN JSON.parse() erover heen, dat gaf hier "[object
      // Object] is not valid JSON". Vergelijk taxatieweb-opname.user.js, waar cloudData ook
      // rechtstreeks als object gebruikt wordt.
      let gewijzigd = false;
      if (data && typeof data === 'object') { state.taxatie.data = data; gewijzigd = true; }
      if (bewoning_data && typeof bewoning_data === 'object') { state.taxatie.bewoning = bewoning_data; gewijzigd = true; }
      if (bouwkundig_data && typeof bouwkundig_data === 'object') { state.taxatie.bouwkundig = metVolledigBouwkundig(bouwkundig_data); gewijzigd = true; }
      // aantekeningen alleen overnemen als lokaal nog leeg is — anders zou een cloud-versie die (door
      // de eerder ontbrekende sync) nog leeg is een lokaal wél al ingetypte notitie overschrijven.
      if (aantekeningen && !state.taxatie.aantekeningen) { state.taxatie.aantekeningen = aantekeningen; gewijzigd = true; }
      if (gewijzigd) {
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
      inhoud.appendChild(el('div', {
        class: 'taxatie-kaart',
        onclick: () => { location.hash = '#/opname/' + encodeURIComponent(t.rapport_id) + '/meting'; },
      },
        el('div', { class: 'adres' },
          t.adres || '(adres onbekend)',
          t.voorlopig ? el('span', { class: 'badge-voorlopig' }, '⏳ Voorlopig') : null,
        ),
        el('div', { class: 'plaats' }, t.plaats || ''),
        el('div', { class: 'meta' }, el('span', { class: 'afspraak' }, formatAfspraak(t.afspraak_datumtijd))),
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
const TABS = [
  { id: 'onderzoek', icon: '🔍', label: 'Onderzoek' },
  { id: 'bewoning', icon: '🔑', label: 'Bewoning' },
  { id: 'meting', icon: '📐', label: 'Meting' },
  { id: 'indeling', icon: '🏠', label: 'Indeling' },
  { id: 'bouwkundig', icon: '🧱', label: 'Bouwkundig' },
  { id: 'fotos', icon: '📷', label: "Foto's" },
  { id: 'aantekeningen', icon: '📝', label: 'Notities' },
  { id: 'macros', icon: '⚙️', label: "Macro's" },
];

function renderOpnameScherm() {
  const t = state.taxatie;
  const wrap = el('div', { class: 'opname-scherm' });
  wrap.appendChild(el('div', { class: 'statusbalk' },
    el('button', { class: 'terug', onclick: () => { location.hash = ''; } }, '‹'),
    el('h1', {}, t.adres || t.rapport_id),
    el('span', { class: 'sync-pil ' + syncPilTekst().klasse }, syncPilTekst().tekst),
  ));

  const inhoud = el('div', { class: 'inhoud' });
  if (state.route.tab === 'meting') inhoud.appendChild(renderMetingTab());
  else if (state.route.tab === 'indeling') inhoud.appendChild(renderIndelingTab());
  else if (state.route.tab === 'onderzoek') inhoud.appendChild(renderOnderzoekTab());
  else if (state.route.tab === 'bewoning') inhoud.appendChild(renderBewoningTab());
  else if (state.route.tab === 'bouwkundig') inhoud.appendChild(renderBouwkundigTab());
  else if (state.route.tab === 'fotos') inhoud.appendChild(renderFotosTab());
  else if (state.route.tab === 'aantekeningen') inhoud.appendChild(renderAantekeningenTab());
  else if (state.route.tab === 'macros') inhoud.appendChild(renderMacrosTab());
  wrap.appendChild(inhoud);

  const tabbalk = el('div', { class: 'tabbalk' });
  TABS.forEach(tab => {
    const actief = state.route.tab === tab.id;
    const verplichtNogNietKlaar = tab.id === 'fotos' && bepaalVerplichteFotos().some(v => !v.klaar);
    tabbalk.appendChild(el('button', {
      class: (actief ? 'actief ' : '') + (verplichtNogNietKlaar ? 'badge-stip' : ''),
      onclick: () => { location.hash = '#/opname/' + encodeURIComponent(t.rapport_id) + '/' + tab.id; },
    }, el('span', { class: 'icon' }, tab.icon), tab.label));
  });
  wrap.appendChild(tabbalk);
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

  const wissel = el('div', { class: 'weergave-wissel' });
  [['tekening', '✏️ Tekenen'], ['lijst', '📋 Lijst']].forEach(([modus, label]) => {
    wissel.appendChild(el('button', {
      class: state.afmetingenWeergave === modus ? 'actief' : '',
      onclick: () => { state.afmetingenWeergave = modus; render(); },
    }, label));
  });
  wrap.appendChild(wissel);

  wrap.appendChild(el('div', { class: 'section-label' }, 'Woonlagen'));
  t.data.afmetingen.woonlagen.forEach((woonlaag, wIdx) => {
    const kaart = el('div', { class: 'woonlaag-kaart' });
    const naamInput = el('input', {
      value: woonlaag.naam || `${wIdx + 1}e woonlaag`, placeholder: `${wIdx + 1}e woonlaag`,
      oninput: (e) => { woonlaag.naam = e.target.value; planOpslaan(); },
    });
    koppelDatalist(naamInput, 'verdiepingen');
    kaart.appendChild(el('div', { class: 'woonlaag-titel' },
      naamInput,
      el('span', { class: 'totaal' }, formatM2(woonlaagTotaal(woonlaag)) + ' m²'),
    ));

    if (state.afmetingenWeergave === 'tekening') {
      kaart.appendChild(renderTekenkader(woonlaag, wIdx));
    } else {
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
        kaart.appendChild(rij);
      });
    }
    kaart.appendChild(el('button', { class: 'knop spook klein', onclick: () => { woonlaag.blokken.push(leegBlok()); planOpslaan(); render(); } }, '+ Blok toevoegen'));
    wrap.appendChild(kaart);
  });
  wrap.appendChild(el('button', {
    class: 'knop spook', style: 'margin-bottom:14px;',
    onclick: () => { t.data.afmetingen.woonlagen.push(leegWoonlaag()); planOpslaan(); render(); },
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

function renderIndelingTab() {
  const t = state.taxatie;
  const wrap = el('div', {});
  t.data.indeling.woonlagen.forEach((woonlaag, wIdx) => {
    wrap.appendChild(el('div', { class: 'section-label' }, woonlaag.naam || `Woonlaag ${wIdx + 1}`));
    const naamInput = el('input', {
      value: woonlaag.naam || '', placeholder: `Naam woonlaag (bv. "Begane grond")`,
      style: 'width:100%;margin-bottom:8px;padding:8px 10px;border-radius:9px;border:1px solid var(--divider);',
      oninput: (e) => { woonlaag.naam = e.target.value; planOpslaan(); },
    });
    koppelDatalist(naamInput, 'verdiepingen');
    wrap.appendChild(naamInput);

    (woonlaag.ruimtes || []).forEach((ruimte, rIdx) => {
      wrap.appendChild(renderRuimteKaart(ruimte, () => { woonlaag.ruimtes.splice(rIdx, 1); planOpslaan(); render(); }));
    });
    wrap.appendChild(el('button', {
      class: 'knop spook klein', style: 'margin-bottom:16px;',
      onclick: () => { woonlaag.ruimtes.push(leegRuimte()); planOpslaan(); render(); },
    }, '+ Ruimte toevoegen'));
  });
  wrap.appendChild(el('button', {
    class: 'knop spook', style: 'margin-bottom:16px;',
    onclick: () => { t.data.indeling.woonlagen.push(leegIndelingWoonlaag()); planOpslaan(); render(); },
  }, '+ Woonlaag toevoegen'));

  wrap.appendChild(el('div', { class: 'section-label' }, 'Extern'));
  (t.data.indeling.extern || []).forEach((ruimte, i) => {
    wrap.appendChild(renderRuimteKaart(ruimte, () => { t.data.indeling.extern.splice(i, 1); planOpslaan(); render(); }));
  });
  wrap.appendChild(el('button', {
    class: 'knop spook',
    onclick: () => { t.data.indeling.extern.push(leegRuimte()); planOpslaan(); render(); },
  }, '+ Extern onderdeel toevoegen'));
  return wrap;
}

function renderRuimteKaart(ruimte, verwijder) {
  const kaart = el('div', { class: 'ruimte-kaart' });
  const ruimteNaamInput = el('input', {
    value: ruimte.naam || '', placeholder: 'Ruimte (bv. "Woonkamer")',
    oninput: (e) => { ruimte.naam = e.target.value; planOpslaan(); },
  });
  koppelDatalist(ruimteNaamInput, 'ruimtes');
  kaart.appendChild(el('div', { class: 'ruimte-rij-boven' },
    ruimteNaamInput,
    el('button', { class: 'camera-knop', title: 'Foto maken bij deze ruimte', onclick: () => openCameraVoorRuimte(ruimte, kaart) }, '📷'),
    el('button', { class: 'verwijder', onclick: verwijder }, '✕'),
  ));
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

  // verborgen input voor de camera-per-ruimte-koppeling (zie openCameraVoorRuimte)
  const cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none;' });
  cameraInput.addEventListener('change', () => { verwerkGekozenFoto(cameraInput.files[0], ruimte.naam); });
  kaart.appendChild(cameraInput);
  kaart._cameraInput = cameraInput;
  return kaart;
}

function openCameraVoorRuimte(ruimte, kaart) {
  if (kaart._cameraInput) kaart._cameraInput.click();
}

// --- Foto's ---
function bepaalQRCategorieVoorRuimte(ruimteNaam) {
  const kaal = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const doel = kaal(ruimteNaam);
  if (!doel) return null;
  const treffer = QR_CATEGORIEEN.find(c => { const kc = kaal(c); return doel === kc || doel.startsWith(kc) || doel.includes(kc); });
  return treffer || null;
}

function bepaalVerplichteFotos() {
  const items = VASTE_VERPLICHTE_FOTOS.map(naam => ({ naam, categorie: naam }));
  // per ruimte-instantie uit Indeling — gegroepeerd per categorie zodat "3 slaapkamers" ook echt
  // 3 losse verplichte foto's oplevert i.p.v. 1.
  const groepen = {};
  alleRuimtes().forEach(r => {
    const cat = bepaalQRCategorieVoorRuimte(r.naam) || r.naam;
    if (!groepen[cat]) groepen[cat] = [];
    groepen[cat].push(r.naam);
  });
  Object.entries(groepen).forEach(([cat, namen]) => {
    if (VASTE_VERPLICHTE_FOTOS.includes(cat) && namen.length <= 1) return; // al gedekt door de vaste lijst
    namen.forEach((naam, i) => {
      items.push({ naam: namen.length > 1 ? `${cat} ${i + 1}/${namen.length}` : cat, categorie: cat, instantie: i });
    });
  });
  // Foto's die als "eigen archief" gemarkeerd zijn tellen niet mee voor de checklist — dat zijn
  // bewust extra opnamen voor Arno's eigen naslag, niet bedoeld voor Q/R.
  const relevanteFotos = state.fotos.filter(f => !f.archief);
  const gemaakt = relevanteFotos.map(f => f.categorie + '::' + (f.instantie || 0));
  return items.map((item, i) => ({ ...item, klaar: gemaakt.includes((item.categorie) + '::' + (item.instantie || 0)) || relevanteFotos.some(f => f.ruimte_label === item.naam) }));
}

function renderFotosTab() {
  const wrap = el('div', {});
  const checklist = el('div', { class: 'checklist-kaart' });
  checklist.appendChild(el('div', { class: 'section-label' }, 'Verplichte foto\'s'));
  bepaalVerplichteFotos().forEach(item => {
    checklist.appendChild(el('div', { class: 'checklist-item' + (item.klaar ? ' klaar' : '') },
      el('span', { class: 'vinkje' }, item.klaar ? '✓' : ''),
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
function openLightbox(foto) {
  const bestaand = document.querySelector('.lightbox');
  if (bestaand) bestaand.remove();
  const toggle = el('input', { type: 'checkbox' });
  toggle.checked = !!foto.archief;
  toggle.addEventListener('change', async () => {
    foto.archief = toggle.checked;
    await VeldopnameDB.werkFotoBij(foto.id, { archief: foto.archief });
  });
  const overlay = el('div', { class: 'lightbox' },
    el('div', { class: 'lightbox-top' },
      el('span', { class: 'lightbox-titel' }, foto.ruimte_label || foto.categorie || 'Anders'),
      el('button', { onclick: () => overlay.remove() }, '✕'),
    ),
    el('div', { class: 'lightbox-beeld' }, el('img', { src: URL.createObjectURL(foto.blob) })),
    el('div', { class: 'lightbox-onder' },
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
    ),
  );
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
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

async function verwerkGekozenFoto(file, ruimteNaam) {
  if (!file) return;
  const categorie = ruimteNaam ? (bepaalQRCategorieVoorRuimte(ruimteNaam) || 'Anders') : 'Anders';
  const foto = {
    rapport_id: state.taxatie.rapport_id,
    blob: await verkleinFoto(file),
    ruimte_label: ruimteNaam || null,
    categorie,
    gemaaktOp: new Date().toISOString(),
    status: 'lokaal',
    archief: false,
  };
  const id = await VeldopnameDB.bewaarFoto(foto);
  foto.id = id;
  state.fotos.push(foto);
  await VeldopnameDB.voegWachtrijItemToe({ type: 'foto', fotoId: id });
  if (state.route.tab === 'fotos') render();
  verstuurFotoWachtrij();
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

function renderBewoningTab() {
  const t = state.taxatie;
  const wrap = el('div', {});

  const groepA = el('div', { class: 'macro-groep' });
  groepA.appendChild(el('h3', {}, 'A. Waar heb ik gezocht naar informatie?'));
  groepA.appendChild(renderJaNeeVraag('Bij de eigenaar of de bewoner', t, 'gezochtEigenaarBewoner', 'gezochtEigenaarBewonerToelichting'));
  groepA.appendChild(renderJaNeeVraag('Bij de verkopende makelaar', t, 'gezochtMakelaar', 'gezochtMakelaarToelichting'));
  groepA.appendChild(renderJaNeeVraag('Andere bronnen', t, 'gezochtAndereBronnen', 'gezochtAndereBronnenToelichting'));
  wrap.appendChild(groepA);

  const groepB = el('div', { class: 'macro-groep' });
  groepB.appendChild(renderJaNeeVraag('Ik heb de woning volledig kunnen inspecteren', t, 'volledigGeinspecteerd', null));
  wrap.appendChild(groepB);

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

// --- Bouwkundig (Fase 2 "volledige opname", J.4 Bouwkundige opnamestaat) ---
function conditieChips(bouwdeel) {
  const wrap = el('div', { class: 'conditie-chips' });
  CONDITIE_LABELS.forEach((label, waarde) => {
    wrap.appendChild(el('button', {
      class: 'klein' + (bouwdeel.conditie === waarde ? ' actief' : ''),
      onclick: () => { bouwdeel.conditie = waarde; planOpslaan(); render(); },
    }, label));
  });
  return wrap;
}
function renderBouwdeelKaart(sectieObj, def) {
  const bouwdeel = sectieObj[def.key];
  const sleutel = def.key;
  const ingeklapt = !bouwdeel.aanwezig; // niet-aanwezige bouwdelen tonen alleen de kop, zelfde als Taxatieweb
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  const kop = el('div', {
    class: 'bouwdeel-kop',
    onclick: () => { bouwdeel.aanwezig = !bouwdeel.aanwezig; planOpslaan(); render(); },
  },
    el('input', { type: 'checkbox', checked: bouwdeel.aanwezig ? 'checked' : null }),
    el('span', { class: 'bouwdeel-titel' }, def.label));
  kaart.appendChild(kop);
  if (ingeklapt) return kaart;

  if (def.type !== 'simpel') {
    kaart.appendChild(el('div', { class: 'bouwdeel-veld-label' }, 'Conditie: ' + CONDITIE_LABELS[bouwdeel.conditie]));
    kaart.appendChild(conditieChips(bouwdeel));
  }

  if (def.type === 'materiaal') {
    const grid = el('div', { class: 'bouwdeel-materiaal-grid' });
    def.opties.forEach(optie => {
      const aan = (bouwdeel.materialen || []).includes(optie);
      grid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
        el('input', {
          type: 'checkbox', checked: aan ? 'checked' : null,
          onchange: () => {
            bouwdeel.materialen = bouwdeel.materialen || [];
            const i = bouwdeel.materialen.indexOf(optie);
            if (i >= 0) bouwdeel.materialen.splice(i, 1); else bouwdeel.materialen.push(optie);
            planOpslaan(); render();
          },
        }), optie));
    });
    kaart.appendChild(grid);
  } else {
    const omschrijvingVeld = el('textarea', {
      class: 'bouwdeel-omschrijving', placeholder: 'Omschrijving ' + def.label.toLowerCase() + '…',
      oninput: (e) => { bouwdeel.omschrijving = e.target.value; planOpslaan(); },
    });
    omschrijvingVeld.value = bouwdeel.omschrijving || '';
    kaart.appendChild(omschrijvingVeld);
  }

  if (def.type !== 'simpel') {
    kaart.appendChild(el('div', { class: 'bouwdeel-veld-label' }, 'Aandachtspunten ' + def.label.toLowerCase() + '?'));
    const wissel = el('div', { class: 'weergave-wissel' });
    [[false, 'Nee'], [true, 'Ja']].forEach(([waarde, tekst]) => {
      wissel.appendChild(el('button', {
        class: 'klein' + (bouwdeel.aandachtspuntenAanwezig === waarde ? ' actief' : ''),
        onclick: () => { bouwdeel.aandachtspuntenAanwezig = waarde; planOpslaan(); render(); },
      }, tekst));
    });
    kaart.appendChild(wissel);
    if (bouwdeel.aandachtspuntenAanwezig === true) {
      const toelichting = el('textarea', {
        class: 'bouwdeel-omschrijving', placeholder: 'Toelichting aandachtspunt…',
        oninput: (e) => { bouwdeel.aandachtspuntenToelichting = e.target.value; planOpslaan(); },
      });
      toelichting.value = bouwdeel.aandachtspuntenToelichting || '';
      kaart.appendChild(toelichting);
    }
  }
  return kaart;
}
function renderBouwkundigTab() {
  const t = state.taxatie;
  const wrap = el('div', {});

  const hoofdtabs = el('div', { class: 'weergave-wissel bouwkundig-hoofdtabs' });
  [['buitenzijde', 'Buitenzijde'], ['binnenzijde', 'Binnenzijde (binnenkort)'], ['installaties', 'Installaties (binnenkort)']].forEach(([id, label]) => {
    hoofdtabs.appendChild(el('button', {
      class: 'klein' + (state.bouwkundigHoofdtab === id ? ' actief' : ''),
      disabled: id === 'buitenzijde' ? null : 'disabled',
      onclick: () => { state.bouwkundigHoofdtab = id; render(); },
    }, label));
  });
  wrap.appendChild(hoofdtabs);

  if (state.bouwkundigHoofdtab !== 'buitenzijde') {
    wrap.appendChild(el('p', { class: 'bouwkundig-nog-niet' }, 'Deze sectie is nog niet uitgewerkt in de Veldopname-app — komt in een volgende fase.'));
    return wrap;
  }

  const subtabs = el('div', { class: 'weergave-wissel bouwkundig-subtabs' });
  BUITENZIJDE_SUBTABS.forEach(sub => {
    subtabs.appendChild(el('button', {
      class: 'klein' + (state.bouwkundigSubtab === sub.id ? ' actief' : ''),
      onclick: () => { state.bouwkundigSubtab = sub.id; render(); },
    }, sub.label));
  });
  wrap.appendChild(subtabs);

  const sectieObj = t.bouwkundig.buitenzijde[state.bouwkundigSubtab];
  const defs = BOUWKUNDIG_SCHEMA.buitenzijde[state.bouwkundigSubtab];
  const lijst = el('div', { class: 'bouwdeel-lijst' });
  defs.forEach(def => lijst.appendChild(renderBouwdeelKaart(sectieObj, def)));
  wrap.appendChild(lijst);
  return wrap;
}

function renderAantekeningenTab() {
  const t = state.taxatie;
  const veld = el('textarea', {
    class: 'aantekeningen-veld', placeholder: 'Aantekeningen tijdens de opname…',
    oninput: (e) => { t.aantekeningen = e.target.value; planOpslaan(); },
  });
  veld.value = t.aantekeningen || '';
  return el('div', {}, veld);
}

// --- Macro's ---
const MACRO_GROEPEN = [
  { sleutel: 'verdiepingen', titel: 'Verdiepingen', uitleg: 'Suggesties bij de naam van een woonlaag (Indeling).' },
  { sleutel: 'ruimtes', titel: 'Ruimtes', uitleg: 'Suggesties bij de naam van een ruimte (Indeling).' },
  { sleutel: 'ruimteblokken', titel: 'Ruimteblokken', uitleg: 'Suggesties bij de naam van een meetblok (Meting).' },
  { sleutel: 'toevoegingen', titel: 'Toevoegingen (algemeen)', uitleg: 'Suggesties bij het toevoegen van een element — bij élke ruimte, naast de lijst hieronder indien van toepassing.' },
  { sleutel: 'sanitair', titel: 'Sanitair', uitleg: 'Extra suggesties bij een ruimte met "badkamer", "toilet" of "douche" in de naam.' },
  { sleutel: 'keuken', titel: 'Keuken', uitleg: 'Extra suggesties bij een ruimte met "keuken" in de naam.' },
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
