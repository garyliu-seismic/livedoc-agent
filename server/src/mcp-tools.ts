/**
 * MCP Tool definitions for Seismic LiveDoc API.
 * 
 * These tools will be registered with the local Agent (langchain / mcp-sdk)
 * so that the LLM can dynamically choose which tool to call based on user intent,
 * rather than hardcoded frontend POST calls.
 * 
 * Each function is also exposed via Express for backward compatibility & debugging.
 */

const BASE_URL = process.env.SEISMIC_BASE_URL ?? "https://api.seismic-dev.com/livedoc";
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL ?? "http://localhost:5173";
let _runtimeToken: string = "";

export function setRuntimeToken(token: string): void {
  _runtimeToken = token;
}

function getToken(): string {
  return _runtimeToken || process.env.SEISMIC_API_TOKEN || "";
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}`, ...extra };
}

// The Integration API is a sibling service used to resolve a DocCenter profile's id/versionId
// by name. Its gateway route isn't a simple sibling path of BASE_URL — non-prod inserts an extra
// "services/" segment (mirrors mcp-seismic-livedoc/src/config.ts's deriveIntegrationBaseUrl).
function deriveIntegrationBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const nonProdMatch = url.pathname.match(/^\/(dev|qa|uat)\/livedoc\/?$/);
  if (nonProdMatch) return `${url.origin}/${nonProdMatch[1]}/services/integration`;
  return `${url.origin}/integration`;
}

const INTEGRATION_BASE_URL = process.env.SEISMIC_INTEGRATION_BASE_URL ?? deriveIntegrationBaseUrl(BASE_URL);

// The workspace-browsing endpoints (GetWorkspaceDestinationSpaces/Roots/FolderItems) live in a
// separate "Document Generator (Internal)" API resource (api-specifications commit 06dc51c1,
// 2026-09-03), added with its own api_id so it can't collide with the main LiveDoc api_id. Unlike
// the Integration API, this one is a simple sibling path: "/{env}/livedoc" (prod: "/livedoc") ->
// "/{env}/livedoc-internal" (prod: "/livedoc-internal"), no extra segment inserted. Mirrors
// mcp-seismic-livedoc/src/config.ts's deriveInternalBaseUrl.
function deriveInternalBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.origin}${url.pathname.replace(/\/livedoc\/?$/, "/livedoc-internal")}`;
}

const INTERNAL_BASE_URL = process.env.SEISMIC_INTERNAL_BASE_URL ?? deriveInternalBaseUrl(BASE_URL);

// LDS's APIs never return a browsable URL for a committed Workspace file, so it's built
// client-side from fileId + the JWT's tenant_fqdn claim. viewType is not format-dependent —
// "DraftPresentations" is the one value confirmed to work end-to-end, treated as a default.
function jwtTenantFqdn(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof payload.tenant_fqdn === "string" ? payload.tenant_fqdn : null;
  } catch {
    return null;
  }
}

function buildWorkspaceUrl(fileId: string): string | null {
  const tenantFqdn = jwtTenantFqdn(getToken());
  if (!tenantFqdn) return null;
  return `https://${tenantFqdn}/apps/workspace/doc/${fileId}//grid/title?viewType=DraftPresentations`;
}

const SEISMIC_FETCH_TIMEOUT_MS = 30_000;

async function seismicFetch(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
  base: string = BASE_URL
): Promise<{ status: number; body: unknown }> {
  const url = `${base}${path}`;
  // Without this, a hung upstream request blocks the whole tool call indefinitely — observed
  // live: a submit_ucb_workspace_generation call hung until the client's own 5-minute abort
  // killed it, with zero diagnostic info about where time was actually being spent.
  const res = await fetch(url, {
    method: options.method ?? "GET",
    body: options.body,
    headers: { ...authHeaders(), ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(SEISMIC_FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// ================================================================
// Tool 1: search_templates — Search Seismic content library
// ================================================================
export async function searchTemplates(params: {
  searchText?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ results: Array<{ title: string; format: string; contentVersionId: string; teamSiteId: string; modifiedDate: string; description: string; contentProfiles?: string[]; profileVersionIds?: string[] }>; totalCount: number }> {
  const body = {
    searchText: params.searchText ?? "",
    allowPptx: true,
    includeLiveDoc: true,
    allowPdf: false,
    page: { size: params.pageSize ?? 10, from: (params.page ?? 0) * (params.pageSize ?? 10) },
    orderBy: [{ attr: "modifiedDate", direction: "DESC" }],
  };

  const result = await seismicFetch("/v3/contents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (result.status !== 200) {
    // Was previously swallowed as an empty result set, which is indistinguishable from a
    // genuine "no matches" and made auth/token failures silently look like bad search terms.
    throw new Error(`Search failed (HTTP ${result.status}): ${JSON.stringify(result.body)}`);
  }

  const data = result.body as { totalCount: number; documents: Array<Record<string, any>> };
  return {
    totalCount: data.totalCount ?? 0,
    // contentProfiles[i] corresponds to profileVersionIds[i] — when present, these can be used
    // directly as submit_ucb_workspace_generation's origin.profileId/profileVersionId without a
    // separate find_doccenter_profile lookup.
    results: (data.documents ?? []).map(d => ({
      title: d.title,
      format: d.format,
      contentVersionId: d.contentVersionId,
      teamSiteId: d.teamsite,
      modifiedDate: d.modifiedDate,
      description: d.description,
      contentProfiles: d.contentProfiles,
      profileVersionIds: d.profileVersionIds,
    })),
  };
}

// ================================================================
// Tool 2: get_template_form — Get template definition (inputs / forms)
// ================================================================
export async function getTemplateForm(params: { teamSiteId: string; versionId: string }): Promise<Record<string, unknown>> {
  const result = await seismicFetch(`/v3/teamsites/${params.teamSiteId}/livedocVersions/${params.versionId}`);
  if (result.status !== 200) {
    throw new Error(`Failed to load template: ${JSON.stringify(result.body)}`);
  }

  const body = result.body as Record<string, unknown>;
  // Normalize from Seismic PascalCase → camelCase (same logic as livedocRoutes.ts)
  return normalizeTemplate(body);
}

function pick(o: Record<string, unknown>, lc: string, pc: string): unknown {
  return o[lc] ?? o[pc];
}

function normInputArr(raw: unknown): Record<string, unknown>[] {
  const rawCols = ((raw as any) ?? []) as Array<Record<string, unknown>>;
  return rawCols.map(item => {
    const rawSub = (item.columns ?? item.Columns) as Array<Record<string, unknown>> | null;
    return {
      id: pick(item as any, "id", "Id"),
      name: pick(item as any, "name", "Name"),
      type: (pick(item as any, "type", "Type") ?? "STRING") as string,
      format: pick(item as any, "format", "Format") ?? null,
      columns: normInputArr(rawSub),
    };
  });
}

function normVlArr(raw: unknown): Record<string, unknown>[] {
  return ((raw as any) ?? []).map<Record<string, unknown>>(vl => ({
    variableListName: pick(vl, "variableListName", "VariableListName"),
    dataSourceId: pick(vl, "dataSourceId", "DataSourceId") ?? null,
    dataSourceName: pick(vl, "dataSourceName", "DataSourceName") ?? null,
    variableInputs: normInputArr((vl as any).variableInputs ?? (vl as any).VariableInputs),
  }));
}

function normFormsArr(raw: unknown): Record<string, unknown>[] {
  return ((raw as any) ?? []).map(f => ({
    id: pick(f, "id", "Id"),
    name: pick(f, "name", "Name"),
    isDefault: pick(f, "isDefault", "IsDefault") ?? false,
    outputs: (((f as any).outputs ?? (f as any).Outputs) as Array<Record<string, unknown>> | null)?.map(o => ({
      format: pick(o, "format", "Format"),
      name: pick(o, "name", "Name"),
    })),
  }));
}

function normManualSelect(raw: unknown): Promise<Record<string, unknown> | null> {
  if (!raw) return Promise.resolve(null);
  const r = raw as Record<string, unknown>;
  const items = ((r.manualSelectContentItems ?? r.ManualSelectContentItems) as any[]) ?? [];
  return Promise.all(items.map(i => {
    return Promise.resolve({
      id: pick(i, "id", "Id"),
      name: pick(i, "name", "Name"),
    });
  })).then(normalized => ({ manualSelectContentItems: normalized }));
}

function normalizeTemplate(body: Record<string, unknown>): Record<string, unknown> {
  body.adhocInputs = normInputArr(body.adhocInputs ?? body.AdhocInputs);
  body.variableListData = normVlArr(body.variableListData ?? body.VariableListData);
  body.forms = normFormsArr(body.forms ?? body.Forms);
  
  const msPromise = normManualSelect(body.manualSelectContentInput ?? body.ManualSelectContentInput);
  return Promise.resolve({ ...body, manualSelectContentInput: null }).then(b => {
    return msPromise.then(ms => ({ ...b, manualSelectContentInput: ms }));
  });
}

// ================================================================
// Tool 3: generate_live_doc — Submit LiveDoc generation request
// ================================================================
export async function generateLiveDoc(params: {
  teamSiteId: string;
  versionId: string;
  data: Record<string, unknown>;
}): Promise<{ generatedLivedocId: string; rawBody: unknown }> {
  const qp = params.data?.liveFormSellerTemplateId 
    ? `?liveFormSellerTemplateId=${encodeURIComponent(params.data.liveFormSellerTemplateId as string)}`
    : "";

  const result = await seismicFetch(
    `/v3/teamsites/${params.teamSiteId}/livedocVersions/${params.versionId}${qp}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params.data),
    }
  );

  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`Generation failed (${result.status}): ${JSON.stringify(result.body)}`);
  }

  const body = result.body as Record<string, unknown>;
  return {
    generatedLivedocId: (body.generatedLivedocId ?? body.id ?? body.GeneratedLivedocId ?? body.Id) as string,
    rawBody: body,
  };
}

// ================================================================
// Tool 4: poll_generation_status — Poll LiveDoc generation status
// ================================================================
// Same round-starvation risk as get_ucb_workspace_generation_status: poll internally for a
// bounded budget instead of returning after one check, so the chat loop's limited tool-call
// rounds aren't spent entirely on polling a still-running generation.
const GENERATION_POLL_BUDGET_MS = 25_000;
const GENERATION_POLL_INTERVAL_MS = 2_000;

export async function pollGenerationStatus(params: { generatedLivedocId: string }): Promise<{
  allDone: boolean;
  outputs: Array<{ id: string; status: string; format: string; name: string; fileName: string; errorString: string | null }>;
}> {
  const STATUS_NAMES = ["Queued", "Generating", "Completed", "Failed"];
  function statusName(raw: unknown): string {
    if (typeof raw === "number" && STATUS_NAMES[raw]) return STATUS_NAMES[raw];
    if (typeof raw === "string" && STATUS_NAMES.includes(raw)) return raw;
    return String(raw);
  }

  const deadline = Date.now() + GENERATION_POLL_BUDGET_MS;
  let outputs: Array<{ id: string; status: string; format: string; name: string; fileName: string; errorString: string | null }>;
  let allDone: boolean;

  while (true) {
    const result = await seismicFetch(`/v3/generatedLivedocs/${params.generatedLivedocId}`);
    if (result.status !== 200) {
      throw new Error(`Status check failed: ${JSON.stringify(result.body)}`);
    }

    const raw = result.body as Record<string, unknown>;
    const rawOutputs = (raw.outputs ?? raw.Outputs ?? []) as Array<Record<string, unknown>>;
    outputs = rawOutputs.map(o => ({
      id: o.id ?? (o.Id as string),
      status: statusName(o.status ?? o.Status),
      format: o.format ?? o.Format as string,
      name: o.name ?? o.Name as string,
      fileName: o.fileName ?? o.FileName as string,
      errorString: (o.errorString ?? o.ErrorString ?? null) as string | null,
    }));
    allDone = outputs.every(o => o.status === "Completed" || o.status === "Failed");

    if (allDone || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, GENERATION_POLL_INTERVAL_MS));
  }

  return { allDone, outputs };
}

// ================================================================
// Tool 5: get_form_result — Retrieve generation result (from in-memory store)
// ================================================================
export function setGenerationResult(token: string, data: Record<string, unknown>): void {
  _resultStore.set(token, { ...data, storedAt: Date.now() });
}

export function getGenerationResult(token: string): Record<string, unknown> | null {
  const entry = _resultStore.get(token);
  return entry ? entry : null;
}

const _resultStore = new Map<string, { generatedLivedocId: string; outputs: unknown[]; storedAt: number }>();

// ================================================================
// Tool: open_form_ui — Hand complex data entry off to the real form page
// (FormPage.tsx / FormBuilder.tsx) instead of collecting fields via chat.
// Returns a URL the client should open in a new tab, plus the token that
// get_form_result later reads back. Non-blocking: the agent does NOT wait
// here — the user submits on their own time, then either tells the agent
// or the agent's next turn calls get_form_result to check.
// ================================================================
export function openFormUi(params: {
  teamSiteId: string;
  versionId: string;
  context?: string;
  prefillValues?: Record<string, unknown>;
  // When present, the form page submits via the UCB Workspace generation endpoint instead
  // of the default download flow. Only pass these when the user actually asked to save to
  // Workspace/UCB — otherwise the form defaults to the normal generate-and-download path.
  workspace?: { spaceId: string; folderId: string; name?: string };
  origin?: { profileId: string; profileVersionId: string; contentLocation: string };
}): { url: string; token: string } {
  const token = crypto.randomUUID();

  const query = new URLSearchParams({
    teamSiteId: params.teamSiteId,
    versionId: params.versionId,
    token,
  });
  if (params.context) query.set("context", Buffer.from(params.context, "utf-8").toString("base64"));
  if (params.prefillValues) query.set("prefill", Buffer.from(JSON.stringify(params.prefillValues), "utf-8").toString("base64"));
  if (params.workspace) query.set("workspace", Buffer.from(JSON.stringify(params.workspace), "utf-8").toString("base64"));
  if (params.origin) query.set("origin", Buffer.from(JSON.stringify(params.origin), "utf-8").toString("base64"));

  return { url: `${CLIENT_BASE_URL}/fill?${query.toString()}`, token };
}

// ================================================================
// Tool 6: download_generated_file — Download output file
// ================================================================
export async function downloadGeneratedFile(params: { generatedLivedocId: string; outputId: string }): Promise<{ url: string; contentType: string }> {
  const dlResult = await seismicFetch(
    `/v3/generatedLivedocs/${params.generatedLivedocId}/outputs/${params.outputId}/content?redirect=false`
  );

  if (dlResult.status !== 200) {
    throw new Error(`Download URL fetch failed (${dlResult.status})`);
  }

  const urlData = dlResult.body as { url?: string; DownloadUrl?: string };
  const fileUrl = urlData.url ?? urlData.DownloadUrl;
  
  if (!fileUrl) {
    throw new Error("No download URL in response");
  }

  return { url: fileUrl, contentType: "application/octet-stream" };
}

// ================================================================
// UCB -> Workspace: generate a LiveDoc directly into a Workspace folder
// (as opposed to a downloadable file), then auto-commit + return a real
// browsable workspaceUrl. Mirrors mcp-seismic-livedoc's ucb-workspace tools.
// ================================================================

export async function findDocCenterProfile(params: { profileName: string; teamSiteId?: string }): Promise<Record<string, unknown>> {
  const result = await seismicFetch("/v2/users/profiles", {}, INTEGRATION_BASE_URL);
  if (result.status === 401 || result.status === 403) {
    return {
      error: "profile_lookup_unauthorized",
      message: `The Integration API rejected the request (HTTP ${result.status}) — the current token likely lacks the ` +
        "seismic.self.view/seismic.self.manage scope required to list assigned profiles. A manually-set SEISMIC_API_TOKEN " +
        "usually won't have this scope. Fall back to reading contentProfiles/profileVersionIds directly off search_templates results.",
    };
  }
  if (result.status !== 200) {
    return { error: `Listing profiles failed (HTTP ${result.status})`, detail: result.body };
  }

  const profiles = (result.body as Array<Record<string, unknown>>) ?? [];
  const nameLower = params.profileName.trim().toLowerCase();

  const toResult = (p: Record<string, unknown>) => ({
    profileId: pick(p, "id", "Id"),
    // The raw API field is versionId/VersionId — the caller needs it as profileVersionId
    // for submit_ucb_workspace_generation's origin, so rename it here rather than passing
    // the raw shape through (which silently omitted a usable profileVersionId key).
    profileVersionId: pick(p, "versionId", "VersionId"),
    name: pick(p, "name", "Name"),
    teamSiteId: pick(p, "teamSiteId", "TeamSiteId"),
    isDefault: pick(p, "isDefault", "IsDefault"),
    isPublished: pick(p, "isPublished", "IsPublished"),
  });

  let matches = profiles.filter(p => String(pick(p, "name", "Name") ?? "").toLowerCase() === nameLower);
  if (params.teamSiteId) {
    matches = matches.filter(p => String(pick(p, "teamSiteId", "TeamSiteId") ?? "") === params.teamSiteId);
  }
  if (matches.length > 0) {
    return { totalCount: matches.length, matches: matches.map(toResult) };
  }

  // No exact match — surface partial-name matches so the caller can disambiguate instead of guessing.
  const suggestions = profiles
    .filter(p => String(pick(p, "name", "Name") ?? "").toLowerCase().includes(nameLower))
    .map(toResult);
  return { totalCount: 0, matches: [], suggestions };
}

export async function listWorkspaceSpaces(): Promise<unknown> {
  const result = await seismicFetch("/v3/workspace/destinations/spaces", {}, INTERNAL_BASE_URL);
  if (result.status !== 200) {
    return { error: `Listing Workspace spaces failed (HTTP ${result.status})`, detail: result.body };
  }
  return result.body;
}

export async function listWorkspaceFolders(params: {
  spaceId: string;
  folderId?: string;
  offset?: number;
  limit?: number;
}): Promise<unknown> {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;
  const path = params.folderId
    ? `/v3/workspace/destinations/spaces/${encodeURIComponent(params.spaceId)}/folders/${encodeURIComponent(params.folderId)}/items?offset=${offset}&limit=${limit}`
    : `/v3/workspace/destinations/spaces/${encodeURIComponent(params.spaceId)}/roots`;
  const result = await seismicFetch(path, {}, INTERNAL_BASE_URL);
  if (result.status !== 200) {
    return { error: `Listing Workspace folder contents failed (HTTP ${result.status})`, detail: result.body };
  }
  return result.body;
}

interface PendingCommit {
  spaceId: string;
  fileId: string;
  fileVersionId: string;
  instanceId: string;
  stageId: string;
  stageRecordId: string;
  committed: boolean;
  committing?: Promise<{ committed: true } | { error: string; detail?: unknown }>;
}

const _pendingCommits = new Map<string, PendingCommit>();

export async function submitUcbWorkspaceGeneration(params: {
  teamSiteId: string;
  libraryContentVersionId: string;
  adHocInputs: Array<{ name: string; value: unknown }>;
  outputs: Array<{ format: string; name?: string; fileName?: string }>;
  variableListData?: Array<{ variableListName: string; variableInputs: Array<{ name: string; value: unknown }> }>;
  regionalFormat?: string;
  workspace: { spaceId: string; folderId: string; name: string; format: string };
  origin: { profileId: string; profileVersionId: string; contentLocation: string };
}): Promise<Record<string, unknown>> {
  // Validate up front with clear per-field messages — the model has previously called this
  // tool omitting required object/array fields entirely, which crashed with an opaque
  // "Cannot read properties of undefined" instead of a diagnosable error.
  const missing: string[] = [];
  if (!Array.isArray(params.outputs) || params.outputs.length === 0) missing.push("outputs (array with exactly one {format,...} entry)");
  if (!Array.isArray(params.adHocInputs)) missing.push("adHocInputs (array, can be empty)");
  if (!params.workspace?.spaceId) missing.push("workspace.spaceId");
  if (!params.workspace?.folderId) missing.push("workspace.folderId");
  if (!params.workspace?.name) missing.push("workspace.name");
  if (!params.workspace?.format) missing.push("workspace.format");
  if (!params.origin?.profileId) missing.push("origin.profileId");
  if (!params.origin?.profileVersionId) missing.push("origin.profileVersionId");
  if (!params.origin?.contentLocation) missing.push("origin.contentLocation");
  if (missing.length > 0) {
    return { error: "submit_ucb_workspace_generation is missing required fields", detail: `Missing or empty: ${missing.join(", ")}` };
  }
  if (params.outputs.length !== 1) {
    return { error: "Exactly one output is required for a UCB Workspace generation.", detail: `Got ${params.outputs.length} outputs.` };
  }

  const generationInput: Record<string, unknown> = {
    adHocInputs: params.adHocInputs,
    outputs: params.outputs,
  };
  if (params.variableListData) generationInput.variableListData = params.variableListData;
  if (params.regionalFormat) generationInput.regionalFormat = params.regionalFormat;

  const result = await seismicFetch(
    `/v3/teamsites/${params.teamSiteId}/livedocVersions/${params.libraryContentVersionId}/ucb-workspace-generations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationInput,
        workspace: params.workspace,
        origin: params.origin,
      }),
    }
  );
  if (result.status !== 200 && result.status !== 201) {
    return { error: `UCB Workspace generation submission failed (HTTP ${result.status})`, detail: result.body };
  }

  const body = result.body as Record<string, unknown>;
  const generationId = String(body.id ?? body.Id ?? "");
  const lifecycle = (body.lifecycle ?? body.Lifecycle ?? {}) as Record<string, unknown>;
  const workspace = (body.workspace ?? body.Workspace ?? {}) as Record<string, unknown>;

  const instanceId = String(lifecycle.instanceId ?? lifecycle.InstanceId ?? "");
  const stageId = String(lifecycle.stageId ?? lifecycle.StageId ?? "");
  const stageRecordId = String(lifecycle.stageRecordId ?? lifecycle.StageRecordId ?? "");
  const fileId = String(workspace.fileId ?? workspace.FileId ?? "");
  const fileVersionId = String(workspace.fileVersionId ?? workspace.FileVersionId ?? "");

  if (generationId && instanceId && stageId && stageRecordId && fileId && fileVersionId) {
    _pendingCommits.set(generationId, {
      spaceId: params.workspace.spaceId,
      fileId,
      fileVersionId,
      instanceId,
      stageId,
      stageRecordId,
      committed: false,
    });
  }

  return {
    generationId,
    workspaceFileName: params.workspace.name,
    message: "UCB Workspace generation submitted. Call get_ucb_workspace_generation_status to poll for completion.",
  };
}

async function commitToWorkspace(pending: PendingCommit): Promise<{ committed: true } | { error: string; detail?: unknown }> {
  const result = await seismicFetch(
    `/v3/workspace/spaces/${encodeURIComponent(pending.spaceId)}/files/${encodeURIComponent(pending.fileId)}/versions/${encodeURIComponent(pending.fileVersionId)}/livedoc/instance`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: pending.instanceId,
        stage: { id: pending.stageId, recordId: pending.stageRecordId },
        useCustomName: false,
      }),
    }
  );
  if (result.status !== 200 && result.status !== 202 && result.status !== 204) {
    return { error: `Committing the generated file to Workspace failed (HTTP ${result.status})`, detail: result.body };
  }
  pending.committed = true;
  return { committed: true };
}

// Polling budget for a single tool call: previously each call did exactly one status check, so
// a chat loop with a bounded number of tool-call rounds (MAX_TOOL_ROUNDS in agentChatRoutes.ts)
// could burn its whole round budget polling a slow-to-finish generation and hit the round limit
// before status ever reached "Ready" — the model then had no workspaceUrl to report but had
// already promised one, and fabricated it (observed live). Looping internally here collapses
// "poll every couple seconds until done" into one tool call for the common case.
const STATUS_POLL_BUDGET_MS = 25_000;
const STATUS_POLL_INTERVAL_MS = 2_000;

export async function getUcbWorkspaceGenerationStatus(params: { generationId: string }): Promise<Record<string, unknown>> {
  const deadline = Date.now() + STATUS_POLL_BUDGET_MS;
  let raw: Record<string, unknown>;

  while (true) {
    const result = await seismicFetch(`/v3/ucb-workspace-generations/${params.generationId}/status`);
    if (result.status !== 200) {
      return { error: `Status check failed (HTTP ${result.status})`, detail: result.body };
    }
    raw = result.body as Record<string, unknown>;
    const status = String(raw.status ?? raw.Status ?? "");
    if (status === "Ready" || Boolean(raw.isCompleted ?? raw.IsCompleted) || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }

  const status = String(raw.status ?? raw.Status ?? "");
  const isCompleted = Boolean(raw.isCompleted ?? raw.IsCompleted ?? false);

  const response: Record<string, unknown> = {
    generationId: String(raw.id ?? raw.Id ?? params.generationId),
    status,
    workspaceCommitted: false,
    formRecordId: raw.formRecordId ?? raw.FormRecordId ?? null,
  };

  // This is a terminal state (isCompleted: true) that is NOT "Ready", so without this check the
  // caller would poll forever until its own timeout instead of stopping immediately. The backend
  // now includes ErrorMessage on Failure (app-livedoc-service PublicAPIV3Controller.UcbWorkspace.cs) —
  // previously this endpoint had no error detail at all, so a Failure gave no clue why.
  if (isCompleted && status !== "Ready") {
    const errorMessage = String(raw.errorMessage ?? raw.ErrorMessage ?? "").trim();
    return {
      ...response,
      error: `UCB Workspace generation ended with status "${status}"${errorMessage ? `: ${errorMessage}` : ""}`,
    };
  }
  if (status !== "Ready") {
    return {
      ...response,
      message: `Generation is still "${status}" after ${STATUS_POLL_BUDGET_MS / 1000}s of polling. ` +
        "Call get_ucb_workspace_generation_status again to keep waiting — do not report a workspaceUrl yet.",
    };
  }

  const pending = _pendingCommits.get(params.generationId);
  if (!pending) {
    return {
      ...response,
      error: "Generation is Ready, but the Workspace commit context for this generationId was lost " +
        "(likely a server restart mid-flow). The generation must be resubmitted via submit_ucb_workspace_generation.",
    };
  }
  if (pending.committed) {
    return { ...response, workspaceCommitted: true, workspaceUrl: buildWorkspaceUrl(pending.fileId) };
  }

  if (!pending.committing) {
    pending.committing = commitToWorkspace(pending).finally(() => {
      pending.committing = undefined;
    });
  }
  const commitResult = await pending.committing;
  if ("error" in commitResult) {
    return { ...response, workspaceCommitted: false, commitError: commitResult.error, commitErrorDetail: commitResult.detail };
  }
  return { ...response, workspaceCommitted: true, workspaceUrl: buildWorkspaceUrl(pending.fileId) };
}
