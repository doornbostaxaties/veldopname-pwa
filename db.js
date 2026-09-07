// db.js — kleine IndexedDB-wrapper voor Veldopname.
//
// Drie object stores:
//  - "taxaties"     : lokale kopie van elke geopende taxatie (zelfde `data`-vorm als
//                      taxatieweb-opname.user.js gebruikt: {afmetingen, externeBergruimte, indeling}),
//                      plus adres/plaats/afspraak_datumtijd/aantekeningen en een lokale wijzigings-
//                      teller (`lokaleVersie`) om te weten of er nog gesynchroniseerd moet worden.
//  - "fotos"         : elke gemaakte foto — het ruwe Blob-bestand + metadata (ruimte_label, categorie,
//                      rapport_id, gemaaktOp) + syncstatus ('lokaal' | 'wachtend' | 'verzonden').
//  - "wachtrij"       : generieke sync-wachtrij (taxatie-opslaan en foto-upload acties) — lokaal-eerst,
//                      wordt leeggewerkt zodra er weer verbinding is (zie app.js: verwerkWachtrij()).
//
// Bewust GEEN framework/ORM — vanilla IndexedDB, zelfde stijl als de rest van dit project
// (geen build-stap, makkelijk door Claude te onderhouden net als de Tampermonkey-scripts).

const VeldopnameDB = (() => {
  const DB_NAAM = 'veldopname';
  const DB_VERSIE = 2;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAAM, DB_VERSIE);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('taxaties')) {
          db.createObjectStore('taxaties', { keyPath: 'rapport_id' });
        }
        if (!db.objectStoreNames.contains('fotos')) {
          const fotos = db.createObjectStore('fotos', { keyPath: 'id', autoIncrement: true });
          fotos.createIndex('rapport_id', 'rapport_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('wachtrij')) {
          db.createObjectStore('wachtrij', { keyPath: 'id', autoIncrement: true });
        }
        // Sinds v2: macro's (verdiepingen/ruimtes/ruimteblokken/toevoegingen) — bewust GLOBAAL
        // (één record, key 'globaal'), niet per taxatie, zelfde als GM_setValue zonder rapportId()
        // in taxatieweb-opname.user.js: Arno's eigen, over alle taxaties heen herbruikbare lijsten.
        if (!db.objectStoreNames.contains('macros')) {
          db.createObjectStore('macros', { keyPath: 'sleutel' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function store(naam, modus) {
    const db = await open();
    return db.transaction(naam, modus).objectStore(naam);
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    // --- taxaties ---
    async bewaarTaxatie(taxatie) {
      const s = await store('taxaties', 'readwrite');
      return wrap(s.put(taxatie));
    },
    async haalTaxatie(rapportId) {
      const s = await store('taxaties', 'readonly');
      return wrap(s.get(rapportId));
    },
    async alleTaxaties() {
      const s = await store('taxaties', 'readonly');
      return wrap(s.getAll());
    },

    // --- foto's ---
    async bewaarFoto(foto) {
      const s = await store('fotos', 'readwrite');
      return wrap(s.add(foto));
    },
    async werkFotoBij(id, wijzigingen) {
      const s = await store('fotos', 'readwrite');
      const bestaand = await wrap(s.get(id));
      if (!bestaand) return;
      Object.assign(bestaand, wijzigingen);
      return wrap(s.put(bestaand));
    },
    async fotosVoorTaxatie(rapportId) {
      const s = await store('fotos', 'readonly');
      const index = s.index('rapport_id');
      return wrap(index.getAll(rapportId));
    },
    async verwijderFoto(id) {
      const s = await store('fotos', 'readwrite');
      return wrap(s.delete(id));
    },

    // --- macro's (globaal) ---
    async haalMacros() {
      const s = await store('macros', 'readonly');
      const rec = await wrap(s.get('globaal'));
      return rec ? rec.waarde : null;
    },
    async bewaarMacros(macros) {
      const s = await store('macros', 'readwrite');
      return wrap(s.put({ sleutel: 'globaal', waarde: macros }));
    },

    // --- sync-wachtrij ---
    async voegWachtrijItemToe(item) {
      const s = await store('wachtrij', 'readwrite');
      return wrap(s.add(item));
    },
    async alleWachtrijItems() {
      const s = await store('wachtrij', 'readonly');
      return wrap(s.getAll());
    },
    async verwijderWachtrijItem(id) {
      const s = await store('wachtrij', 'readwrite');
      return wrap(s.delete(id));
    },
  };
})();
