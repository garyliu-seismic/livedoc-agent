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

async function seismicFetch(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}
): Promise<{ status: number; body: unknown }> {
  const url = `${BASE_URL}${path}`;
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
