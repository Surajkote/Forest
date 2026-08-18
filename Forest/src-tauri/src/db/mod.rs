use rusqlite::Connection;
use std::sync::Mutex;

pub struct DbManager {
    pub conn: Mutex<Connection>,
}

impl DbManager {
    pub fn new(app_data_dir: std::path::PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
        
        // SWITCH TO V3: This abandons the old bloated vector database instantly
        let db_path = app_data_dir.join("forest_v3.db");
        
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

        // We only need the lightweight metadata table now! No chunks table.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL,
                last_modified INTEGER NOT NULL,
                content TEXT
            )",
            [],
        ).map_err(|e| e.to_string())?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS watched_folders (
                folder_path TEXT PRIMARY KEY,
                enabled INTEGER DEFAULT 1
            )",
            [],
        ).map_err(|e| e.to_string())?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}