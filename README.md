# SmileConnect Ticket Agent (Template)

Vorlage für autonome Agenten, die von SMILEconnect-Events geweckt werden und
Tickets über den SmileConnect MCP Server bearbeiten. Der Ablauf pro Event:

```
SMILEconnect QueueData (Outgoing Ticket Event)
        │  REST-Call mit Ticket-Nummer
        ▼
Agent-Webhook (POST /ticket-event)
        │  1. Token von der SSO holen (client_credentials)
        │  2. MCP-Session öffnen → Tools kommen vom MCP-Server
        ▼
LLM-Loop:  Ticket lesen → Entscheidung als Worklog → lösen (Worklogs + Resolved)
           ODER eskalieren (Zuweisung gemäß ESCALATION_INSTRUCTION + Worklog)
```

Weitere Agenten entstehen durch Kopieren dieses Templates: eigener SSO-Client,
eigene SmileConnect-Client-Config, angepasster System-Prompt (`SYSTEM_PROMPT`
in `src/agent.ts`) — der restliche Code bleibt gleich.

## Einrichtung (einmal pro Agent)

### 1. Remedy-User für den Agenten

Der Agent bekommt einen eigenen Remedy-User (z.B. `svc-ki-agent`) mit den
Rechten, die er braucht (Worklogs schreiben, Incidents ändern/zuweisen).
Alle Aktionen erscheinen im ITSM unter diesem User.

### 2. + 3. SSO-Client und SmileConnect-Client-Config — zwei Modelle

**Modell 1 — eigener Client pro Agent** (`TOKEN_GRANT=client_credentials`):
In Ihrer SSO einen Client pro Agent (Service Accounts aktiviert). In SmileConnect
eine Client-Config mit derselben ID und statischer Impersonierung:

```json
"options": { "impersonateUser": "svc-ki-agent" }
```

Die User-Zuordnung ist Admin-Config, im Token steht kein
User — niemand kann sie beeinflussen. Dafür eine Client-Config pro Agent.

**Modell 2 — gemeinsamer Client, mehrere Agenten** (`TOKEN_GRANT=password`):
In Ihrer SSO *ein* Client (z.B. `agents`, „Direct Access Grants" aktiviert) und
pro Agent ein **Service-User** (`svc-agent-1`, `svc-agent-2`, …) mit eigenen
Credentials. Der Agent holt den Token per Password-Grant — die SSO prüft die
User-Credentials und setzt `preferred_username` selbst, die Identität ist also
SSO-beglaubigt (Agent 1 kann ohne Passwort von Agent 2 nicht dessen Identität
bekommen). Die *eine* SmileConnect-Client-Config braucht dann:

```json
"options": { "allowDynamicImpersonate": true }
```

Der Password-Grant ist dabei nur der Beispielweg dieses Templates —
entscheidend ist allein, dass der Agent ein von Ihrer SSO signiertes Token
erhält, dessen `preferred_username` seine Identität trägt. Jeder andere
Mechanismus Ihres Identity Providers, der solche Tokens ausstellt (z.B.
Token Exchange oder eigene Grants), funktioniert genauso; im Template wäre
dafür nur die Funktion `fetchAgentToken()` in `src/agent.ts` anzupassen.

Alle Agenten eines gemeinsamen Clients teilen sich dasselbe
Tool-Set/Design-Package; braucht ein Agent andere Scripts oder Rechte,
bekommt er einen eigenen Client (Modell 1) — beide Modelle sind mischbar.

In beiden Fällen wird die SmileConnect-Seite nach der Vorlage im Ordner
[`smileconnect/`](smileconnect/) eingerichtet: die Client-Config
(`default-agents.json` — Module, Felder und die drei ScriptEndpoints, die dem
Agenten automatisch als Tools `run_assignIncidentToMe`, `run_getMyIncidents`
und `run_escalateTicket` erscheinen) sowie die zugehörigen Scripts. Die
vollständige Beschreibung steht in
[`smileconnect/CONFIG.md`](smileconnect/CONFIG.md).

### 4. QueueData Outgoing-Event

In SMILEconnect ein Outgoing Ticket Event auf die `SMILEconnect_QueueData`
Form konfigurieren, das bei Ticket-Anlage den Agenten-Webhook aufruft:

- URL: `https://<agent-host>:4100/ticket-event`
- Payload: JSON mit der Ticket-Nummer, Feldname per `TICKET_ID_FIELD`
  konfigurierbar (Default `ticketNumber`), z.B. `{"ticketNumber": "INC000000001401"}`
- Optional Header `x-agent-token: <WEBHOOK_TOKEN>` als Shared Secret

### 5. Agent starten

```bash
cd examples/autonomous-agent
npm install
cp .env.example .env   # ausfüllen
npm run dev
```

## Testen

Event simulieren:

```bash
curl -s -X POST http://localhost:4100/ticket-event \
  -H 'Content-Type: application/json' \
  -d '{"ticketNumber": "INC000000001401"}'
```

**Ohne LLM-Key** (`DRY_RUN=true` in `.env`): testet die komplette Kette
Webhook → SSO-Token → MCP-Session → Tool-Aufruf (liest das Ticket) und loggt
das Ergebnis — ideal für die Inbetriebnahme, bevor der Gateway-Zugang da ist.

**Lokal gegen den Mock** (aus dem Repo-Root `npm run mock:server` und
`npm run dev` starten), dann in der Agent-`.env`:

```
SSO_TOKEN_URL=http://localhost:3001/sso/token
AGENT_CLIENT_ID=agent-1
AGENT_CLIENT_SECRET=test
MCP_SERVER_URL=http://localhost:3000/mcp
DRY_RUN=true
```

## Hinweise

- **LLM-Anbindung:** Der Agent spricht eine OpenAI-kompatible Chat-Completions-
  API und funktioniert damit mit jedem entsprechenden Endpoint — einem
  LLM-Gateway wie LiteLLM genauso wie direkt mit OpenAI (`LLM_BASE_URL`,
  `LLM_API_KEY`, `LLM_MODEL` = Modellname wie am Endpoint konfiguriert).
  Voraussetzung: das Modell muss Tool-Calling können (Claude, GPT-4-Klasse
  etc.). Der Agent nutzt **immer Streaming** (`stream: true`) und setzt die
  Deltas selbst zusammen — damit funktionieren auch Gateway-Routen, die
  ausschließlich Streaming unterstützen.
- **Der System-Prompt ist das Produkt:** Die Regeln in `SYSTEM_PROMPT`
  (erst lesen, Entscheidung zuerst als Worklog, keine erfundenen Werte,
  Eskalation im Zweifel) sind bewusst konservativ. Pro Agent-Variante wird
  primär dieser Prompt angepasst.
- **Tool-Namen sind nicht hardcodiert:** Der Agent reicht die Tools des MCP-
  Servers 1:1 an das LLM durch. Er funktioniert daher unverändert mit den
  statischen Tools (v1.3.x) und den dynamischen per-Client-Tools
  (feature/dynamic-tools) — inklusive kundenspezifischer ScriptEndpoints.
