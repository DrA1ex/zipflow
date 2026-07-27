import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const EXPECTED = {
  de: {
    'Safe source archive updates': 'Sichere Aktualisierungen aus Quellarchiven',
    'Project setup': 'Projekteinrichtung',
    'Archive safety': 'Archivsicherheit',
    'Applying update': 'Aktualisierung wird angewendet',
    'Checks failed': 'Prüfungen fehlgeschlagen',
    'Create ZIP': 'ZIP erstellen',
    'Run history': 'Ausführungsverlauf',
    'Global settings': 'Allgemeine Einstellungen',
    'Reasoning effort': 'Denkaufwand',
    'Use an external Codex server': 'Externen Codex-Server verwenden',
    'Codex server endpoint': 'Codex-Server-Endpunkt',
    'Cancel': 'Abbrechen',
  },
  fr: {
    'Safe source archive updates': 'Mises à jour sûres depuis des archives source',
    'Project setup': 'Configuration du projet',
    'Archive safety': 'Sécurité de l’archive',
    'Applying update': 'Application de la mise à jour',
    'Checks failed': 'Échec des vérifications',
    'Create ZIP': 'Créer un ZIP',
    'Run history': 'Historique des exécutions',
    'Global settings': 'Paramètres généraux',
    'Reasoning effort': 'Effort de raisonnement',
    'Use an external Codex server': 'Utiliser un serveur Codex externe',
    'Codex server endpoint': 'Endpoint du serveur Codex',
    'Cancel': 'Annuler',
  },
  it: {
    'Safe source archive updates': 'Aggiornamenti sicuri da archivi sorgente',
    'Project setup': 'Configurazione del progetto',
    'Archive safety': 'Sicurezza dell’archivio',
    'Applying update': 'Applicazione dell’aggiornamento',
    'Checks failed': 'Verifiche non riuscite',
    'Create ZIP': 'Crea ZIP',
    'Run history': 'Cronologia delle esecuzioni',
    'Global settings': 'Impostazioni generali',
    'Reasoning effort': 'Livello di ragionamento',
    'Use an external Codex server': 'Usa un server Codex esterno',
    'Codex server endpoint': 'Endpoint del server Codex',
    'Cancel': 'Annulla',
  },
  es: {
    'Safe source archive updates': 'Actualizaciones seguras desde archivos de código fuente',
    'Project setup': 'Configuración del proyecto',
    'Archive safety': 'Seguridad del archivo',
    'Applying update': 'Aplicando actualización',
    'Checks failed': 'Las comprobaciones fallaron',
    'Create ZIP': 'Crear ZIP',
    'Run history': 'Historial de ejecuciones',
    'Global settings': 'Ajustes generales',
    'Reasoning effort': 'Esfuerzo de razonamiento',
    'Use an external Codex server': 'Usar un servidor Codex externo',
    'Codex server endpoint': 'Endpoint del servidor Codex',
    'Cancel': 'Cancelar',
  },
};

for (const [language, expected] of Object.entries(EXPECTED)) {
  test(`${language} has concrete translations for the basic Zipflow workflow`, async () => {
    const pack = JSON.parse(await readFile(new URL(`../src/i18n/locales/${language}.json`, import.meta.url), 'utf8'));
    assert.ok(Object.keys(pack.messages).length >= 250, `${language} basic catalog unexpectedly shrank`);
    for (const [source, translation] of Object.entries(expected)) {
      assert.equal(pack.messages[source], translation, `${language}: ${source}`);
      assert.notEqual(pack.messages[source], source, `${language}: untranslated fallback for ${source}`);
    }
  });
}
