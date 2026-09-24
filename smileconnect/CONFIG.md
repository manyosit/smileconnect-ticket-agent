# SMILEconnect-Konfiguration für den Ticket-Agenten

Dieser Ordner enthält alles, was auf SMILEconnect-Seite für den Agenten
eingerichtet wird:

| Datei | Zweck |
|---|---|
| `default-agents.json` | Vollständige Client-Config des Agenten-Clients (Referenz) |
| `assignIncidentToMe.js` | Script: Ticket dem Agenten zuweisen + In Progress |
| `getMyIncidents.js` | Script: offene Tickets des Agenten mit allen gemappten Feldern |
| `escalateTicket.js` | Script: Ticket an die Eskalationsgruppe des Agenten zuweisen |

## 1. Client-Config (`default-agents.json`)

Die Client-Config ist die zentrale Steuerung — sie bestimmt, **was der Agent
sehen und tun kann**. Anlegen über die SMILEconnect-GUI (Clients) mit der
Client-ID, die auch der SSO-Client des Agenten trägt (hier: `default-agents`).
Die Datei in diesem Ordner dient als Referenz/Vorlage. Die wichtigsten Teile:

- **Module & Felder:** Pro Objekt (`incident`, `person`, `supportGroup`,
  `cmdbobject`, …) definieren `fields` die zugänglichen Remedy-Felder und
  `basequery` den Datenausschnitt. Nicht benötigte Module sind mit
  `"basequery": "1=2"` und leerer Feldliste deaktiviert (`change`,
  `workOrder`, `problem`, `organisation`) — sie erscheinen dann **nicht** im
  Design-Package des Clients und damit auch nicht als MCP-Tools. Die
  Feldlisten steuern also direkt, welche Tools der Agent bekommt und welche
  Felder deren Schemas enthalten.
- **`constants`:** Feste Werte, die SMILEconnect bei Create/Update selbst
  setzt (z.B. `Work Log Type` für Worklogs) — der Agent muss sie nicht
  kennen.
- **`options.allowDynamicImpersonate: true`:** Aktiviert die dynamische
  Impersonierung — der MCP-Server reicht den SSO-verifizierten Usernamen des
  Agenten (`preferred_username` aus dem Token) als `impersonateUser` durch,
  sodass alle Aktionen im ITSM unter dem jeweiligen Agenten-User laufen.
- **`scriptEndpoints`:** Die drei Agenten-Endpoints inklusive ihrer
  `openAPISpec` (Summary, Beschreibung, Request-/Response-Schema). Diese
  Specs erscheinen 1:1 als MCP-Tools `run_assignIncidentToMe`,
  `run_getMyIncidents` und `run_escalateTicket` — sie sind die
  „Bedienungsanleitung" für das LLM und sollten entsprechend sorgfältig
  gepflegt werden (wann das Tool zu benutzen ist, welche Parameter es
  braucht, was der Aufrufer NICHT wählen kann).

Änderungen an der Client-Config wirken sofort auf das Tool-Set: neue
Session des Agenten → neues Design-Package → aktualisierte Tools.

## 2. Scripts (`/conf/scripts/`)

Die drei `.js`-Dateien über die SMILEconnect-GUI (Scripts) anlegen — die
Dateinamen müssen den `scripts`-Referenzen in den `scriptEndpoints` der
Client-Config entsprechen.

Im `escalateTicket.js` das Eskalations-Mapping am Script-Anfang pflegen —
welcher Agent eskaliert an welche Gruppe:

```javascript
const GROUP_BY_AGENT = {
    "svc-agent-1": "Service Desk",
    "svc-agent-2": "Frontoffice Support"
};
```

Die Zielgruppe wird serverseitig aus diesem Mapping bestimmt; der Agent
übergibt nur die Ticket-Nummer.

## 3. Voraussetzungen

- **Remedy-User pro Agent** (z.B. `svc-agent-1`): Support-Mitarbeiter mit
  Modify-Rechten auf Incidents (z.B. **Incident Master**) und Mitgliedschaft
  in mindestens einer Support-Gruppe (für die Selbstzuweisung). Alle
  Worklogs, Status- und Zuweisungsänderungen erscheinen im ITSM unter diesem
  User.
- **smileconnect-Adapter** (nur für `getMyIncidents`): Das Script liest die
  gefundenen Tickets über die eigene SMILEconnect-API, damit Feldliste und
  Feld-Mapping des Clients automatisch angewendet werden. Dafür am
  API-Deployment die Env-Variablen `SC_CLIENT`, `SC_SECRET`, `SC_SSO_URL`
  und `SC_SMILECONNECT_URL` setzen (vollständige URL inkl. `https://`).
- **SSO-Seite** (Client + Service-User pro Agent): siehe README des Samples.

## 4. Wie alles zusammenspielt

```
SSO-Token (preferred_username = svc-agent-1, azp = default-agents)
        │
        ▼
MCP-Server:  azp → Design-Package "default-agents" → Tool-Set des Agenten
             preferred_username → impersonateUser
        │
        ▼
SMILEconnect:  Client-Config (Felder, Rechte, Scripts)
               Scripts handeln impersoniert als svc-agent-1 im Remedy
```

Ein weiterer Agent = ein weiterer Service-User in der SSO + ein Remedy-User
+ ein Eintrag im `GROUP_BY_AGENT`-Mapping. Ein Agent mit anderem Tool-Set
oder anderen Rechten = eine eigene Client-Config nach diesem Muster.
