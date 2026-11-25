// Integration tests for the rpc-server binary. Spawns a real instance on an
// OS-assigned port and drives the HTTP endpoints. Run via `cargo test --release`
// from packages/k8s/rpc-server/.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const TOKEN: &str = "test-token";

// Unique suffix per spawned server within this test process, so concurrent or
// sequential tests don't collide on the shared /tmp/rpc-logs job files or the
// per-process tmpdir.
static SEQ: AtomicU32 = AtomicU32::new(0);

struct Server {
    child: Child,
    port: u16,
    tmpdir: PathBuf,
}

impl Server {
    fn start() -> Self {
        Self::start_with_env(&[])
    }

    fn start_with_env(extra_env: &[(&str, &str)]) -> Self {
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let tmpdir = std::env::temp_dir().join(format!("rpc-test-{}-{seq}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmpdir);

        let bin = env!("CARGO_BIN_EXE_rpc-server");
        let mut child = Command::new(bin)
            .args(["--port", "0", "--token", TOKEN])
            .envs(extra_env.iter().copied())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn rpc-server");

        let stdout = child.stdout.take().expect("stdout");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        let port = loop {
            line.clear();
            match reader.read_line(&mut line) {
                Err(e) => panic!("error reading rpc-server stdout: {e}"),
                // EOF: child closed stdout (almost certainly exited) before
                // announcing its port. Fail now instead of spinning to the
                // deadline and reporting a misleading timeout.
                Ok(0) => panic!("rpc-server exited before printing port"),
                Ok(_) => {}
            }
            if let Some(rest) = line.strip_prefix("RPC server listening on [::]:") {
                break rest.trim().parse().expect("parse port");
            }
            if Instant::now() > deadline {
                panic!("rpc-server did not announce port in time");
            }
        };

        Self {
            child,
            port,
            tmpdir,
        }
    }

    fn raw(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> (u16, String) {
        let (code, _, body) = self.raw_full(method, path, token, body);
        (code, body)
    }

    // Like `raw`, but also returns the response headers (lowercased keys) so
    // tests can assert on things like X-More-Data.
    fn raw_full(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> (u16, HashMap<String, String>, String) {
        http_roundtrip(self.port, method, path, token, body)
    }

    fn write_script(&self, name: &str, body: &str) -> String {
        let p = self.tmpdir.join(name);
        std::fs::write(&p, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().into_owned()
    }

    // Poll /status until it reports a terminal state (completed/failed) or the
    // timeout elapses; returns the final status body. Panics on timeout.
    fn wait_terminal(&self, timeout: Duration) -> String {
        let deadline = Instant::now() + timeout;
        loop {
            let (_, st) = self.raw("GET", "/status", Some(TOKEN), None);
            if st.contains(r#""status":"completed""#) || st.contains(r#""status":"failed""#) {
                return st;
            }
            if Instant::now() > deadline {
                panic!("job never reached terminal state: {st}");
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

// Issue one HTTP/1.1 request to 127.0.0.1:port and return (status, headers, body).
// Free function (not a method) so tests can drive a server from a separate
// thread without sharing the Server handle.
fn http_roundtrip(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> (u16, HashMap<String, String>, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    use std::io::Write;
    let body = body.unwrap_or("");
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n");
    if let Some(t) = token {
        req.push_str(&format!("X-Auth-Token: {t}\r\n"));
    }
    if !body.is_empty() {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    req.push_str("Connection: close\r\n\r\n");
    req.push_str(body);
    stream.write_all(req.as_bytes()).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    // Read raw bytes: log responses are octet-streams that may not be UTF-8
    // and can be large (MAX_CHUNK), so don't assume String.
    let mut resp = Vec::new();
    use std::io::Read;
    let _ = stream.read_to_end(&mut resp);
    let split = resp
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .unwrap_or(resp.len());
    let head = String::from_utf8_lossy(&resp[..split]).to_string();
    let body_bytes = resp.get(split..).unwrap_or(&[]).to_vec();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut headers = HashMap::new();
    for line in head.lines().skip(1) {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    // tiny_http streams large bodies with Transfer-Encoding: chunked; undo
    // the chunk framing so callers see the real payload bytes.
    let body_bytes = if headers.get("transfer-encoding").map(String::as_str) == Some("chunked") {
        dechunk(&body_bytes)
    } else {
        body_bytes
    };
    let body = String::from_utf8_lossy(&body_bytes).to_string();
    (status, headers, body)
}

// Decode an HTTP/1.1 chunked transfer-encoding body into its raw bytes.
// Each chunk is "<hex-size>[;ext]\r\n<data>\r\n", terminated by a 0-size chunk.
fn dechunk(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // Find end of the chunk-size line.
        let Some(eol) = bytes[i..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .map(|p| i + p)
        else {
            break;
        };
        let size_line = String::from_utf8_lossy(&bytes[i..eol]);
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16).unwrap_or(0);
        i = eol + 2; // skip past "\r\n"
        if size == 0 {
            break;
        }
        let end = (i + size).min(bytes.len());
        out.extend_from_slice(&bytes[i..end]);
        i = end + 2; // skip chunk data's trailing "\r\n"
    }
    out
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.tmpdir);
    }
}

#[test]
fn health_no_auth() {
    let s = Server::start();
    let (code, body) = s.raw("GET", "/health", None, None);
    assert_eq!(code, 200);
    assert!(body.contains(r#""status":"ok""#));
}

#[test]
fn status_requires_auth() {
    let s = Server::start();
    let (code, _) = s.raw("GET", "/status", None, None);
    assert_eq!(code, 403);
}

#[test]
fn status_idle_initially() {
    let s = Server::start();
    let (code, body) = s.raw("GET", "/status", Some(TOKEN), None);
    assert_eq!(code, 200);
    assert!(body.contains(r#""status":"idle""#));
    assert!(body.contains(r#""id":null"#));
    assert!(body.contains(r#""exit_code":null"#));
}

#[test]
fn exec_runs_to_completion() {
    let s = Server::start();
    let script = s.write_script("ok.sh", "#!/bin/sh\necho hi\nexit 0\n");
    let body = format!(r#"{{"id":"job1","path":"{script}"}}"#);
    let (code, body) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(code, 200);
    assert!(body.contains(r#""status":"running""#));

    // Wait for completion.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let (_, st) = s.raw("GET", "/status", Some(TOKEN), None);
        if st.contains(r#""status":"completed""#) {
            assert!(st.contains(r#""exit_code":0"#));
            return;
        }
        if Instant::now() > deadline {
            panic!("never completed: {st}");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn second_exec_409_while_running() {
    let s = Server::start();
    let long = s.write_script("long.sh", "#!/bin/sh\nsleep 30\n");
    let b1 = format!(r#"{{"id":"a","path":"{long}"}}"#);
    let (c1, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&b1));
    assert_eq!(c1, 200);
    let b2 = format!(r#"{{"id":"b","path":"{long}"}}"#);
    let (c2, body2) = s.raw("POST", "/exec", Some(TOKEN), Some(&b2));
    assert_eq!(c2, 409);
    assert!(body2.contains("already running"));
}

#[test]
fn kill_terminates_running_job() {
    let s = Server::start();
    let long = s.write_script("kill.sh", "#!/bin/sh\nsleep 30\n");
    let body = format!(r#"{{"id":"k","path":"{long}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);

    // Wait for state to reflect running before killing.
    thread::sleep(Duration::from_millis(100));

    let (kc, kb) = s.raw("POST", "/kill", Some(TOKEN), None);
    assert_eq!(kc, 200);
    assert!(
        kb.contains(r#""status":"failed""#),
        "kill response should reflect failed status, got: {kb}"
    );

    // A new exec should be accepted now.
    let ok = s.write_script("ok.sh", "#!/bin/sh\nexit 0\n");
    let body = format!(r#"{{"id":"after","path":"{ok}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);
}

#[test]
fn logs_serve_stdout_and_stderr() {
    let s = Server::start();
    let script = s.write_script(
        "logs.sh",
        "#!/bin/sh\necho out1\necho err1 >&2\necho out2\n",
    );
    let body = format!(r#"{{"id":"logjob","path":"{script}"}}"#);
    s.raw("POST", "/exec", Some(TOKEN), Some(&body));

    // Wait for completion.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let (_, st) = s.raw("GET", "/status", Some(TOKEN), None);
        if st.contains("completed") || st.contains("failed") {
            break;
        }
        if Instant::now() > deadline {
            panic!("never finished");
        }
        thread::sleep(Duration::from_millis(50));
    }

    let (_, out) = s.raw("GET", "/logs?stream=stdout", Some(TOKEN), None);
    assert!(
        out.contains("out1") && out.contains("out2"),
        "stdout: {out}"
    );
    let (_, err) = s.raw("GET", "/logs?stream=stderr", Some(TOKEN), None);
    assert!(err.contains("err1"), "stderr: {err}");
}

#[test]
fn heartbeat_accepted() {
    let s = Server::start();
    let (c, body) = s.raw("POST", "/heartbeat", Some(TOKEN), None);
    assert_eq!(c, 200);
    assert!(body.contains(r#""status":"ok""#));
}

// --- Auth negative paths ---

#[test]
fn wrong_token_rejected() {
    let s = Server::start();
    let (code, _) = s.raw("GET", "/status", Some("not-the-token"), None);
    assert_eq!(code, 403);
    // A protected mutating endpoint rejects too.
    let (code, _) = s.raw("POST", "/kill", Some("not-the-token"), None);
    assert_eq!(code, 403);
}

#[test]
fn exec_missing_auth_rejected() {
    let s = Server::start();
    let script = s.write_script("noauth.sh", "#!/bin/sh\nexit 0\n");
    let body = format!(r#"{{"id":"noauth","path":"{script}"}}"#);
    let (code, _) = s.raw("POST", "/exec", None, Some(&body));
    assert_eq!(code, 403);
}

// --- /exec malformed input ---

#[test]
fn exec_invalid_body_400() {
    let s = Server::start();
    let (code, body) = s.raw("POST", "/exec", Some(TOKEN), Some("not json at all"));
    assert_eq!(code, 400);
    assert!(body.contains("invalid body"), "got: {body}");
    // Server stays usable: still idle.
    let (_, st) = s.raw("GET", "/status", Some(TOKEN), None);
    assert!(st.contains(r#""status":"idle""#));
}

#[test]
fn exec_missing_fields_400() {
    let s = Server::start();
    let (code, body) = s.raw("POST", "/exec", Some(TOKEN), Some(r#"{"id":"x"}"#));
    assert_eq!(code, 400);
    assert!(body.contains("missing id or path"), "got: {body}");
}

#[test]
fn exec_nonexistent_script_fails_cleanly() {
    // `sh -e /no/such/file` spawns fine but exits non-zero; the job should land
    // in "failed", not wedge the server, and a subsequent exec must be accepted.
    let s = Server::start();
    let body = r#"{"id":"missing","path":"/no/such/script-xyz.sh"}"#;
    let (code, _) = s.raw("POST", "/exec", Some(TOKEN), Some(body));
    assert_eq!(code, 200);
    let st = s.wait_terminal(Duration::from_secs(5));
    assert!(st.contains(r#""status":"failed""#), "got: {st}");

    let ok = s.write_script("recover.sh", "#!/bin/sh\nexit 0\n");
    let body = format!(r#"{{"id":"recover","path":"{ok}"}}"#);
    let (code, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(code, 200);
}

// --- /kill idempotency across lifecycle states ---

#[test]
fn kill_idle_is_noop() {
    let s = Server::start();
    let (code, body) = s.raw("POST", "/kill", Some(TOKEN), None);
    assert_eq!(code, 200);
    assert!(body.contains(r#""status":"idle""#), "got: {body}");
}

#[test]
fn kill_after_completion_preserves_exit_code() {
    let s = Server::start();
    let script = s.write_script("exit7.sh", "#!/bin/sh\nexit 7\n");
    let body = format!(r#"{{"id":"done","path":"{script}"}}"#);
    s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    let st = s.wait_terminal(Duration::from_secs(5));
    assert!(st.contains(r#""status":"failed""#), "got: {st}");
    assert!(st.contains(r#""exit_code":7"#), "got: {st}");

    // Killing a finished job is a no-op and must not clobber the exit code.
    let (code, kb) = s.raw("POST", "/kill", Some(TOKEN), None);
    assert_eq!(code, 200);
    assert!(kb.contains(r#""status":"failed""#), "got: {kb}");
    assert!(kb.contains(r#""exit_code":7"#), "got: {kb}");
}

#[test]
fn kill_is_idempotent_when_running() {
    let s = Server::start();
    let long = s.write_script("long.sh", "#!/bin/sh\nsleep 30\n");
    let body = format!(r#"{{"id":"twice","path":"{long}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);
    thread::sleep(Duration::from_millis(100));

    let (c1, b1) = s.raw("POST", "/kill", Some(TOKEN), None);
    assert_eq!(c1, 200);
    assert!(b1.contains(r#""status":"failed""#), "got: {b1}");
    // A SIGTERM'd `sleep` reports signal 15 -> exit_code -15 (not -1).
    assert!(b1.contains(r#""exit_code":-15"#), "got: {b1}");

    // Second kill on the already-dead job is a harmless no-op.
    let (c2, b2) = s.raw("POST", "/kill", Some(TOKEN), None);
    assert_eq!(c2, 200);
    assert!(b2.contains(r#""status":"failed""#), "got: {b2}");
}

// --- SIGTERM -> SIGKILL escalation ---

#[test]
fn kill_escalates_to_sigkill_when_sigterm_ignored() {
    // 1s grace so the test is quick. The job ignores SIGTERM, so /kill must wait
    // out the grace window and then SIGKILL it.
    let s = Server::start_with_env(&[("RPC_KILL_GRACE_SECS", "1")]);
    let script = s.write_script(
        "ignore-term.sh",
        "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 0.2; done\n",
    );
    let body = format!(r#"{{"id":"stubborn","path":"{script}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);
    thread::sleep(Duration::from_millis(200));

    let start = Instant::now();
    let (kc, kb) = s.raw("POST", "/kill", Some(TOKEN), None);
    let elapsed = start.elapsed();
    assert_eq!(kc, 200);
    // Must have waited at least the grace window before escalating.
    assert!(
        elapsed >= Duration::from_millis(900),
        "kill returned too fast ({elapsed:?}); escalation likely skipped"
    );
    assert!(kb.contains(r#""status":"failed""#), "got: {kb}");
    // SIGKILL is signal 9 -> exit_code -9.
    assert!(kb.contains(r#""exit_code":-9"#), "got: {kb}");
}

#[test]
fn kill_reports_killing_during_teardown() {
    // A job that ignores SIGTERM keeps the killer in its grace window. While the
    // kill is in flight, /status must report "killing" (not "running"), so a
    // poller can tell teardown was initiated. 4s grace gives a comfortable
    // window to observe it.
    let s = Server::start_with_env(&[("RPC_KILL_GRACE_SECS", "4")]);
    let script = s.write_script(
        "ignore-term2.sh",
        "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 0.2; done\n",
    );
    let body = format!(r#"{{"id":"teardown","path":"{script}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);
    thread::sleep(Duration::from_millis(200));

    // Kill on a separate thread — it blocks through the grace window.
    let port = s.port;
    let killer = thread::spawn(move || http_roundtrip(port, "POST", "/kill", Some(TOKEN), None));

    // Mid-teardown, status should read "killing".
    thread::sleep(Duration::from_millis(800));
    let (_, st) = s.raw("GET", "/status", Some(TOKEN), None);
    assert!(
        st.contains(r#""status":"killing""#),
        "expected killing during teardown, got: {st}"
    );

    // A new /exec is refused while killing.
    let (busy, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(busy, 409);

    // Once the killer finishes, the job is failed (SIGKILL -> -9).
    let (kc, _, kb) = killer.join().expect("killer thread");
    assert_eq!(kc, 200);
    assert!(kb.contains(r#""status":"failed""#), "got: {kb}");
    assert!(kb.contains(r#""exit_code":-9"#), "got: {kb}");
}

// --- Graceful shutdown: signal forwarded to the child, no orphan ---

// Send a signal to `pid` via /bin/kill (avoids a libc dev-dependency). `sig` is
// e.g. "-TERM" or "-0"; returns true if kill reported success (for "-0", that
// means the process exists).
fn send_signal(pid: i32, sig: &str) -> bool {
    std::process::Command::new("kill")
        .args([sig, &pid.to_string()])
        // Silence "No such process" noise from the liveness ("-0") polls.
        .stderr(Stdio::null())
        .status()
        .map(|st| st.success())
        .unwrap_or(false)
}

#[test]
fn sigterm_terminates_child_job_no_orphan() {
    let mut s = Server::start();
    let pidfile = s.tmpdir.join("child.pid");
    // The job records its own PID (== its process-group leader, thanks to the
    // server's setsid) then sleeps. We use that PID to check it's really gone.
    let script = s.write_script(
        "pidwrite.sh",
        &format!("#!/bin/sh\necho $$ > '{}'\nsleep 30\n", pidfile.display()),
    );
    let body = format!(r#"{{"id":"orphan","path":"{script}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);

    // Wait for the job to publish its PID.
    let deadline = Instant::now() + Duration::from_secs(5);
    let child_pid: i32 = loop {
        if let Ok(txt) = std::fs::read_to_string(&pidfile) {
            if let Ok(pid) = txt.trim().parse::<i32>() {
                break pid;
            }
        }
        if Instant::now() > deadline {
            panic!("job never wrote its pid");
        }
        thread::sleep(Duration::from_millis(50));
    };
    assert!(
        send_signal(child_pid, "-0"),
        "job should be alive before SIGTERM"
    );

    // SIGTERM the server; its handler must forward termination to the job's
    // process group and then exit on its own.
    let server_pid = s.child.id() as i32;
    assert!(send_signal(server_pid, "-TERM"), "failed to SIGTERM server");

    let exit_deadline = Instant::now() + Duration::from_secs(10);
    let server_status = loop {
        match s.child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Err(_) => break None,
            Ok(None) => {}
        }
        if Instant::now() > exit_deadline {
            panic!("server did not exit after SIGTERM");
        }
        thread::sleep(Duration::from_millis(50));
    };

    // The server must terminate *via* SIGTERM (re-raised after cleanup), not a
    // masking exit(0). 15 == SIGTERM.
    use std::os::unix::process::ExitStatusExt;
    if let Some(st) = server_status {
        assert_eq!(
            st.signal(),
            Some(15),
            "server should exit via SIGTERM, got {st:?}"
        );
    }

    // The job must be gone — not left orphaned and running.
    let alive_deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if !send_signal(child_pid, "-0") {
            break;
        }
        if Instant::now() > alive_deadline {
            panic!("child job {child_pid} still alive after server SIGTERM (orphaned)");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

// --- Heartbeat watchdog ---

#[test]
fn heartbeat_watchdog_kills_stale_job() {
    // 2s timeout, 1s tick: with no heartbeats sent, the watchdog should reap a
    // running job within a few seconds instead of the 60s production default.
    let s = Server::start_with_env(&[
        ("RPC_HEARTBEAT_TIMEOUT_SECS", "2"),
        ("RPC_WATCHDOG_TICK_SECS", "1"),
    ]);
    let long = s.write_script("watchdog.sh", "#!/bin/sh\nsleep 30\n");
    let body = format!(r#"{{"id":"stale","path":"{long}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);

    // No /heartbeat calls -> watchdog times out and kills the job.
    let st = s.wait_terminal(Duration::from_secs(15));
    assert!(st.contains(r#""status":"failed""#), "got: {st}");
}

#[test]
fn heartbeats_keep_job_alive() {
    // Same short timeout, but we keep sending heartbeats; the job must NOT be
    // killed by the watchdog and should complete on its own.
    let s = Server::start_with_env(&[
        ("RPC_HEARTBEAT_TIMEOUT_SECS", "2"),
        ("RPC_WATCHDOG_TICK_SECS", "1"),
    ]);
    let script = s.write_script("brief.sh", "#!/bin/sh\nsleep 4\nexit 0\n");
    let body = format!(r#"{{"id":"kept","path":"{script}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);

    // Beat every 500ms for ~5s, covering the job's 4s runtime.
    for _ in 0..10 {
        let (hc, _) = s.raw("POST", "/heartbeat", Some(TOKEN), None);
        assert_eq!(hc, 200);
        thread::sleep(Duration::from_millis(500));
    }
    let (_, st) = s.raw("GET", "/status", Some(TOKEN), None);
    assert!(
        st.contains(r#""status":"completed""#),
        "job should have completed normally, got: {st}"
    );
}

#[test]
fn watchdog_kill_then_new_job_supervised() {
    // Regression guard for the watchdog race fix: after the watchdog reaps a
    // stale job A, a freshly-started job B must be supervised on its own terms —
    // i.e. A's timeout handling must not have disarmed B, and B (kept alive by
    // heartbeats) must run to completion rather than being collateral damage.
    let s = Server::start_with_env(&[
        ("RPC_HEARTBEAT_TIMEOUT_SECS", "2"),
        ("RPC_WATCHDOG_TICK_SECS", "1"),
    ]);

    // Job A: never heartbeated -> watchdog kills it.
    let long = s.write_script("a.sh", "#!/bin/sh\nsleep 30\n");
    let a = format!(r#"{{"id":"A","path":"{long}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&a));
    assert_eq!(c, 200);
    let st = s.wait_terminal(Duration::from_secs(15));
    assert!(
        st.contains(r#""status":"failed""#),
        "A should be killed: {st}"
    );

    // Job B: heartbeated throughout, must complete normally.
    let brief = s.write_script("b.sh", "#!/bin/sh\nsleep 4\nexit 0\n");
    let b = format!(r#"{{"id":"B","path":"{brief}"}}"#);
    let (c, body) = s.raw("POST", "/exec", Some(TOKEN), Some(&b));
    assert_eq!(c, 200, "B should be accepted after A died: {body}");
    for _ in 0..12 {
        let (hc, _) = s.raw("POST", "/heartbeat", Some(TOKEN), None);
        assert_eq!(hc, 200);
        thread::sleep(Duration::from_millis(500));
    }
    let (_, st) = s.raw("GET", "/status", Some(TOKEN), None);
    assert!(
        st.contains(r#""status":"completed""#) && st.contains(r#""id":"B""#),
        "B should complete normally, got: {st}"
    );
}

#[test]
fn no_watchdog_log_after_clean_completion() {
    // After a job finishes, the client stops heartbeating. The watchdog must
    // not later fire on the stale last_heartbeat and log a misleading
    // "heartbeat timeout, killing job" for a job that already completed.
    let mut s = Server::start_with_env(&[
        ("RPC_HEARTBEAT_TIMEOUT_SECS", "2"),
        ("RPC_WATCHDOG_TICK_SECS", "1"),
    ]);

    // Drain the server's stderr in the background so we can inspect it.
    let stderr = s.child.stderr.take().expect("stderr");
    let log = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let log_writer = std::sync::Arc::clone(&log);
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => log_writer.lock().unwrap().push_str(&line),
            }
        }
    });

    let script = s.write_script("quick.sh", "#!/bin/sh\nexit 0\n");
    let body = format!(r#"{{"id":"quick","path":"{script}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);
    let st = s.wait_terminal(Duration::from_secs(5));
    assert!(st.contains(r#""status":"completed""#), "got: {st}");

    // Wait well past the heartbeat timeout + several watchdog ticks; with the
    // bug the watchdog would have logged by now.
    thread::sleep(Duration::from_secs(5));

    let captured = log.lock().unwrap().clone();
    assert!(
        !captured.contains("Heartbeat timeout"),
        "watchdog fired for an already-completed job; stderr:\n{captured}"
    );
}

// --- /logs paging at MAX_CHUNK ---

#[test]
fn logs_chunk_at_max_and_paginate() {
    const MAX_CHUNK: usize = 1_048_576;
    let total = MAX_CHUNK + 51_424; // one full chunk + a remainder
    let s = Server::start();
    // Emit `total` 'a' bytes to stdout, then exit.
    let script = s.write_script(
        "big.sh",
        &format!("#!/bin/sh\nhead -c {total} /dev/zero | tr '\\0' a\n"),
    );
    let body = format!(r#"{{"id":"big","path":"{script}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);
    s.wait_terminal(Duration::from_secs(10));

    // First chunk: exactly MAX_CHUNK bytes, with more data flagged.
    let (code, headers, body) =
        s.raw_full("GET", "/logs?stream=stdout&offset=0", Some(TOKEN), None);
    assert_eq!(code, 200);
    assert_eq!(
        body.len(),
        MAX_CHUNK,
        "first chunk should be exactly MAX_CHUNK"
    );
    assert_eq!(
        headers.get("x-more-data").map(String::as_str),
        Some("true"),
        "headers: {headers:?}"
    );

    // Second chunk from the returned offset: the remainder, no more data.
    let off = MAX_CHUNK;
    let (code, headers, body) = s.raw_full(
        "GET",
        &format!("/logs?stream=stdout&offset={off}"),
        Some(TOKEN),
        None,
    );
    assert_eq!(code, 200);
    assert_eq!(body.len(), total - MAX_CHUNK);
    assert_eq!(
        headers.get("x-more-data").map(String::as_str),
        Some("false"),
        "headers: {headers:?}"
    );
}

// --- OOM score: the user job must remain an OOM candidate ---

#[test]
fn child_job_oom_score_is_reset() {
    // Linux-only: verifies the spawned job's oom_score_adj is reset to 0 so it
    // stays an OOM-kill candidate (the server itself runs with -1000). On
    // non-Linux hosts there's no /proc, so skip.
    if !PathBuf::from("/proc/self/oom_score_adj").exists() {
        eprintln!("skipping child_job_oom_score_is_reset: no /proc");
        return;
    }
    let s = Server::start();
    let script = s.write_script("oom.sh", "#!/bin/sh\ncat /proc/self/oom_score_adj\n");
    let body = format!(r#"{{"id":"oom","path":"{script}"}}"#);
    let (c, _) = s.raw("POST", "/exec", Some(TOKEN), Some(&body));
    assert_eq!(c, 200);
    s.wait_terminal(Duration::from_secs(5));

    let (_, out) = s.raw("GET", "/logs?stream=stdout", Some(TOKEN), None);
    assert_eq!(
        out.trim(),
        "0",
        "child oom_score_adj should be 0, got: {out:?}"
    );
}
