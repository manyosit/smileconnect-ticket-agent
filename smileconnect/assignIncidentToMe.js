// =============================================================================
// SMILEconnect Script: assignIncidentToMe
//
// Weist ein Incident dem aktuell authentifizierten (impersonierten) User zu
// und setzt es auf "In Progress". Die Zielperson ist immer der Aufrufer
// selbst und kann nicht gewählt werden.
//
// Die Zuweisung läuft über adapter.remedy mit impersonateUser — die Änderung
// geschieht als der User selbst, der dafür entsprechende Rechte braucht
// (z.B. Incident Master) und Mitglied mindestens einer Support-Gruppe sein
// muss (Lookup über CTM:Support Group Assoc LookUp).
//
// Aufruf (als MCP-Tool run_assignIncidentToMe):
//   POST /v1/scriptEndpoints/assignIncidentToMe   { "data": { "id": "INC..." } }
//
// Ablage: /conf/scripts/assignIncidentToMe.js (über die GUI verwalten)
// Endpoint-Konfiguration: siehe CONFIG.md im selben Ordner.
// =============================================================================

try {
    const userId = globalScriptParams.user?.config?.options?.impersonateUser;
    if (!userId) {
        reject({ code: 400, message: "Kein impersonateUser im Kontext" });
        return;
    }

    const incidentId = requestData.id || requestData.data?.id;
    if (!incidentId) {
        reject({ code: 400, message: "Parameter id (Incident-Nummer) fehlt" });
        return;
    }

    const options = {
        limit: 1,
        impersonateUser: userId
    };

    // Support-Gruppe und People-Datensatz des Users nachschlagen
    const group = await adapter.remedy.search(
        "CTM:Support Group Assoc LookUp",
        `'Login ID' = "${userId}"`,
        "Full Name,Company,Support Organization,Support Group Name,Support Group ID",
        options
    );
    const person = await adapter.remedy.search(
        "CTM:People",
        `'Remedy Login ID' = "${userId}"`,
        "Person ID, Full Name",
        options
    );

    const inc = await adapter.remedy.search(
        "HPD:Help Desk",
        `'Incident Number' = "${incidentId}"`,
        "Entry ID",
        options
    );

    if (!inc?.data?.length) {
        reject({ "error": "Incident not found! " + incidentId });
        return;
    }
    if (!group?.data?.length) {
        reject({ "error": `no groups for ${userId} found in remedy!!` });
        return;
    }
    if (!person?.data?.length) {
        reject({ "error": `no person found for ${userId}` });
        return;
    }

    const id = inc.data[0]["Entry ID"];
    const myGroup = group.data[0];
    const me = person.data[0];

    const update = {
        "Assigned Group": myGroup["Support Group Name"],
        "Assigned Group ID": myGroup["Support Group ID"],
        "Assigned Support Company": myGroup["Company"],
        "Assigned Support Organization": myGroup["Support Organization"],
        "Assignee": me["Full Name"],
        "Assignee Login ID": userId,
        "Status": "In Progress"
    };
    // Rückgabewert ist die interne Entry-ID der Form – bewusst NICHT im Ergebnis
    // zurückgeben: Sie sieht aus wie eine Incident-Nummer, ist aber eine andere,
    // und ein KI-Assistent deutet das zu Recht als "falsches Ticket geändert".
    await adapter.remedy.update("HPD:Help Desk", id, update, options);

    customResponse.data = {
        id: incidentId,
        assignee: me["Full Name"],
        assigneeLoginId: userId,
        assignedGroup: myGroup["Support Group Name"],
        status: "In Progress",
        message: "successfully assigned"
    };
} catch (e) {
    log.error(e.message || e);
    reject(e);
}
