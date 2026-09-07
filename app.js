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
  return { naam: '', type: 'wonen', lengte: '', breedte: '' };
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
// STATE
// ----------------------------------------------------------------------------------------------
const state = {
  route: { naam: 'lijst' }, // { naam:'lijst' } | { naam:'opname', rapportId, tab }
  taxatie: null, // huidig geladen taxatie (zelfde vorm als leegTaxatie())
  fotos: [], // foto's van de huidige taxatie (uit IndexedDB), inclusief nog-niet-verzonden
  taxatielijst: [], // cache voor het homescherm
  online: navigator.onLine,
  wachtrijAantal: 0,
};

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
    el('h1', {}, el('span', { class: 'letter' }, 'D&H'), ' Veldopname'),
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
function renderMetingTab() {
  const t = state.taxatie;
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'section-label' }, 'Woonlagen'));
  t.data.afmetingen.woonlagen.forEach((woonlaag, wIdx) => {
    const kaart = el('div', { class: 'woonlaag-kaart' });
    kaart.appendChild(el('div', { class: 'woonlaag-titel' },
      el('input', {
        value: woonlaag.naam || `${wIdx + 1}e woonlaag`, placeholder: `${wIdx + 1}e woonlaag`,
        oninput: (e) => { woonlaag.naam = e.target.value; planOpslaan(); },
      }),
      el('span', { class: 'totaal' }, formatM2(woonlaagTotaal(woonlaag)) + ' m²'),
    ));
    (woonlaag.blokken || []).forEach((blok, bIdx) => {
      const rij = el('div', { class: 'blok-rij' },
        el('input', { value: blok.naam || '', placeholder: 'Basis', oninput: (e) => { blok.naam = e.target.value; planOpslaan(); } }),
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
  kaart.appendChild(el('div', { class: 'ruimte-rij-boven' },
    el('input', {
      value: ruimte.naam || '', placeholder: 'Ruimte (bv. "Woonkamer")',
      oninput: (e) => { ruimte.naam = e.target.value; planOpslaan(); },
    }),
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
  const gemaakt = state.fotos.map(f => f.categorie + '::' + (f.instantie || 0));
  return items.map((item, i) => ({ ...item, klaar: gemaakt.includes((item.categorie) + '::' + (item.instantie || 0)) || state.fotos.some(f => f.ruimte_label === item.naam) }));
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

  wrap.appendChild(el('div', { class: 'section-label' }, "Alle foto's"));
  const grid = el('div', { class: 'foto-grid' });
  state.fotos.forEach(f => {
    const tegel = el('div', { class: 'foto-tegel' },
      el('img', { src: URL.createObjectURL(f.blob) }),
      el('span', { class: 'badge ' + (f.status === 'verzonden' ? 'ok' : 'wachtend') }, f.status === 'verzonden' ? '✓' : '⏳'),
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

// ----------------------------------------------------------------------------------------------
// INIT
// ----------------------------------------------------------------------------------------------
(function init() {
  const m = location.hash.match(/^#\/opname\/([^/]+)\/([a-z]+)$/);
  if (m) laadOpname(decodeURIComponent(m[1]), m[2]);
  else render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
