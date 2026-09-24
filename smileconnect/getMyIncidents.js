// =============================================================================
// SMILEconnect Script: getMyIncidents
//
// Liefert die offenen Incidents des aktuell authentifizierten (impersonierten)
// Users — mit allen Feldern, die im Client-Mapping konfiguriert sind.
//
// Zweistufig: die Suche (freie Qualification) läuft über adapter.remedy,
// das Lesen der Treffer über adapter.smileconnect.getTicket — dadurch werden
// Feldliste und Feld-Mapping des Clients automatisch angewendet, ohne sie im
// Script zu pflegen. Voraussetzung: konfigurierter smileconnect-Adapter
// (SC_CLIENT, SC_SECRET, SC_SSO_URL, SC_SMILECONNECT_URL).
//
// Aufruf (als MCP-Tool run_getMyIncidents):
//   POST /v1/scriptEndpoints/getMyIncidents   { "data": {} }
//
// Ablage: /conf/scripts/getMyIncidents.js (über die GUI verwalten)
// Endpoint-Konfiguration: siehe CONFIG.md im selben Ordner.
// =============================================================================

const LIMIT = 20;

try {
    const userId = globalScriptParams.user?.config?.options?.impersonateUser;
    if (!userId) {
        reject({ code: 400, message: "Kein impersonateUser im Kontext" });
        return;
    }

    // 1. Suche in Remedy: nur die Incident-Nummern (Status < Resolved = offen)
    const qualification = `'Assignee Login ID' = "${userId}" AND 'Status' < "Resolved"`;
    const found = await adapter.remedy.search(
        "HPD:Help Desk",
        qualification,
        "Incident Number",
        { limit: LIMIT, impersonateUser: userId }
    );
    const ids = (found.data || []).map(e => e["Incident Number"]);

    // 2. Treffer über die SMILEconnect-API lesen: Feldliste + Mapping des
    //    Clients werden dort automatisch angewendet.
    const clientId = globalScriptParams.user.config.clientId;
    const incidents = [];
    for (const id of ids) {
        const ticket = await adapter.smileconnect.getTicket("incidents", id, { clientId });
        if (ticket && ticket.data && !ticket.error) incidents.push(ticket.data);
    }

    customResponse.data = { userId, count: incidents.length, data: incidents };
} catch (e) {
    log.error(e.message || e);
    reject(e);
}
