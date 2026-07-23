# Interface localization

Zipflow loads interface languages from JSON. Built-in packs live in `src/i18n/locales`; user packs live in `~/.zipflow/languages` or under `ZIPFLOW_HOME/languages` when that environment variable is set. English is the default interface language; users can explicitly choose **System language** to follow the operating-system locale when a matching pack exists.

`src/i18n/locales/en.json` is the canonical complete source catalog. Add every new user-facing English string or placeholder pattern there first, then translate it in other packs. English entries map source text to itself. Other packs may remain incremental and fall back to English, but they may not introduce a message or pattern that is absent from the English catalog. `npm run check` scans audited static UI fields and rejects either kind of drift.

## Add a custom language

Create a `.json` file that validates against [`language.schema.json`](language.schema.json):

```json
{
  "$schema": "./language.schema.json",
  "version": 1,
  "id": "example",
  "locale": "en-XA",
  "name": "Example language",
  "nativeName": "Example",
  "messages": {
    "Settings": "Example settings",
    "Update policy": "Example policy"
  },
  "patterns": [
    {
      "source": "{count} checks selected",
      "target": "{count} example checks"
    }
  ]
}
```

Choose **Refresh languages** under **Settings → Language**, or restart Zipflow. The pack appears when validation succeeds. Unknown or invalid files are ignored. A missing message falls back to English, which allows a pack to be introduced incrementally. The source audit verifies that static labels, descriptions, context help, dialog fields, common statuses, and toast titles are represented by the canonical English catalog. The bundled Russian pack has an additional full-coverage regression audit. Overlapping placeholder patterns are evaluated from the most specific source string to the least specific one.

`id` is the value stored in settings. It must be lowercase and may contain ASCII letters, digits, and hyphens. `locale` is used when **System language** is selected. `nativeName` is the label shown in the language picker.

## Placeholders

Exact entries in `messages` are matched first. `patterns` support named placeholders such as `{count}` or `{directory}`. Every placeholder used in a target should also be present in its source. Patterns match one complete source string; they are not regular expressions.

## Safety

Language packs are data only. Zipflow does not import them as JavaScript, execute code, resolve external references, or load files named by the JSON. The schema rejects unknown top-level fields and non-string message values.
