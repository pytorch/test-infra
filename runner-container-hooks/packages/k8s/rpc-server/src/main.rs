// In-pod RPC server. Port of src/k8s/rpc-server.py to Rust so the
// in-pod helper has no runtime dependency on the container image
// (no python3, no node — just a static musl binary).

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::os::unix::io::FromRawFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tiny_http::{Header, Method, Request, Response, Server};

const LOG_DIR: &str = "/tmp/rpc-logs";
const MAX_CHUNK: usize = 1_048_576;

// Lifecycle timeouts. Defaults match production; each is overridable via an
// env var so integration tests can drive these paths without waiting minutes.
const HEARTBEAT_TIMEOUT_DEFAULT_SECS: u64 = 60;
const WATCHDOG_TICK_DEFAULT_SECS: u64 = 5;
const KILL_GRACE_DEFAULT_SECS: u64 = 5;

fn env_duration_secs(key: &str, default_secs: u64) -> Duration {
    let secs = env::var(key)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default_secs);
    Duration::from_secs(secs)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum JobStatus {
    Idle,
    Starting,
    Running,
    // Termination has been initiated (SIGTERM sent, possibly escalating to
    // SIGKILL) but the process hasn't been reaped yet. Distinct from Running so
    // a /status or /kill poll during teardown — including the pathological case
    // where the target is wedged in uninterruptible sleep and outlives the
    // SIGKILL grace window — reports "killing" rather than a misleading
    // "running" that looks like the kill never happened.
    Killing,
    Completed,
    Failed,
}

impl JobStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Killing => "killing",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

struct State {
    auth_token: String,
    job_id: Option<String>,
    status: JobStatus,
    exit_code: Option<i32>,
    // PID of the running child. Set by /exec, cleared by the waiter when the
    // child is reaped. We keep only the pid (not the Child) here so /kill can
    // signal the process without racing the waiter for ownership of `Child`.
    child_pid: Option<i32>,
    last_heartbeat: Option<Instant>,
}

impl State {
    fn new(auth_token: String) -> Self {
        Self {
            auth_token,
            job_id: None,
            status: JobStatus::Idle,
            exit_code: None,
            child_pid: None,
            last_heartbeat: None,
        }
    }
}

type SharedState = Arc<Mutex<State>>;

// Lock the state, recovering from poisoning instead of propagating the panic.
// Thread-per-request means a panic in one handler while it holds the lock would
// otherwise poison the Mutex and make every later `.lock_state()` panic too,
// turning the server into a process that fails every request forever. Our State
// is a few plain fields with no cross-field invariant that a mid-update panic
// could leave half-applied, so taking the (possibly stale) inner value and
// carrying on degrades far more gracefully than wedging the whole server.
trait LockRecover<T> {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockRecover<T> for Mutex<T> {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

// --- JSON: hand-rolled. Payloads are 2-3 string/int fields, no nesting. ---

fn json_escape(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn status_json(state: &State) -> String {
    let mut s = String::from("{\"id\":");
    match &state.job_id {
        Some(id) => json_escape(id, &mut s),
        None => s.push_str("null"),
    }
    s.push_str(",\"status\":");
    json_escape(state.status.as_str(), &mut s);
    s.push_str(",\"exit_code\":");
    match state.exit_code {
        Some(c) => s.push_str(&c.to_string()),
        None => s.push_str("null"),
    }
    s.push('}');
    s
}

// Minimal extractor for {"key1":"val1","key2":"val2"}. Handles whitespace
// and the escapes our generator might emit; rejects anything fancier with None.
fn parse_simple_obj(body: &str) -> Option<std::collections::HashMap<String, String>> {
    let body = body.trim();
    let body = body.strip_prefix('{')?.strip_suffix('}')?;
    let mut out = std::collections::HashMap::new();
    let mut chars = body.chars().peekable();
    loop {
        while let Some(c) = chars.peek() {
            if c.is_whitespace() || *c == ',' {
                chars.next();
            } else {
                break;
            }
        }
        if chars.peek().is_none() {
            return Some(out);
        }
        let key = parse_json_string(&mut chars)?;
        while let Some(c) = chars.peek() {
            if c.is_whitespace() {
                chars.next();
            } else {
                break;
            }
        }
        if chars.next()? != ':' {
            return None;
        }
        while let Some(c) = chars.peek() {
            if c.is_whitespace() {
                chars.next();
            } else {
                break;
            }
        }
        let value = parse_json_string(&mut chars)?;
        out.insert(key, value);
    }
}

fn parse_json_string(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Option<String> {
    if chars.next()? != '"' {
        return None;
    }
    let mut out = String::new();
    loop {
        let c = chars.next()?;
        match c {
            '"' => return Some(out),
            '\\' => {
                let esc = chars.next()?;
                match esc {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    '/' => out.push('/'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'u' => {
                        let mut code = 0u32;
                        for _ in 0..4 {
                            let hex = chars.next()?;
                            code = code * 16 + hex.to_digit(16)?;
                        }
                        out.push(char::from_u32(code)?);
                    }
                    _ => return None,
                }
            }
            c => out.push(c),
        }
    }
}

// --- HTTP helpers ---

fn json_response(body: String, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(status)
        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
}

fn empty(status: u16) -> Response<std::io::Empty> {
    Response::empty(status)
}

fn check_auth(req: &Request, expected: &str) -> bool {
    req.headers().iter().any(|h| {
        h.field
            .as_str()
            .as_str()
            .eq_ignore_ascii_case("X-Auth-Token")
            && h.value.as_str() == expected
    })
}

fn path_only(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

fn query_param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    let qs = url.split_once('?')?.1;
    for pair in qs.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(v);
            }
        }
    }
    None
}

// --- /proc/self/oom_score_adj helpers ---

fn write_oom_score_adj_self(value: &str) {
    if let Ok(mut f) = OpenOptions::new()
        .write(true)
        .open("/proc/self/oom_score_adj")
    {
        let _ = f.write_all(value.as_bytes());
    }
}

/// Async-signal-safe reset of the child's oom_score_adj. Runs in the child
/// between fork() and execve() — only async-signal-safe calls allowed here
/// (open/write/close, no allocation, no logging).
unsafe fn reset_child_oom_score() -> std::io::Result<()> {
    let path = b"/proc/self/oom_score_adj\0";
    let fd = libc::open(path.as_ptr() as *const _, libc::O_WRONLY);
    if fd < 0 {
        return Ok(()); // best effort; OK if /proc isn't there in tests
    }
    let buf = b"0";
    libc::write(fd, buf.as_ptr() as *const _, buf.len());
    libc::close(fd);
    Ok(())
}

// --- Subprocess lifecycle ---

fn spawn_job(job_id: &str, script_path: &str) -> std::io::Result<Child> {
    fs::create_dir_all(LOG_DIR)?;
    let stdout_file = File::create(format!("{LOG_DIR}/{job_id}.stdout"))?;
    let stderr_file = File::create(format!("{LOG_DIR}/{job_id}.stderr"))?;

    let mut cmd = Command::new("sh");
    cmd.args(["-e", script_path])
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    unsafe {
        cmd.pre_exec(|| {
            // New session so killpg() can take down the whole group.
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Don't inherit our OOM immunity — user job must remain an OOM candidate.
            reset_child_oom_score()?;
            Ok(())
        });
    }
    cmd.spawn()
}

// Waiter owns the Child. It is the only place that calls Child::wait(), so
// only one thread ever reaps. /kill signals via raw libc and waits for the
// waiter to update the state.
fn wait_for_process(state: SharedState, job_id: String, mut child: Child) {
    use std::os::unix::process::ExitStatusExt;
    // Preserve the cause of death: a normal exit yields its code; a process
    // killed by a signal (SIGTERM/SIGKILL from /kill or the watchdog) has no
    // exit code, so report the negated signal number (e.g. -9, -15) instead of
    // a blanket -1.
    let code = child
        .wait()
        .map(|st| st.code().or_else(|| st.signal().map(|s| -s)).unwrap_or(-1))
        .unwrap_or(-1);
    let mut s = state.lock_state();
    if s.job_id.as_deref() == Some(&job_id) {
        s.exit_code = Some(code);
        s.status = if code == 0 {
            JobStatus::Completed
        } else {
            JobStatus::Failed
        };
        s.child_pid = None;
        // Disarm the watchdog: the job is done, and the client stops sending
        // heartbeats once it observes a terminal status. Without this the
        // watchdog would, one timeout later, log a misleading "heartbeat
        // timeout, killing job" for a job that already finished cleanly.
        s.last_heartbeat = None;
    }
}

// Has the job slot moved on from `expected` — either reaped (exit_code set) or
// replaced by a different /exec? Once true, there's nothing left for a killer
// targeting `expected` to do.
fn job_slot_settled(state: &SharedState, expected: &str) -> bool {
    let s = state.lock_state();
    s.job_id.as_deref() != Some(expected) || s.exit_code.is_some()
}

// Kill the running job, but ONLY while it is still `expected`. SIGTERM the
// process group, then escalate to SIGKILL after a grace period if it hasn't
// died. If the slot has been reaped or replaced by a different job by the time
// we look (or at any point during the grace window), this is a no-op — so a
// timed-out job A can never have its SIGTERM land on an unrelated job B that
// started in the meantime. The waiter thread owns reaping; we only signal and
// observe the state transition.
fn kill_running_if_match(state: &SharedState, expected: &str) {
    let pid = {
        let mut s = state.lock_state();
        let matches_target = matches!(
            (s.child_pid, s.job_id.as_deref()),
            (Some(_), Some(jid)) if jid == expected
        ) && s.exit_code.is_none();
        if !matches_target {
            return;
        }
        // Mark teardown in progress so concurrent /status and /kill polls see
        // "killing" instead of "running" while we signal and wait for the reap.
        s.status = JobStatus::Killing;
        s.child_pid.unwrap()
    };

    let grace = env_duration_secs("RPC_KILL_GRACE_SECS", KILL_GRACE_DEFAULT_SECS);

    unsafe {
        let pgid = libc::getpgid(pid);
        if pgid < 0 {
            return;
        }
        libc::killpg(pgid, libc::SIGTERM);

        let deadline = Instant::now() + grace;
        loop {
            if job_slot_settled(state, expected) {
                return;
            }
            if Instant::now() >= deadline {
                libc::killpg(pgid, libc::SIGKILL);
                // After SIGKILL the waiter normally reaps within milliseconds;
                // wait briefly so /kill's status snapshot reflects the death. If
                // the target is stuck in uninterruptible sleep and outlives even
                // this, we return with status still "killing" (set above) — an
                // accurate "teardown in progress", not a misleading "running".
                let kill_deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < kill_deadline {
                    if job_slot_settled(state, expected) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

// Kill whatever job is currently running (the /kill endpoint's semantics).
// Snapshots the current job under the lock and delegates to the match-guarded
// killer, so if a concurrent /exec swaps the job out mid-kill we stop rather
// than escalate SIGKILL against a stale process group.
fn kill_running(state: &SharedState) {
    let expected = {
        let s = state.lock_state();
        match (&s.job_id, s.exit_code) {
            (Some(jid), None) => jid.clone(),
            _ => return,
        }
    };
    kill_running_if_match(state, &expected);
}

// --- Route handlers ---

fn handle_health(req: Request) {
    let _ = req.respond(json_response(r#"{"status":"ok"}"#.into(), 200));
}

fn handle_status(req: Request, state: &SharedState) {
    let s = state.lock_state();
    let body = status_json(&s);
    drop(s);
    let _ = req.respond(json_response(body, 200));
}

fn handle_heartbeat(req: Request, state: &SharedState) {
    state.lock_state().last_heartbeat = Some(Instant::now());
    let _ = req.respond(json_response(r#"{"status":"ok"}"#.into(), 200));
}

fn handle_exec(mut req: Request, state: &SharedState) {
    let mut body = String::new();
    if req.as_reader().read_to_string(&mut body).is_err() {
        let _ = req.respond(json_response(r#"{"error":"read failed"}"#.into(), 400));
        return;
    }
    let Some(obj) = parse_simple_obj(&body) else {
        let _ = req.respond(json_response(r#"{"error":"invalid body"}"#.into(), 400));
        return;
    };
    let (Some(job_id), Some(path)) = (obj.get("id"), obj.get("path")) else {
        let _ = req.respond(json_response(
            r#"{"error":"missing id or path"}"#.into(),
            400,
        ));
        return;
    };

    // Step 1: under lock, reserve the slot with a "starting" sentinel.
    let prev_status = {
        let mut s = state.lock_state();
        if matches!(
            s.status,
            JobStatus::Running | JobStatus::Starting | JobStatus::Killing
        ) {
            let _ = req.respond(json_response(
                r#"{"error":"A job is already running"}"#.into(),
                409,
            ));
            return;
        }
        let prev = s.status;
        s.status = JobStatus::Starting;
        prev
    };

    // Step 2: outside lock, do the I/O (open log files, fork+exec).
    let child = match spawn_job(job_id, path) {
        Ok(c) => c,
        Err(e) => {
            state.lock_state().status = prev_status;
            let mut body = String::from(r#"{"error":"#);
            json_escape(&e.to_string(), &mut body);
            body.push('}');
            let _ = req.respond(json_response(body, 500));
            return;
        }
    };

    let pid = child.id() as i32;

    // Step 3: commit running state under lock.
    {
        let mut s = state.lock_state();
        s.job_id = Some(job_id.clone());
        s.status = JobStatus::Running;
        s.exit_code = None;
        s.child_pid = Some(pid);
        s.last_heartbeat = Some(Instant::now());
    }

    let waiter_state = Arc::clone(state);
    let waiter_id = job_id.clone();
    thread::spawn(move || wait_for_process(waiter_state, waiter_id, child));

    let mut body = String::from(r#"{"id":"#);
    json_escape(job_id, &mut body);
    body.push_str(r#","status":"running"}"#);
    let _ = req.respond(json_response(body, 200));
}

fn handle_kill(req: Request, state: &SharedState) {
    kill_running(state);
    let body = status_json(&state.lock_state());
    let _ = req.respond(json_response(body, 200));
}

fn handle_logs(req: Request, state: &SharedState) {
    let url = req.url().to_string();
    let offset: u64 = query_param(&url, "offset")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let stream = match query_param(&url, "stream") {
        Some("stderr") => "stderr",
        _ => "stdout",
    };

    let job_id = state.lock_state().job_id.clone();
    let Some(job_id) = job_id else {
        respond_bytes(req, Vec::new(), false);
        return;
    };

    let path: PathBuf = format!("{LOG_DIR}/{job_id}.{stream}").into();
    let Ok(mut f) = File::open(&path) else {
        respond_bytes(req, Vec::new(), false);
        return;
    };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    if offset >= size {
        respond_bytes(req, Vec::new(), false);
        return;
    }
    if f.seek(SeekFrom::Start(offset)).is_err() {
        respond_bytes(req, Vec::new(), false);
        return;
    }
    let mut buf = vec![0u8; MAX_CHUNK];
    let n = f.read(&mut buf).unwrap_or(0);
    buf.truncate(n);
    let remaining = size.saturating_sub(offset + n as u64);
    respond_bytes(req, buf, remaining > 0);
}

fn respond_bytes(req: Request, data: Vec<u8>, more: bool) {
    let resp = Response::from_data(data).with_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/octet-stream"[..]).unwrap(),
    );
    let resp = if more {
        resp.with_header(Header::from_bytes(&b"X-More-Data"[..], &b"true"[..]).unwrap())
    } else {
        resp.with_header(Header::from_bytes(&b"X-More-Data"[..], &b"false"[..]).unwrap())
    };
    let _ = req.respond(resp);
}

// --- Dispatcher ---

fn dispatch(req: Request, state: SharedState) {
    let path = path_only(req.url()).to_string();
    let method = req.method().clone();

    if method == Method::Get && path == "/health" {
        return handle_health(req);
    }

    let token = { state.lock_state().auth_token.clone() };
    // /exec, /kill, /heartbeat all require auth; /status and /logs too.
    if !check_auth(&req, &token) {
        let _ = req.respond(empty(403));
        return;
    }

    match (method, path.as_str()) {
        (Method::Get, "/status") => handle_status(req, &state),
        (Method::Get, "/logs") => handle_logs(req, &state),
        (Method::Post, "/exec") => handle_exec(req, &state),
        (Method::Post, "/kill") => handle_kill(req, &state),
        (Method::Post, "/heartbeat") => handle_heartbeat(req, &state),
        _ => {
            let _ = req.respond(empty(404));
        }
    }
}

// --- Watchdog + signals + main ---

fn start_heartbeat_watchdog(state: SharedState) {
    let timeout = env_duration_secs("RPC_HEARTBEAT_TIMEOUT_SECS", HEARTBEAT_TIMEOUT_DEFAULT_SECS);
    let tick = env_duration_secs("RPC_WATCHDOG_TICK_SECS", WATCHDOG_TICK_DEFAULT_SECS);
    thread::spawn(move || loop {
        thread::sleep(tick);
        // Atomically, under a single lock: (a) decide whether the heartbeat has
        // timed out, (b) clear it, and (c) snapshot which job we intend to kill.
        // Doing all three together means a /exec that lands after this point
        // can't have its fresh heartbeat clobbered, and can't be killed in
        // place of the job that actually timed out.
        let target_job_id = {
            let mut s = state.lock_state();
            let timed_out = matches!(s.last_heartbeat, Some(t) if t.elapsed() > timeout);
            if !timed_out {
                continue;
            }
            s.last_heartbeat = None;
            s.job_id.clone()
        };
        let Some(job_id) = target_job_id else {
            continue;
        };
        eprintln!(
            "Heartbeat timeout: no heartbeat for {}s, killing job {job_id}",
            timeout.as_secs()
        );
        kill_running_if_match(&state, &job_id);
    });
}

// Write end of the self-pipe the signal handler nudges; -1 until main wires it
// up. A RawFd is just an i32, so an atomic load/store of it is lock-free and
// async-signal-safe.
static SIGNAL_PIPE_WRITE: AtomicI32 = AtomicI32::new(-1);
// Set on the first termination signal so a second one force-exits instead of
// waiting for graceful child teardown.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

// Self-pipe handler. It does ONLY async-signal-safe work — lock-free atomics
// plus write()/_exit(), all on the POSIX async-signal-safe list — and hands the
// real teardown to start_signal_thread(), which runs in normal context where it
// can take the state mutex and signal the child. Doing that work here instead
// would mean locking a mutex from signal context, which can deadlock if the
// signal interrupts a thread already holding it.
extern "C" fn signal_handler(signum: libc::c_int) {
    if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
        // Second signal: the operator/orchestrator is impatient — exit now
        // rather than waiting out the graceful child-kill grace period. Use the
        // conventional 128+signum status so the cause is still visible.
        unsafe { libc::_exit(128 + signum) };
    }
    let fd = SIGNAL_PIPE_WRITE.load(Ordering::Relaxed);
    if fd < 0 {
        // No self-pipe (setup failed) — can't do graceful teardown, but still
        // honor the signal AND exit with the proper signal-terminated status by
        // restoring the default disposition and re-raising it.
        unsafe {
            libc::signal(signum, libc::SIG_DFL);
            libc::raise(signum);
            libc::_exit(128 + signum);
        }
    }
    // Hand the signal number to the worker thread so it can re-raise it after
    // cleanup and exit with the matching WIFSIGNALED status.
    let byte = signum as u8;
    unsafe {
        libc::write(fd, &byte as *const u8 as *const libc::c_void, 1);
    }
}

// Spawn the thread that turns a termination signal into a graceful shutdown.
// The user's job runs in its own session (pre_exec setsid), so it does NOT
// receive the SIGTERM/SIGINT delivered to this server — without forwarding it
// would be orphaned and keep running when the server is stopped locally or in
// tests. On signal we SIGTERM the job's process group, escalate to SIGKILL
// after the grace period (kill_running), then exit.
fn start_signal_thread(state: SharedState) {
    let mut fds = [0 as libc::c_int; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        // Leave SIGNAL_PIPE_WRITE == -1; the handler will _exit(0) on signal,
        // matching the previous best-effort behavior.
        return;
    }
    let read_fd = fds[0];
    SIGNAL_PIPE_WRITE.store(fds[1], Ordering::Relaxed);

    thread::spawn(move || {
        // Block until the handler nudges us (retrying on EINTR).
        let mut buf = [0u8; 1];
        loop {
            let n = unsafe { libc::read(read_fd, buf.as_mut_ptr() as *mut libc::c_void, 1) };
            if n >= 0 {
                break; // got the signum byte, or EOF (0)
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                break;
            }
        }
        let signum = buf[0] as libc::c_int;
        eprintln!("Received termination signal; stopping any running job and exiting");
        kill_running(&state);
        // Re-raise the original signal under the default disposition so we
        // terminate *from* that signal: the parent's waitpid then reports
        // WIFSIGNALED(signum) instead of a misleading exit(0). The _exit is a
        // fallback in case the signal is somehow blocked and raise() returns.
        unsafe {
            libc::signal(signum, libc::SIG_DFL);
            libc::raise(signum);
            libc::_exit(128 + signum);
        }
    });
}

fn install_signal_handlers() {
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = signal_handler as *const () as usize;
        libc::sigemptyset(&mut sa.sa_mask);
        libc::sigaction(libc::SIGTERM, &sa, std::ptr::null_mut());
        libc::sigaction(libc::SIGINT, &sa, std::ptr::null_mut());
    }
}

fn parse_args() -> (u16, String, bool) {
    let mut port: u16 = 8080;
    let mut token: Option<String> = None;
    let mut daemonize = false;
    let mut args = env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => {
                port = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .expect("--port requires a number");
            }
            "--token" => token = args.next(),
            // Print the listening port to stdout, then fork into the
            // background and detach stdio so the launching `kubectl exec`
            // returns. Off by default so tests can drive a foreground server.
            "--daemonize" => daemonize = true,
            other => panic!("unknown arg: {other}"),
        }
    }
    (port, token.expect("--token is required"), daemonize)
}

/// Point stdin at /dev/null and stdout/stderr at the daemon log file, closing
/// the daemon's inherited copies of the launching exec's stdio. Once these are
/// redirected (and the parent has exited), the exec has no writers left on its
/// pipes and returns.
unsafe fn detach_stdio() {
    let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY);
    if devnull >= 0 {
        libc::dup2(devnull, libc::STDIN_FILENO);
        if devnull > 2 {
            libc::close(devnull);
        }
    }
    let log = libc::open(
        c"/tmp/rpc-server.log".as_ptr(),
        libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND,
        0o644 as libc::c_int,
    );
    if log >= 0 {
        libc::dup2(log, libc::STDOUT_FILENO);
        libc::dup2(log, libc::STDERR_FILENO);
        if log > 2 {
            libc::close(log);
        }
    }
}

fn bind_dual_stack(port: u16) -> std::io::Result<TcpListener> {
    use libc::{c_int, c_void, socklen_t};
    unsafe {
        let fd = libc::socket(libc::AF_INET6, libc::SOCK_STREAM, 0);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SO_REUSEADDR for fast restarts in retry loops.
        let yes: c_int = 1;
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_REUSEADDR,
            &yes as *const _ as *const c_void,
            std::mem::size_of_val(&yes) as socklen_t,
        );
        // Dual-stack: accept both v4 and v6 connections.
        let off: c_int = 0;
        libc::setsockopt(
            fd,
            libc::IPPROTO_IPV6,
            libc::IPV6_V6ONLY,
            &off as *const _ as *const c_void,
            std::mem::size_of_val(&off) as socklen_t,
        );

        let mut addr: libc::sockaddr_in6 = std::mem::zeroed();
        // sin6_family is u16 on Linux, u8 on macOS (BSDs have sin6_len first).
        addr.sin6_family = libc::AF_INET6 as _;
        addr.sin6_port = port.to_be();
        if libc::bind(
            fd,
            &addr as *const _ as *const libc::sockaddr,
            std::mem::size_of_val(&addr) as socklen_t,
        ) < 0
        {
            let e = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(e);
        }
        if libc::listen(fd, 128) < 0 {
            let e = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(e);
        }
        Ok(TcpListener::from_raw_fd(fd))
    }
}

fn main() {
    let (port, token, daemonize) = parse_args();

    // Bind first so the OS-assigned port (when --port 0) is known, and report
    // it on stdout. The launcher reads this single line to learn the port —
    // no port file, no polling.
    let listener = bind_dual_stack(port).expect("bind");
    let actual_port = listener.local_addr().expect("local_addr").port();
    println!("RPC server listening on [::]:{actual_port}");
    let _ = std::io::stdout().flush();

    if daemonize {
        // Detach from the launching `kubectl exec` so it returns once it has
        // read the port line above. The fork() MUST happen here, before any
        // thread is spawned below: forking a multithreaded process clones only
        // the calling thread and can leave another thread's mutex locked in
        // the child.
        unsafe {
            match libc::fork() {
                -1 => panic!("fork failed: {}", std::io::Error::last_os_error()),
                0 => {
                    // Child: lead a new session and move stdio off the exec's
                    // pipes so the exec sees EOF and completes.
                    libc::setsid();
                    detach_stdio();
                }
                _ => libc::_exit(0), // Parent: let the exec complete.
            }
        }
    }

    write_oom_score_adj_self("-1000");
    let _ = fs::create_dir_all(LOG_DIR);

    let state = Arc::new(Mutex::new(State::new(token)));
    // Wire up the self-pipe before installing handlers so the very first signal
    // has a thread to hand off to (rather than racing an unset pipe fd).
    start_signal_thread(Arc::clone(&state));
    install_signal_handlers();
    start_heartbeat_watchdog(Arc::clone(&state));

    let server = Server::from_listener(listener, None).expect("server");
    let server = Arc::new(server);

    // Thread-per-request — matches the Python ThreadingHTTPServer model.
    for req in server.incoming_requests() {
        let s = Arc::clone(&state);
        thread::spawn(move || dispatch(req, s));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_state_recovers_from_poison() {
        let m = Arc::new(Mutex::new(5));
        let m2 = Arc::clone(&m);
        // Panic while holding the lock -> the Mutex is now poisoned.
        let _ = thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        // A plain lock().unwrap() would now panic forever...
        assert!(m.lock().is_err(), "mutex should be poisoned");
        // ...but lock_state() recovers and yields the inner value, so the
        // server keeps serving instead of failing every subsequent request.
        assert_eq!(*m.lock_state(), 5);
    }
}
