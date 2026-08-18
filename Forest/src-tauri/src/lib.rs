mod db;
mod indexer;

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use notify::{Watcher, RecursiveMode, RecommendedWatcher};

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct AgentResponse {
    pub reply: String,
    pub files: Vec<crate::indexer::SearchResult>,
}

struct FileWatcher(Mutex<Option<RecommendedWatcher>>);
pub struct AgentProcessState(pub Mutex<Option<Child>>);

// Helper function to check if the Python server is already responding on port 8765
fn is_server_running() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:8765".parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
}

#[tauri::command]
async fn ensure_agent_server(
    state: State<'_, AgentProcessState>,
) -> Result<String, String> {
    if is_server_running() {
        return Ok("Server is already running.".into());
    }

    // Resolve cross-platform path to the agent_server directory and venv python
    let current_dir = std::env::current_dir().map_err(|e| e.to_string())?;
    
    // Check both standard dev root and nested app paths
    let agent_dir = if current_dir.join("agent_server").exists() {
        current_dir.join("agent_server")
    } else if current_dir.join("../agent_server").exists() {
        current_dir.join("../agent_server")
    } else {
        return Err("Could not locate agent_server folder.".into());
    };

    let python_binary: PathBuf = if cfg!(target_os = "windows") {
        let venv_win = agent_dir.join(".venv").join("Scripts").join("python.exe");
        if venv_win.exists() {
            venv_win
        } else {
            PathBuf::from("python")
        }
    } else {
        let venv_unix = agent_dir.join(".venv").join("bin").join("python");
        if venv_unix.exists() {
            venv_unix
        } else {
            PathBuf::from("python3")
        }
    };

    // Spawn server.py as a silent detached background process
    let child = Command::new(&python_binary)
        .arg("server.py")
        .current_dir(&agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn agent server ({:?}): {}", python_binary, e))?;

    // Store the child handle for cleanup
    let mut process_lock = state.0.lock().unwrap();
    *process_lock = Some(child);

    // Poll until the server port is active (up to 4 seconds)
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(200));
        if is_server_running() {
            return Ok("Agent server started successfully.".into());
        }
    }

    Err("Agent server started but failed to open port 8765 in time.".into())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn hide_window(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
fn get_watched_folders(db: State<'_, Arc<db::DbManager>>) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT folder_path FROM watched_folders WHERE enabled = 1").map_err(|e| e.to_string())?;
    let folders = stmt.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>().map_err(|e| e.to_string())?;
    Ok(folders)
}

#[tauri::command]
fn add_watched_folder(
    db: State<'_, Arc<db::DbManager>>, 
    watcher_state: State<'_, FileWatcher>, 
    path: String
) -> Result<(), String> {
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT OR IGNORE INTO watched_folders (folder_path, enabled) VALUES (?1, 1)", [&path]).map_err(|e| e.to_string())?;
    }
    
    if let Some(watcher) = watcher_state.0.lock().unwrap().as_mut() {
        let _ = watcher.watch(std::path::Path::new(&path), RecursiveMode::Recursive);
    }

    let db_clone = db.inner().clone();
    let path_clone = path.clone();
    std::thread::spawn(move || {
        let _ = indexer::scan_folder(&db_clone, &path_clone);
    });

    Ok(())
}

#[tauri::command]
fn remove_watched_folder(
    db: State<'_, Arc<db::DbManager>>, 
    watcher_state: State<'_, FileWatcher>, 
    path: String
) -> Result<(), String> {
    if let Some(watcher) = watcher_state.0.lock().unwrap().as_mut() {
        let _ = watcher.unwatch(std::path::Path::new(&path));
    }

    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM watched_folders WHERE folder_path = ?1", [&path]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM files WHERE file_path LIKE ?1 || '%'", [&path]).map_err(|e| e.to_string())?;
    let _ = conn.execute("VACUUM", []);
    Ok(())
}

#[tauri::command]
async fn ask_agent(
    db: tauri::State<'_, std::sync::Arc<crate::db::DbManager>>,
    query: String,
    chat_history: Vec<ChatMessage>, 
) -> Result<AgentResponse, String> {
    
    const GROQ_API_KEY: &str = "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"; 
    let trimmed_query = query.trim();

    let client = reqwest::Client::new();

    // =========================================================================
    // MODE 1: @find (One-Off Isolated Local File Search)
    // =========================================================================
    if trimmed_query.starts_with("@find") {
        let clean_search_query = trimmed_query.trim_start_matches("@find").trim();
        
        let stage1_prompt = r#"You are Forest's Master File Search Planner.
Context: We locate files across the user's computer using metadata, naming variations, extensions, and directory structures.

HARD RULES:
1. BOOKS / READING: Prioritize extensions ["pdf", "epub", "mobi", "docx"]. Brainstorm titles/authors.
2. PRESENTATIONS: Prioritize extensions ["pptx", "ppt", "key", "pdf"].
3. TARGET FOLDERS: Extract specific folder names into `target_folder_hints`.

Output ONLY valid JSON matching this schema:
{
  "reasoning": "Reasoning steps...",
  "target_folder_hints": ["Downloads", "Documents"],
  "ranked_extensions": ["pdf", "epub"],
  "ranked_filename_patterns": ["report", "summary"],
  "terminal_commands_macos": ["mdfind -name 'report'"],
  "terminal_commands_windows": ["dir /s /b *report*"],
  "order_by_latest": false
}"#;

        let stage1_res = client.post("https://api.groq.com/openai/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", GROQ_API_KEY))
            .json(&serde_json::json!({
                "model": "openai/gpt-oss-120b",
                "messages": [
                    { "role": "system", "content": stage1_prompt },
                    { "role": "user", "content": clean_search_query }
                ],
                "response_format": { "type": "json_object" },
                "temperature": 0.1
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let stage1_json: serde_json::Value = stage1_res.json().await.map_err(|e| e.to_string())?;
        let plan_str = stage1_json["choices"][0]["message"]["content"].as_str().unwrap_or("{}");
        let plan: serde_json::Value = serde_json::from_str(plan_str).unwrap_or_else(|_| serde_json::json!({}));

        let ranked_extensions: Vec<String> = plan["ranked_extensions"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.trim_start_matches('.').to_lowercase())).collect())
            .unwrap_or_default();
            
        let ranked_patterns: Vec<String> = plan["ranked_filename_patterns"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

        let target_folder_hints: Vec<String> = plan["target_folder_hints"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_lowercase())).collect())
            .unwrap_or_default();

        let mut candidate_pool: Vec<(String, String, String, i64, i64, String)> = Vec::new();

        // 1. Watched Folders Scan
        let mut watched_folders = Vec::new();
        {
            let conn = db.conn.lock().unwrap();
            if let Ok(mut stmt) = conn.prepare("SELECT folder_path FROM watched_folders WHERE enabled = 1") {
                if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                    for row in rows.flatten() { watched_folders.push(row); }
                }
            };
        }

        for base_folder in &watched_folders {
            let walker = ignore::WalkBuilder::new(base_folder).standard_filters(true).build();
            for entry in walker.flatten() {
                let path = entry.path();
                let path_str = path.to_string_lossy().to_string();
                let lower_path = path_str.to_lowercase();
                let in_target_dir = target_folder_hints.iter().any(|hint| lower_path.contains(hint));

                if path.is_file() {
                    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let lower_name = name.to_lowercase();
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();

                    let ext_matches = ranked_extensions.is_empty() || ranked_extensions.contains(&ext);
                    let name_matches = ranked_patterns.iter().any(|pat| lower_name.contains(&pat.to_lowercase()));

                    if (in_target_dir && ext_matches) || (ext_matches && name_matches) {
                        let cat = crate::indexer::categorize_file(path).to_string();
                        let last_mod = path.metadata().ok().and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64).unwrap_or(0);
                        candidate_pool.push((name, path_str, cat, 0, last_mod, "Direct Match".to_string()));
                    }
                }
            }
        }

        // 2. Terminal OS Finder
        let os_commands = if cfg!(target_os = "macos") { plan["terminal_commands_macos"].as_array() } else if cfg!(target_os = "windows") { plan["terminal_commands_windows"].as_array() } else { None };
        if let Some(cmds) = os_commands {
            for cmd_val in cmds.iter().take(3) {
                if let Some(cmd) = cmd_val.as_str() {
                    let output = if cfg!(target_os = "windows") {
                        std::process::Command::new("cmd").args(&["/C", cmd]).output()
                    } else {
                        std::process::Command::new("sh").args(&["-c", cmd]).output()
                    };

                    if let Ok(out) = output {
                        let out_str = String::from_utf8_lossy(&out.stdout);
                        for line in out_str.lines().take(15) {
                            let path = std::path::Path::new(line.trim());
                            if path.is_file() {
                                let path_str = path.to_string_lossy().to_string();
                                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                                let cat = crate::indexer::categorize_file(path).to_string();
                                let last_mod = path.metadata().ok().and_then(|m| m.modified().ok())
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs() as i64).unwrap_or(0);
                                candidate_pool.push((name, path_str, cat, 0, last_mod, "Native Search".to_string()));
                            }
                        }
                    }
                }
            }
        }

        candidate_pool.sort_by(|a, b| a.1.cmp(&b.1));
        candidate_pool.dedup_by(|a, b| a.1 == b.1);
        candidate_pool.sort_by(|a, b| b.4.cmp(&a.4));

        let top_candidates: Vec<_> = candidate_pool.into_iter().take(15).collect();
        let mut candidate_context = String::new();
        for (name, path, cat, _, _, source) in &top_candidates {
            candidate_context.push_str(&format!("- Name: {}\n  Path: {}\n  Type: {}\n  Source: {}\n\n", name, path, cat, source));
        }

        let stage3_prompt = format!(
            r#"You are Forest, an ultra-fast local desktop AI file assistant.
User Search Query: "{}"

CANDIDATES FOUND ON DISK:
{}

STRICT FORMATTING RULES:
1. NO MARKDOWN. Do not use asterisks (**) or hashes (#). 
2. Use double line breaks (\n\n) between lines to ensure proper spacing.
3. IF FILES ARE FOUND: State "Found the matching file(s):" and list them using standard Unicode bullets (•).
4. IF NO FILES FOUND: State EXACTLY: "I could not find the required files. Please try adding more details to your prompt, such as the folder name, file format, or specific keywords."

Return ONLY valid JSON:
{{
  "explanation": "Properly spaced plain text message...",
  "ranked_files": [
    {{"path": "/path/to/file", "score": 95}}
  ]
}}"#,
            clean_search_query,
            if candidate_context.is_empty() { "No files found." } else { &candidate_context }
        );

        let stage3_res = client.post("https://api.groq.com/openai/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", GROQ_API_KEY))
            .json(&serde_json::json!({
                "model": "openai/gpt-oss-120b",
                "messages": [
                    { "role": "system", "content": stage3_prompt },
                    { "role": "user", "content": clean_search_query }
                ],
                "response_format": { "type": "json_object" },
                "temperature": 0.1
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let stage3_json: serde_json::Value = stage3_res.json().await.map_err(|e| e.to_string())?;
        let judge_str = stage3_json["choices"][0]["message"]["content"].as_str().unwrap_or("{}");
        let judge_val: serde_json::Value = serde_json::from_str(judge_str).unwrap_or_default();

        let explanation = judge_val["explanation"].as_str().unwrap_or("No matching files found.").to_string();
        let mut final_results = Vec::new();

        if let Some(ranked_files) = judge_val["ranked_files"].as_array() {
            for item in ranked_files {
                if let (Some(path), Some(score)) = (item["path"].as_str(), item["score"].as_u64()) {
                    if let Some((name, p, cat, id, _, source)) = top_candidates.iter().find(|c| c.1 == path) {
                        final_results.push(crate::indexer::SearchResult {
                            id: id.to_string(),
                            name: name.clone(),
                            path: p.clone(),
                            category: cat.clone(),
                            modified: source.clone(),
                            match_score: score as u8,
                        });
                    }
                }
            }
        }

        return Ok(AgentResponse {
            reply: explanation,
            files: final_results,
        });
    }

    // =========================================================================
    // MODE 2: @download (Intelligent Software Installer & Package Manager)
    // =========================================================================
    if trimmed_query.starts_with("@download") {
        let clean_download_query = trimmed_query.trim_start_matches("@download").trim();

        let os_type = if cfg!(target_os = "macos") { "macOS" } else if cfg!(target_os = "windows") { "Windows" } else { "Linux" };

        let download_planner_prompt = format!(
            r#"You are Forest's System Software Package Manager Agent.
User Target: "{}"
Current OS: {}

YOUR TASK:
1. Identify the exact software, CLI tool, or runtime the user wants (e.g. Python, uv, Claude Code, Jupyter, Node, Rust, FFmpeg).
2. Generate the command to check if it is ALREADY installed on the machine.
3. Determine the best, most modern, one-step installation command (e.g., Homebrew, npm i -g, uv tool, official curl script, winget).
4. Provide the target install directory and latest stable version.

Output ONLY valid JSON:
{{
  "software_name": "Claude Code",
  "check_command": "which claude || command -v claude",
  "version_command": "claude --version",
  "install_command": "npm install -g @anthropic-ai/claude-code",
  "install_directory": "/opt/homebrew/bin/claude or ~/.npm-global/bin",
  "latest_version": "latest stable",
  "uninstall_command": "npm uninstall -g @anthropic-ai/claude-code"
}}"#,
            clean_download_query, os_type
        );

        let dl_res = client.post("https://api.groq.com/openai/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", GROQ_API_KEY))
            .json(&serde_json::json!({
                "model": "openai/gpt-oss-120b",
                "messages": [
                    { "role": "system", "content": download_planner_prompt },
                    { "role": "user", "content": clean_download_query }
                ],
                "response_format": { "type": "json_object" },
                "temperature": 0.0
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let dl_json: serde_json::Value = dl_res.json().await.map_err(|e| e.to_string())?;
        let plan_str = dl_json["choices"][0]["message"]["content"].as_str().unwrap_or("{}");
        let plan: serde_json::Value = serde_json::from_str(plan_str).unwrap_or_default();

        let software_name = plan["software_name"].as_str().unwrap_or(clean_download_query);
        let check_cmd = plan["check_command"].as_str().unwrap_or("");
        let version_cmd = plan["version_command"].as_str().unwrap_or("");
        let install_cmd = plan["install_command"].as_str().unwrap_or("");
        let install_dir = plan["install_directory"].as_str().unwrap_or("Standard System Binaries");
        let latest_ver = plan["latest_version"].as_str().unwrap_or("latest");

        // Execute local check in background
        let mut is_installed = false;
        let mut installed_path_or_ver = String::new();

        if !check_cmd.is_empty() {
            let check_output = if cfg!(target_os = "windows") {
                std::process::Command::new("cmd").args(&["/C", check_cmd]).output()
            } else {
                std::process::Command::new("sh").args(&["-c", check_cmd]).output()
            };

            if let Ok(out) = check_output {
                if out.status.success() {
                    is_installed = true;
                    installed_path_or_ver = String::from_utf8_lossy(&out.stdout).trim().to_string();

                    // Try to get version string
                    if !version_cmd.is_empty() {
                        let ver_out = if cfg!(target_os = "windows") {
                            std::process::Command::new("cmd").args(&["/C", version_cmd]).output()
                        } else {
                            std::process::Command::new("sh").args(&["-c", version_cmd]).output()
                        };
                        if let Ok(v) = ver_out {
                            let v_str = String::from_utf8_lossy(&v.stdout).trim().to_string();
                            if !v_str.is_empty() {
                                installed_path_or_ver = format!("{} ({})", installed_path_or_ver, v_str);
                            }
                        }
                    }
                }
            }
        }

        let uninstall_cmd = plan["uninstall_command"].as_str().unwrap_or(""); // Ensure we extract this

        let reply_msg = if is_installed {
            format!(
                "**{} is already installed on your machine!**\n\n\
                • Current Location / Version: `{}`\n\n\
                ___DOWNLOAD_ACTIONS___{{\"software\": \"{}\", \"install_cmd\": \"{}\", \"uninstall_cmd\": \"{}\", \"is_installed\": true}}",
                software_name, installed_path_or_ver, software_name, install_cmd, uninstall_cmd
            )
        } else {
            format!(
                "**Ready to install {} ({})**\n\n\
                • Target Directory: `{}`\n\
                • One-Step Command: `{}`\n\n\
                ___DOWNLOAD_ACTIONS___{{\"software\": \"{}\", \"install_cmd\": \"{}\", \"uninstall_cmd\": \"\", \"is_installed\": false}}",
                software_name, latest_ver, install_dir, install_cmd, software_name, install_cmd
            )
        };

        return Ok(AgentResponse {
            reply: reply_msg,
            files: vec![],
        });
    }

    // =========================================================================
    // MODE 4: @prompt (Expert Prompt Engineer)
    // =========================================================================
    if trimmed_query.starts_with("@prompt") {
        let clean_intent = trimmed_query.trim_start_matches("@prompt").trim();

        let prompt_engineer_system = r#"You are Forest's Expert Prompt Engineer with over 10 years of experience in NLP and LLM behavior.
Your task is to take the user's rough intent and transform it into a highly optimized, mastercrafted prompt ready to be pasted into an advanced LLM.

STRICT RULES:
1. Analyze the intent and select the best framework (e.g., Chain of Thought, Tree of Thoughts, Few-Shot, Persona-based).
2. Inject necessary behavioral constraints (e.g., "Think step-by-step", "Be brutally honest", "Do not hallucinate", "Take a deep breath").
3. Format the output cleanly using double newlines (\n\n) and standard Unicode bullets (•). 
4. DO NOT use markdown asterisks (**) or hashes (#) as the UI does not support it.
5. OUTPUT EXACTLY AND ONLY THE FINAL PROMPT. Do not include introductory remarks like "Here is your prompt:". The text must be 100% ready to copy-paste."#;

        let prompt_res = client.post("https://api.groq.com/openai/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", GROQ_API_KEY))
            .json(&serde_json::json!({
                "model": "openai/gpt-oss-120b", // Use whichever Groq model you prefer here
                "messages": [
                    { "role": "system", "content": prompt_engineer_system },
                    { "role": "user", "content": clean_intent }
                ],
                "temperature": 0.4 // Slightly higher creativity for better prompt design
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let prompt_json: serde_json::Value = prompt_res.json().await.map_err(|e| e.to_string())?;
        let raw_reply = prompt_json["choices"][0]["message"]["content"].as_str()
            .unwrap_or("Failed to generate prompt.")
            .to_string();

        // Inject a hidden tag so the frontend knows this is a generated prompt
        let reply = format!("{}___PROMPT_OUTPUT___", raw_reply);

        return Ok(AgentResponse {
            reply,
            files: vec![],
        });
    }

    // =========================================================================
    // MODE 5: @execute (Automated Terminal Command Runner)
    // =========================================================================
    if trimmed_query.starts_with("@execute") {
        let cmd_to_run = trimmed_query.trim_start_matches("@execute").trim();

        let output = if cfg!(target_os = "windows") {
            std::process::Command::new("cmd").args(&["/C", cmd_to_run]).output()
        } else {
            std::process::Command::new("sh").args(&["-c", cmd_to_run]).output()
        };

        let reply = match output {
            Ok(out) => {
                if out.status.success() {
                    format!("✅ **Successfully executed:**\n`{}`\n\n**Output:**\n{}", cmd_to_run, String::from_utf8_lossy(&out.stdout).trim())
                } else {
                    format!("❌ **Command failed:**\n`{}`\n\n**Error:**\n{}", cmd_to_run, String::from_utf8_lossy(&out.stderr).trim())
                }
            },
            Err(e) => format!("⚠️ **System Error:** Failed to spawn terminal process.\n{}", e)
        };

        return Ok(AgentResponse {
            reply,
            files: vec![],
        });
    }

    // =========================================================================
    // MODE 3: DEFAULT (Forest All-in-One PC Assistant with Context Memory)
    // =========================================================================
    let default_system_prompt = "You are Forest, an all-in-one desktop PC AI assistant. You help the user with quick questions, coding, explanations, general knowledge, and system tasks.\n\n\
STRICT FORMATTING RULES:\n\
1. YOUR UI DOES NOT RENDER MARKDOWN. DO NOT use asterisks (**) for bolding, hashes (#) for headers, or markdown tables.\n\
2. Use DOUBLE line breaks (\\n\\n) to separate paragraphs so the text does not clump together.\n\
3. For lists, use standard Unicode bullets (•) and put each item on a new line with a double line break before the list starts.\n\
4. Rely on the conversational chat history to resolve context, follow-ups, and pronouns.\n\
5. Be direct, concise, grounded, and helpful.";

    let mut messages_payload = vec![serde_json::json!({ "role": "system", "content": default_system_prompt })];
    for msg in &chat_history {
        messages_payload.push(serde_json::json!({ "role": msg.role.clone(), "content": msg.content.clone() }));
    }
    messages_payload.push(serde_json::json!({ "role": "user", "content": query }));

    let chat_res = client.post("https://api.groq.com/openai/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", GROQ_API_KEY))
        .json(&serde_json::json!({
            "model": "openai/gpt-oss-120b",
            "messages": messages_payload,
            "temperature": 0.3
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let chat_json: serde_json::Value = chat_res.json().await.map_err(|e| e.to_string())?;
    let reply = chat_json["choices"][0]["message"]["content"].as_str().unwrap_or("How can I assist you today?").to_string();

    Ok(AgentResponse {
        reply,
        files: vec![],
    })
}

#[tauri::command]
fn search_files(db: State<'_, Arc<db::DbManager>>, query: String) -> Result<Vec<indexer::SearchResult>, String> {
    indexer::query_files(&db, &query)
}

#[tauri::command]
fn scan_all_folders(
    db: State<'_, Arc<db::DbManager>>,
    watcher_state: State<'_, FileWatcher>
) -> Result<usize, String> {
    let folders = get_watched_folders(db.clone())?;
    if let Some(watcher) = watcher_state.0.lock().unwrap().as_mut() {
        for folder in &folders {
            let _ = watcher.watch(std::path::Path::new(folder), RecursiveMode::Recursive);
        }
    }

    let db_clone = db.inner().clone();
    std::thread::spawn(move || {
        for folder in folders {
            let _ = indexer::scan_folder(&db_clone, &folder);
        }
    });

    Ok(0)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            let _ = window.hide();
        } else {
            let _ = window.set_visible_on_all_workspaces(true);
            let _ = window.set_always_on_top(true);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let opt_space = Shortcut::new(Some(Modifiers::ALT), Code::Space);
                        let cmd_shift_space = Shortcut::new(
                            Some(Modifiers::SUPER | Modifiers::SHIFT),
                            Code::Space,
                        );
                        if shortcut == &opt_space || shortcut == &cmd_shift_space {
                            toggle_main_window(app);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("Failed to get app data directory");
            let db_manager = Arc::new(db::DbManager::new(app_data_dir).expect("Failed to initialize database"));
            
            let app_handle = app.handle().clone();
            let db_clone = db_manager.clone();
            
            let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    indexer::handle_file_event(&db_clone, event);
                    let _ = app_handle.emit("file-changed", ());
                }
            }).ok(); 
        
            app.manage(db_manager);
            app.manage(FileWatcher(Mutex::new(watcher)));
            app.manage(AgentProcessState(Mutex::new(None)));

            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App(Default::default())
            )
            .title("Forest")
            .inner_size(750.0, 500.0)
            .min_inner_size(400.0, 300.0)
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .center()
            .visible(false)
            .shadow(false)
            .build()?;

            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show Forest", true, None::<&str>)?;
            let menu = Menu::new(app)?;
            menu.append(&show_i)?;
            menu.append(&quit_i)?;

            let tray_icon = app.default_window_icon().unwrap().clone();
            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => toggle_main_window(app),
                    _ => {}
                })
                .build(app)?;

            let opt_space = Shortcut::new(Some(Modifiers::ALT), Code::Space);
            let cmd_shift_space = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
            let _ = app.global_shortcut().register(opt_space);
            let _ = app.global_shortcut().register(cmd_shift_space);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet, 
            hide_window, 
            get_watched_folders, 
            add_watched_folder, 
            remove_watched_folder,
            search_files,
            scan_all_folders,
            open_path,
            ask_agent,
            ensure_agent_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}