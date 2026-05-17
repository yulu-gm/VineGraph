use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_ATTACH_SNAPSHOT_CHARS: usize = 200_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PtySessionStatus {
    Running,
    Exited,
    Failed,
    Cancelled,
    Killed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PtySessionRequest {
    pub session_id: String,
    pub run_id: String,
    pub activation_id: String,
    pub node_id: String,
    pub workspace_path: String,
    pub command: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionSummary {
    pub session_id: String,
    pub run_id: String,
    pub activation_id: String,
    pub node_id: String,
    pub workspace_path: String,
    pub command: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub status: PtySessionStatus,
    pub created_at_ms: u128,
    pub updated_at_ms: u128,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionAttachSnapshot {
    pub session_id: String,
    pub run_id: String,
    pub activation_id: String,
    pub node_id: String,
    pub workspace_path: String,
    pub command: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub status: PtySessionStatus,
    pub exit_code: Option<i32>,
    pub snapshot: String,
    pub truncated: bool,
    pub snapshot_max_chars: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionCapability {
    pub backend: String,
    pub available: bool,
    pub fallback: String,
}

#[derive(Debug)]
struct PtySessionState {
    summary: PtySessionSummary,
    transcript: String,
    transcript_truncated: bool,
}

#[derive(Debug)]
pub struct PtySessionManager {
    sessions: Mutex<HashMap<String, PtySessionState>>,
    snapshot_max_chars: usize,
}

impl Default for PtySessionManager {
    fn default() -> Self {
        Self::new(DEFAULT_ATTACH_SNAPSHOT_CHARS)
    }
}

impl PtySessionManager {
    pub fn new(snapshot_max_chars: usize) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            snapshot_max_chars,
        }
    }

    pub fn portable_pty_available(&self) -> bool {
        false
    }

    pub fn capability(&self) -> PtySessionCapability {
        PtySessionCapability {
            backend: "portable-pty".into(),
            available: self.portable_pty_available(),
            fallback: "node-pty-or-stream".into(),
        }
    }

    pub fn create_session(&self, request: PtySessionRequest) -> Result<PtySessionSummary, String> {
        let session_id = request.session_id.trim();
        if session_id.is_empty() {
            return Err("Missing terminal session id".into());
        }

        let now = now_ms();
        let summary = PtySessionSummary {
            session_id: session_id.into(),
            run_id: request.run_id,
            activation_id: request.activation_id,
            node_id: request.node_id,
            workspace_path: request.workspace_path,
            command: request.command,
            args: request.args,
            cols: request.cols,
            rows: request.rows,
            status: PtySessionStatus::Running,
            created_at_ms: now,
            updated_at_ms: now,
            exit_code: None,
        };

        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        if sessions.contains_key(&summary.session_id) {
            return Err(format!(
                "Terminal session already exists: {}",
                summary.session_id
            ));
        }
        sessions.insert(
            summary.session_id.clone(),
            PtySessionState {
                summary: summary.clone(),
                transcript: String::new(),
                transcript_truncated: false,
            },
        );
        Ok(summary)
    }

    pub fn append_output(&self, session_id: &str, chunk: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        let state = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Terminal session not found: {}", session_id))?;
        state.transcript.push_str(chunk);
        let max_chars = self.snapshot_max_chars;
        let bounded = tail_by_chars(&state.transcript, max_chars);
        if bounded.truncated {
            state.transcript = bounded.snapshot;
            state.transcript_truncated = true;
        }
        state.summary.updated_at_ms = now_ms();
        Ok(())
    }

    pub fn attach_session(&self, session_id: &str) -> Result<PtySessionAttachSnapshot, String> {
        let sessions = self.sessions.lock().map_err(lock_error)?;
        let state = sessions
            .get(session_id)
            .ok_or_else(|| format!("Terminal session not found: {}", session_id))?;
        let bounded = tail_by_chars(&state.transcript, self.snapshot_max_chars);
        Ok(PtySessionAttachSnapshot {
            session_id: state.summary.session_id.clone(),
            run_id: state.summary.run_id.clone(),
            activation_id: state.summary.activation_id.clone(),
            node_id: state.summary.node_id.clone(),
            workspace_path: state.summary.workspace_path.clone(),
            command: state.summary.command.clone(),
            args: state.summary.args.clone(),
            cols: state.summary.cols,
            rows: state.summary.rows,
            status: state.summary.status.clone(),
            exit_code: state.summary.exit_code,
            snapshot: bounded.snapshot,
            truncated: state.transcript_truncated || bounded.truncated,
            snapshot_max_chars: self.snapshot_max_chars,
        })
    }

    pub fn close_session(
        &self,
        session_id: &str,
        status: PtySessionStatus,
        exit_code: Option<i32>,
    ) -> Result<PtySessionSummary, String> {
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        let state = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Terminal session not found: {}", session_id))?;
        state.summary.status = status;
        state.summary.exit_code = exit_code;
        state.summary.updated_at_ms = now_ms();
        Ok(state.summary.clone())
    }

    pub fn list_sessions(&self, run_id: Option<&str>) -> Result<Vec<PtySessionSummary>, String> {
        let sessions = self.sessions.lock().map_err(lock_error)?;
        Ok(sessions
            .values()
            .filter(|state| run_id.map_or(true, |id| state.summary.run_id == id))
            .map(|state| state.summary.clone())
            .collect())
    }
}

struct BoundedSnapshot {
    snapshot: String,
    truncated: bool,
}

fn tail_by_chars(value: &str, max_chars: usize) -> BoundedSnapshot {
    let total_chars = value.chars().count();
    if total_chars <= max_chars {
        return BoundedSnapshot {
            snapshot: value.into(),
            truncated: false,
        };
    }

    let skip_chars = total_chars - max_chars;
    let start = value
        .char_indices()
        .nth(skip_chars)
        .map(|(index, _)| index)
        .unwrap_or(value.len());

    BoundedSnapshot {
        snapshot: value[start..].into(),
        truncated: true,
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    format!("Terminal session manager lock poisoned: {}", error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_returns_bounded_snapshot_and_session_metadata() {
        let manager = PtySessionManager::new(8);
        let session = manager
            .create_session(PtySessionRequest {
                session_id: "term_a".into(),
                run_id: "run_a".into(),
                activation_id: "act_a".into(),
                node_id: "node_a".into(),
                workspace_path: "/tmp/project".into(),
                command: "sh".into(),
                args: vec!["-lc".into(), "printf hello".into()],
                cols: 100,
                rows: 28,
            })
            .expect("session can be created");

        manager
            .append_output(&session.session_id, "0123456789")
            .expect("output can be appended");

        let snapshot = manager
            .attach_session(&session.session_id)
            .expect("session can be attached");

        assert_eq!(snapshot.session_id, "term_a");
        assert_eq!(snapshot.run_id, "run_a");
        assert_eq!(snapshot.activation_id, "act_a");
        assert_eq!(snapshot.node_id, "node_a");
        assert_eq!(snapshot.status, PtySessionStatus::Running);
        assert_eq!(snapshot.cols, 100);
        assert_eq!(snapshot.rows, 28);
        assert_eq!(snapshot.snapshot, "23456789");
        assert!(snapshot.truncated);
    }

    #[test]
    fn close_session_uses_one_lifecycle_model_for_active_sessions() {
        let manager = PtySessionManager::new(128);
        assert!(!manager.portable_pty_available());
        manager
            .create_session(PtySessionRequest {
                session_id: "term_b".into(),
                run_id: "run_b".into(),
                activation_id: "act_b".into(),
                node_id: "node_b".into(),
                workspace_path: "/tmp/project".into(),
                command: "sh".into(),
                args: vec![],
                cols: 80,
                rows: 24,
            })
            .expect("session can be created");

        let closed = manager
            .close_session("term_b", PtySessionStatus::Killed, Some(-1))
            .expect("session can be closed");

        assert_eq!(closed.status, PtySessionStatus::Killed);
        assert_eq!(closed.exit_code, Some(-1));
        assert_eq!(
            manager
                .list_sessions(Some("run_b"))
                .expect("sessions can be listed")
                .len(),
            1
        );
        assert_eq!(
            manager
                .attach_session("term_b")
                .expect("closed session remains attachable")
                .status,
            PtySessionStatus::Killed
        );
    }

    #[test]
    fn lifecycle_statuses_cover_planned_terminal_outcomes() {
        assert_eq!(PtySessionStatus::Exited, PtySessionStatus::Exited);
        assert_eq!(PtySessionStatus::Failed, PtySessionStatus::Failed);
        assert_eq!(PtySessionStatus::Cancelled, PtySessionStatus::Cancelled);
    }

    #[test]
    fn capability_reports_explicit_browser_dev_fallback_until_pty_backend_is_linked() {
        let capability = PtySessionManager::new(128).capability();

        assert_eq!(capability.backend, "portable-pty");
        assert!(!capability.available);
        assert_eq!(capability.fallback, "node-pty-or-stream");
    }

    #[test]
    fn bounded_snapshot_is_unicode_safe() {
        let manager = PtySessionManager::new(2);
        manager
            .create_session(PtySessionRequest {
                session_id: "term_unicode".into(),
                run_id: "run_unicode".into(),
                activation_id: "act_unicode".into(),
                node_id: "node_unicode".into(),
                workspace_path: "/tmp/project".into(),
                command: "sh".into(),
                args: vec![],
                cols: 80,
                rows: 24,
            })
            .expect("session can be created");

        manager
            .append_output("term_unicode", "你好世界")
            .expect("unicode output can be bounded");

        let snapshot = manager
            .attach_session("term_unicode")
            .expect("unicode snapshot can be attached");

        assert_eq!(snapshot.snapshot, "世界");
        assert!(snapshot.truncated);
    }
}
