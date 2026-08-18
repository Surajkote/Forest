use rusqlite::params;
use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;
use notify::Event;
use ignore::WalkBuilder;
use crate::db::DbManager;

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub id: String,
    pub name: String,
    pub path: String,
    pub category: String,
    pub modified: String,
    pub match_score: u8,
}

pub fn categorize_file(path: &Path) -> &'static str {
    if path.is_dir() { return "folder"; }
    match path.extension().and_then(|ext| ext.to_str()).map(|s| s.to_lowercase()).as_deref() {
        Some("rs" | "ts" | "js" | "py" | "cpp" | "c" | "h" | "html" | "css" | "json" | "sh" | "tsx" | "jsx" | "toml" | "yaml" | "yml" | "gitignore" | "env") => "code",
        Some("md" | "txt" | "doc" | "docx" | "pages" | "pdf" | "csv") => "doc",
        Some("png" | "jpg" | "jpeg" | "gif" | "svg" | "webp") => "image",
        Some("mp3" | "wav" | "m4a" | "flac" | "aac") => "audio",
        Some("mp4" | "mov" | "avi" | "mkv") => "video",
        Some("zip" | "tar" | "gz" | "bin" | "iso" | "7z") => "archive",
        _ => "doc",
    }
}

pub fn scan_folder(db: &DbManager, folder_path: &str) -> Result<usize, String> {
    if folder_path.trim().is_empty() { return Ok(0); }
    
    let mut count = 0;
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 1. Instantly clear old records for this folder to prevent stale data
    let pattern = format!("{}%", folder_path);
    tx.execute("DELETE FROM files WHERE file_path LIKE ?1", params![pattern]).map_err(|e| e.to_string())?;

    // 2. Blazing fast multi-threaded directory walking using 'ignore'
    // It automatically skips .git, node_modules, target folders, and respects .gitignore!
    let walker = WalkBuilder::new(folder_path)
        .standard_filters(true)
        .build();

    for result in walker {
        if let Ok(entry) = result {
            let path = entry.path();
            if path.is_dir() { continue; }

            let path_str = path.to_string_lossy().to_string();
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                let category = categorize_file(path);
                let last_modified = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                // Insert the lightweight metadata
                let _ = tx.execute(
                    "INSERT INTO files (file_name, file_path, category, last_modified, content)
                     VALUES (?1, ?2, ?3, ?4, '')",
                    params![file_name, path_str, category, last_modified],
                );
                count += 1;
            }
        }
    }
    
    tx.commit().map_err(|e| e.to_string())?;
    println!("Successfully indexed {} files in {}", count, folder_path);
    Ok(count)
}

pub fn handle_file_event(db: &DbManager, event: Event) {
    let conn = db.conn.lock().unwrap();
    for path in event.paths {
        let path_str = path.to_string_lossy().to_string();

        if path.exists() {
            if path.is_file() {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    let category = categorize_file(&path);
                    let last_modified = path.metadata().ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);

                    let _ = conn.execute(
                        "INSERT INTO files (file_name, file_path, category, last_modified, content) VALUES (?1, ?2, ?3, ?4, '')
                         ON CONFLICT(file_path) DO UPDATE SET file_name = excluded.file_name, category = excluded.category, last_modified = excluded.last_modified",
                        params![file_name, path_str, category, last_modified],
                    );
                }
            }
        } else {
            let _ = conn.execute("DELETE FROM files WHERE file_path = ?1", params![path_str]);
        }
    }
}

pub fn query_files(db: &DbManager, search_term: &str) -> Result<Vec<SearchResult>, String> {
    let conn = db.conn.lock().unwrap();
    let mut results = Vec::new();

    // Fast lexical fallback search for the UI
    let sql = format!(
        "SELECT id, file_name, file_path, category, last_modified 
         FROM files 
         WHERE file_name LIKE '%{}%' OR file_path LIKE '%{}%' OR category LIKE '%{}%' 
         LIMIT 30", 
        search_term, search_term, search_term
    );

    if let Ok(mut stmt) = conn.prepare(&sql) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok(SearchResult {
                id: row.get::<_, i64>(0)?.to_string(),
                name: row.get(1)?,
                path: row.get(2)?,
                category: row.get(3)?,
                modified: "Indexed".to_string(),
                match_score: 95, 
            })
        }) {
            for row in rows.flatten() {
                results.push(row);
            }
        }
    }

    Ok(results)
}