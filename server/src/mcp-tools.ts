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

async function seismicFetch(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
  base: string = BASE_URL
): Promise<{ status: number; body: unknown }> {
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method: options.method ?? "GET",
    body: options.body,
    headers: { ...authHeaders(), ...(options.headers ?? {}) },
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
}): Promise<{ results: Array<{ title: string; format: string; contentVersionId: string; teamSiteId: string; modifiedDate: string; description: string }>; totalCount: number }> {
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
    return { results: [], totalCount: 0 };
  }

  const data = result.body as { totalCount: number; documents: Array<Record<string, string>> };
  return {
    totalCount: data.totalCount ?? 0,
    results: (data.documents ?? []).map(d => ({
      title: d.title,
      format: d.format,
      contentVersionId: d.contentVersionId,
      teamSiteId: d.teamsite,
      modifiedDate: d.modifiedDate,
      description: d.description,
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
export async function pollGenerationStatus(params: { generatedLivedocId: string }): Promise<{ 
  allDone: boolean; 
  outputs: Array<{ id: string; status: string; format: string; name: string; fileName: string; errorString: string | null }>;
}> {
  const result = await seismicFetch(`/v3/generatedLivedocs/${params.generatedLivedocId}`);
  if (result.status !== 200) {
    throw new Error(`Status check failed: ${JSON.stringify(result.body)}`);
  }

  const raw = result.body as Record<string, unknown>;
  const rawOutputs = (raw.outputs ?? raw.Outputs ?? []) as Array<Record<string, unknown>>;
  
  const STATUS_NAMES = ["Queued", "Generating", "Completed", "Failed"];
  function statusName(raw: unknown): string {
    if (typeof raw === "number" && STATUS_NAMES[raw]) return STATUS_NAMES[raw];
    if (typeof raw === "string" && STATUS_NAMES.includes(raw)) return raw;
    return String(raw);
  }

  const outputs = rawOutputs.map(o => ({
    id: o.id ?? o.Id as string,
    status: statusName(o.status ?? o.Status),
    format: o.format ?? o.Format as string,
    name: o.name ?? o.Name as string,
    fileName: o.fileName ?? o.FileName as string,
    errorString: (o.errorString ?? o.ErrorString ?? null) as string | null,
  }));

  const allDone = outputs.every(o => o.status === "Completed" || o.status === "Failed");

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
}): { url: string; token: string } {
  const token = crypto.randomUUID();

  const query = new URLSearchParams({
    teamSiteId: params.teamSiteId,
    versionId: params.versionId,
    token,
  });
  if (params.context) query.set("context", Buffer.from(params.context, "utf-8").toString("base64"));
  if (params.prefillValues) query.set("prefill", Buffer.from(JSON.stringify(params.prefillValues), "utf-8").toString("base64"));

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
  const matches = profiles.filter(p => {
    const name = String(p.name ?? p.Name ?? "").toLowerCase();
    const teamSiteOk = !params.teamSiteId || String(p.teamSiteId ?? p.TeamSiteId ?? "") === params.teamSiteId;
    return teamSiteOk && name.includes(nameLower);
  });

  return { matches };
}

export async function listWorkspaceSpaces(): Promise<unknown> {
  const result = await seismicFetch("/v3/workspace/destinations/spaces");
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
  const result = await seismicFetch(path);
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

export async function getUcbWorkspaceGenerationStatus(params: { generationId: string }): Promise<Record<string, unknown>> {
  const result = await seismicFetch(`/v3/ucb-workspace-generations/${params.generationId}/status`);
  if (result.status !== 200) {
    return { error: `Status check failed (HTTP ${result.status})`, detail: result.body };
  }
  const raw = result.body as Record<string, unknown>;
  const status = String(raw.status ?? raw.Status ?? "");

  const response: Record<string, unknown> = {
    generationId: String(raw.id ?? raw.Id ?? params.generationId),
    status,
    workspaceCommitted: false,
  };

  if (status !== "Ready") return response;

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

  const commitResult = await commitToWorkspace(pending);
  if ("error" in commitResult) {
    return { ...response, workspaceCommitted: false, commitError: commitResult.error, commitErrorDetail: commitResult.detail };
  }
  return { ...response, workspaceCommitted: true, workspaceUrl: buildWorkspaceUrl(pending.fileId) };
}
