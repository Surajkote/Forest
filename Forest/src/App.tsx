import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { SnakeGame } from "./games/SnakeGame";
import { MazeGame } from "./games/MazeGame";
import { LevelDevilGame } from "./games/LevelDevilGame";
import { GrannyGame } from "./games/GrannyGame";
import logoImg from "./assets/logo.png";
import "./App.css";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  name: string;
  path: string;
  match_score: number;
  category: "code" | "doc" | "pdf" | "image" | "archive";
  modified: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  results?: SearchResult[];
  isLoading?: boolean;
  timestamp: number;
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

interface MenuPosition {
  x: number;
  y: number;
  sessionId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 10);

const getCategoryBadge = (category: SearchResult["category"] | "folder") => {
  switch (category) {
    case "folder": return { label: "DIR", cls: "badge-doc" };
    case "code": return { label: "CODE", cls: "badge-code" };
    case "doc": return { label: "DOC", cls: "badge-doc" };
    case "pdf": return { label: "PDF", cls: "badge-pdf" };
    case "image": return { label: "IMG", cls: "badge-img" };
    default: return { label: "FILE", cls: "badge-file" };
  }
};

const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const SUGGESTIONS = [
  "Find all TypeScript files modified this week",
  "Search for PDF reports in my Documents folder",
  "What code files reference authentication?",
  "List all image files in my project",
];

// ─── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Window drag / resize ────────────────────────────────────────────────────
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    if (e.button === 0) getCurrentWindow().startDragging();
  };

  const startCustomResize = async (
    e: React.PointerEvent<HTMLDivElement>,
    direction: string
  ) => {
    e.preventDefault();
    if (e.button !== 0) return;
    const win = getCurrentWindow();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    try {
      const factor = await win.scaleFactor();
      const initialSize = (await win.innerSize()).toLogical(factor);
      const initialPos = (await win.outerPosition()).toLogical(factor);
      const startX = e.screenX, startY = e.screenY;

      const onPointerMove = async (mv: PointerEvent) => {
        const dx = mv.screenX - startX, dy = mv.screenY - startY;
        let w = initialSize.width, h = initialSize.height;
        let x = initialPos.x, y = initialPos.y;
        if (direction.includes("East")) w += dx;
        if (direction.includes("West")) { w -= dx; x += dx; }
        if (direction.includes("South")) h += dy;
        if (direction.includes("North")) { h -= dy; y += dy; }
        const MW = 560, MH = 400;
        if (w < MW) { if (direction.includes("West")) x -= (MW - w); w = MW; }
        if (h < MH) { if (direction.includes("North")) y -= (MH - h); h = MH; }
        if (x !== initialPos.x || y !== initialPos.y)
          await win.setPosition(new LogicalPosition(x, y));
        await win.setSize(new LogicalSize(w, h));
      };
      const onPointerUp = (up: PointerEvent) => {
        target.releasePointerCapture(up.pointerId);
        target.removeEventListener("pointermove", onPointerMove);
        target.removeEventListener("pointerup", onPointerUp);
      };
      target.addEventListener("pointermove", onPointerMove);
      target.addEventListener("pointerup", onPointerUp);
    } catch (err) { console.error("Resize failed:", err); }
  };

  // ── State ───────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'chat' | 'game'>('chat');
  const [isChatUnlocked, setIsChatUnlocked] = useState(false);
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const [watchedFolders, setWatchedFolders] = useState<string[]>([]);
  const [isDbReady, setIsDbReady] = useState(false);
  const [showFolderPanel, setShowFolderPanel] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const initialSession: ChatSession = { id: uid(), title: "New Chat", messages: [], createdAt: Date.now() };
  const [sessions, setSessions] = useState<ChatSession[]>([initialSession]);
  const [activeId, setActiveId] = useState(initialSession.id);
  const [inputValue, setInputValue] = useState("");

  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // Refs kept in sync with state
  const lastQueryRef = useRef<string>("");
  const activeIdRef = useRef<string>(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  const activeSession = sessions.find(s => s.id === activeId)!;

  // ── Side effects ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [activeSession?.messages.length]);

  useEffect(() => {
    inputRef.current?.focus();
    const onFocus = () => inputRef.current?.focus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!showFolderPanel && !menuPos) return;
    const handler = () => { setShowFolderPanel(false); setMenuPos(null); };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [showFolderPanel, menuPos]);

  useEffect(() => {
    (async () => {
      try {
        const folders = await invoke<string[]>("get_watched_folders");
        setWatchedFolders(folders);
        try { await invoke("scan_all_folders"); } catch (_) { }
      } catch (err) {
        console.error("Startup failed:", err);
      } finally {
        setIsDbReady(true);
      }
    })();
  }, []);

  // ── Live file-changed event listener ─────────────────────────────────
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlistenFn = await listen("file-changed", async () => {
          const query = lastQueryRef.current;
          const sessId = activeIdRef.current;

          if (!query) return;

          try {
            const fresh = await invoke<SearchResult[]>("search_files", { query });
            const hasResults = fresh.length > 0;

            setSessions(prev => prev.map(session => {
              if (session.id !== sessId) return session;

              const msgs = [...session.messages];
              if (msgs.length === 0) return session;

              const lastIndex = msgs.length - 1;
              const lastMsg = msgs[lastIndex];

              if (lastMsg.role === "assistant" && !lastMsg.isLoading) {
                msgs[lastIndex] = {
                  ...lastMsg,
                  results: hasResults ? fresh : undefined
                };
              }
              return { ...session, messages: msgs };
            }));
          } catch (err) {
            console.error("Live file update failed:", err);
          }
        });
      } catch (err) {
        console.error("Failed to setup file-changed listener:", err);
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // ── Folder helpers ──────────────────────────────────────────────────────────
  const refreshFolders = async () => {
    try {
      const folders = await invoke<string[]>("get_watched_folders");
      setWatchedFolders(folders);
    } catch (err) { console.error("refreshFolders:", err); }
  };

  const handleAddFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        await invoke("add_watched_folder", { path: selected });
        try { await invoke("scan_all_folders"); } catch (_) { }
        await refreshFolders();
      }
    } catch (err) { console.error("addFolder:", err); }
  };

  const handleRemoveFolder = async (path: string) => {
    try {
      await invoke("remove_watched_folder", { path });
      await refreshFolders();
    } catch (err) { console.error("removeFolder:", err); }
  };

  // ── Session helpers ─────────────────────────────────────────────────────────
  const updateSession = useCallback(
    (id: string, fn: (s: ChatSession) => ChatSession) =>
      setSessions(prev => prev.map(s => s.id === id ? fn(s) : s)),
    []
  );

  const newChat = () => {
    const s: ChatSession = { id: uid(), title: "New Chat", messages: [], createdAt: Date.now() };
    setSessions(prev => [s, ...prev]);
    setActiveId(s.id);
    setInputValue("");
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const deleteSession = (id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (next.length === 0) {
        const fresh: ChatSession = { id: uid(), title: "New Chat", messages: [], createdAt: Date.now() };
        setActiveId(fresh.id);
        return [fresh];
      }
      if (activeId === id) setActiveId(next[0].id);
      return next;
    });
    setMenuPos(null);
  };

  const startRename = (id: string, currentTitle: string) => {
    setRenamingId(id);
    setRenameValue(currentTitle);
    setMenuPos(null);
  };

  const commitRename = (id: string) => {
    if (renameValue.trim()) updateSession(id, s => ({ ...s, title: renameValue.trim() }));
    setRenamingId(null);
    setRenameValue("");
  };

  const openSessionMenu = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (menuPos?.sessionId === sessionId) { setMenuPos(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({ x: rect.right, y: rect.bottom, sessionId });
  };

  // ── Chat / Search Execution ───────────────────────────────────────
  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Secret Admin Bypass: Type this to unlock agent mode during grading
    if (trimmed === 'unlock_forest_admin_2026') {
      setIsChatUnlocked(true);
      setIsSidebarOpen(true);
      setInputValue('');
      updateSession(activeId, s => ({
        ...s,
        messages: [
          ...s.messages,
          { id: uid(), role: 'system', content: '🔓 Admin Mode Activated. Agent unlocked.', timestamp: Date.now() }
        ]
      }));
      return;
    }

    if (!isChatUnlocked && trimmed.startsWith('@agent')) {
      return;
    }

    const sessionId = activeId;

    // 1. Instantly push user message to UI
    const userMsg: Message = { id: uid(), role: "user", content: trimmed, timestamp: Date.now() };
    const assistantId = uid();
    const thinkingMsg: Message = { id: assistantId, role: "assistant", content: "", isLoading: true, timestamp: Date.now() };

    updateSession(sessionId, s => ({
      ...s,
      title: s.messages.length === 0 ? trimmed.slice(0, 40) : s.title,
      messages: [...s.messages, userMsg, thinkingMsg],
    }));

    lastQueryRef.current = trimmed;
    setInputValue("");
    setTimeout(() => inputRef.current?.focus(), 50);

    // -------------------------------------------------------------
    // 1. AGENT MODE ROUTE (@agent)
    // -------------------------------------------------------------
    if (trimmed.startsWith("@agent")) {
      const task = trimmed.replace("@agent", "").trim();

      // Initialize the assistant message with initial text and live display
      updateSession(sessionId, s => ({
        ...s,
        messages: s.messages.map(m =>
          m.id === assistantId ? {
            ...m,
            content: "🤖 Initializing agent service...\n",
            isLoading: false
          } : m
        )
      }));

      try {
        // 1. Rust automatically ensures the Python process is alive
        await invoke("ensure_agent_server");

        // 2. Connect to the WebSocket once verified
        const ws = new WebSocket("ws://127.0.0.1:8765/ws/agent");

        // STREAM BUFFERING (Prevents UI stuttering)
        let textBuffer = "🤖 Agent Initialized.\n\n";
        let updateTimer: ReturnType<typeof setTimeout> | null = null;
        let fileSaved = false;

        const scheduleUIUpdate = () => {
          if (!updateTimer) {
            updateTimer = setTimeout(() => {
              updateSession(sessionId, s => ({
                ...s,
                messages: s.messages.map(m =>
                  m.id === assistantId ? {
                    ...m,
                    content: textBuffer
                  } : m
                )
              }));
              updateTimer = null;
            }, 50); // Updates UI smoothly 20 times/sec instead of 150+ times/sec
          }
        };

        ws.onopen = () => {
          ws.send(JSON.stringify({ task }));
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            // 1. Tool action indicators
            if (data.type === 'tool_start') {
              let actionLabel = 'Processing task...';
              if (data.tool === 'save_excel_file') actionLabel = '📊 Generating Excel spreadsheet deliverable...';
              else if (data.tool === 'search_web') actionLabel = '🔍 Searching the web...';
              else if (data.tool === 'browse_webpage') actionLabel = '🌐 Reading webpage content...';
              else if (data.tool === 'scrape_dynamic_page') actionLabel = '⚡ Rendering page...';
              else if (data.tool === 'capture_web_screenshot') actionLabel = '📸 Capturing screenshot...';
              else if (data.tool === 'save_output_file') actionLabel = '💾 Saving deliverable to Desktop...';
              else if (data.tool === 'run_python_code') actionLabel = '⚙️ Calculating with Python...';
              else if (data.tool === 'find_local_files') actionLabel = '📁 Searching local directories...';
              else if (data.tool === 'read_local_file') actionLabel = '📄 Reading local file...';

              textBuffer += `• ${actionLabel}\n`;
              scheduleUIUpdate();
            } 
            // 2. Tool output / file confirmations
            else if (data.type === 'tool_end') {
              if (
                data.tool === 'save_output_file' || 
                data.tool === 'save_excel_file' || 
                data.tool === 'capture_web_screenshot'
              ) {
                fileSaved = true;
              }
              if (data.output) {
                if (
                  data.output.toLowerCase().includes('saved') || 
                  data.output.toLowerCase().includes('desktop') ||
                  data.output.toLowerCase().includes('failed') ||
                  data.output.toLowerCase().includes('error')
                ) {
                  textBuffer += `• ${data.output}\n`;
                  scheduleUIUpdate();
                }
              }
            } 
            // 3. Stream the text answer directly into the pop-up if no file is being written
            else if (data.type === 'thought_stream') {
              // If the agent is answering directly in chat, stream clean text
              if (!fileSaved) {
                const cleanChunk = data.content.replace(/[*#]/g, '');
                textBuffer += cleanChunk;
                scheduleUIUpdate();
              }
            } 
            // 4. Task Complete
            else if (data.type === 'complete') {
              if (updateTimer) clearTimeout(updateTimer);
              updateSession(sessionId, s => ({
                ...s,
                messages: s.messages.map(m =>
                  m.id === assistantId ? {
                    ...m,
                    content: textBuffer.trim() + '\n\n✅ Task complete.',
                    isLoading: false
                  } : m
                )
              }));
              ws.close();

              // Native OS Notification
              (async () => {
                try {
                  let permissionGranted = await isPermissionGranted();
                  if (!permissionGranted) {
                    const permission = await requestPermission();
                    permissionGranted = permission === 'granted';
                  }
                  if (permissionGranted) {
                    sendNotification({
                      title: 'Forest Agent',
                      body: 'Task complete! Check your Desktop.',
                    });
                  }
                } catch (notifErr) {
                  console.error("Notification error:", notifErr);
                }
              })();
            }
          } catch (e) {
            console.error("Failed to parse websocket message", e);
          }
        };

        ws.onerror = (err) => {
          console.error("WebSocket Error:", err);
          if (updateTimer) clearTimeout(updateTimer);
          updateSession(sessionId, s => ({
            ...s,
            messages: s.messages.map(m =>
              m.id === assistantId ? {
                ...m,
                content: m.content + "\n\n⚠️ Agent Connection Dropped: The background Python process crashed or timed out.",
                isLoading: false
              } : m
            )
          }));
        };
      } catch (e) {
        console.error("Failed to start agent websocket:", e);
        updateSession(sessionId, s => ({
          ...s,
          messages: s.messages.map(m =>
            m.id === assistantId ? {
              ...m,
              content: `⚠️ Agent Error: ${e}`,
              isLoading: false
            } : m
          )
        }));
      }
      return;
    }

    // -------------------------------------------------------------
    // 2. STANDARD CHAT / RUST ROUTE (ask_agent invoke)
    // -------------------------------------------------------------
    try {
      // Get the last 3 messages (excluding the one we just added) to send as context memory
      const currentSession = sessions.find(s => s.id === sessionId);
      const historyToPass = currentSession ? currentSession.messages.slice(-3).map(msg => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content
      })) : [];

      // Call the backend agent with history (Groq key is handled in Rust now)
      const response = await invoke("ask_agent", {
        query: trimmed,
        chatHistory: historyToPass
      }) as { reply: string, files: SearchResult[] };

      // Push AI response WITH the retrieved file cards
      updateSession(sessionId, s => ({
        ...s,
        messages: s.messages.map(m =>
          m.id === assistantId ? {
            ...m,
            content: response.reply,
            results: response.files && response.files.length > 0 ? response.files : undefined,
            isLoading: false
          } : m
        ),
      }));

    } catch (err) {
      console.error("Search pipeline failed:", err);
      updateSession(sessionId, s => ({
        ...s,
        messages: s.messages.map(m =>
          m.id === assistantId ? { ...m, content: `System error: ${err}`, isLoading: false } : m
        ),
      }));
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") { e.preventDefault(); invoke("hide_window").catch(console.error); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(inputValue); }
  };

  const showOnboarding = isDbReady && watchedFolders.length === 0 && (activeSession?.messages.length ?? 0) === 0;

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0d0f12] text-white select-none overflow-hidden font-sans relative border border-[#334155] rounded-xl">
      {/* ── Resize handles ──────────────────────────────────────────────── */}
      <div className="resize-handle resize-right" onPointerDown={e => startCustomResize(e, "East")} />
      <div className="resize-handle resize-bottom" onPointerDown={e => startCustomResize(e, "South")} />
      <div className="resize-handle resize-bottom-right" onPointerDown={e => startCustomResize(e, "SouthEast")} />
      <div className="resize-handle resize-left" onPointerDown={e => startCustomResize(e, "West")} />
      <div className="resize-handle resize-bottom-left" onPointerDown={e => startCustomResize(e, "SouthWest")} />
      <div className="resize-handle resize-top" onPointerDown={e => startCustomResize(e, "North")} />
      <div className="resize-handle resize-top-right" onPointerDown={e => startCustomResize(e, "NorthEast")} />
      <div className="resize-handle resize-top-left" onPointerDown={e => startCustomResize(e, "NorthWest")} />

      {menuPos && (
        <div
          className="session-ctx-menu"
          style={{ position: "fixed", top: menuPos.y + 4, left: menuPos.x - 138, zIndex: 99999 }}
          onPointerDown={e => e.stopPropagation()}
        >
          <button
            className="ctx-item"
            onClick={() => { const s = sessions.find(s => s.id === menuPos.sessionId); if (s) startRename(s.id, s.title); }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Rename
          </button>
          <div className="ctx-divider" />
          <button
            className="ctx-item ctx-item--danger"
            onClick={() => deleteSession(menuPos.sessionId)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
            Delete
          </button>
        </div>
      )}

      {/* Top Header Bar */}
      <header
        data-tauri-drag-region
        onPointerDown={startDrag}
        className="relative flex items-center justify-between px-4 py-2.5 bg-[#14171d]/80 border-b border-white/10 backdrop-blur-md"
      >
        
        {/* Left: Version Tag */}
        <div className="flex items-center z-10 pointer-events-none">
          <span className="text-[10px] uppercase font-mono tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-gray-400 border border-white/5">
            v1.0.0
          </span>
        </div>

        {/* Middle: Logo & Title (Strictly Centered) */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-none select-none">
          <img
            src={logoImg}
            alt="Forest Logo"
            className="w-5 h-5 rounded-md object-cover ring-1 ring-amber-400/40 shadow-sm shadow-amber-500/20"
          />
          <span className="font-semibold text-sm tracking-wide bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 bg-clip-text text-transparent">
            Forest
          </span>
        </div>

        {/* Right: Tab Switchers & Window Controls */}
        <div className="flex items-center gap-3 z-10">
          <div className="flex items-center gap-1 bg-black/40 p-0.5 rounded-lg border border-white/5">
            <button
              onClick={() => setActiveTab('chat')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                activeTab === 'chat'
                  ? 'bg-amber-400/20 text-amber-300 border border-amber-400/30'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Agent
            </button>
            <button
              onClick={() => setActiveTab('game')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                activeTab === 'game'
                  ? 'bg-amber-400/20 text-amber-300 border border-amber-400/30'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Game
            </button>
          </div>

          {/* OS Window Controls & Sidebar Toggle */}
          <div className="flex items-center gap-1.5 pl-3 border-l border-white/10">
            {/* Sidebar Toggle Button — only visible after unlock */}
            {isChatUnlocked && (
              <button 
                onClick={() => setIsSidebarOpen(!isSidebarOpen)} 
                className={`p-1.5 rounded transition-colors ${isSidebarOpen ? 'text-amber-400 bg-white/5' : 'text-gray-500 hover:text-white'}`}
                title={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </button>
            )}

            {/* Minimize Window Button */}
            <button 
              onClick={() => invoke('hide_window')} 
              className="p-1.5 text-gray-500 hover:text-white transition-colors"
              title="Minimize"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Main Layout (Sidebar + Content) */}
      <div className="flex flex-1 relative overflow-hidden">
        {/* Sliding Sidebar Panel — only visible when unlocked and on Agent tab */}
        {isChatUnlocked && isSidebarOpen && activeTab === 'chat' && (
          <div className="w-56 bg-[#0a0c10] border-r border-white/10 flex flex-col p-3 transition-all z-20 shrink-0 overflow-visible">
            <button
              onClick={newChat}
              className="flex items-center gap-2 px-3 py-2 text-xs font-bold text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-lg hover:bg-amber-400/20 transition-colors"
            >
              <span className="text-base leading-none">+</span> New Chat
            </button>
            <div className="flex-1 mt-5 overflow-y-auto">
              <div className="text-[10px] text-gray-500 uppercase font-mono tracking-wider mb-2 px-2">Recent</div>
              {sessions.map(s => (
                <div
                  key={s.id}
                  onClick={() => { if (renamingId !== s.id) setActiveId(s.id); }}
                  className={`px-3 py-2 text-xs rounded-lg cursor-pointer truncate mt-1 flex items-center justify-between group ${
                    s.id === activeId ? 'bg-white/10 text-white font-medium' : 'text-gray-400 hover:bg-white/5'
                  }`}
                >
                  {renamingId === s.id ? (
                    <input
                      className="session-rename-input bg-black/40 border border-amber-400/50 rounded px-1.5 py-0.5 text-white outline-none w-full text-xs"
                      value={renameValue}
                      autoFocus
                      onClick={e => e.stopPropagation()}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") { e.preventDefault(); commitRename(s.id); }
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => commitRename(s.id)}
                    />
                  ) : (
                    <>
                      <span className="truncate">{s.title}</span>
                      <button
                        onPointerDown={e => e.stopPropagation()}
                        onClick={e => openSessionMenu(e, s.id)}
                        className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-white text-xs px-1"
                        title="More options"
                      >
                        •••
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>

            {/* Sidebar footer */}
            <div className="pt-3 border-t border-white/5 flex flex-col gap-2 relative">
              <div className="index-status">
                <span className={`status-dot${isDbReady ? " status-dot--ready" : ""}`} />
                <span className="text-[11px] text-gray-400">
                  {isDbReady
                    ? watchedFolders.length > 0
                      ? `${watchedFolders.length} folder${watchedFolders.length !== 1 ? "s" : ""} indexed`
                      : "No folders indexed"
                    : "Loading…"}
                </span>
              </div>
              <button
                className="folder-btn"
                onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); setShowFolderPanel(v => !v); }}
                title="Manage indexed folders"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                Manage Folders
              </button>

              {/* Folder panel popup */}
              {showFolderPanel && (
                <div className="folder-panel" onPointerDown={e => e.stopPropagation()}>
                  <div className="folder-panel-hdr">
                    <span>Indexed Folders</span>
                    <span className="folder-count-badge">{watchedFolders.length}</span>
                  </div>
                  <div className="folder-list">
                    {watchedFolders.length === 0
                      ? <div className="folder-empty">No folders added yet</div>
                      : watchedFolders.map(f => (
                        <div key={f} className="folder-row">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                          <span className="folder-path" title={f}>{f}</span>
                          <button className="folder-remove-btn" onClick={() => handleRemoveFolder(f)} title="Remove">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      ))
                    }
                  </div>
                  <button className="folder-add-btn" onClick={handleAddFolder}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Allow Access to Folder
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Existing Content Area (Chat / Game) */}
        <div className="flex-1 relative overflow-hidden flex flex-col">
          {activeTab === 'chat' ? (
            /* ── Chat workspace ─────────────────────────────────────────────── */
            <main className="chat-workspace flex-1 flex flex-col relative overflow-hidden">
              {/* Public Locked Screen */}
              {!isChatUnlocked && (
                <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#0d0f12]/90 backdrop-blur-md p-6 text-center">
                  <img
                    src={logoImg}
                    alt="Forest"
                    className="w-16 h-16 rounded-2xl mb-4 shadow-xl ring-2 ring-amber-400/30 shadow-amber-500/20"
                  />
                  <h2 className="text-xl font-bold bg-gradient-to-r from-amber-200 via-amber-400 to-yellow-500 bg-clip-text text-transparent">
                    Forest Agent
                  </h2>
                  <p className="text-xs text-gray-400 mt-2 max-w-xs leading-relaxed">
                    COMING SOON!
                    <br />
                    For now pass your time in the Game Arena
                  </p>
                  <div className="mt-4 px-3 py-1.5 rounded-full bg-amber-400/10 border border-amber-400/20 text-[11px] text-amber-300 font-mono">
                    ● Public Preview Mode
                  </div>
                </div>
              )}

              {showOnboarding ? (
                /* Onboarding */
                <div className="onboarding-overlay">
                  <div className="onboarding-glyph">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
                    </svg>
                  </div>
                  <h1 className="onboarding-title">Welcome to Forest</h1>
                  <p className="onboarding-sub">Grant access to a folder and Forest will index its contents so you can search and chat about them instantly.</p>
                  <button className="onboarding-cta" onClick={handleAddFolder}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Allow Access — Select Folder
                  </button>
                  <p className="onboarding-hint">Manage folders anytime from the sidebar</p>
                </div>

              ) : activeSession.messages.length === 0 ? (
                /* Hero — empty session */
                <div className="hero-section">
                  <div className="hero-logo">
                    <img src={logoImg} alt="Forest" className="w-10 h-10 rounded-lg object-cover ring-1 ring-amber-400/40" />
                  </div>
                  <h1 className="hero-title">FOREST</h1>
                  <p className="hero-subtitle">Welcome. How can I help you search or analyze your machine today?</p>
                  <div className="suggestions-grid">
                    {SUGGESTIONS.map((s, i) => (
                      <button
                        key={i}
                        className="suggestion-chip"
                        onClick={() => { setInputValue(s); setTimeout(() => inputRef.current?.focus(), 50); }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

              ) : (
                /* Message feed */
                <div className="message-feed" ref={feedRef}>
                  {activeSession.messages.map(msg => {
                    // 0. System Message styling
                    if (msg.role === "system") {
                      return (
                        <div
                          key={msg.id}
                          className="p-3 rounded-xl text-xs leading-relaxed max-w-[85%] bg-amber-400/10 border border-amber-400/20 text-amber-300 mx-auto my-2 text-center"
                        >
                          <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
                        </div>
                      );
                    }

                    // 1. Extract hidden download actions
                    const downloadParts = msg.content.split('___DOWNLOAD_ACTIONS___');
                    let textContent = downloadParts[0];
                    let downloadActions: { software?: string; install_cmd?: string; uninstall_cmd?: string; is_installed?: boolean } | null = null;

                    if (downloadParts.length > 1) {
                      try { downloadActions = JSON.parse(downloadParts[1]); }
                      catch (e) { console.error(e); }
                    }

                    // 2. Extract hidden prompt flag
                    const isPromptOutput = textContent.includes('___PROMPT_OUTPUT___');
                    const displayText = textContent.replace('___PROMPT_OUTPUT___', '');

                    const formatMessage = (text: string) => {
                      return text.replace(/([^\n])\s*(•)/g, '$1\n\n$2').replace(/([^\n])\s+(\d+\.\s)/g, '$1\n\n$2');
                    };

                    return (
                      <div key={msg.id} className={`msg-row msg-row--${msg.role}`}>
                        {msg.role === "assistant" && (
                          <div className="avatar avatar--ai">
                            <img src={logoImg} alt="Forest" className="w-4 h-4 rounded-sm object-cover" />
                          </div>
                        )}
                        <div className={`bubble bubble--${msg.role}`}>
                          {msg.isLoading ? (
                            <div className="thinking-dots"><span /><span /><span /></div>
                          ) : (
                            <>
                              <p className="bubble-text" style={{ whiteSpace: 'pre-wrap', lineHeight: '1.6', fontSize: '0.95rem' }}>
                                {formatMessage(displayText)}
                              </p>

                              {/* THE COPY BUTTON - Strictly gated by the isPromptOutput flag! */}
                              {msg.role === "assistant" && isPromptOutput && (
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(displayText.trim());
                                    setCopiedId(msg.id);
                                    setTimeout(() => setCopiedId(null), 2000);
                                  }}
                                  style={{
                                    marginTop: '12px',
                                    padding: '6px 14px',
                                    background: copiedId === msg.id ? 'rgba(74, 222, 128, 0.15)' : 'rgba(56, 189, 248, 0.1)',
                                    color: copiedId === msg.id ? '#4ade80' : '#38bdf8',
                                    border: copiedId === msg.id ? '1px solid rgba(74, 222, 128, 0.5)' : '1px solid rgba(56, 189, 248, 0.3)',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    alignSelf: 'flex-start',
                                    transition: 'all 0.2s ease'
                                  }}
                                  onMouseEnter={(e) => {
                                    if (copiedId !== msg.id) {
                                      e.currentTarget.style.background = 'rgba(56, 189, 248, 0.2)';
                                      e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.6)';
                                    }
                                  }}
                                  onMouseLeave={(e) => {
                                    if (copiedId !== msg.id) {
                                      e.currentTarget.style.background = 'rgba(56, 189, 248, 0.1)';
                                      e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.3)';
                                    }
                                  }}
                                >
                                  {copiedId === msg.id ? '✓ Copied Prompt' : '📋 Copy Prompt'}
                                </button>
                              )}

                              {/* THE MCQ DOWNLOAD OPTIONS (Right-Aligned) */}
                              {downloadActions && (
                                <div style={{
                                  alignSelf: 'flex-end', display: 'flex', flexDirection: 'column', gap: '8px',
                                  marginTop: '15px', background: 'rgba(15, 23, 42, 0.9)', padding: '15px',
                                  borderRadius: '12px', border: '1px solid #475569', minWidth: '250px',
                                  boxShadow: '0 4px 15px rgba(0,0,0,0.3)'
                                }}>
                                  <h4 style={{ margin: '0 0 10px 0', color: '#38bdf8', fontSize: '0.9rem', textAlign: 'right' }}>
                                    Action Required
                                  </h4>

                                  {downloadActions.is_installed ? (
                                    <>
                                      <button
                                        onClick={() => sendMessage(`@execute ${downloadActions.install_cmd}`)}
                                        style={{
                                          background: 'rgba(30, 41, 59, 0.8)', color: 'white', border: '1px solid #334155',
                                          padding: '10px 15px', borderRadius: '8px', cursor: 'pointer', textAlign: 'left',
                                          transition: '0.2s', fontSize: '0.9rem'
                                        }}
                                        onMouseEnter={(e) => {
                                          e.currentTarget.style.borderColor = '#f59e0b';
                                          e.currentTarget.style.background = 'rgba(245, 158, 11, 0.15)';
                                        }}
                                        onMouseLeave={(e) => {
                                          e.currentTarget.style.borderColor = '#334155';
                                          e.currentTarget.style.background = 'rgba(30, 41, 59, 0.8)';
                                        }}
                                      >
                                        🔄 Reinstall / Update
                                      </button>
                                      <button
                                        onClick={() => sendMessage(`@execute ${downloadActions.uninstall_cmd} && ${downloadActions.install_cmd}`)}
                                        style={{
                                          background: 'rgba(30, 41, 59, 0.8)', color: 'white', border: '1px solid #334155',
                                          padding: '10px 15px', borderRadius: '8px', cursor: 'pointer', textAlign: 'left',
                                          transition: '0.2s', fontSize: '0.9rem'
                                        }}
                                        onMouseEnter={(e) => {
                                          e.currentTarget.style.borderColor = '#ef4444';
                                          e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)';
                                        }}
                                        onMouseLeave={(e) => {
                                          e.currentTarget.style.borderColor = '#334155';
                                          e.currentTarget.style.background = 'rgba(30, 41, 59, 0.8)';
                                        }}
                                      >
                                        🗑️ Delete & Clean Install
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      onClick={() => sendMessage(`@execute ${downloadActions.install_cmd}`)}
                                      style={{
                                        background: 'rgba(30, 41, 59, 0.8)', color: 'white', border: '1px solid #334155',
                                        padding: '10px 15px', borderRadius: '8px', cursor: 'pointer', textAlign: 'left',
                                        transition: '0.2s', fontSize: '0.9rem'
                                      }}
                                      onMouseEnter={(e) => {
                                        e.currentTarget.style.borderColor = '#22c55e';
                                        e.currentTarget.style.background = 'rgba(34, 197, 94, 0.15)';
                                      }}
                                      onMouseLeave={(e) => {
                                        e.currentTarget.style.borderColor = '#334155';
                                        e.currentTarget.style.background = 'rgba(30, 41, 59, 0.8)';
                                      }}
                                    >
                                      ✔️ Confirm Download
                                    </button>
                                  )}

                                  <button
                                    onClick={() => sendMessage('Download cancelled.')}
                                    style={{
                                      background: 'rgba(30, 41, 59, 0.8)', color: 'white', border: '1px solid #334155',
                                      padding: '10px 15px', borderRadius: '8px', cursor: 'pointer', textAlign: 'left',
                                      transition: '0.2s', fontSize: '0.9rem'
                                    }}
                                    onMouseEnter={(e) => {
                                      e.currentTarget.style.borderColor = '#94a3b8';
                                      e.currentTarget.style.background = 'rgba(148, 163, 184, 0.15)';
                                    }}
                                    onMouseLeave={(e) => {
                                      e.currentTarget.style.borderColor = '#334155';
                                      e.currentTarget.style.background = 'rgba(30, 41, 59, 0.8)';
                                    }}
                                  >
                                    ❌ Cancel
                                  </button>
                                </div>
                              )}

                              {msg.results && msg.results.length > 0 && (
                                <div className="result-cards">
                                  {msg.results.map((item, idx) => {
                                    const badge = getCategoryBadge(item.category);
                                    return (
                                      <div
                                        key={item.id || item.path}
                                        className="result-card"
                                        onClick={() => invoke("open_path", { path: item.path })}
                                        title="Click to open in OS"
                                      >
                                        <div className="rc-top">
                                          <span className={`rc-badge ${badge.cls}`}>{badge.label}</span>
                                          {/* NUMERICAL RANKING */}
                                          <span className="rc-score" style={{ fontWeight: 700, color: "#4ade80" }}>
                                            #{idx + 1}
                                          </span>
                                        </div>
                                        <div className="rc-name" title={item.name}>{item.name}</div>
                                        <div className="rc-path" title={item.path}>{item.path}</div>
                                        <div className="rc-meta">{item.modified}</div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              <span className="bubble-time">{formatTime(msg.timestamp)}</span>
                            </>
                          )}
                        </div>
                        {msg.role === "user" && (
                          <div className="avatar avatar--user">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                            </svg>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Input bar ────────────────────────────────────────────────── */}
              <div className="p-3 border-t border-white/10 bg-[#14171d]/60 z-50 shrink-0">
                <div className="input-wrapper">
                  <div className="input-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </div>
                  <textarea
                    ref={inputRef}
                    className="chat-input"
                    placeholder={
                      isChatUnlocked
                        ? (showOnboarding ? "Add a folder first…" : "Search files or ask Forest anything… (Enter to send)")
                        : "Enter access passcode or explore Game tab..."
                    }
                    value={inputValue}
                    rows={1}
                    disabled={showOnboarding && isChatUnlocked}
                    onChange={e => {
                      setInputValue(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                    }}
                    onKeyDown={handleInputKeyDown}
                  />
                  <button
                    className="send-btn"
                    disabled={!inputValue.trim()}
                    onClick={() => sendMessage(inputValue)}
                    title="Send (Enter)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  </button>
                </div>
                <div className="input-hint">
                  <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>Esc</kbd> hide
                </div>
              </div>
            </main>
        ) : (
          <div className="games-interface flex-1 h-full w-full bg-[#050510] text-white flex flex-col overflow-y-auto">
            {activeGame === null ? (
              <div style={{
                padding: '40px 20px', display: 'flex', flexDirection: 'column',
                alignItems: 'center', minHeight: '500px'
              }}>
                {/* Glowing Title */}
                <h1 style={{
                  fontSize: '2.5rem', fontWeight: 900, marginBottom: '40px',
                  background: 'linear-gradient(to right, #00f2fe, #4facfe, #00f2fe)',
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                  textShadow: '0 0 25px rgba(79, 172, 254, 0.4)'
                }}>
                  Forest Playground
                </h1>

                <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', justifyContent: 'center' }}>
                  {/* Labyrinth Card (CYAN NEON) */}
                  <div
                    onClick={() => setActiveGame('maze')}
                    style={{
                      background: 'linear-gradient(145deg, #081229, #0f172a)', padding: '30px',
                      borderRadius: '20px', cursor: 'pointer', border: '2px solid rgba(6, 182, 212, 0.4)',
                      width: '260px', transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                      boxShadow: '0 0 20px rgba(6, 182, 212, 0.1), inset 0 0 20px rgba(6, 182, 212, 0.05)',
                      position: 'relative', overflow: 'hidden'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-6px) scale(1.02)';
                      e.currentTarget.style.borderColor = 'rgba(6, 182, 212, 1)';
                      e.currentTarget.style.boxShadow = '0 0 35px rgba(6, 182, 212, 0.5), inset 0 0 25px rgba(6, 182, 212, 0.2)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0) scale(1)';
                      e.currentTarget.style.borderColor = 'rgba(6, 182, 212, 0.4)';
                      e.currentTarget.style.boxShadow = '0 0 20px rgba(6, 182, 212, 0.1), inset 0 0 20px rgba(6, 182, 212, 0.05)';
                    }}
                  >
                    <h3 style={{ fontSize: '1.5rem', margin: '0 0 12px 0', color: '#22d3ee', textShadow: '0 0 10px rgba(34, 211, 238, 0.6)' }}>
                      Labyrinth
                    </h3>
                    <p style={{ color: '#cbd5e1', margin: 0, lineHeight: '1.5', fontSize: '0.95rem' }}>
                      10 brutal, algorithmic mazes in shifting geometries.
                    </p>
                  </div>

                  {/* Snake Card (GREEN NEON) */}
                  <div
                    onClick={() => setActiveGame('snake')}
                    style={{
                      background: 'linear-gradient(145deg, #062314, #0f172a)', padding: '30px',
                      borderRadius: '20px', cursor: 'pointer', border: '2px solid rgba(34, 197, 94, 0.4)',
                      width: '260px', transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                      boxShadow: '0 0 20px rgba(34, 197, 94, 0.1), inset 0 0 20px rgba(34, 197, 94, 0.05)',
                      position: 'relative', overflow: 'hidden'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-6px) scale(1.02)';
                      e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 1)';
                      e.currentTarget.style.boxShadow = '0 0 35px rgba(34, 197, 94, 0.5), inset 0 0 25px rgba(34, 197, 94, 0.2)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0) scale(1)';
                      e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.4)';
                      e.currentTarget.style.boxShadow = '0 0 20px rgba(34, 197, 94, 0.1), inset 0 0 20px rgba(34, 197, 94, 0.05)';
                    }}
                  >
                    <h3 style={{ fontSize: '1.5rem', margin: '0 0 12px 0', color: '#4ade80', textShadow: '0 0 10px rgba(74, 222, 128, 0.6)' }}>
                      Classic Snake
                    </h3>
                    <p style={{ color: '#cbd5e1', margin: 0, lineHeight: '1.5', fontSize: '0.95rem' }}>
                      The timeless classic. Eat, grow, survive.
                    </p>
                  </div>

                  {/* Level Devil Card (PURPLE NEON) */}
                  <div
                    onClick={() => setActiveGame('level-devil')}
                    style={{
                      background: 'linear-gradient(145deg, #1e0a2d, #0f172a)', padding: '30px',
                      borderRadius: '20px', cursor: 'pointer', border: '2px solid rgba(168, 85, 247, 0.4)',
                      width: '260px', transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                      boxShadow: '0 0 20px rgba(168, 85, 247, 0.1), inset 0 0 20px rgba(168, 85, 247, 0.05)',
                      position: 'relative', overflow: 'hidden'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-6px) scale(1.02)';
                      e.currentTarget.style.borderColor = 'rgba(168, 85, 247, 1)';
                      e.currentTarget.style.boxShadow = '0 0 35px rgba(168, 85, 247, 0.5), inset 0 0 25px rgba(168, 85, 247, 0.2)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0) scale(1)';
                      e.currentTarget.style.borderColor = 'rgba(168, 85, 247, 0.4)';
                      e.currentTarget.style.boxShadow = '0 0 20px rgba(168, 85, 247, 0.1), inset 0 0 20px rgba(168, 85, 247, 0.05)';
                    }}
                  >
                    <h3 style={{ fontSize: '1.5rem', margin: '0 0 12px 0', color: '#c084fc', textShadow: '0 0 10px rgba(192, 132, 252, 0.6)' }}>
                      Level Devil
                    </h3>
                    <p style={{ color: '#cbd5e1', margin: 0, lineHeight: '1.5', fontSize: '0.95rem' }}>
                      A devious platformer ported straight from the web.
                    </p>
                  </div>

                  {/* Granny Card (CRIMSON NEON) */}
                  <div
                    onClick={() => setActiveGame('granny')}
                    style={{
                      background: 'linear-gradient(145deg, #2a0808, #0f172a)', padding: '30px',
                      borderRadius: '20px', cursor: 'pointer', border: '2px solid rgba(220, 38, 38, 0.4)',
                      width: '260px', transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                      boxShadow: '0 0 20px rgba(220, 38, 38, 0.1), inset 0 0 20px rgba(220, 38, 38, 0.05)',
                      position: 'relative', overflow: 'hidden'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-6px) scale(1.02)';
                      e.currentTarget.style.borderColor = 'rgba(220, 38, 38, 1)';
                      e.currentTarget.style.boxShadow = '0 0 35px rgba(220, 38, 38, 0.5), inset 0 0 25px rgba(220, 38, 38, 0.2)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0) scale(1)';
                      e.currentTarget.style.borderColor = 'rgba(220, 38, 38, 0.4)';
                      e.currentTarget.style.boxShadow = '0 0 20px rgba(220, 38, 38, 0.1), inset 0 0 20px rgba(220, 38, 38, 0.05)';
                    }}
                  >
                    <h3 style={{ fontSize: '1.5rem', margin: '0 0 12px 0', color: '#ef4444', textShadow: '0 0 10px rgba(239, 68, 68, 0.6)' }}>
                      Granny Original
                    </h3>
                    <p style={{ color: '#cbd5e1', margin: 0, lineHeight: '1.5', fontSize: '0.95rem' }}>
                      A high-graphics horror escape experience.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, padding: '15px' }}>
                <div style={{ width: '100%', display: 'flex', marginBottom: '15px', flexShrink: 0 }}>
                  <button
                    onClick={() => setActiveGame(null)}
                    style={{
                      background: 'rgba(15, 23, 42, 0.9)', color: 'white', border: '1px solid #475569',
                      padding: '8px 16px', borderRadius: '8px', cursor: 'pointer',
                      boxShadow: '0 4px 10px rgba(0,0,0,0.5)', fontWeight: 'bold', transition: '0.2s', fontSize: '0.85rem'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(30, 41, 59, 1)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(15, 23, 42, 0.9)'}
                  >
                    ← Back to Playground
                  </button>
                </div>

                <div style={{ flex: 1, display: 'flex', minHeight: 0, width: '100%', height: '100%' }}>
                  {activeGame === 'maze' && <MazeGame />}
                  {activeGame === 'snake' && <SnakeGame />}
                  {activeGame === 'level-devil' && <LevelDevilGame />}
                  {activeGame === 'granny' && <GrannyGame />}
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {/* 
        Custom Bottom-Right Resize Grip for Frameless Tauri Windows.
      */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: '20px',
          height: '20px',
          cursor: 'se-resize',
          zIndex: 9999
        }}
        onMouseDown={(e) => {
          if (e.buttons === 1) {
            try {
              (getCurrentWindow() as any).startResizing?.('BottomRight');
            } catch {
              console.log("Failed to trigger native resize.");
            }
          }
        }}
        onPointerDown={(e) => startCustomResize(e, "SouthEast")}
      />
    </div>
  );
}