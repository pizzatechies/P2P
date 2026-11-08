import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { api, streamSse } from "../api";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { ErrorText } from "../components/ui";
import { timeAgo } from "../format";
import { useLoad, useToast } from "../state";
import type { ChatMsg, Conversation, Provider } from "../types";

interface Target {
  provider: string;
  model: string;
}

function pickDefault(providers: Provider[]): Target {
  const order = ["anthropic", "openai", "google", "openrouter", "mistral", "groq", "xai", "deepseek", "together", "perplexity", "ollama", "demo"];
  const p = order.map((id) => providers.find((x) => x.id === id && x.available)).find(Boolean) ?? providers.find((x) => x.id === "demo")!;
  return { provider: p.id, model: p.models[0]?.id ?? "" };
}

/** Provider + model chooser. Live model lists are fetched from the provider when it supports it. */
function ModelPicker({ providers, value, onChange }: { providers: Provider[]; value: Target; onChange: (t: Target) => void }) {
  const provider = providers.find((p) => p.id === value.provider);
  const [live, setLive] = useState<Record<string, { id: string; label: string }[]>>({});
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    if (!provider?.available || !provider.listModels || live[provider.id]) return;
    api
      .get<{ models: { id: string; label: string }[]; live: boolean }>(`/api/ai/providers/${provider.id}/models`)
      .then((r) => r.live && setLive((m) => ({ ...m, [provider.id]: r.models })))
      .catch(() => undefined);
  }, [provider, live]);

  const models = useMemo(() => {
    const base = provider?.models ?? [];
    const extra = (live[value.provider] ?? []).filter((m) => !base.some((b) => b.id === m.id));
    return [...base, ...extra];
  }, [provider, live, value.provider]);

  return (
    <div className="row wrap" style={{ gap: 8 }}>
      <select
        className="input"
        style={{ width: "auto", height: 34, fontSize: 14 }}
        value={value.provider}
        onChange={(e) => {
          const p = providers.find((x) => x.id === e.target.value)!;
          setCustom(false);
          onChange({ provider: p.id, model: p.models[0]?.id ?? "" });
        }}
        aria-label="AI provider"
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.available ? "" : " (not connected)"}
          </option>
        ))}
      </select>
      {custom ? (
        <input
          className="input"
          style={{ width: 220, height: 34, fontSize: 14 }}
          placeholder="model id"
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          aria-label="Model id"
        />
      ) : (
        <select
          className="input"
          style={{ width: "auto", maxWidth: 260, height: 34, fontSize: 14 }}
          value={models.some((m) => m.id === value.model) ? value.model : "__custom"}
          onChange={(e) => (e.target.value === "__custom" ? setCustom(true) : onChange({ ...value, model: e.target.value }))}
          aria-label="Model"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
          {provider?.kind !== "demo" && <option value="__custom">Other model id…</option>}
        </select>
      )}
    </div>
  );
}

export function AIHubPage() {
  const toast = useToast();
  const providers = useLoad(() => api.get<{ providers: Provider[] }>("/api/ai/providers").then((r) => r.providers));
  const conversations = useLoad(() => api.get<{ conversations: Conversation[] }>("/api/ai/conversations").then((r) => r.conversations));
  const [mode, setMode] = useState<"chat" | "compare">("chat");
  const [target, setTarget] = useState<Target | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (providers.data && !target) setTarget(pickDefault(providers.data));
  }, [providers.data, target]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function openConversation(id: string) {
    abortRef.current?.abort();
    const { conversation } = await api.get<{ conversation: Conversation & { messages: ChatMsg[] } }>(`/api/ai/conversations/${id}`);
    setConvId(id);
    setMessages(conversation.messages);
    setTarget({ provider: conversation.provider, model: conversation.model });
    setMode("chat");
  }

  function newChat() {
    abortRef.current?.abort();
    setConvId(null);
    setMessages([]);
  }

  async function deleteConversation(id: string) {
    await api.del(`/api/ai/conversations/${id}`);
    if (id === convId) newChat();
    conversations.reload();
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || !target || streaming) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "", pending: true, provider: target.provider, model: target.model }]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const patchLast = (fn: (m: ChatMsg) => ChatMsg) => setMessages((all) => [...all.slice(0, -1), fn(all[all.length - 1])]);
    try {
      await streamSse(
        "/api/ai/chat",
        { conversationId: convId ?? undefined, provider: target.provider, model: target.model, message: text },
        (event, data) => {
          if (event === "meta") setConvId(data.conversationId);
          else if (event === "delta") patchLast((m) => ({ ...m, content: m.content + data.text }));
          else if (event === "done") patchLast((m) => ({ ...m, pending: false, model: data.model, usage: data.usage }));
          else if (event === "error") patchLast((m) => ({ ...m, pending: false, error: data.message }));
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) patchLast((m) => ({ ...m, pending: false, error: (err as Error).message }));
    } finally {
      patchLast((m) => ({ ...m, pending: false }));
      setStreaming(false);
      conversations.reload();
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const list = providers.data ?? [];
  const current = list.find((p) => p.id === target?.provider);
  const connected = list.filter((p) => p.available && p.kind !== "demo");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI Hub</h1>
          <p className="muted">
            {connected.length} provider{connected.length === 1 ? "" : "s"} connected · <Link to="/app/settings#ai-keys">manage API keys</Link>
          </p>
        </div>
        <div className="seg" role="tablist" aria-label="Mode">
          <button className={mode === "chat" ? "on" : ""} onClick={() => setMode("chat")} role="tab" aria-selected={mode === "chat"}>Chat</button>
          <button className={mode === "compare" ? "on" : ""} onClick={() => setMode("compare")} role="tab" aria-selected={mode === "compare"}>
            <Icon.Columns size={14} /> Compare models
          </button>
        </div>
      </div>

      {mode === "compare" ? (
        <CompareView providers={list} />
      ) : (
        <div className="chat-layout">
          <div className="card chat-side" style={{ padding: 10 }}>
            <button className="btn block" onClick={newChat} style={{ marginBottom: 10 }}><Icon.Plus size={16} /> New chat</button>
            {(conversations.data ?? []).map((c) => (
              <div key={c.id} className="row" style={{ gap: 2 }}>
                <button className={`conv-item ${c.id === convId ? "active" : ""}`} onClick={() => openConversation(c.id).catch((e) => toast(e.message, "error"))} title={`${c.title} · ${timeAgo(c.updatedAt)}`}>
                  <span>{c.title}</span>
                </button>
                <button className="btn ghost icon-btn" style={{ width: 28, height: 28 }} onClick={() => deleteConversation(c.id)} aria-label={`Delete ${c.title}`}>
                  <Icon.Trash size={14} />
                </button>
              </div>
            ))}
            {conversations.data?.length === 0 && <p className="faint small" style={{ padding: 8 }}>Your chats will appear here.</p>}
          </div>

          <div className="card chat-main">
            <div className="chat-toolbar">
              {target && list.length > 0 && <ModelPicker providers={list} value={target} onChange={setTarget} />}
              {current && !current.available && (
                <span className="small bad">Not connected — <Link to="/app/settings#ai-keys">add a {current.name} key</Link></span>
              )}
              {current?.source && current.kind !== "demo" && <span className="pill">{current.source === "user" ? "your key" : "server key"}</span>}
            </div>
            <div className="chat-scroll" ref={scrollRef}>
              {messages.length === 0 && (
                <div className="empty" style={{ margin: "auto" }}>
                  <Icon.Sparkle size={28} />
                  <p style={{ marginTop: 8 }}>Ask anything. Switch provider and model at any time; the conversation keeps its history.</p>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  {m.role === "user" ? (
                    m.content
                  ) : (
                    <>
                      {m.content ? <Markdown text={m.content} /> : m.pending ? <span className="faint row"><span className="spinner" /> Thinking…</span> : null}
                      <ErrorText error={m.error} />
                      {!m.pending && (m.model || m.usage) && (
                        <div className="msg-meta">
                          {m.model}
                          {m.usage?.outputTokens ? ` · ${m.usage.inputTokens ?? "?"} in / ${m.usage.outputTokens} out tokens` : ""}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
            <form className="chat-input" onSubmit={send}>
              <textarea
                className="input"
                rows={1}
                placeholder="Message… (Enter to send, Shift+Enter for a new line)"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                aria-label="Message"
              />
              {streaming ? (
                <button type="button" className="btn secondary" onClick={() => abortRef.current?.abort()}><Icon.Stop size={14} /> Stop</button>
              ) : (
                <button className="btn" disabled={!input.trim() || !current?.available}>Send</button>
              )}
            </form>
          </div>
        </div>
      )}
    </>
  );
}

interface Pane {
  text: string;
  error?: string;
  done?: { model: string; ms: number };
}

function CompareView({ providers }: { providers: Provider[] }) {
  const available = providers.filter((p) => p.available);
  const [targets, setTargets] = useState<Target[]>(() =>
    available.slice(0, 2).map((p) => ({ provider: p.id, model: p.models[0]?.id ?? "" })),
  );
  const [prompt, setPrompt] = useState("");
  const [panes, setPanes] = useState<Pane[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (targets.length < 2 && providers.length) {
      const demo = providers.find((p) => p.id === "demo")!;
      setTargets((t) => [...t, ...Array.from({ length: 2 - t.length }, () => ({ provider: demo.id, model: demo.models[0].id }))]);
    }
  }, [providers, targets.length]);

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setPanes(targets.map(() => ({ text: "" })));
    setRunning(true);
    try {
      await streamSse("/api/ai/compare", { prompt, targets }, (event, data) => {
        if (event === "delta") setPanes((p) => p.map((x, i) => (i === data.index ? { ...x, text: x.text + data.text } : x)));
        if (event === "done") setPanes((p) => p.map((x, i) => (i === data.index ? { ...x, done: { model: data.model, ms: data.ms } } : x)));
        if (event === "error") setPanes((p) => p.map((x, i) => (i === data.index ? { ...x, error: data.message } : x)));
      });
    } catch (err) {
      setPanes((p) => p.map((x) => ({ ...x, error: x.error ?? (err as Error).message })));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <div className="stack-sm">
          {targets.map((t, i) => (
            <div key={i} className="row wrap">
              <span className="pill">{i + 1}</span>
              <ModelPicker providers={providers} value={t} onChange={(nt) => setTargets((all) => all.map((x, j) => (j === i ? nt : x)))} />
              {targets.length > 2 && (
                <button className="btn ghost icon-btn" onClick={() => setTargets((all) => all.filter((_, j) => j !== i))} aria-label={`Remove model ${i + 1}`}>
                  <Icon.X size={14} />
                </button>
              )}
            </div>
          ))}
          {targets.length < 4 && (
            <button
              className="btn ghost sm"
              style={{ alignSelf: "flex-start" }}
              onClick={() => {
                const p = available[targets.length] ?? providers.find((x) => x.id === "demo")!;
                setTargets((all) => [...all, { provider: p.id, model: p.models[0]?.id ?? "" }]);
              }}
            >
              <Icon.Plus size={14} /> Add model
            </button>
          )}
        </div>
        <form className="row" onSubmit={run} style={{ alignItems: "flex-end" }}>
          <textarea className="input grow" rows={2} placeholder="One prompt, several models…" value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt" />
          <button className="btn" disabled={running || !prompt.trim()}>{running ? "Running…" : "Compare"}</button>
        </form>
      </div>
      {panes.length > 0 && (
        <div className="compare-grid">
          {panes.map((p, i) => (
            <div className="card" key={i}>
              <div className="card-head">
                <h3>{providers.find((x) => x.id === targets[i]?.provider)?.name} · <span className="muted">{targets[i]?.model}</span></h3>
                {p.done && <span className="pill">{(p.done.ms / 1000).toFixed(1)}s</span>}
              </div>
              {p.text ? <Markdown text={p.text} /> : !p.error && <span className="faint row"><span className="spinner" /> Waiting…</span>}
              <ErrorText error={p.error} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
