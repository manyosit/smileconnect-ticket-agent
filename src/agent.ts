/**
 * SmileConnect Ticket Agent — Template für autonome Agenten.
 *
 * Ablauf:
 *   SMILEconnect QueueData Outgoing-Event → POST /ticket-event {ticketNumber}
 *   → Agent holt sich per client_credentials ein Token von der Kunden-SSO
 *   → verbindet sich mit dem SmileConnect MCP Server (Tools kommen von dort)
 *   → LLM-Loop: Ticket lesen, Entscheidung als Worklog, lösen ODER eskalieren.
 *
 * Identität: Der Agent hat einen eigenen SSO-Client. Die zugehörige
 * SmileConnect-Client-Config setzt options.impersonateUser auf den
 * Remedy-User des Agenten — alle Aktionen laufen im ITSM unter diesem User.
 */
import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ─── Konfiguration ───────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Fehlende Umgebungsvariable: ${name} (siehe .env.example)`);
    process.exit(1);
  }
  return value;
}

const SSO_TOKEN_URL = requireEnv("SSO_TOKEN_URL");
const AGENT_CLIENT_ID = requireEnv("AGENT_CLIENT_ID");
const AGENT_CLIENT_SECRET = process.env.AGENT_CLIENT_SECRET || undefined;
// Identitätsmodell: "client" = eigener SSO-Client pro Agent (client_credentials,
// Impersonierung statisch in der SmileConnect-Client-Config) ODER "user" =
// gemeinsamer Client + eigener SSO-Service-User pro Agent (password grant,
// SmileConnect-Client hat allowDynamicImpersonate: true).
const TOKEN_GRANT = (process.env.TOKEN_GRANT ?? "client_credentials") as
  | "client_credentials"
  | "password";
const AGENT_USERNAME = process.env.AGENT_USERNAME || undefined;
const AGENT_PASSWORD = process.env.AGENT_PASSWORD || undefined;
if (TOKEN_GRANT === "password" && (!AGENT_USERNAME || !AGENT_PASSWORD)) {
  console.error("TOKEN_GRANT=password benötigt AGENT_USERNAME und AGENT_PASSWORD");
  process.exit(1);
}
if (TOKEN_GRANT === "client_credentials" && !AGENT_CLIENT_SECRET) {
  console.error("TOKEN_GRANT=client_credentials benötigt AGENT_CLIENT_SECRET");
  process.exit(1);
}
const MCP_SERVER_URL = requireEnv("MCP_SERVER_URL");
const DRY_RUN = process.env.DRY_RUN === "true";
// LLM über eine OpenAI-kompatible API — z.B. das LiteLLM-Gateway des Kunden.
// LLM_MODEL ist der Modellname, wie er im Gateway konfiguriert ist.
const LLM_BASE_URL = process.env.LLM_BASE_URL || undefined;
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || undefined;
const LLM_MODEL = process.env.LLM_MODEL ?? "claude-opus-5";
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 4100);
const TICKET_ID_FIELD = process.env.TICKET_ID_FIELD ?? "ticketNumber";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || undefined;
const ESCALATION_INSTRUCTION =
  process.env.ESCALATION_INSTRUCTION ??
  "Setze per Ticket-Update das Feld assignedGroup auf 'Service Desk'.";

if (!DRY_RUN && (!LLM_BASE_URL || !LLM_API_KEY)) {
  console.error("Ohne DRY_RUN werden LLM_BASE_URL und LLM_API_KEY benötigt (siehe .env.example)");
  process.exit(1);
}

// ─── System-Prompt (der eigentliche "Auftrag" des Agenten) ───────────────────

const SYSTEM_PROMPT = `Du bist ein autonomer Ticket-Bearbeitungs-Agent für das ITSM-System SMILEconnect.
Du wirst pro Ticket-Event einmal aufgerufen und arbeitest ausschließlich über die dir bereitgestellten Tools.

Dein Ablauf für jedes Ticket:

1. LESEN: Lies das Ticket zuerst vollständig (nutze bevorzugt ein Summary-Tool, das Ticket inkl. Worklogs liefert). Handle nie, bevor du das Ticket gelesen hast.

2. ENTSCHEIDEN: Prüfe ehrlich, ob du das Ticket mit deinen Tools lösen kannst. Lösbar sind typischerweise: Anfragen, die sich durch Information/Anleitung beantworten lassen, Statuspflege und dokumentierte Standardlösungen. NICHT lösbar sind: Eingriffe in Systeme, für die du kein Tool hast, unklare Sachverhalte oder fehlende Informationen. Im Zweifel: nicht lösbar.

3. ENTSCHEIDUNG DOKUMENTIEREN: Schreibe deine Entscheidung ZUERST als Worklog in das Ticket, bevor du weitere Aktionen ausführst. Format: "KI-Agent: <Entscheidung + kurze Begründung>".

4. WENN LÖSBAR: Weise dir das Ticket ZUERST selbst zu und nimm es in Bearbeitung (nutze dafür das Zuweisungs-Tool für den aktuellen User, z.B. run_assignIncidentToMe). Führe dann die Lösung durch. Dokumentiere jede wesentliche Aktion als eigenes Worklog ("KI-Agent: <was getan wurde>"). Wenn die Lösung erfolgreich abgeschlossen ist, setze das Ticket auf gelöst — dabei im SELBEN Update immer alle drei Felder: status ("Resolved" bzw. den Wert aus dem Tool-Schema), statusReason (passender Wert aus dem Schema) und resolution (kurzer Lösungstext).

5. WENN NICHT LÖSBAR ODER LÖSUNG FEHLGESCHLAGEN: Eskaliere wie folgt: ${ESCALATION_INSTRUCTION}
   Bei "nicht lösbar" weist du dir das Ticket NICHT selbst zu — es geht direkt an die Eskalationsgruppe.
   Dokumentiere die Begründung der Eskalation als Worklog.

Regeln:
- Erfinde niemals Fakten, IDs oder Lösungen. Was du nicht aus dem Ticket oder einem Tool-Ergebnis weißt, weißt du nicht.
- Nutze für Feldwerte (Status, Gruppen, Kategorien) ausschließlich Werte aus den Tool-Schemas oder aus Lookup-Tools — rate keine Werte.
- Schlägt ein Tool-Aufruf fehl, versuche es einmal sinnvoll korrigiert erneut; schlägt es wieder fehl, eskaliere.
- Worklogs auf Deutsch, sachlich und präzise, immer mit Präfix "KI-Agent:".
- Ändere nichts am Ticket außer dem, was dieser Ablauf vorsieht.

Am Ende: fasse in deiner Abschlussantwort in 2-3 Sätzen zusammen, was du getan hast (diese Antwort wird nur geloggt, sie landet nicht im Ticket).`;

// ─── SSO: client_credentials Token ───────────────────────────────────────────

async function fetchAgentToken(): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const params = new URLSearchParams();

  if (TOKEN_GRANT === "password") {
    // Gemeinsamer Client, Identität = SSO-Service-User des Agenten.
    // Der preferred_username im Token wird von der SSO nach Prüfung der
    // User-Credentials gesetzt → fälschungssichere Agent-Identität.
    params.set("grant_type", "password");
    params.set("client_id", AGENT_CLIENT_ID);
    if (AGENT_CLIENT_SECRET) params.set("client_secret", AGENT_CLIENT_SECRET);
    params.set("username", AGENT_USERNAME!);
    params.set("password", AGENT_PASSWORD!);
  } else {
    // Eigener Client pro Agent, Identität = Client selbst (azp).
    params.set("grant_type", "client_credentials");
    headers.Authorization =
      "Basic " + Buffer.from(`${AGENT_CLIENT_ID}:${AGENT_CLIENT_SECRET}`).toString("base64");
  }

  const res = await fetch(SSO_TOKEN_URL, {
    method: "POST",
    headers,
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`SSO-Token-Anfrage fehlgeschlagen: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("SSO-Antwort enthält kein access_token");
  return data.access_token;
}

// ─── MCP-Verbindung ──────────────────────────────────────────────────────────

interface McpSession {
  client: Client;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  close: () => Promise<void>;
}

async function connectMcp(token: string): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "smileconnect-ticket-agent", version: "0.1.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    client,
    tools: tools as McpSession["tools"],
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

/** MCP-Tool-Ergebnis in Text für das LLM umwandeln. */
function toolResultToText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  const text = content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
  return text || JSON.stringify(result);
}

// ─── Ticket-Verarbeitung ─────────────────────────────────────────────────────

async function processTicket(ticketId: string): Promise<void> {
  const log = (msg: string) => console.log(`[${new Date().toISOString()}] [${ticketId}] ${msg}`);
  log("Verarbeitung gestartet");

  const token = await fetchAgentToken();
  log("SSO-Token erhalten");

  const mcp = await connectMcp(token);
  log(`MCP verbunden, ${mcp.tools.length} Tools verfügbar: ${mcp.tools.map((t) => t.name).join(", ")}`);

  try {
    if (DRY_RUN) {
      // Kette testen ohne LLM: Summary-/Get-Tool heuristisch aufrufen
      const readTool =
        mcp.tools.find((t) => /summary/i.test(t.name)) ??
        mcp.tools.find((t) => /^get_(incident|ticket)$/.test(t.name));
      if (readTool) {
        const props = (readTool.inputSchema?.properties ?? {}) as Record<string, unknown>;
        const args: Record<string, unknown> = {};
        if ("ticket_id" in props) args.ticket_id = ticketId;
        if ("ticket_type" in props) args.ticket_type = "incidents";
        const result = await mcp.client.callTool({ name: readTool.name, arguments: args });
        log(`DRY_RUN: ${readTool.name} →\n${toolResultToText(result).substring(0, 500)}`);
      } else {
        log("DRY_RUN: kein Lese-Tool gefunden");
      }
      return;
    }

    // LLM-Loop über eine OpenAI-kompatible API (LiteLLM-Gateway):
    // Tools des MCP-Servers 1:1 als Function-Tools durchreichen.
    const llm = new OpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY });
    const llmTools: ChatCompletionTool[] = mcp.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? t.name,
        parameters: t.inputSchema,
      },
    }));

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Neues Ticket-Event von SMILEconnect. Ticket-Nummer: ${ticketId}. ` +
          `Bearbeite das Ticket gemäß deinem Auftrag.`,
      },
    ];

    const MAX_ITERATIONS = 30;
    let summary = "(keine Abschlussantwort)";

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Immer streamen: manche Gateway-Routen (z.B. ChatGPT-Abo hinter LiteLLM)
      // unterstützen NUR Streaming, und normale Routen können es ohnehin.
      // Die Deltas (Text + fragmentierte Tool-Call-Argumente) werden zu einer
      // vollständigen Assistant-Message zusammengesetzt.
      const stream = await llm.chat.completions.create({
        model: LLM_MODEL,
        messages,
        tools: llmTools,
        stream: true,
      });

      let content = "";
      const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) content += delta.content;
        for (const tc of delta.tool_calls ?? []) {
          const acc = (toolCalls[tc.index] ??= {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.function.name += tc.function.name;
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        }
      }

      const msg: ChatCompletionMessageParam = {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      messages.push(msg);

      if (toolCalls.length === 0) {
        summary = content || summary;
        break;
      }

      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        const { name } = call.function;
        let resultText: string;
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          log(`Tool-Call: ${name} ${call.function.arguments}`);
          const result = await mcp.client.callTool({ name, arguments: args });
          resultText = toolResultToText(result);
        } catch (err) {
          resultText = `Fehler beim Tool-Aufruf: ${err instanceof Error ? err.message : String(err)}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
      }
    }

    log(`Abgeschlossen:\n${summary}`);
  } finally {
    await mcp.close();
  }
}

// ─── Webhook (Ziel des QueueData Outgoing-Events) ────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/ticket-event", (req, res) => {
  if (WEBHOOK_TOKEN && req.headers["x-agent-token"] !== WEBHOOK_TOKEN) {
    res.status(401).json({ error: "invalid webhook token" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const ticketId = body[TICKET_ID_FIELD];
  if (typeof ticketId !== "string" || ticketId.length === 0) {
    res.status(400).json({ error: `Feld "${TICKET_ID_FIELD}" fehlt im Event-Payload` });
    return;
  }

  // Sofort bestätigen, Verarbeitung asynchron — das Event soll nicht auf das LLM warten
  res.status(202).json({ status: "accepted", ticket: ticketId });

  processTicket(ticketId).catch((err) => {
    console.error(`[${ticketId}] Verarbeitung fehlgeschlagen:`, err instanceof Error ? err.message : err);
  });
});

app.listen(AGENT_PORT, () => {
  console.log(`SmileConnect Ticket Agent läuft auf Port ${AGENT_PORT} (DRY_RUN=${DRY_RUN})`);
  console.log(`Webhook: POST /ticket-event  { "${TICKET_ID_FIELD}": "INC..." }`);
});
