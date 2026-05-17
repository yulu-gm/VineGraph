use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_ATTACH_SNAPSHOT_CHARS: usize = 200_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PtySessionStatus {
    Running,
    Exited,
    Failed,
    #[allow(dead_code)]
    Cancelled,
    Killed,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
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
    pub terminal_session_id: String,
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
    pub terminal_session_id: String,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionOutput {
    pub session_id: String,
    pub terminal_session_id: String,
    pub run_id: String,
    pub activation_id: String,
    pub node_id: String,
    pub chunk: String,
}

#[derive(Clone, Debug)]
pub enum PtySessionEvent {
    SessionStarted(PtySessionSummary),
    Output(PtySessionOutput),
    Resized(PtySessionSummary),
    Status(PtySessionSummary),
    Ended(PtySessionSummary),
}

pub type PtySessionEventCallback = Arc<dyn Fn(PtySessionEvent) + Send + Sync + 'static>;

struct PtyRuntimeSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

struct PtySessionState {
    summary: PtySessionSummary,
    transcript: String,
    transcript_truncated: bool,
    runtime: Option<PtyRuntimeSession>,
}

pub struct PtySessionManager {
    sessions: Arc<Mutex<HashMap<String, PtySessionState>>>,
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
            sessions: Arc::new(Mutex::new(HashMap::new())),
            snapshot_max_chars,
        }
    }

    pub fn portable_pty_available(&self) -> bool {
        probe_native_pty_available()
    }

    pub fn capability(&self) -> PtySessionCapability {
        PtySessionCapability {
            backend: "portable-pty".into(),
            available: self.portable_pty_available(),
            fallback: "node-pty-or-stream".into(),
        }
    }

    #[cfg(test)]
    pub fn create_session(&self, request: PtySessionRequest) -> Result<PtySessionSummary, String> {
        self.create_session_with_events(request, None)
    }

    pub fn create_session_with_events(
        &self,
        request: PtySessionRequest,
        event_sink: Option<PtySessionEventCallback>,
    ) -> Result<PtySessionSummary, String> {
        let session_id = request.session_id.trim().to_string();
        if session_id.is_empty() {
            return Err("Missing terminal session id".into());
        }
        if request.command.trim().is_empty() {
            return Err("Missing terminal session command".into());
        }

        {
            let sessions = self.sessions.lock().map_err(lock_error)?;
            if sessions.contains_key(&session_id) {
                return Err(format!("Terminal session already exists: {}", session_id));
            }
        }

        let cols = request.cols.max(1);
        let rows = request.rows.max(1);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("Failed to open terminal pty: {}", err))?;

        let mut command = CommandBuilder::new(&request.command);
        command.args(request.args.iter());
        if !request.workspace_path.trim().is_empty() {
            command.cwd(&request.workspace_path);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| format!("Failed to spawn terminal command: {}", err))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| format!("Failed to clone terminal reader: {}", err))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|err| format!("Failed to open terminal writer: {}", err))?;
        let killer = child.clone_killer();

        let now = now_ms();
        let summary = PtySessionSummary {
            session_id: session_id.clone(),
            terminal_session_id: session_id.clone(),
            run_id: request.run_id,
            activation_id: request.activation_id,
            node_id: request.node_id,
            workspace_path: request.workspace_path,
            command: request.command,
            args: request.args,
            cols,
            rows,
            status: PtySessionStatus::Running,
            created_at_ms: now,
            updated_at_ms: now,
            exit_code: None,
        };

        {
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
                    runtime: Some(PtyRuntimeSession {
                        master: pair.master,
                        writer,
                        killer,
                    }),
                },
            );
        }

        emit_event(
            &event_sink,
            PtySessionEvent::SessionStarted(summary.clone()),
        );
        emit_event(&event_sink, PtySessionEvent::Status(summary.clone()));

        let reader_session_id = session_id.clone();
        let reader_sessions = Arc::clone(&self.sessions);
        let reader_sink = event_sink.clone();
        let snapshot_max_chars = self.snapshot_max_chars;
        std::thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(byte_count) => {
                        let chunk = String::from_utf8_lossy(&buffer[..byte_count]).into_owned();
                        if let Ok(Some(output)) = append_output_to_sessions(
                            &reader_sessions,
                            &reader_session_id,
                            &chunk,
                            snapshot_max_chars,
                        ) {
                            emit_event(&reader_sink, PtySessionEvent::Output(output));
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let wait_session_id = session_id;
        let wait_sessions = Arc::clone(&self.sessions);
        let wait_sink = event_sink;
        std::thread::spawn(move || {
            let (status, exit_code) = match child.wait() {
                Ok(exit_status) => {
                    let status = if exit_status.success() {
                        PtySessionStatus::Exited
                    } else {
                        PtySessionStatus::Failed
                    };
                    (status, Some(exit_status.exit_code() as i32))
                }
                Err(_) => (PtySessionStatus::Failed, None),
            };

            if let Ok(summary) =
                mark_session_finished(&wait_sessions, &wait_session_id, status, exit_code, false)
            {
                emit_event(&wait_sink, PtySessionEvent::Status(summary.clone()));
                emit_event(&wait_sink, PtySessionEvent::Ended(summary));
            }
        });

        Ok(summary)
    }

    #[cfg(test)]
    pub fn append_output(&self, session_id: &str, chunk: &str) -> Result<(), String> {
        append_output_to_sessions(&self.sessions, session_id, chunk, self.snapshot_max_chars)
            .map(|_| ())
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<PtySessionSummary, String> {
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        let state = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Terminal session not found: {}", session_id))?;
        let runtime = state
            .runtime
            .as_mut()
            .ok_or_else(|| format!("Terminal session is not running: {}", session_id))?;
        runtime
            .writer
            .write_all(data.as_bytes())
            .map_err(|err| format!("Failed to write terminal input: {}", err))?;
        runtime
            .writer
            .flush()
            .map_err(|err| format!("Failed to flush terminal input: {}", err))?;
        state.summary.updated_at_ms = now_ms();
        Ok(state.summary.clone())
    }

    pub fn resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<PtySessionSummary, String> {
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        let state = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Terminal session not found: {}", session_id))?;
        let runtime = state
            .runtime
            .as_ref()
            .ok_or_else(|| format!("Terminal session is not running: {}", session_id))?;
        let cols = cols.max(1);
        let rows = rows.max(1);
        runtime
            .master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("Failed to resize terminal pty: {}", err))?;
        state.summary.cols = cols;
        state.summary.rows = rows;
        state.summary.updated_at_ms = now_ms();
        Ok(state.summary.clone())
    }

    pub fn interrupt(&self, session_id: &str) -> Result<PtySessionSummary, String> {
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        let state = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Terminal session not found: {}", session_id))?;
        if let Some(runtime) = state.runtime.as_mut() {
            runtime
                .writer
                .write_all(b"\x03")
                .map_err(|err| format!("Failed to interrupt terminal session: {}", err))?;
            runtime
                .writer
                .flush()
                .map_err(|err| format!("Failed to flush terminal interrupt: {}", err))?;
            state.summary.updated_at_ms = now_ms();
        }
        Ok(state.summary.clone())
    }

    pub fn attach_session(&self, session_id: &str) -> Result<PtySessionAttachSnapshot, String> {
        let sessions = self.sessions.lock().map_err(lock_error)?;
        let state = sessions
            .get(session_id)
            .ok_or_else(|| format!("Terminal session not found: {}", session_id))?;
        let bounded = tail_by_chars(&state.transcript, self.snapshot_max_chars);
        Ok(PtySessionAttachSnapshot {
            session_id: state.summary.session_id.clone(),
            terminal_session_id: state.summary.terminal_session_id.clone(),
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
        let mut killer = {
            let sessions = self.sessions.lock().map_err(lock_error)?;
            let state = sessions
                .get(session_id)
                .ok_or_else(|| format!("Terminal session not found: {}", session_id))?;
            state
                .runtime
                .as_ref()
                .map(|runtime| runtime.killer.clone_killer())
        };

        if let Some(killer) = killer.as_mut() {
            let _ = killer.kill();
        }

        mark_session_finished(&self.sessions, session_id, status, exit_code, true)
    }

    pub fn shutdown_all(&self) -> Result<Vec<PtySessionSummary>, String> {
        let killers = {
            let sessions = self.sessions.lock().map_err(lock_error)?;
            sessions
                .iter()
                .filter(|(_, state)| state.summary.status == PtySessionStatus::Running)
                .filter_map(|(session_id, state)| {
                    state
                        .runtime
                        .as_ref()
                        .map(|runtime| (session_id.clone(), runtime.killer.clone_killer()))
                })
                .collect::<Vec<_>>()
        };

        for (_, mut killer) in killers {
            let _ = killer.kill();
        }

        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        let now = now_ms();
        Ok(sessions
            .values_mut()
            .map(|state| {
                if state.summary.status == PtySessionStatus::Running {
                    state.summary.status = PtySessionStatus::Killed;
                    state.summary.updated_at_ms = now;
                    state.runtime = None;
                }
                state.summary.clone()
            })
            .collect())
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

impl Drop for PtySessionManager {
    fn drop(&mut self) {
        let _ = self.shutdown_all();
    }
}

struct BoundedSnapshot {
    snapshot: String,
    truncated: bool,
}

fn append_output_to_sessions(
    sessions: &Arc<Mutex<HashMap<String, PtySessionState>>>,
    session_id: &str,
    chunk: &str,
    snapshot_max_chars: usize,
) -> Result<Option<PtySessionOutput>, String> {
    let mut sessions = sessions.lock().map_err(lock_error)?;
    let Some(state) = sessions.get_mut(session_id) else {
        return Ok(None);
    };
    if chunk.contains("\u{1b}[6n") {
        if let Some(runtime) = state.runtime.as_mut() {
            let _ = runtime.writer.write_all(b"\x1b[1;1R");
            let _ = runtime.writer.flush();
        }
    }
    state.transcript.push_str(chunk);
    let bounded = tail_by_chars(&state.transcript, snapshot_max_chars);
    if bounded.truncated {
        state.transcript = bounded.snapshot;
        state.transcript_truncated = true;
    }
    state.summary.updated_at_ms = now_ms();
    Ok(Some(PtySessionOutput {
        session_id: state.summary.session_id.clone(),
        terminal_session_id: state.summary.terminal_session_id.clone(),
        run_id: state.summary.run_id.clone(),
        activation_id: state.summary.activation_id.clone(),
        node_id: state.summary.node_id.clone(),
        chunk: chunk.into(),
    }))
}

fn mark_session_finished(
    sessions: &Arc<Mutex<HashMap<String, PtySessionState>>>,
    session_id: &str,
    status: PtySessionStatus,
    exit_code: Option<i32>,
    overwrite_terminal_status: bool,
) -> Result<PtySessionSummary, String> {
    let mut sessions = sessions.lock().map_err(lock_error)?;
    let state = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Terminal session not found: {}", session_id))?;

    if !overwrite_terminal_status && is_terminal_status(&state.summary.status) {
        if state.summary.exit_code.is_none() {
            state.summary.exit_code = exit_code;
            state.summary.updated_at_ms = now_ms();
        }
        return Ok(state.summary.clone());
    }

    state.summary.status = status;
    state.summary.exit_code = exit_code;
    state.summary.updated_at_ms = now_ms();
    if is_terminal_status(&state.summary.status) {
        state.runtime = None;
    }
    Ok(state.summary.clone())
}

fn is_terminal_status(status: &PtySessionStatus) -> bool {
    !matches!(status, PtySessionStatus::Running)
}

fn emit_event(event_sink: &Option<PtySessionEventCallback>, event: PtySessionEvent) {
    if let Some(event_sink) = event_sink {
        event_sink(event);
    }
}

fn probe_native_pty_available() -> bool {
    native_pty_system()
        .openpty(PtySize {
            cols: 1,
            rows: 1,
            pixel_width: 0,
            pixel_height: 0,
        })
        .is_ok()
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
                workspace_path: test_workspace_path(),
                command: test_shell_command(),
                args: vec![],
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
        assert!(manager.portable_pty_available());
        manager
            .create_session(PtySessionRequest {
                session_id: "term_b".into(),
                run_id: "run_b".into(),
                activation_id: "act_b".into(),
                node_id: "node_b".into(),
                workspace_path: test_workspace_path(),
                command: test_shell_command(),
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
        assert!(capability.available);
        assert_eq!(capability.fallback, "node-pty-or-stream");
    }

    #[test]
    fn portable_pty_session_runs_real_command_and_captures_output() {
        let manager = PtySessionManager::new(1024);
        assert!(manager.portable_pty_available());

        let request = PtySessionRequest {
            session_id: "term_real_command".into(),
            run_id: "run_real_command".into(),
            activation_id: "act_real_command".into(),
            node_id: "node_real_command".into(),
            workspace_path: test_workspace_path(),
            command: test_shell_command(),
            args: test_echo_args("VG_PORTABLE_PTY_READY"),
            cols: 80,
            rows: 24,
        };

        let summary = manager
            .create_session(request)
            .expect("real pty session can be created");
        assert_eq!(summary.status, PtySessionStatus::Running);

        let snapshot =
            wait_for_session_status(&manager, "term_real_command", PtySessionStatus::Exited);
        assert!(snapshot.snapshot.contains("VG_PORTABLE_PTY_READY"));
        assert_eq!(snapshot.exit_code, Some(0));
    }

    #[test]
    fn pty_controls_preserve_session_metadata() {
        let manager = PtySessionManager::new(1024);
        manager
            .create_session(PtySessionRequest {
                session_id: "term_controls".into(),
                run_id: "run_controls".into(),
                activation_id: "act_controls".into(),
                node_id: "node_controls".into(),
                workspace_path: test_workspace_path(),
                command: test_shell_command(),
                args: test_shell_args(test_interactive_command()),
                cols: 80,
                rows: 24,
            })
            .expect("real pty session can be created");

        manager
            .resize("term_controls", 100, 32)
            .expect("session can resize");
        manager
            .write("term_controls", "VG_WRITE_OK\r\n")
            .expect("session can write");

        let after_write = wait_for_snapshot_contains(&manager, "term_controls", "VG_WRITE_OK");
        assert_eq!(after_write.run_id, "run_controls");
        assert_eq!(after_write.activation_id, "act_controls");
        assert_eq!(after_write.node_id, "node_controls");
        assert_eq!(after_write.cols, 100);
        assert_eq!(after_write.rows, 32);

        manager
            .interrupt("term_controls")
            .expect("session can interrupt");
        let after_interrupt = manager
            .attach_session("term_controls")
            .expect("session remains attachable after interrupt");
        assert_eq!(after_interrupt.session_id, "term_controls");
        assert_eq!(after_interrupt.run_id, "run_controls");

        let closed = manager
            .close_session("term_controls", PtySessionStatus::Killed, Some(-1))
            .expect("session can close");
        assert_eq!(closed.session_id, "term_controls");
        assert_eq!(closed.run_id, "run_controls");
        assert_eq!(closed.status, PtySessionStatus::Killed);
    }

    #[test]
    fn shutdown_all_kills_running_sessions_and_keeps_metadata_attachable() {
        let manager = PtySessionManager::new(1024);
        manager
            .create_session(PtySessionRequest {
                session_id: "term_shutdown".into(),
                run_id: "run_shutdown".into(),
                activation_id: "act_shutdown".into(),
                node_id: "node_shutdown".into(),
                workspace_path: test_workspace_path(),
                command: test_shell_command(),
                args: test_shell_args(test_interactive_command()),
                cols: 80,
                rows: 24,
            })
            .expect("real pty session can be created");

        let closed = manager
            .shutdown_all()
            .expect("all sessions can be shut down");
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].session_id, "term_shutdown");
        assert_eq!(closed[0].run_id, "run_shutdown");
        assert_eq!(closed[0].activation_id, "act_shutdown");
        assert_eq!(closed[0].node_id, "node_shutdown");
        assert_eq!(closed[0].status, PtySessionStatus::Killed);

        let snapshot = manager
            .attach_session("term_shutdown")
            .expect("shutdown session remains attachable");
        assert_eq!(snapshot.status, PtySessionStatus::Killed);
        assert_eq!(snapshot.run_id, "run_shutdown");
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
                workspace_path: test_workspace_path(),
                command: test_shell_command(),
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

    fn wait_for_session_status(
        manager: &PtySessionManager,
        session_id: &str,
        expected: PtySessionStatus,
    ) -> PtySessionAttachSnapshot {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let snapshot = manager
                .attach_session(session_id)
                .expect("session remains attachable");
            if snapshot.status == expected {
                return snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "session {session_id} did not reach {expected:?}; last status: {:?}; snapshot: {:?}",
                snapshot.status,
                snapshot.snapshot
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    fn wait_for_snapshot_contains(
        manager: &PtySessionManager,
        session_id: &str,
        expected: &str,
    ) -> PtySessionAttachSnapshot {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let snapshot = manager
                .attach_session(session_id)
                .expect("session remains attachable");
            if snapshot.snapshot.contains(expected) {
                return snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "session {session_id} did not output {expected:?}; last snapshot: {:?}",
                snapshot.snapshot
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    fn test_shell_command() -> String {
        if cfg!(windows) {
            "cmd.exe".into()
        } else {
            "sh".into()
        }
    }

    fn test_shell_args(script: &str) -> Vec<String> {
        if cfg!(windows) {
            vec!["/C".into(), script.into()]
        } else {
            vec!["-lc".into(), script.into()]
        }
    }

    fn test_echo_args(value: &str) -> Vec<String> {
        if cfg!(windows) {
            vec!["/C".into(), format!("echo {value}")]
        } else {
            vec!["-lc".into(), format!("printf '%s' {value:?}")]
        }
    }

    fn test_interactive_command() -> &'static str {
        if cfg!(windows) {
            "set /p value= & echo %value%"
        } else {
            "read value; printf '%s\\n' \"$value\""
        }
    }

    fn test_workspace_path() -> String {
        std::env::current_dir()
            .expect("test cwd is available")
            .to_string_lossy()
            .into_owned()
    }
}
