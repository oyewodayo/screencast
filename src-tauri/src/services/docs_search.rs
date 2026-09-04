// services/docs_search.rs
//
// Full-text search index for the Docs feature, backing DocsHome.tsx's search - replaces the
// previous approach of decoding every doc's full Yjs bytes into memory on every search keystroke,
// which didn't scale past a modest doc count. This Rust backend has no Yjs decoder of its own (all
// CRDT work happens client-side, in JS - see docs.rs's own header comment on why doc.bin is opaque
// to Rust), so the *plain text* to index has to be computed on the frontend
// (useDocsEditStore.ts, on load and on every autosave) and handed over here - this file only owns
// storage/querying, not text extraction.
//
// One SQLite database, Docs/search.db, with a single FTS5 virtual table - SQLite specifically
// (unlike every other piece of Docs state, which is plain JSON sidecars) because FTS5 gives real
// indexed full-text search; a hand-rolled scan over N small sidecar files would still be O(n) per
// query, just with smaller files to read than a full Yjs decode. A fresh Connection is opened per
// command rather than held open across calls - cheap for SQLite, and keeps this file free of any
// shared/lazy-static connection state to manage.
use rusqlite::{params, Connection};
use std::path::PathBuf;
use tauri::command;

use super::docs::DOCS_DIR_NAME;
use super::utility::briefcast_dir;

fn db_path() -> Result<PathBuf, String> {
    let root = briefcast_dir()?.join(DOCS_DIR_NAME);
    std::fs::create_dir_all(&root).map_err(|e| format!("Failed to create Docs folder: {}", e))?;
    Ok(root.join("search.db"))
}

fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(db_path()?).map_err(|e| format!("Failed to open search index: {}", e))?;
    conn.execute_batch("CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, title, body);")
        .map_err(|e| format!("Failed to initialize search index: {}", e))?;
    Ok(conn)
}

// Upsert - FTS5 has no native ON CONFLICT upsert, so this is a delete-then-insert inside one
// transaction. Called by the frontend whenever a doc's content could have changed (on open, and on
// every autosave) - see useDocsEditStore.ts.
#[command]
pub fn index_doc_content(id: String, title: String, body: String) -> Result<(), String> {
    let mut conn = open_db()?;
    let tx = conn.transaction().map_err(|e| format!("Failed to index document: {}", e))?;
    tx.execute("DELETE FROM docs_fts WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to index document: {}", e))?;
    tx.execute("INSERT INTO docs_fts (id, title, body) VALUES (?1, ?2, ?3)", params![id, title, body])
        .map_err(|e| format!("Failed to index document: {}", e))?;
    tx.commit().map_err(|e| format!("Failed to index document: {}", e))
}

// Called when a doc is soft-deleted (docs.rs's delete_doc) so a trashed doc - already excluded
// from list_docs - stops showing up in search results too. Restoring a doc doesn't re-add it here
// immediately; it picks itself back up the next time it's opened or saved, same as a doc that was
// never indexed in the first place (see list_indexed_doc_ids' own comment on that gap).
#[command]
pub fn remove_doc_from_index(id: String) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute("DELETE FROM docs_fts WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to remove document from search index: {}", e))?;
    Ok(())
}

// Lets the frontend find which docs from list_docs' own result are *not* indexed yet - a doc
// created before this feature shipped, or one restored from trash, has no row here until it's
// next opened/saved. DocsHome.tsx uses this once per app-visit to lazily backfill the gap in the
// background (load + extract text + index_doc_content), the same "fix it up the next time it's
// touched" posture relink_doc_path already uses for stale linked-file paths elsewhere in this
// feature.
#[command]
pub fn list_indexed_doc_ids() -> Result<Vec<String>, String> {
    let conn = open_db()?;
    let mut stmt = conn.prepare("SELECT id FROM docs_fts").map_err(|e| format!("Failed to read search index: {}", e))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to read search index: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Failed to read search index: {}", e))
}

// FTS5's query syntax treats several characters ("*^:-()) specially - a raw user query containing
// any of them (a stray quote, a title with a colon in it) would throw a syntax error rather than
// just searching for it literally. Stripping every term down to bare alphanumerics before adding
// FTS5's own prefix-match suffix (`term*`, matching any token starting with it - what makes typing
// a partial word while search-as-you-type still return results) sidesteps that entirely: nothing
// but a trailing `*` ever reaches the query syntax layer, so nothing in the original input can be
// interpreted as FTS5 syntax.
fn sanitize_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|term| term.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|term| !term.is_empty())
        .map(|term| format!("{}*", term))
        .collect::<Vec<_>>()
        .join(" ")
}

// Returns matching doc ids only (not titles/snippets) - DocsHome.tsx already holds the full
// DocSummary list from list_docs and just needs to know which ones matched, not a second copy of
// their metadata.
#[command]
pub fn search_docs(query: String) -> Result<Vec<String>, String> {
    let sanitized = sanitize_fts_query(&query);
    if sanitized.is_empty() {
        return Ok(Vec::new());
    }
    let conn = open_db()?;
    let mut stmt = conn
        .prepare("SELECT id FROM docs_fts WHERE docs_fts MATCH ?1 ORDER BY rank")
        .map_err(|e| format!("Failed to search documents: {}", e))?;
    let rows = stmt
        .query_map(params![sanitized], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to search documents: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Failed to search documents: {}", e))
}
