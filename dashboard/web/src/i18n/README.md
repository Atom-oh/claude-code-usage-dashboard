# Application localization

The application defaults to Korean. The language picker selects English,
Simplified Chinese, Japanese, Spanish or Korean and persists `ccdash.locale`.
Other catalogs load on demand. A failed load keeps the current language and can
be retried; a newer selection supersedes an older request.

`useLocale()` subscribes a component without remounting it. `translate(key, values)`
formats authored messages with positional placeholders. Values are opaque:
identities, model IDs, user text and telemetry must not be translated. Use
`richMessage` for complete sentences containing React elements; it renders text
and elements directly, without interpreting HTML. Store `localizedMessage`
descriptors for application feedback that must follow later language changes.

Static presentation records can opt into `localize()`. Labels then resolve when
read rather than freezing at module initialization; record identities remain
stable. Do not apply it to API payloads, request parameters or user data.
`translateSource` bridges existing authored string constants to their catalog
keys. Short dates and numbers use the selected locale; exact trace timestamps
retain a padded numeric form in the browser time zone.

Catalog keys are `m` plus the first twelve hexadecimal digits of the source
message's SHA256. Korean is the source catalog, including established English
technical labels. Add coherent source messages, use Luna for translations, and
preserve every positional placeholder. Catalog and React integration tests check
coverage, asynchronous selection, state retention and escaping.
