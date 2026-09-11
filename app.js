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
// 'C.V.-ketel' toegevoegd op Arno's verzoek (12-09-2026): Verwarmingstoestel is net als Meterkast
// een verplichte foto — de bouwkundig-tab-fotoknop bij dat bouwdeel gebruikt dezelfde categorienaam,
// zodat die éne foto ook meteen deze checklist-regel afvinkt (zie ook FOTO_CATEGORIE_PER_BOUWDEEL).
const VASTE_VERPLICHTE_FOTOS = [
  'Vooraanzicht', 'Straatbeeld', 'Achtergevel', 'Tuin', 'Badkamer', 'Keuken', 'Woonkamer',
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
    energetisch: leegEnergetisch(),
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
    woningtype: '', bouwjaar: '',
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
  return bk;
}
const CONDITIE_LABELS = ['niet waarneembaar', 'nader onderzoek nodig', 'slecht', 'matig', 'redelijk', 'goed'];
const BOUWKUNDIG_SCHEMA = {
  buitenzijde: {
    daken: [
      { key: 'dakconstructie', label: 'Dakconstructie', type: 'tekst', standaardAan: true },
      { key: 'materiaalDak', label: 'Materiaal dak', type: 'materiaal', opties: ['Pannen', 'Leien', 'Riet', 'Bitumineus', 'EPDM', 'Sedum', 'Overige'], standaardAan: true },
      { key: 'dakkapellen', label: 'Dakkapel(len)', type: 'tekst' },
      { key: 'schoorstenen', label: 'Schoorste(e)n(en)', type: 'tekst' },
      { key: 'goten', label: 'Goten (incl. hemelwaterafvoeren)', type: 'tekst' },
      { key: 'loodwerk', label: 'Loodwerk', type: 'tekst' },
    ],
    gevel: [
      { key: 'gevelwerk', label: 'Gevelwerk', type: 'materiaal', opties: ['Metselwerk', 'Gevelbetimmering', 'Gevelcement', 'Stucwerk', 'Composiet', 'Overige'], standaardAan: true },
      { key: 'balkon', label: 'Balkon', type: 'tekst' },
      { key: 'kozijnen', label: 'Kozijnen', type: 'tekst', standaardAan: true },
      { key: 'buitendeuren', label: 'Buitendeuren', type: 'tekst', standaardAan: true },
      { key: 'hangEnSluitwerk', label: 'Hang- en sluitwerk', type: 'tekst', standaardAan: true },
      { key: 'buitenschilderwerk', label: 'Buitenschilderwerk', type: 'tekst', standaardAan: true },
      { key: 'glas1eWoonlaag', label: 'Glas 1e woonlaag', type: 'tekst', standaardAan: true },
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
  binnenzijde: {
    funderingen: [
      { key: 'fundering', label: 'Fundering', type: 'materiaal', opties: ['Fundering op staal', 'Fundering op houten palen', 'Fundering op vloerplaat', 'Strokenfundering', 'Fundering op betonnen palen', 'Overige'] },
      { key: 'kelder', label: 'Kelder', type: 'tekst' },
      { key: 'kruipruimte', label: 'Kruipruimte', type: 'tekst' },
    ],
    vloeren: [
      { key: 'woonlaag1', label: 'Woonlaag 1', type: 'materiaal', opties: ['Beton', 'Hout', 'Kwaaitaal', 'Manta', 'Overige'] },
      { key: 'woonlaag2', label: 'Woonlaag 2', type: 'materiaal', opties: ['Beton', 'Hout', 'Kwaaitaal', 'Manta', 'Overige'] },
      { key: 'woonlaag3', label: 'Woonlaag 3', type: 'materiaal', opties: ['Beton', 'Hout', 'Kwaaitaal', 'Manta', 'Overige'] },
      { key: 'woonlaagOverige', label: 'Woonlaag overige', type: 'materiaal', opties: ['Beton', 'Hout', 'Kwaaitaal', 'Manta', 'Overige'] },
    ],
    wanden: [
      { key: 'wandenEnBinnenmuren', label: 'Wanden en binnenmuren', type: 'tekst', standaardAan: true },
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
      { key: 'verwarmingstoestel', label: 'Verwarmingstoestel', type: 'materiaal', opties: ['Airconditioning', 'Blokverwarming', 'Centrale verwarming', 'CV-ketel', 'Gaskachels', 'Hybride warmtepomp', 'Lucht/lucht warmtepomp', 'Micro WKK(HRe-ketel)', 'Open haard/houtkachel', 'Stadsverwarming', 'Biomassaketel', 'Bodem/water warmtepomp', 'Collectieve warmtepomp', 'Elektrische verwarming', 'HR combi ketel', 'Infrarood', 'Lucht/water warmtepomp', 'Moederhaard', 'Pelletkachel', 'Water/water warmtepomp(WKO)', 'Overige'], details: [{ key: 'bouwjaar', label: 'Bouwjaar', type: 'jaar' }, { key: 'eigendom', label: 'Eigendom', type: 'select', opties: ['Anders', 'Eigendom', 'Huur', 'Lease'] }], standaardAan: true, verplichteFoto: true, fotoCategorie: 'C.V.-ketel' },
      { key: 'verwarmingssysteem1eWoonlaag', label: 'Verwarmingssysteem 1e woonlaag', type: 'materiaal', opties: ['Radiatoren', 'Convectoren', 'Elektrische vloerverwarming', 'Infraroodpanelen', 'Vloerverwarming', 'Wandverwarming', 'Overige'] },
      { key: 'verwarmingssysteem2eEnVolgendeWoonlaag', label: 'Verwarmingssysteem 2e en volgende woonlaag', type: 'materiaal', opties: ['Radiatoren', 'Convectoren', 'Elektrische vloerverwarming', 'Infraroodpanelen', 'Vloerverwarming', 'Wandverwarming', 'Overige'] },
    ],
    warmwater: [
      { key: 'warmwatertoestel', label: 'Warmwatertoestel', type: 'materiaal', opties: ['Geiser', 'Boiler', 'Geïntegreerd in cv', 'Doorstroom (stadsverwarming)', 'Kokendwaterkraan', 'Zonneboiler', 'Overige'], details: [{ key: 'bouwjaar', label: 'Bouwjaar', type: 'jaar' }, { key: 'eigendom', label: 'Eigendom', type: 'select', opties: ['Anders', 'Eigendom', 'Huur', 'Lease'] }], standaardAan: true },
    ],
    ventilatieKoeling: [
      { key: 'ventilatie', label: 'Ventilatie', type: 'materiaal', opties: ['Natuurlijk', 'Mechanisch', 'Gebalanceerd', 'Decentraal mechanisch', 'Vraaggestuurd', 'Overige'], standaardAan: true },
      { key: 'koeling', label: 'Koeling', type: 'materiaal', opties: ['Airconditioning', 'Radiatoren', 'Vloerverwarming', 'Ventilatie', 'Overige'] },
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
    ramen: [
      { key: 'glas1e', label: 'Glas 1e woonlaag', type: 'materiaalTijd', opties: GLAS_OPTIES },
      { key: 'glas2e', label: 'Glas 2e woonlaag', type: 'materiaalTijd', opties: GLAS_OPTIES },
      { key: 'glas3e', label: 'Glas 3e woonlaag', type: 'materiaalTijd', opties: GLAS_OPTIES },
      { key: 'glasOverige', label: 'Glas overige woonlagen', type: 'materiaalTijd', opties: GLAS_OPTIES },
    ],
    overige: [
      { key: 'leidingisolatie', label: 'Leidingisolatie', type: 'isolatie' },
      { key: 'energiezuinigeKozijnen', label: 'Energiezuinige kozijnen, deuren en daarmee gelijk te stellen constructieonderdelen in combinatie met hoog rendement beglazing (tenminste HR++)', type: 'simpel' },
    ],
  },
  installaties: {
    verwarming: [
      { key: 'verwarmingstoestel', label: 'Verwarmingstoestel', type: 'materiaalTijd', opties: ['Airconditioning', 'Biomassaketel', 'Blokverwarming', 'Bodem/water warmtepomp', 'Centrale verwarming', 'Collectieve warmtepomp', 'CV-ketel', 'Elektrische verwarming', 'Gaskachels', 'HR combi ketel', 'Hybride warmtepomp', 'Infrarood', 'Lucht/lucht warmtepomp', 'Lucht/water warmtepomp', 'Micro WKK(HRe-ketel)', 'Moederhaard', 'Open haard/houtkachel', 'Pelletkachel', 'Stadsverwarming', 'Water/water warmtepomp(WKO)', 'Overige'] },
      { key: 'verwarmingssysteem1e', label: 'Verwarmingssysteem 1e woonlaag', type: 'materiaalTijd', opties: ['Radiatoren', 'Convectoren', 'Vloerverwarming', 'Elektrische vloerverwarming', 'Wandverwarming', 'Infraroodpanelen', 'Overige'] },
      { key: 'verwarmingssysteem2e', label: 'Verwarmingssysteem 2e en volgende woonlaag', type: 'materiaalTijd', opties: ['Radiatoren', 'Convectoren', 'Vloerverwarming', 'Elektrische vloerverwarming', 'Wandverwarming', 'Infraroodpanelen', 'Overige'] },
    ],
    warmWater: [
      { key: 'warmwatertoestel', label: 'Warmwater toestel', type: 'materiaalTijd', opties: ['Geiser', 'Boiler', 'Geïntegreerd in cv', 'Doorstroom (stadsverwarming)', 'Zonneboiler', 'Kokend waterkraan', 'Overige'] },
      { key: 'doucheWtw', label: 'Douche-warmteterugwinningssysteem', type: 'simpel' },
      { key: 'zonneboilerInstallatie', label: 'Zonneboiler', type: 'simpel' },
    ],
    ventilatieKoeling: [
      { key: 'ventilatie', label: 'Ventilatie', type: 'materiaalTijd', opties: ['Natuurlijk', 'Mechanisch', 'Gebalanceerd', 'Decentraal mechanisch', 'Vraaggestuurd', 'Overige'] },
      { key: 'koeling', label: 'Koeling', type: 'materiaalTijd', opties: ['Airconditioning', 'Vloerverwarming', 'Radiatoren', 'Ventilatie', 'Overige'] },
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

function leegIsolatieVeld() { return { aanwezig: false, gedeeltelijk: null, installatiemoment: '', jaar: '', opmerkingen: '' }; }
function leegDakVeld() { return { aanwezig: false, geisoleerd: null, gedeeltelijk: null, installatiemoment: '', jaar: '', opmerkingen: '' }; }
function leegMateriaalTijdVeld() { return { aanwezig: false, materialen: [], overigeTekst: '', installatiemoment: '', jaar: '', opmerkingen: '' }; }
function leegEnergetischSimpelVeld() { return { aanwezig: false, opmerkingen: '' }; }
// orientaties is een lijst (Taxatieweb toont dit als checkbox-multiselect, geen keuzelijst — live
// geverifieerd 13-09-2026: een dak/installatie kan op meerdere windrichtingen tegelijk liggen).
function leegZonnepanelenVeld() { return { aanwezig: false, metenType: '', aantal: '', orientaties: [], eigendom: '', installatiemoment: '', jaar: '', opmerkingen: '' }; }
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
    algemeen: { bron: [], bouwtype: [] },
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
  bouwkundigHoofdtab: 'buitenzijde', // 'buitenzijde' | 'binnenzijde' | 'installaties' | 'overigeBijzonderheden'
  bouwkundigSubtab: 'daken', // zie BOUWKUNDIG_SUBTABS[hoofdtab]
  instellingenMenuOpen: false,
  energetischHoofdtab: 'algemeen', // 'algemeen' | 'isolatie' | 'installaties' | 'energieopwekking'
  energetischSubtab: 'gevel', // zie ENERGETISCH_SUBTABS[hoofdtab]
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
    energetisch_data: JSON.stringify(taxatie.energetisch || leegEnergetisch()),
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
  lokaal.bouwkundig = metVolledigBouwkundig(lokaal.bouwkundig); // taxaties van vóór Fase 2 "volledige opname"
  lokaal.energetisch = metVolledigEnergetisch(lokaal.energetisch); // taxaties van vóór Fase 3 "volledige opname"
  state.taxatie = lokaal;
  state.fotos = await VeldopnameDB.fotosVoorTaxatie(rapportId);
  navigeer({ naam: 'opname', rapportId, tab: tab || 'meting' });

  // Op de achtergrond: cloud-versie ophalen en overnemen als die recenter/aanwezig is (net als
  // taxatieweb-opname.user.js bij het laden doet) — alleen als er lokaal nog geen wijziging in de
  // wachtrij staat, anders zouden we eigen niet-verzonden werk overschrijven.
  if (state.online && !lokaal.lokaalGewijzigd) {
    try {
      const { data, bewoning_data, bouwkundig_data, energetisch_data, aantekeningen } = await cloudOphalen(rapportId);
      // Let op: `data` (en sinds Fase 1/2 "volledige opname" ook bewoning_data/bouwkundig_data) komt
      // al als object terug (de Make-respons splitst 'm rechtstreeks in de JSON-body,
      // {"data":{{...}}} zonder quotes) — GEEN JSON.parse() erover heen, dat gaf hier "[object
      // Object] is not valid JSON". Vergelijk taxatieweb-opname.user.js, waar cloudData ook
      // rechtstreeks als object gebruikt wordt.
      let gewijzigd = false;
      if (data && typeof data === 'object') { state.taxatie.data = data; gewijzigd = true; }
      if (bewoning_data && typeof bewoning_data === 'object') {
        if (bewoning_data.woningtype === undefined) bewoning_data.woningtype = '';
        if (bewoning_data.bouwjaar === undefined) bewoning_data.bouwjaar = '';
        state.taxatie.bewoning = bewoning_data; gewijzigd = true;
      }
      if (bouwkundig_data && typeof bouwkundig_data === 'object') { state.taxatie.bouwkundig = metVolledigBouwkundig(bouwkundig_data); gewijzigd = true; }
      if (energetisch_data && typeof energetisch_data === 'object') { state.taxatie.energetisch = metVolledigEnergetisch(energetisch_data); gewijzigd = true; }
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
// Volgorde op Arno's verzoek (12-09-2026): Onderzoek helemaal rechts (was vooraan — dat blijkt in de
// praktijk niet de tab waarmee de opname begint); Macro's is GEEN eigen tabblad meer, verhuisd naar
// het Instellingen-menu rechtsboven (zie renderOpnameScherm/renderInstellingenMenu).
const TABS = [
  { id: 'objectkenmerken', icon: '🔑', label: 'Objectkenmerken' },
  { id: 'meting', icon: '📐', label: 'Meting' },
  { id: 'indeling', icon: '🏠', label: 'Indeling' },
  { id: 'bouwkundig', icon: '🧱', label: 'Bouwkundig' },
  { id: 'energetisch', icon: '♻️', label: 'Energetisch' },
  { id: 'fotos', icon: '📷', label: "Foto's" },
  { id: 'aantekeningen', icon: '📝', label: 'Notities' },
  { id: 'onderzoek', icon: '🔍', label: 'Onderzoek' },
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
function renderFotoKnopRij(label, categorie, verplicht) {
  const fotos = fotosVoorLabel(label);
  const rij = el('div', { class: 'bouwdeel-foto-rij' });
  fotos.forEach(f => {
    rij.appendChild(el('button', {
      type: 'button', class: 'bouwdeel-foto-mini', onclick: () => openLightbox(f),
    }, el('img', { src: URL.createObjectURL(f.blob) })));
  });
  rij.appendChild(el('label', { class: 'bouwdeel-foto-knop' + (fotos.length ? '' : verplicht ? ' verplicht' : '') },
    fotos.length ? '📷 Nog een foto' : (verplicht ? '📷 Foto verplicht' : '📷 Foto toevoegen'),
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

  const groepKenmerken = el('div', { class: 'macro-groep' });
  groepKenmerken.appendChild(el('h3', {}, 'Objectkenmerken'));
  const kenmerkenRij = el('div', { class: 'objectkenmerken-rij' });
  // Beide velden zijn keuzelijsten i.p.v. vrije tekst/getal sinds 13-09-2026 (Arno: "Woningtype lijst
  // overnemen" + "Bouwjaar met keuzelijst"), exact de opties van Taxatieweb's C. Object/eigen
  // bouwjaar-aanpak — een auto-ingevulde waarde die niet exact matcht (bv. rechtstreeks uit Funda)
  // toont dan gewoon "Selecteer", de taxateur kiest zelf de juiste.
  const woningtypeVeld = el('select', {
    onchange: (e) => { t.bewoning.woningtype = e.target.value; planOpslaan(); },
  },
    el('option', { value: '' }, 'Selecteer'),
    ...WONINGTYPE_OPTIES.map(o => el('option', { value: o, selected: t.bewoning.woningtype === o ? 'selected' : null }, o)));
  const bouwjaarVeld = renderJaarSelect(t.bewoning.bouwjaar, (w) => { t.bewoning.bouwjaar = w; planOpslaan(); });
  kenmerkenRij.appendChild(el('label', { class: 'objectkenmerken-veld' }, 'Woningtype', woningtypeVeld));
  kenmerkenRij.appendChild(el('label', { class: 'objectkenmerken-veld' }, 'Bouwjaar', bouwjaarVeld));
  groepKenmerken.appendChild(kenmerkenRij);
  wrap.appendChild(groepKenmerken);

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
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  const kop = el('div', {
    class: 'bouwdeel-kop',
    onclick: () => { bouwdeel.aanwezig = !bouwdeel.aanwezig; planOpslaan(); render(); },
  },
    el('input', { type: 'checkbox', checked: bouwdeel.aanwezig ? 'checked' : null }),
    el('span', { class: 'bouwdeel-titel' }, def.label));
  kaart.appendChild(kop);
  if (!bouwdeel.aanwezig) return kaart;

  kaart.appendChild(jaNeeMetToelichtingRij(
    'Risico', bouwdeel.risico, (w) => { bouwdeel.risico = w; planOpslaan(); },
    bouwdeel.omschrijving, (v) => { bouwdeel.omschrijving = v; planOpslaan(); },
    'Omschrijving ' + def.label.toLowerCase() + '…',
  ));
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
      renderJaarSelect(waarde, (w) => { bouwdeel.details[d.key] = w; planOpslaan(); }, 'bouwdeel-detail-select'));
  }
  // 'getal'
  const input = el('input', {
    type: 'number', placeholder: '0',
    oninput: (e) => { bouwdeel.details[d.key] = e.target.value; planOpslaan(); },
  });
  input.value = waarde || '';
  return el('label', { class: 'bouwdeel-detail-veld' }, d.label, input);
}
function renderBouwdeelKaart(sectieObj, def) {
  const bouwdeel = sectieObj[def.key];
  if (def.type === 'risico') return renderRisicoBouwdeelKaart(bouwdeel, def);
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

  if (def.type !== 'simpel') kaart.appendChild(conditieRij(bouwdeel));

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
    // "Overige" toont net als in Taxatieweb een vrij tekstveld ernaast (Arno's verzoek 12-09-2026).
    if ((bouwdeel.materialen || []).includes('Overige')) {
      const overigeVeld = el('input', {
        type: 'text', class: 'bouwdeel-overige-tekst', placeholder: 'Namelijk…',
        oninput: (e) => { bouwdeel.overigeTekst = e.target.value; planOpslaan(); },
      });
      overigeVeld.value = bouwdeel.overigeTekst || '';
      kaart.appendChild(overigeVeld);
    }
  } else {
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

  // Meterkast/Verwarmingstoestel zijn altijd een verplichte foto (Arno's verzoek 12-09-2026,
  // zelfde categorienaam als de bestaande Foto's-tab-checklist, zie VASTE_VERPLICHTE_FOTOS). Bij
  // een slechte of matige conditie is DAARNAAST altijd een foto verplicht, apart bewaard onder
  // "Aandachtspunt <bouwdeel>" — ook als dit bouwdeel zelf al een verplichte foto heeft.
  if (def.verplichteFoto) kaart.appendChild(renderFotoKnopRij(def.label, def.fotoCategorie, true));
  const slechteConditie = bouwdeel.conditie === 2 || bouwdeel.conditie === 3; // slecht/matig
  if (def.type !== 'simpel' && slechteConditie) {
    kaart.appendChild(renderFotoKnopRij('Aandachtspunt ' + def.label, 'Aandachtspunt ' + def.label, true));
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
function renderJaNeeToggle(labelText, huidigeWaarde, onChange) {
  const wissel = el('div', { class: 'weergave-wissel' });
  [[false, 'Nee'], [true, 'Ja']].forEach(([waarde, tekst]) => {
    wissel.appendChild(el('button', {
      class: 'klein' + (huidigeWaarde === waarde ? ' actief' : ''),
      onclick: () => { onChange(waarde); planOpslaan(); render(); },
    }, tekst));
  });
  return el('div', { class: 'bouwdeel-conditie-rij' }, el('span', { class: 'energetisch-veld-label' }, labelText), wissel);
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
function renderInstallatiemomentEnOpmerkingen(veld) {
  const wrap = el('div', {});
  const rij = el('div', { class: 'bouwdeel-details-grid' });
  rij.appendChild(renderSelectVeld('Installatiemoment', veld.installatiemoment, INSTALLATIEMOMENT_OPTIES, (w) => { veld.installatiemoment = w; }));
  // Bouwjaar-veld naast Installatiemoment, alleen zichtbaar bij Bouwjaar/Installatiejaar (Arno's
  // verzoek 13-09-2026: "past er prima naast").
  if (veld.installatiemoment === 'Bouwjaar' || veld.installatiemoment === 'Installatiejaar') {
    rij.appendChild(el('label', { class: 'bouwdeel-detail-veld' },
      el('span', { class: 'energetisch-veld-label' }, veld.installatiemoment),
      renderJaarSelect(veld.jaar, (w) => { veld.jaar = w; planOpslaan(); })));
  }
  wrap.appendChild(rij);
  const opmerkingen = el('textarea', {
    class: 'bouwdeel-omschrijving', placeholder: 'Opmerkingen…',
    oninput: (e) => { veld.opmerkingen = e.target.value; planOpslaan(); },
  });
  opmerkingen.value = veld.opmerkingen || '';
  wrap.appendChild(opmerkingen);
  return wrap;
}
function renderEnergetischKop(veld, def) {
  return el('div', {
    class: 'bouwdeel-kop',
    onclick: () => { veld.aanwezig = !veld.aanwezig; planOpslaan(); render(); },
  },
    el('input', { type: 'checkbox', checked: veld.aanwezig ? 'checked' : null }),
    el('span', { class: 'bouwdeel-titel' }, def.label));
}
function renderIsolatieKaart(veld, def) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderEnergetischKop(veld, def));
  if (!veld.aanwezig) return kaart;
  kaart.appendChild(renderJaNeeToggle('Gedeeltelijk', veld.gedeeltelijk, (w) => { veld.gedeeltelijk = w; }));
  kaart.appendChild(renderInstallatiemomentEnOpmerkingen(veld));
  return kaart;
}
function renderDakKaart(veld, def) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderEnergetischKop(veld, def));
  if (!veld.aanwezig) return kaart;
  kaart.appendChild(renderJaNeeToggle('Geïsoleerd', veld.geisoleerd, (w) => { veld.geisoleerd = w; }));
  kaart.appendChild(renderJaNeeToggle('Gedeeltelijk', veld.gedeeltelijk, (w) => { veld.gedeeltelijk = w; }));
  kaart.appendChild(renderInstallatiemomentEnOpmerkingen(veld));
  return kaart;
}
function renderMateriaalTijdKaart(veld, def) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderEnergetischKop(veld, def));
  if (!veld.aanwezig) return kaart;
  const grid = el('div', { class: 'bouwdeel-materiaal-grid' });
  def.opties.forEach(optie => {
    const aan = (veld.materialen || []).includes(optie);
    grid.appendChild(el('label', { class: 'bouwdeel-materiaal-optie' },
      el('input', {
        type: 'checkbox', checked: aan ? 'checked' : null,
        onchange: () => {
          veld.materialen = veld.materialen || [];
          const i = veld.materialen.indexOf(optie);
          if (i >= 0) veld.materialen.splice(i, 1); else veld.materialen.push(optie);
          planOpslaan(); render();
        },
      }), optie));
  });
  kaart.appendChild(grid);
  if ((veld.materialen || []).includes('Overige')) {
    const overigeVeld = el('input', {
      type: 'text', class: 'bouwdeel-overige-tekst', placeholder: 'Namelijk…',
      oninput: (e) => { veld.overigeTekst = e.target.value; planOpslaan(); },
    });
    overigeVeld.value = veld.overigeTekst || '';
    kaart.appendChild(overigeVeld);
  }
  kaart.appendChild(renderInstallatiemomentEnOpmerkingen(veld));
  return kaart;
}
function renderEnergetischSimpelKaart(veld, def) {
  const kaart = el('div', { class: 'bouwdeel-kaart' });
  kaart.appendChild(renderEnergetischKop(veld, def));
  if (!veld.aanwezig) return kaart;
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
  kaart.appendChild(renderEnergetischKop(veld, def));
  if (!veld.aanwezig) return kaart;
  // "Omschrijving zonnepanelen": Taxatieweb laat je kiezen of je Wattpiek of aantal panelen invult
  // (Arno's verzoek 13-09-2026), i.p.v. altijd een kaal getalveld "Aantal".
  kaart.appendChild(renderSelectVeld('Omschrijving zonnepanelen', veld.metenType, ENERGETISCH_METEN_TYPE_OPTIES, (w) => { veld.metenType = w; }));
  const aantalInput = el('input', {
    type: 'number', placeholder: '0',
    oninput: (e) => { veld.aantal = e.target.value; planOpslaan(); },
  });
  aantalInput.value = veld.aantal || '';
  kaart.appendChild(el('label', { class: 'bouwdeel-detail-veld' }, veld.metenType || 'Aantal Wattpiek of aantal panelen', aantalInput));
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
  kaart.appendChild(el('span', { class: 'energetisch-veld-label' }, 'Oriëntatie'));
  kaart.appendChild(orientatieGrid);
  kaart.appendChild(renderSelectVeld('Eigendom', veld.eigendom, ENERGETISCH_EIGENDOM_OPTIES, (w) => { veld.eigendom = w; }));
  kaart.appendChild(renderInstallatiemomentEnOpmerkingen(veld));
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
function renderEnergetischAlgemeen() {
  const t = state.taxatie;
  const alg = t.energetisch.algemeen;
  const wrap = el('div', {});
  wrap.appendChild(renderMultiselectGroep('Bron van de informatie', ENERGETISCH_BRON_OPTIES, alg.bron, (optie) => {
    const i = alg.bron.indexOf(optie);
    if (i >= 0) alg.bron.splice(i, 1); else alg.bron.push(optie);
  }));
  wrap.appendChild(renderMultiselectGroep('Bouwtype', ENERGETISCH_BOUWTYPE_OPTIES, alg.bouwtype, (optie) => {
    const i = alg.bouwtype.indexOf(optie);
    if (i >= 0) alg.bouwtype.splice(i, 1); else alg.bouwtype.push(optie);
  }));
  return wrap;
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
