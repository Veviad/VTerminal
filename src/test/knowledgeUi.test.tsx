import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  EmbeddingCatalogEntry,
  EmbeddingProfile,
  KnowledgeBucketDescriptor,
  KnowledgeBucketRef,
  KnowledgeDocumentIngestInput,
  KnowledgeDocumentMetadataUpdate,
  KnowledgeDocumentPage,
  KnowledgeJob,
  KnowledgePointId,
  QdrantImportInspection,
  QdrantImportInput,
  QdrantConnection,
  QdrantConnectionInput,
} from "../lib/types";

const api = vi.hoisted(() => ({
  knowledgeEmbeddingModelsList: vi.fn<() => Promise<EmbeddingCatalogEntry[]>>(),
  knowledgeEmbeddingModelInstall: vi.fn(() => Promise.resolve()),
  knowledgeEmbeddingModelCancel: vi.fn(() => Promise.resolve()),
  knowledgeEmbeddingProfileCreateCloud: vi.fn(() => Promise.resolve("profile-cloud")),
  knowledgeQdrantConnectionsList: vi.fn<() => Promise<QdrantConnection[]>>(),
  knowledgeQdrantConnectionSave: vi.fn<(input: QdrantConnectionInput) => Promise<string>>(() =>
    Promise.resolve("q1"),
  ),
  knowledgeQdrantConnectionTest: vi.fn<(id: string) => Promise<QdrantConnection>>(),
  knowledgeQdrantConnectionDelete: vi.fn(() => Promise.resolve()),
  knowledgeQdrantConnectionClearKey: vi.fn(() => Promise.resolve()),
  knowledgeBucketCreate: vi.fn(() => Promise.resolve("bucket")),
  knowledgeDocumentsList: vi.fn<
    (
      bucket: KnowledgeBucketRef,
      cursor?: KnowledgePointId | null,
      limit?: number,
    ) => Promise<KnowledgeDocumentPage>
  >(),
  knowledgeDocumentIngest: vi.fn<
    (input: KnowledgeDocumentIngestInput) => Promise<KnowledgeJob>
  >(() => Promise.resolve({} as KnowledgeJob)),
  knowledgeDocumentUpdate: vi.fn<
    (
      bucket: KnowledgeBucketRef,
      documentId: string,
      update: KnowledgeDocumentMetadataUpdate,
    ) => Promise<void>
  >(() => Promise.resolve()),
  knowledgeDocumentDelete: vi.fn<
    (bucket: KnowledgeBucketRef, documentId: string) => Promise<void>
  >(() => Promise.resolve()),
  knowledgeJobsList: vi.fn<() => Promise<KnowledgeJob[]>>(),
  knowledgeJobCancel: vi.fn(() => Promise.resolve({} as KnowledgeJob)),
  knowledgeJobRetry: vi.fn(() => Promise.resolve({} as KnowledgeJob)),
  knowledgeQdrantTurboQuantSet: vi.fn<
    (bucket: KnowledgeBucketRef, config: unknown) => Promise<void>
  >(() => Promise.resolve()),
  knowledgeQdrantImportInspect: vi.fn<
    (bucket: KnowledgeBucketRef) => Promise<QdrantImportInspection>
  >(),
  knowledgeQdrantImportSave: vi.fn<
    (bucket: KnowledgeBucketRef, input: QdrantImportInput) => Promise<void>
  >(() => Promise.resolve()),
  knowledgeQdrantImportRemove: vi.fn(() => Promise.resolve()),
  knowledgeBucketEmbed: vi.fn(() => Promise.resolve({} as KnowledgeJob)),
  knowledgeBucketSemanticEnable: vi.fn(() => Promise.resolve({} as KnowledgeJob)),
  knowledgeCliInstall: vi.fn(() => Promise.resolve("/Users/test/.local/bin/vterminal-docs")),
}));

vi.mock("../lib/tauri", () => api);

const { KnowledgeModelsSection, BUILTIN_EMBEDDING_MODEL_IDS } = await import(
  "../components/settings/KnowledgeModelsSection"
);
const { QdrantConnectionsSection } = await import(
  "../components/settings/QdrantConnectionsSection"
);
const { BucketChip, BucketPicker } = await import("../components/ai/BucketPicker");
const { RemoteDocumentsPanel } = await import(
  "../components/settings/RemoteDocumentsPanel"
);
const { TurboQuantPanel } = await import("../components/settings/TurboQuantPanel");
const { QdrantImportWizard } = await import("../components/settings/QdrantImportWizard");
const { emptyAiStream, useAppStore } = await import("../stores/appStore");

function model(
  id: (typeof BUILTIN_EMBEDDING_MODEL_IDS)[number],
  label: string,
  available = true,
): EmbeddingCatalogEntry {
  return {
    id,
    label,
    description: `${label} description`,
    provider: "local",
    model: id.slice("local/".length),
    dimensions: [768],
    default_dimension: 768,
    context_tokens: 512,
    download: available
      ? {
          repo_id: "veviad/models",
          filename: `${id.slice("local/".length)}.gguf`,
          size_bytes: 250_000_000,
          min_ram_gb: 2,
          requires_license: id === "local/embeddinggemma-300m",
        }
      : null,
    installed: false,
    available,
    unavailable_reason: available
      ? null
      : "Signed Veviad GGUF release artifact is not published yet",
    recommended: id === "local/qwen3-embedding-0.6b",
    privacy: "local",
  };
}

function cloudProfile(over: Partial<EmbeddingProfile> = {}): EmbeddingProfile {
  return {
    id: "openai/text-embedding-3-small/1536",
    fingerprint: "sha256:openai-small-1536",
    label: "text-embedding-3-small",
    provider: "openai",
    model: "text-embedding-3-small",
    revision: null,
    dimensions: 1536,
    pooling: "provider",
    normalized: true,
    query_prefix: null,
    document_prefix: null,
    max_tokens: 8191,
    distance: "cosine",
    available: true,
    ...over,
  };
}

const MODEL_LABELS = [
  "Qwen3 Embedding 0.6B",
  "Qwen3 Embedding 4B",
  "Qwen3 Embedding 8B",
  "EmbeddingGemma",
  "Multilingual E5 Base",
  "Multilingual E5 Large",
] as const;

function connection(over: Partial<QdrantConnection> = {}): QdrantConnection {
  return {
    id: "q1",
    label: "Production Qdrant",
    url: "https://example.cloud.qdrant.io:6333",
    has_api_key: true,
    allow_insecure: false,
    status: "connected",
    server_version: "1.18.1",
    last_checked_at: 0,
    error: null,
    ...over,
  };
}

function bucket(over: Partial<KnowledgeBucketDescriptor> = {}): KnowledgeBucketDescriptor {
  return {
    ref: { source: "local", bucket_id: "local-1" },
    label: "Runbooks",
    connection_label: null,
    profile: null,
    compatibility: "managed_compatible",
    compatibility_reason: null,
    attachable: true,
    writable: true,
    manageable: true,
    file_count: 2,
    chunk_count: 20,
    pending_count: 0,
    stale: false,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.knowledgeEmbeddingModelsList.mockResolvedValue(
    BUILTIN_EMBEDDING_MODEL_IDS.map((id, index) =>
      model(id, MODEL_LABELS[index], !id.includes("multilingual-e5")),
    ),
  );
  api.knowledgeQdrantConnectionsList.mockResolvedValue([]);
  api.knowledgeQdrantConnectionTest.mockResolvedValue(connection());
  api.knowledgeDocumentsList.mockResolvedValue({ documents: [], next_cursor: null });
  api.knowledgeJobsList.mockResolvedValue([]);
  api.knowledgeQdrantImportInspect.mockResolvedValue({
    vectors: [],
    samples: [],
    profiles: [],
    binding: null,
  });
  useAppStore.setState({
    docsEnabled: true,
    docBuckets: [],
    knowledgeBuckets: [],
    hasApiKey: {},
    sessions: [],
    aiStreams: {},
    sessionUi: {},
  });
});

describe("embedding model UX", () => {
  it("shows exactly the six local one-click models and only OpenAI/Mistral cloud profiles", async () => {
    render(<KnowledgeModelsSection selectedProfileId={null} onSelectProfile={vi.fn()} />);

    for (const label of MODEL_LABELS) expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getAllByText("Download & use")).toHaveLength(4);
    expect(screen.getAllByText("Coming soon")).toHaveLength(2);
    expect(screen.getAllByText(/Signed Veviad GGUF release artifact/)).toHaveLength(2);

    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Mistral")).toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByText("Gemini")).not.toBeInTheDocument();
  });

  it("does not offer a dead download action for unpublished signed E5 artifacts", async () => {
    render(<KnowledgeModelsSection selectedProfileId={null} onSelectProfile={vi.fn()} />);
    const e5 = (await screen.findByText("Multilingual E5 Base")).closest("article");
    expect(e5).not.toBeNull();
    expect(within(e5!).getByText("Coming soon")).toBeInTheDocument();
    expect(within(e5!).queryByText("Download & use")).not.toBeInTheDocument();
  });

  it("requires first-use privacy confirmation before creating a cloud profile", async () => {
    useAppStore.setState({ hasApiKey: { openai: true } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<KnowledgeModelsSection selectedProfileId={null} onSelectProfile={vi.fn()} />);
    const openAi = await screen.findByText("OpenAI");
    const use = within(openAi.closest("article")!).getByRole("button", { name: "Use profile" });
    fireEvent.click(use);
    expect(api.knowledgeEmbeddingProfileCreateCloud).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0][0]).toMatch(/document passages.*search queries/i);
    fireEvent.click(use);
    await waitFor(() => expect(api.knowledgeEmbeddingProfileCreateCloud).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it("selects the exact dimension-qualified id returned after cloud preflight", async () => {
    const profileId = "openai/text-embedding-3-small/1536";
    useAppStore.setState({ hasApiKey: { openai: true } });
    api.knowledgeEmbeddingProfileCreateCloud.mockResolvedValueOnce(profileId);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onSelectProfile = vi.fn();
    const view = render(
      <KnowledgeModelsSection selectedProfileId={null} onSelectProfile={onSelectProfile} />,
    );

    const openAi = await screen.findByText("OpenAI");
    fireEvent.click(within(openAi.closest("article")!).getByRole("button", { name: "Use profile" }));
    await waitFor(() => expect(onSelectProfile).toHaveBeenCalledWith(profileId));

    view.rerender(
      <KnowledgeModelsSection selectedProfileId={profileId} onSelectProfile={onSelectProfile} />,
    );
    expect(
      within(screen.getByText("OpenAI").closest("article")!).getByRole("button", {
        name: "Selected",
      }),
    ).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("restores and reuses the backend's dimension-qualified cloud profile id", async () => {
    useAppStore.setState({ hasApiKey: { openai: true } });
    const profile = cloudProfile();
    const onSelectProfile = vi.fn();
    render(
      <KnowledgeModelsSection
        selectedProfileId={profile.id}
        onSelectProfile={onSelectProfile}
        readyProfiles={[profile]}
      />,
    );

    const openAi = await screen.findByText("OpenAI");
    const use = within(openAi.closest("article")!).getByRole("button", { name: "Selected" });
    fireEvent.click(use);

    expect(onSelectProfile).toHaveBeenCalledWith("openai/text-embedding-3-small/1536");
    expect(api.knowledgeEmbeddingProfileCreateCloud).not.toHaveBeenCalled();
  });

  it("requires explicit EmbeddingGemma license acceptance and passes it to the backend", async () => {
    render(<KnowledgeModelsSection selectedProfileId={null} onSelectProfile={vi.fn()} />);
    const gemma = (await screen.findByText("EmbeddingGemma")).closest("article")!;
    const download = within(gemma).getByRole("button", { name: "Download & use" });
    expect(download).toBeDisabled();
    fireEvent.click(within(gemma).getByRole("checkbox", { name: /Accept EmbeddingGemma/ }));
    expect(download).toBeEnabled();
    fireEvent.click(download);
    await waitFor(() =>
      expect(api.knowledgeEmbeddingModelInstall).toHaveBeenCalledWith(
        "local/embeddinggemma-300m",
        expect.any(Function),
        true,
      ),
    );
  });
});

describe("Qdrant credential UX", () => {
  it("never renders a stored key and keeps it when an edit leaves the key field blank", async () => {
    api.knowledgeQdrantConnectionsList.mockResolvedValue([connection()]);
    render(
      <QdrantConnectionsSection buckets={[]} selectedProfileId={null} onChanged={vi.fn()} />,
    );

    await screen.findByText("Production Qdrant");
    fireEvent.click(screen.getByTitle("Edit connection or replace its key"));
    const key = screen.getByLabelText("Qdrant API key") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    expect(key.placeholder).toMatch(/stored.*replace/i);

    fireEvent.click(screen.getByRole("button", { name: "Save & test" }));
    await waitFor(() => expect(api.knowledgeQdrantConnectionSave).toHaveBeenCalled());
    const submitted = api.knowledgeQdrantConnectionSave.mock.calls[0][0];
    expect(submitted).not.toHaveProperty("api_key");
    expect(JSON.stringify(submitted)).not.toContain("secret");
  });

  it("requires an explicit warning acknowledgement for keyed non-local HTTP", async () => {
    render(
      <QdrantConnectionsSection buckets={[]} selectedProfileId={null} onChanged={vi.fn()} />,
    );
    await waitFor(() => expect(api.knowledgeQdrantConnectionsList).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "Lab" } });
    fireEvent.change(screen.getByLabelText("Qdrant URL"), {
      target: { value: "http://qdrant.example.test:6333" },
    });
    const save = screen.getByRole("button", { name: "Save & test" });
    expect(save).toBeDisabled();
    expect(screen.getByText(/API key and document data can be read in transit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(save).toBeEnabled();
  });
});

describe("mixed-source bucket attachment", () => {
  it("groups local and Qdrant buckets, hides incompatible collections, and stores the full ref", () => {
    const remote = bucket({
      ref: { source: "qdrant", connection_id: "q1", collection: "engineering" },
      label: "Engineering",
      connection_label: "Production Qdrant",
    });
    const incompatible = bucket({
      ref: { source: "qdrant", connection_id: "q1", collection: "legacy" },
      label: "Legacy vectors",
      connection_label: "Production Qdrant",
      compatibility: "incompatible",
      attachable: false,
    });
    useAppStore.setState({
      knowledgeBuckets: [bucket(), remote, incompatible],
      sessions: [
        {
          id: "session",
          shell: "/bin/zsh",
          cwd: null,
          createdAt: "2026-08-13T00:00:00.000Z",
          exited: false,
          exitCode: null,
          hostId: null,
          hostLabel: null,
          userTitle: null,
          aiTitle: null,
          ordinal: 1,
        },
      ],
      aiStreams: { session: emptyAiStream() },
    });

    render(<BucketPicker sessionId="session" />);
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("Production Qdrant")).toBeInTheDocument();
    expect(screen.queryByText("Legacy vectors")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Engineering").closest("label")!.querySelector("input")!);
    expect(useAppStore.getState().aiStreams.session.attachedBucketRefs).toEqual([
      { source: "qdrant", connection_id: "q1", collection: "engineering" },
    ]);
    expect(useAppStore.getState().aiStreams.session.attachedBucketIds).toEqual([]);
  });

  it("renders source-qualified chips so equally named buckets remain distinguishable", () => {
    render(
      <BucketChip
        label="Runbooks"
        source="qdrant"
        connectionLabel="Production Qdrant"
        chunkCount={20}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText("Qdrant / Production Qdrant / Runbooks")).toBeInTheDocument();
  });

  it("warns when attached buckets require multiple local embedding models", () => {
    const profile = (id: string) => ({
      id,
      fingerprint: `sha256:${id}`,
      label: id,
      provider: "local" as const,
      model: id,
      revision: "r1",
      dimensions: 768,
      pooling: "mean" as const,
      normalized: true,
      query_prefix: null,
      document_prefix: null,
      max_tokens: 512,
      distance: "cosine" as const,
      available: true,
    });
    const first = bucket({ label: "First", profile: profile("model-a") });
    const second = bucket({
      ref: { source: "local", bucket_id: "local-2" },
      label: "Second",
      profile: profile("model-b"),
    });
    useAppStore.setState({
      sessions: [
        {
          id: "session",
          shell: "/bin/zsh",
          cwd: null,
          createdAt: "2026-08-13T00:00:00Z",
          exited: false,
          exitCode: null,
          hostId: null,
          hostLabel: null,
          userTitle: null,
          aiTitle: null,
          ordinal: 1,
        },
      ],
      knowledgeBuckets: [first, second],
      aiStreams: {
        session: {
          ...emptyAiStream(),
          attachedBucketRefs: [first.ref, second.ref],
          attachedBucketIds: ["local-1", "local-2"],
        },
      },
    });
    render(<BucketPicker sessionId="session" />);
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(screen.getByText(/need 2 local embedding models/i)).toBeInTheDocument();
  });
});

describe("remote document management", () => {
  const remote = () =>
    bucket({
      ref: { source: "qdrant", connection_id: "q1", collection: "engineering" },
      label: "Engineering",
      connection_label: "Production Qdrant",
    });

  const page = (next: string | null = null): KnowledgeDocumentPage => ({
    documents: [
      {
        point_id: "manifest-1",
        manifest: {
          document_id: "doc-1",
          source_id: null,
          revision: 3,
          state: "active",
          content_sha256: "a".repeat(64),
          title: "Deploy guide",
          source_uri: "deploy.md",
          mime_type: "text/markdown",
          chunk_count: 8,
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
        },
      },
    ],
    next_cursor: next,
  });

  it("loads manifests lazily and returns the opaque cursor unchanged", async () => {
    api.knowledgeDocumentsList
      .mockResolvedValueOnce(page("opaque-cursor"))
      .mockResolvedValueOnce({ documents: [], next_cursor: null });
    render(<RemoteDocumentsPanel bucket={remote()} onChanged={vi.fn()} />);
    expect(api.knowledgeDocumentsList).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Documents/ }));
    expect(await screen.findByText("Deploy guide")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.knowledgeDocumentsList).toHaveBeenCalledTimes(2));
    expect(api.knowledgeDocumentsList.mock.calls[1][1]).toBe("opaque-cursor");
  });

  it("updates metadata and deletes using the exact document id", async () => {
    api.knowledgeDocumentsList.mockResolvedValue(page());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<RemoteDocumentsPanel bucket={remote()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Documents/ }));
    await screen.findByText("Deploy guide");
    fireEvent.click(screen.getByTitle("Edit metadata"));
    fireEvent.change(screen.getByLabelText("Title for Deploy guide"), {
      target: { value: "Deployment guide" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Deploy guide" }));
    await waitFor(() => expect(api.knowledgeDocumentUpdate).toHaveBeenCalled());
    expect(api.knowledgeDocumentUpdate.mock.calls[0][1]).toBe("doc-1");
    expect(api.knowledgeDocumentUpdate.mock.calls[0][2]).toMatchObject({
      title: "Deployment guide",
      source_uri: "deploy.md",
      mime_type: "text/markdown",
    });

    fireEvent.click(screen.getByTitle("Delete document"));
    await waitFor(() => expect(api.knowledgeDocumentDelete).toHaveBeenCalled());
    expect(api.knowledgeDocumentDelete.mock.calls[0][1]).toBe("doc-1");
    confirm.mockRestore();
  });

  it("extracts selected files and queues the source-qualified ingest request", async () => {
    render(<RemoteDocumentsPanel bucket={remote()} onChanged={vi.fn()} />);
    const file = new File(["# Reset\n\nRestart the service."], "runbook.md", {
      type: "text/markdown",
      lastModified: 42,
    });
    fireEvent.change(screen.getByLabelText("Upload documents to Engineering"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(api.knowledgeDocumentIngest).toHaveBeenCalled());
    expect(api.knowledgeDocumentIngest.mock.calls[0][0]).toMatchObject({
      bucket: { source: "qdrant", connection_id: "q1", collection: "engineering" },
      title: "runbook.md",
      source_uri: "runbook.md",
      mime_type: "text/markdown",
      mtime_ms: 42,
    });
    expect(api.knowledgeDocumentIngest.mock.calls[0][0].pages[0].text).toContain("Restart");
  });
});

describe("TurboQuant controls", () => {
  it("offers only sidecar presets and confirms aggressive compression", async () => {
    const remote = bucket({
      ref: { source: "qdrant", connection_id: "q1", collection: "engineering" },
      label: "Engineering",
      connection_label: "Production Qdrant",
      quantization: { state: "off" },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<TurboQuantPanel bucket={remote} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByText("Advanced · TurboQuant"));
    const select = screen.getByRole("combobox");
    expect(within(select).queryByRole("option", { name: /turbo4/i })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "bits2" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(api.knowledgeQdrantTurboQuantSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.knowledgeQdrantTurboQuantSet).toHaveBeenCalled());
    expect(api.knowledgeQdrantTurboQuantSet).toHaveBeenCalledWith(remote.ref, {
      bits: "bits2",
      always_ram: false,
    });
    confirm.mockRestore();
  });
});

describe("guided Qdrant import", () => {
  it("requires an exact compatible profile and explicit model attestation", async () => {
    api.knowledgeQdrantImportInspect.mockResolvedValue({
      vectors: [{ name: "content", size: 768, distance: "Cosine", data_type: "float32" }],
      samples: [
        { point_id: "p1", payload: { body: "hello", doc: "d1", title: "Greeting" } },
      ],
      profiles: [
        {
          id: "profile-768",
          fingerprint: "sha256:768",
          label: "E5 Base",
          provider: "local",
          model: "multilingual-e5-base",
          revision: "r1",
          dimensions: 768,
          pooling: "mean",
          normalized: true,
          query_prefix: "query: ",
          document_prefix: "passage: ",
          max_tokens: 512,
          distance: "cosine",
          available: true,
        },
        {
          id: "profile-1024",
          fingerprint: "sha256:1024",
          label: "Wrong dimension",
          provider: "local",
          model: "other",
          revision: "r1",
          dimensions: 1024,
          pooling: "mean",
          normalized: true,
          query_prefix: null,
          document_prefix: null,
          max_tokens: 512,
          distance: "cosine",
          available: true,
        },
      ],
      binding: null,
    });
    const candidate = bucket({
      ref: { source: "qdrant", connection_id: "q1", collection: "existing" },
      label: "Existing",
      compatibility: "needs_import",
      attachable: false,
    });
    render(<QdrantImportWizard bucket={candidate} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Import existing collection/ }));
    expect(await screen.findByText("E5 Base · 768d")).toBeInTheDocument();
    expect(screen.queryByText(/Wrong dimension/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByText("Text field *").querySelector("input")!, {
      target: { value: "body" },
    });
    fireEvent.change(screen.getByText("Document ID field *").querySelector("input")!, {
      target: { value: "doc" },
    });
    const save = screen.getByRole("button", { name: "Save import binding" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByText(/I attest that this is the exact original model/).closest("label")!.querySelector("input")!);
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.knowledgeQdrantImportSave).toHaveBeenCalled());
    expect(api.knowledgeQdrantImportSave.mock.calls[0][1]).toMatchObject({
      vector_name: "content",
      profile_id: "profile-768",
      text_field: "body",
      document_id_field: "doc",
      model_attested: true,
    });
  });
});
