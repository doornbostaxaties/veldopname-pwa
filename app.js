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
const LIJST_WEBHOOK = 'https://hook.eu1.make.com/aft999v1fte9kf1oh6i8jnqkywm372xb'; // Veldopname PWA - Taxatielijst ophalen
// TODO: nog te bouwen Make-scenario (foto's opslaan in Airtable-tabel "Opname Foto's" incl.
// bestandsupload) — tot die tijd blijven foto's lokaal + in de wachtrij staan (nooit verloren,
// wel nog niet naar de cloud/Q/R).
const FOTO_WEBHOOK = null;

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
    data: leegData(),
    lokaalGewijzigd: false,
  };
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
// MACRO'S — Arno's eigen, over alle taxaties heen herbruikbare keuzelijsten. Bewust GLOBAAL
// (niet per taxatie) opgeslagen, zelfde opzet als taxatieweb-opname.user.js' standaardMacros() —
// hier bewust beperkt tot de drie lijsten die in déze app ook echt bij het toevoegen van
// elementen gebruikt worden (verdiepingen/ruimtes/toevoegingen bij Indeling, ruimteblokken bij
// Meting). Sanitair/keuken-subcategorieën van het origineel vallen in v1 onder "toevoegingen".
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
    toevoegingen: [
      'meterkast', 'vaste trap naar de eerste verdieping', 'HR combi-ketel', 'C.V.-ketel', 'boiler',
      'airconditioning', 'trapkast', 'kelderkast', 'inloopkast', 'hangend toilet', 'fonteintje',
      'douche', 'douchecabine', 'wastafelmeubel', '4-pits gaskookplaat', 'afzuigkap',
      'combimagnetron', 'koelkast', 'koel-vriescombinatie',
    ],
  };
}

// ----------------------------------------------------------------------------------------------
// STATE
// ----------------------------------------------------------------------------------------------
const state = {
  route: { naam: 'lijst' }, // { naam:'lijst' } | { naam:'opname', rapportId, tab }
  taxatie: null, // huidig geladen taxatie (zelfde vorm als leegTaxatie())
  fotos: [], // foto's van de huidige taxatie (uit IndexedDB), inclusief nog-niet-verzonden
  taxatielijst: [], // cache voor het homescherm
  online: navigator.onLine,
  wachtrijAantal: 0,
  macros: standaardMacros(), // wordt bij init() overschreven met de bewaarde versie, indien aanwezig
  afmetingenWeergave: 'tekening', // 'tekening' | 'lijst' — zelfde standaard als Taxatieweb sinds v0.17.0
};

async function laadMacros() {
  const bewaard = await VeldopnameDB.haalMacros();
  state.macros = bewaard || standaardMacros();
}
function bewaarMacros() {
  VeldopnameDB.bewaarMacros(state.macros);
}

// Koppelt een <datalist> met macro-suggesties aan een tekstinvoerveld, met de al gekozen waarden
// uitgesloten indien meegegeven (zelfde idee als koppelSuggesties() in taxatieweb-opname.user.js).
// Zonder uitgeslotenFn (bv. verdiepingen/ruimtes/ruimteblokken) delen alle velden dezelfde,
// statische lijst — daar volstaat één gedeelde <datalist> per macroSleutel. MET uitgeslotenFn
// (toevoegingen, verschilt per ruimte) krijgt elk veld zijn EIGEN datalist met een uniek ID, anders
// zou de laatst-getekende ruimte de uitsluitingslijst van alle andere ruimtes overschrijven.
let datalistTeller = 0;
function koppelDatalist(input, macroSleutel, uitgeslotenFn) {
  const lijstId = uitgeslotenFn ? 'dl-' + macroSleutel + '-' + (datalistTeller++) : 'dl-' + macroSleutel;
  input.setAttribute('list', lijstId);
  if (document.getElementById(lijstId)) { document.getElementById(lijstId).remove(); }
  const datalist = el('datalist', { id: lijstId });
  const uitgesloten = uitgeslotenFn ? uitgeslotenFn() : [];
  (state.macros[macroSleutel] || []).filter(t => !uitgesloten.includes(t)).forEach(t => {
    datalist.appendChild(el('option', { value: t }));
  });
  document.body.appendChild(datalist);
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
    adres: taxatie.adres, straat: taxatie.adres, postcode: taxatie.postcode, plaats: taxatie.plaats,
    wonen_totaal_m2: totalen.wonen, overig_inpandig_totaal_m2: totalen.overig,
    buitenruimte_totaal_m2: totalen.buiten, externe_bergruimte_totaal_m2: totalen.extern,
    aantal_woonlagen: totalen.aantalWoonlagen,
    indeling_tekst: componeerIndelingTekst(taxatie.data.indeling),
    data: JSON.stringify(taxatie.data),
    vergelijker_data: '{}',
  };
  const resp = await fetch(CLOUD_WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error('Opslaan mislukt (' + resp.status + ')');
}

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
  }, 1200);
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

window.addEventListener('online', () => { state.online = true; verwerkWachtrij(); werkStatusbalkBij(); });
window.addEventListener('offline', () => { state.online = false; werkStatusbalkBij(); });

// ----------------------------------------------------------------------------------------------
// ROUTER
// ----------------------------------------------------------------------------------------------
function navigeer(route) {
  state.route = route;
  render();
}
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#\/opname\/([^/]+)\/([a-z]+)$/);
  if (m) laadOpname(decodeURIComponent(m[1]), m[2]);
  else navigeer({ naam: 'lijst' });
});

async function laadOpname(rapportId, tab) {
  render(); // toon meteen laadscherm
  let lokaal = await VeldopnameDB.haalTaxatie(rapportId);
  if (!lokaal) lokaal = leegTaxatie(rapportId);
  state.taxatie = lokaal;
  state.fotos = await VeldopnameDB.fotosVoorTaxatie(rapportId);
  navigeer({ naam: 'opname', rapportId, tab: tab || 'meting' });

  // Op de achtergrond: cloud-versie ophalen en overnemen als die recenter/aanwezig is (net als
  // taxatieweb-opname.user.js bij het laden doet) — alleen als er lokaal nog geen wijziging in de
  // wachtrij staat, anders zouden we eigen niet-verzonden werk overschrijven.
  if (state.online && !lokaal.lokaalGewijzigd) {
    try {
      const { data } = await cloudOphalen(rapportId);
      // Let op: `data` komt al als object terug (de Make-respons splitst 'm rechtstreeks in de
      // JSON-body, {"data":{{...}}} zonder quotes) — GEEN JSON.parse() erover heen, dat gaf
      // hier "[object Object] is not valid JSON". Vergelijk taxatieweb-opname.user.js, waar
      // cloudData ook rechtstreeks als object gebruikt wordt.
      if (data && typeof data === 'object') {
        state.taxatie.data = data;
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

function render() {
  app.innerHTML = '';
  // Ruim per-ruimte datalists van de vorige render op (zie koppelDatalist) — anders stapelen die
  // ongebruikt op in document.body bij elke toetsaanslag.
  document.querySelectorAll('datalist[id^="dl-"]').forEach(d => d.remove());
  datalistTeller = 0;
  if (state.route.naam === 'lijst') { app.appendChild(renderLijstScherm()); return; }
  if (!state.taxatie) { app.appendChild(renderLaadscherm()); return; }
  app.appendChild(renderOpnameScherm());
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
async function laadTaxatielijst() {
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
    })).filter(t => t.rapport_id);
  } catch (e) {
    // geen verbinding: laat zien wat we nog in IndexedDB hebben staan (lokaal geopende taxaties)
    const lokaal = await VeldopnameDB.alleTaxaties();
    state.taxatielijst = lokaal.map(t => ({ rapport_id: t.rapport_id, adres: t.adres, plaats: t.plaats, afspraak_datumtijd: t.afspraak_datumtijd }));
  }
  if (state.route.naam === 'lijst') render();
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
  const inhoud = el('div', { class: 'inhoud' }, el('div', { class: 'section-label' }, 'Taxaties'));
  wrap.appendChild(inhoud);

  if (state.taxatielijst.length === 0) {
    inhoud.appendChild(el('div', { class: 'lege-lijst' }, 'Nog geen taxaties gevonden. Trek naar beneden om te vernieuwen zodra er verbinding is.'));
  } else {
    state.taxatielijst.forEach(t => {
      inhoud.appendChild(el('div', {
        class: 'taxatie-kaart',
        onclick: () => { location.hash = '#/opname/' + encodeURIComponent(t.rapport_id) + '/meting'; },
      },
        el('div', { class: 'adres' }, t.adres || '(adres onbekend)'),
        el('div', { class: 'plaats' }, t.plaats || ''),
        el('div', { class: 'meta' }, el('span', { class: 'afspraak' }, formatAfspraak(t.afspraak_datumtijd))),
      ));
    });
  }
  laadTaxatielijst();
  return wrap;
}

// ----------------------------------------------------------------------------------------------
// SCHERM: Opname (Meting / Indeling / Foto's / Aantekeningen)
// ----------------------------------------------------------------------------------------------
const TABS = [
  { id: 'meting', icon: '📐', label: 'Meting' },
  { id: 'indeling', icon: '🏠', label: 'Indeling' },
  { id: 'fotos', icon: '📷', label: "Foto's" },
  { id: 'aantekeningen', icon: '📝', label: 'Notities' },
  { id: 'macros', icon: '⚙️', label: "Macro's" },
];

function renderOpnameScherm() {
  const t = state.taxatie;
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'statusbalk' },
    el('button', { class: 'terug', onclick: () => { location.hash = ''; } }, '‹'),
    el('h1', {}, t.adres || t.rapport_id),
    el('span', { class: 'sync-pil ' + syncPilTekst().klasse }, syncPilTekst().tekst),
  ));

  const inhoud = el('div', { class: 'inhoud' });
  if (state.route.tab === 'meting') inhoud.appendChild(renderMetingTab());
  else if (state.route.tab === 'indeling') inhoud.appendChild(renderIndelingTab());
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
  const invoer = el('input', { placeholder: 'Toevoeging (bv. "meterkast")' });
  koppelDatalist(invoer, 'toevoegingen', () => ruimte.toevoegingen || []);
  invoer.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !invoer.value.trim()) return;
    if (!Array.isArray(ruimte.toevoegingen)) ruimte.toevoegingen = [];
    ruimte.toevoegingen.push(invoer.value.trim());
    planOpslaan(); render();
  });
  kaart.appendChild(el('div', { class: 'chip-toevoegen' }, invoer));

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

async function verwerkGekozenFoto(file, ruimteNaam) {
  if (!file) return;
  const categorie = ruimteNaam ? (bepaalQRCategorieVoorRuimte(ruimteNaam) || 'Anders') : 'Anders';
  const foto = {
    rapport_id: state.taxatie.rapport_id,
    blob: file,
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

async function verstuurFotoWachtrij() {
  if (!FOTO_WEBHOOK || !state.online) return; // nog geen Make-scenario gebouwd — blijft lokaal/wachtend staan
  // (volgt zodra de foto-upload-scenario bestaat: item per item versturen, status bijwerken naar 'verzonden')
}

// --- Aantekeningen ---
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
  { sleutel: 'toevoegingen', titel: 'Toevoegingen', uitleg: 'Suggesties bij het toevoegen van een element aan een ruimte (Indeling).' },
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
  else render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
