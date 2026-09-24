// =============================================================================
// SMILEconnect Script: escalateTicket
//
// Weist ein Incident der Eskalations-Gruppe des aufrufenden Agenten zu.
// Die Zielgruppe wird NICHT vom Aufrufer übergeben, sondern serverseitig über
// das Mapping "Agent-User -> Support-Gruppe" bestimmt — der Agent kann sie
// damit nicht beeinflussen.
//
// Der Update läuft über adapter.remedy mit impersonateUser: die Änderung
// geschieht als der Agent-User selbst, der dafür entsprechende Rechte
// braucht (z.B. Incident Master).
//
// Aufruf (durch den MCP-Agenten als Tool run_escalateTicket):
//   POST /v1/scriptEndpoints/escalateTicket   { "data": { "id": "INC..." } }
//
// Ablage: /conf/scripts/escalateTicket.js (über die GUI verwalten)
// Endpoint-Konfiguration: siehe CONFIG.md im selben Ordner.
// =============================================================================

// --- Mapping: welcher Agent eskaliert an welche Gruppe -----------------------
const GROUP_BY_AGENT = {
    "svc-agent-1": "Service Desk",
    "svc-agent-2": "Frontoffice Support"
};
// Fallback, wenn ein Agent nicht im Mapping steht (leer lassen = Fehler werfen)
const DEFAULT_GROUP = "Service Desk";

try {
    // --- 1. Eingaben prüfen --------------------------------------------------
    const ticketId = requestData.id || requestData.data?.id;
    if (!ticketId) {
        reject({ code: 400, message: "Parameter data.id (Incident-Nummer) fehlt" });
        return;
    }

    // --- 2. Aufrufenden Agenten ermitteln ------------------------------------
    // Bei allowDynamicImpersonate enthält impersonateUser den dynamisch
    // übergebenen User — beim MCP-Server ist das der SSO-verifizierte
    // preferred_username aus dem Token (z.B. svc-agent-1).
    const agentUser = globalScriptParams.user?.config?.options?.impersonateUser;
    if (!agentUser) {
        reject({ code: 400, message: "Kein impersonateUser im Kontext — Eskalation nur für Agenten mit User-Identität" });
        return;
    }

    const groupName = GROUP_BY_AGENT[agentUser] || DEFAULT_GROUP;
    if (!groupName) {
        reject({ code: 400, message: `Kein Eskalationsziel für Agent "${agentUser}" konfiguriert` });
        return;
    }
    log.info(`escalateTicket: ${ticketId} durch ${agentUser} -> Gruppe "${groupName}"`);

    // Alle Remedy-Aufrufe als der Agent-User (impersoniert)
    const options = { limit: 1, impersonateUser: agentUser };

    // --- 3. Zielgruppe nachschlagen (Company/Organisation für die Zuweisung) --
    const group = await adapter.remedy.search(
        "CTM:Support Group",
        `'Support Group Name' = "${groupName}" AND 'Status' = "Enabled"`,
        "Support Group Name,Support Group ID,Company,Support Organization",
        options
    );
    if (!group?.data?.length) {
        reject({ code: 404, message: `Support-Gruppe "${groupName}" nicht gefunden` });
        return;
    }
    const g = group.data[0];

    // --- 4. Incident finden (Entry-ID der HPD:Help Desk) ----------------------
    const inc = await adapter.remedy.search(
        "HPD:Help Desk",
        `'Incident Number' = "${ticketId}"`,
        "Entry ID",
        options
    );
    if (!inc?.data?.length) {
        reject({ code: 404, message: `Incident ${ticketId} nicht gefunden` });
        return;
    }

    // --- 5. Zuweisung schreiben ----------------------------------------------
    const update = {
        "Status": "Assigned",
        "Assigned Group": g["Support Group Name"],
        "Assigned Group ID": g["Support Group ID"],
        "Assigned Support Company": g["Company"],
        "Assigned Support Organization": g["Support Organization"]
    };
    // Rückgabewert ist die interne Entry-ID der Form – bewusst NICHT im Ergebnis
    // zurückgeben: Sie sieht aus wie eine Incident-Nummer, ist aber eine andere,
    // und ein KI-Assistent deutet das zu Recht als "falsches Ticket geändert".
    await adapter.remedy.update("HPD:Help Desk", inc.data[0]["Entry ID"], update, options);

    log.info(`escalateTicket: ${ticketId} erfolgreich an "${groupName}" zugewiesen`);
    customResponse.data = {
        id: ticketId,
        escalatedBy: agentUser,
        assignedGroup: groupName,
        status: "Assigned",
        message: "successfully escalated"
    };
} catch (e) {
    log.error(e.message || e);
    reject(e);
}
