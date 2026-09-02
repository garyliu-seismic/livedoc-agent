import express, { Express, Request, Response, NextFunction } from "express";
import { setRuntimeToken as setMcpRuntimeToken, setGenerationResult, getGenerationResult } from "./mcp-tools.js";

const BASE_URL = process.env.SEISMIC_BASE_URL ?? "https://api.seismic.com/livedoc";
const STATUS_NAMES = ["Queued", "Generating", "Completed", "Failed"];

let _runtimeToken = "";

function getToken(): string {
  return _runtimeToken || process.env.SEISMIC_API_TOKEN || "";
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}`, ...extra };
}

async function seismicFetch(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: options.method,
    body: options.body,
    headers: { ...authHeaders(), ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

function statusName(raw: unknown): string {
  if (typeof raw === "number" && STATUS_NAMES[raw]) return STATUS_NAMES[raw];
  if (typeof raw === "string" && STATUS_NAMES.includes(raw)) return raw;
  return String(raw);
}

type Rec = Record<string, unknown>;

function pick(o: Rec, lc: string, pc: string): unknown { return o[lc] ?? o[pc]; }

function normInputItem(item: Rec): Rec {
  const rawCols = ((item.columns ?? item.Columns) as Rec[] | null) ?? [];
  return {
    id:      pick(item, "id",     "Id"),
    name:    pick(item, "name",   "Name"),
    type:    pick(item, "type",   "Type") ?? "STRING",
    format:  pick(item, "format", "Format") ?? null,
    columns: rawCols.map(normInputItem),
  };
}

function normInputArr(raw: unknown): Rec[] {
  return ((raw as Rec[] | null) ?? []).map(normInputItem);
}

function normVlArr(raw: unknown): Rec[] {
  return ((raw as Rec[] | null) ?? []).map(vl => ({
    variableListName: pick(vl as Rec, "variableListName", "VariableListName"),
    dataSourceId:     pick(vl as Rec, "dataSourceId",     "DataSourceId")     ?? null,
    dataSourceName:   pick(vl as Rec, "dataSourceName",   "DataSourceName")   ?? null,
    variableInputs:   normInputArr((vl as Rec).variableInputs ?? (vl as Rec).VariableInputs),
  }));
}

function normFormsArr(raw: unknown): Rec[] {
  return ((raw as Rec[] | null) ?? []).map(f => ({
    id:        pick(f as Rec, "id",        "Id"),
    name:      pick(f as Rec, "name",      "Name"),
    isDefault: pick(f as Rec, "isDefault", "IsDefault") ?? false,
    outputs:   ((((f as Rec).outputs ?? (f as Rec).Outputs) as Rec[] | null) ?? []).map(o => ({
      format: pick(o, "format", "Format"),
      name:   pick(o, "name",   "Name"),
    })),
  }));
}

// C# bool property names here don't follow simple camelCase (AllowPDF, IncludeStandardPPTX),
// so check several literal casings rather than a single lowercase/PascalCase pick().
function boolField(item: Rec, ...keys: string[]): boolean {
  for (const k of keys) { if (typeof item[k] === "boolean") return item[k] as boolean; }
  return false;
}

const CANDIDATE_PAGE_SIZE = 10;

// Resolves real content candidates for one manualSelectContentItem, mirroring
// mcp-seismic-livedoc's resolveManualSelectCandidates: prefers the item's own filter/format
// flags (the template author's actual search criteria) over a name-based guess, since the
// item's display name (e.g. "sp3") is unrelated to what should actually be searched for.
async function resolveCandidatesForItem(item: Rec): Promise<{ candidates: Rec[]; totalCount: number }> {
  const name = String(pick(item, "name", "Name") ?? "");
  const contentType = String(pick(item, "contentType", "ContentType") ?? "");
  const filter = (pick(item, "filter", "Filter") as unknown[] | null) ?? [];
  const rawIsApplyAllFilter = pick(item, "isApplyAllFilter", "IsApplyAllFilter");
  const isApplyAllFilter = typeof rawIsApplyAllFilter === "boolean" ? rawIsApplyAllFilter : true;

  let allowPptx = boolField(item, "allowPptx", "AllowPptx");
  let includeStandardPptx = boolField(item, "includeStandardPptx", "IncludeStandardPPTX", "IncludeStandardPptx");
  let includeLiveDoc = boolField(item, "includeLiveDoc", "IncludeLiveDoc");
  let allowPdf = boolField(item, "allowPdf", "AllowPDF", "AllowPdf");

  if (!allowPptx && !allowPdf) {
    const isSlideType = ["ExternalSlides", "LiveSlide", "ExternalStaticSlides"].includes(contentType);
    allowPptx = isSlideType; includeStandardPptx = isSlideType; includeLiveDoc = isSlideType; allowPdf = !isSlideType;
  }

  const body: Rec = {
    allowPptx, includeStandardPptx, includeLiveDoc, allowPdf,
    page: { size: CANDIDATE_PAGE_SIZE, from: 0 },
    orderBy: [{ attr: "modifiedDate", direction: "DESC" }],
  };
  if (filter.length > 0) {
    // Combining the item's own filter with a searchText:name guess over-constrains the query
    // and silently returns zero results (verified live), so they're mutually exclusive here.
    body.filter = filter;
    body.isApplyAllFilter = isApplyAllFilter;
  } else {
    body.searchText = name;
  }

  const result = await seismicFetch("/v3/contents", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (result.status !== 200) return { candidates: [], totalCount: 0 };
  const data = result.body as { documents?: Rec[]; totalCount?: number };
  const candidates = (data.documents ?? []).slice(0, CANDIDATE_PAGE_SIZE).map(d => ({
    versionId: pick(d, "contentVersionId", "ContentVersionId"),
    sourceBlobId: pick(d, "sourceBlobId", "SourceBlobId"),
    title: pick(d, "title", "Title"),
    format: pick(d, "format", "Format"),
  }));
  return { candidates, totalCount: data.totalCount ?? candidates.length };
}

async function normManualSelect(raw: unknown): Promise<Rec | null> {
  if (!raw) return null;
  const r = raw as Rec;
  const items = ((r.manualSelectContentItems ?? r.ManualSelectContentItems) as Rec[] | null) ?? [];
  const normalized = await Promise.all(items.map(async i => {
    const contentType = (pick(i, "contentType", "ContentType") as string | null) ?? null;
    const base = {
      id:           pick(i, "id",           "Id"),
      name:         pick(i, "name",         "Name"),
      isInclude:    pick(i, "isInclude",    "IsInclude")    ?? false,
      orderIndex:   pick(i, "orderIndex",   "OrderIndex")   ?? 0,
      contentType,
      previewBlobId:pick(i, "previewBlobId","PreviewBlobId")?? null,
    };
    // "Group"/"Section" items are already fully valid as returned — everything else needs
    // real content resolved via search before submission (denylist, not allowlist, since the
    // GET vocabulary here — e.g. "ExternalSlides" — doesn't match the submission enum 1:1).
    if (contentType === "Group" || contentType === "Section" || !contentType) return base;
    const { candidates, totalCount } = await resolveCandidatesForItem(i);
    return { ...base, candidates, candidatesTotalCount: totalCount };
  }));
  return { manualSelectContentItems: normalized };
}

function normImageUpload(raw: unknown): Rec | null {
  if (!raw) return null;
  const r = raw as Rec;
  const items = ((r.imageUploadContentItems ?? r.ImageUploadContentItems) as Rec[] | null) ?? [];
  return {
    imageUploadContentItems: items.map(i => ({
      id:     pick(i, "id",     "Id"),
      name:   pick(i, "name",   "Name"),
      blobId: pick(i, "blobId", "BlobId") ?? null,
    })),
  };
}

export function registerRoutes(app: Express) {
  // Hot-update the Seismic API token without restarting the server.
  // Called by the MCP open_form_ui handler before returning the form URL.
  app.post("/api/set-token", (req: Request, res: Response) => {
    const token = (req.body as Record<string, unknown>).token;
    if (typeof token !== "string" || !token) return res.status(400).json({ error: "token required" });
    _runtimeToken = token;
    setMcpRuntimeToken(token);
    res.json({ ok: true });
  });

  // Store generation result (called by form UI on completion) — shared with
  // the get_form_result MCP tool via mcp-tools.ts's in-memory store.
  app.post("/api/result/:token", (req: Request, res: Response) => {
    setGenerationResult(req.params.token, req.body);
    res.json({ ok: true });
  });

  // Retrieve generation result (mirrors get_form_result MCP tool, for debugging)
  app.get("/api/result/:token", (req: Request, res: Response) => {
    const entry = getGenerationResult(req.params.token);
    if (!entry) return res.status(404).json({ error: "Result not found — form may not have completed yet" });
    res.json(entry);
  });
  // Search templates
  app.post("/api/search", async (req: Request, res: Response) => {
    const size = Math.min(req.body.page_size ?? 10, 50);
    const result = await seismicFetch("/v3/contents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchText: req.body.searchText ?? "",
        allowPptx: true,
        includeLiveDoc: true,
        allowPdf: false,
        page: { size, from: 0 },
        orderBy: [{ attr: "modifiedDate", direction: "DESC" }],
      }),
    });
    if (result.status !== 200) return res.status(result.status).json({ error: "Search failed", detail: result.body });
    const data = result.body as { totalCount: number; documents: Array<Record<string, unknown>> };
    res.json({
      totalCount: data.totalCount,
      results: data.documents.map(d => ({
        title: d.title,
        format: d.format,
        contentVersionId: d.contentVersionId,
        teamSiteId: d.teamsite,
        modifiedDate: d.modifiedDate,
        description: d.description,
      })),
    });
  });

  // Get template inputs
  app.get("/api/template/:teamSiteId/:versionId", async (req: Request, res: Response) => {
    const { teamSiteId, versionId } = req.params;
    const result = await seismicFetch(`/v3/teamsites/${teamSiteId}/livedocVersions/${versionId}`);
    if (result.status !== 200) return res.status(result.status).json({ error: "Failed to load template", detail: result.body });
    // API returns both PascalCase and camelCase keys — deep-normalize to camelCase
    const body = result.body as Record<string, unknown>;
    body.adhocInputs      = normInputArr(body.adhocInputs      ?? body.AdhocInputs);
    body.variableListData = normVlArr(body.variableListData     ?? body.VariableListData);
    body.forms            = normFormsArr(body.forms             ?? body.Forms);
    body.manualSelectContentInput = await normManualSelect(body.manualSelectContentInput ?? body.ManualSelectContentInput);
    body.imageUploadContentInput  = normImageUpload(body.imageUploadContentInput   ?? body.ImageUploadContentInput);
    delete body.AdhocInputs; delete body.VariableListData; delete body.Forms;
    delete body.ManualSelectContentInput; delete body.ImageUploadContentInput;
    res.json(body);
  });

  // Submit generation
  app.post("/api/generate/:teamSiteId/:versionId", async (req: Request, res: Response) => {
    const { teamSiteId, versionId } = req.params;
    const liveFormSellerId = req.query.liveFormSellerTemplateId as string | undefined;
    const qp = liveFormSellerId ? `?liveFormSellerTemplateId=${encodeURIComponent(liveFormSellerId)}` : "";
    const result = await seismicFetch(
      `/v3/teamsites/${teamSiteId}/livedocVersions/${versionId}${qp}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) }
    );
    if (result.status !== 200 && result.status !== 201) {
      return res.status(result.status).json({ error: "Generation failed", detail: result.body });
    }
    const body = result.body as Record<string, unknown>;
    const generatedLivedocId = (body.generatedLivedocId ?? body.id ?? body.GeneratedLivedocId ?? body.Id) as string;
    res.json({ generatedLivedocId, rawBody: body });
  });

  // Poll status
  app.get("/api/status/:generatedLivedocId", async (req: Request, res: Response) => {
    const result = await seismicFetch(`/v3/generatedLivedocs/${req.params.generatedLivedocId}`);
    if (result.status !== 200) {
      const detail = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
      return res.status(result.status).json({ error: `Status check failed (HTTP ${result.status}): ${detail}`, detail: result.body });
    }
    const raw = result.body as Record<string, unknown>;
    const rawOutputs = (raw.outputs ?? raw.Outputs ?? []) as Array<Record<string, unknown>>;
    const outputs = rawOutputs.map(o => ({
      id: (o.id ?? o.Id) as string,
      status: statusName(o.status ?? o.Status),
      format: (o.format ?? o.Format) as string,
      name: (o.name ?? o.Name) as string,
      fileName: (o.fileName ?? o.FileName) as string,
      errorString: (o.errorString ?? o.ErrorString ?? null) as string | null,
    }));
    const allDone = outputs.every(o => o.status === "Completed" || o.status === "Failed");
    res.json({ generatedLivedocId: raw.id ?? raw.Id, allDone, outputs });
  });

  // Download a generated output (proxy-stream by outputId)
  app.get("/api/download/:outputId", async (req: Request, res: Response, _next: NextFunction) => {
    // outputId here is the output's own id from status — we need the generatedLivedocId too.
    // The client passes generatedLivedocId as a query param.
    const generatedLivedocId = req.query.jobId as string | undefined;
    if (!generatedLivedocId) return res.status(400).json({ error: "Missing jobId query param" });
    const dlResult = await seismicFetch(
      `/v3/generatedLivedocs/${generatedLivedocId}/outputs/${req.params.outputId}/content?redirect=false`
    );
    if (dlResult.status !== 200) return res.status(dlResult.status).json({ error: "Download URL fetch failed", detail: dlResult.body });
    const urlData = dlResult.body as { url?: string; downloadUrl?: string; Url?: string; DownloadUrl?: string };
    const fileUrl = urlData.url ?? urlData.downloadUrl ?? urlData.Url ?? urlData.DownloadUrl;
    if (!fileUrl) return res.status(500).json({ error: "No URL in download response", detail: dlResult.body });

    // Stream the file to the client
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return res.status(fileRes.status).json({ error: "File download failed" });
    const contentType = fileRes.headers.get("content-type") ?? "application/octet-stream";
    const contentDisposition = fileRes.headers.get("content-disposition") ?? "attachment";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", contentDisposition);
    const buf = await fileRes.arrayBuffer();
    res.send(Buffer.from(buf));
  });

  // Image upload proxy
  app.post("/api/image/upload", express.raw({ type: "application/octet-stream", limit: "11mb" }), async (req: Request, res: Response) => {
    const result = await seismicFetch("/v3/images/upload", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: req.body as unknown as BodyInit,
    });
    res.status(result.status).json(result.body);
  });
}
