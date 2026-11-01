# GRÜNNA – echtes Erkennungsbackend für geschlossene Betatests

Implementiert den bestehenden Swift-Client-Vertrag unverändert: Sitzung → Auftrag → JPEG-Uploads → Start → Polling → Löschen. Anbieter: Pl@ntNet, Single-species API. Keine Platzhalter bei Fehlern.

## Start

Node 22 oder neuer. `npm ci`, dann `.env.example` nach `.env` kopieren. Servergeheimnisse ausschließlich dort bzw. im Secret Store des Hosters setzen:

- `BASE_URL`: öffentliche HTTPS-Origin des eigenen Servers, ohne Unterpfad; niemals aus Host-Header abgeleitet.
- `PLANTNET_API_KEY`: eigener Pl@ntNet-Schlüssel.
- `BETA_ACCESS_KEY`: zufälliger Wert mit mindestens 32 Zeichen (z.B. `openssl rand -hex 32`). Nur für eigene Testinstallationen.
- `DAILY_IMAGE_LIMIT`: maximal 100 Anbieteraufrufe pro UTC-Tag und Prozess als Standard. Fehlgeschlagene Aufrufe zählen ebenfalls.

Start mit `node --env-file=.env server.mjs`. Lokal ist HTTP nur zum Testen möglich. Die iPhone-App verlangt HTTPS. Für ein echtes iPhone einen privaten HTTPS-Testhost verwenden. TLS am vorgeschalteten Proxy terminieren; Request-Body höchstens 5 MiB, keine Request-Inhalte, Query-Strings oder Authorization-Header protokollieren.

Alternativ Dockerfile bauen; Umgebungsvariablen beim Start als Secrets bereitstellen. Genau eine Instanz verwenden, keine automatischen Replikate.

## App-Konfiguration

Im Xcode-Scheme unter Run → Arguments → Environment Variables setzen:

- `GRUNNA_API_BASE_URL`: HTTPS-Adresse des Backends.
- `GRUNNA_BETA_ACCESS_KEY`: derselbe Betazugang wie auf dem Server.

Alternativ die nicht geheime Basisadresse über `RecognitionConfig.plist` setzen. Der Pl@ntNet-Schlüssel gehört NIE in Scheme, App oder plist. Der Betazugang wird nicht eingecheckt; er ist nur eine temporäre Zugangshürde für Testgeräte, keine sichere öffentliche App-Authentifizierung.

Ohne Basisadresse bleibt der bestehende deutlich gekennzeichnete Testmodus aktiv. Mit Basisadresse werden Fehler sichtbar gemeldet; kein Mock-Fallback.

## Funktionsgrenzen

Jedes Foto/Einzelbild wird separat als EINE Pflanze analysiert. Gartenübersichten mit vielen Pflanzen werden nicht segmentiert. Deshalb Nahaufnahme verwenden. Keine erfundenen Bounding Boxes, keine automatische Zusammenführung von Individuen und keine kalibrierten Sicherheitsprozente. Alle Kandidaten bleiben Vorschläge und benötigen Prüfung. Der Server setzt konservativ `needsCloseUp`; die UI muss diese ergänzende Aufnahme weiterhin optional erlauben.

Pl@ntNet kann deutsche Trivialnamen liefern, wissenschaftliche Namen sind maßgeblich. Anbieter-Modellversion wird übernommen, falls geliefert. Krankheiten, Essbarkeit und Pflege werden nicht erzeugt.

## Datenschutz und Löschung

Bilder werden nur im Prozessspeicher gehalten und nach Abschluss/Fehler entfernt, nicht auf Platte geschrieben. Jobs, Ergebnisse und Upload-Capabilities verfallen nach zehn Minuten; Bereinigung alle 30 Sekunden. DELETE bricht laufende Anbieteranfragen ab und entfernt lokale Daten. Das kann eine beim Anbieter bereits erfolgte Verarbeitung NICHT rückgängig machen. Dessen Aufbewahrung und Datenschutzbedingungen vor echten Nutzeruploads prüfen. Eigene App-Einwilligung entsprechend anpassen. Medieninhalte werden nicht geloggt.

## Getestet

`npm test`: lokaler HTTP-Protokolltest mit echtem JPEG und injiziertem Anbieter, Zugriffstrennung, Idempotenz, Löschung, Startwiederholung, Kostenlimit, Anbieterfehler und multipart-Aufruf. Kein echter kostenpflichtiger API-Aufruf, kein Hosting-Deployment, kein iPhone-End-to-End-Test.

## Vor öffentlichem Release erforderlich

Dieses Backend ist eine begrenzte, nicht hochverfügbare Beta-Implementierung. Sitzungen, Limits und Jobs liegen im RAM; Neustarts setzen auch das Kostenlimit zurück. Maximal 20 Jobs global und drei je Installation; sechs JPEGs pro Job mit jeweils maximal 5 MiB. Speicherbedarf bis etwa 600 MiB plus Decodierung berücksichtigen. Upload-Limits und IP-Limits sind zusätzlich am Reverse Proxy einzurichten.

Für öffentliche Nutzung: serverseitige attestierte Geräte-/Nutzeridentität statt vertrauensbasierter Installations-ID und geteiltem Betazugang; persistente atomare Budget-/Quotenverwaltung; dauerhafte Jobqueue; kontrollierte Hintergrundbereinigung; Monitoring; nachgewiesene Löschung und geprüfte Datenschutz-/Vertragsbedingungen. Installation-IDs allein sind keine Authentifizierung. Keine öffentliche Freigabe dieses Betaservers ohne diese Ergänzungen.

API-Referenz: https://my.plantnet.org/doc/api/identify


## Render-Einrichtung dieses Repositorys

New Web Service → dieses Repository → Branch `main` → Language `Docker`. Root Directory leer lassen (Backend liegt direkt im Repository-Hauptordner). Region nach Möglichkeit Frankfurt, genau eine Instanz. Health Check Path: `/health`.

Unter Environment die Werte `BASE_URL`, `PLANTNET_API_KEY`, `BETA_ACCESS_KEY`, `DAILY_IMAGE_LIMIT=10` setzen. BASE_URL ist die tatsächlich zugewiesene HTTPS-Origin, ohne abschließenden Unterpfad. PORT wird von Render bereitgestellt. Keine `.env` hochladen. Nach Deployment beide Scheme-Variablen der App setzen (siehe oben).
