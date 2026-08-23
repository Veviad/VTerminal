//! Mandatory stdio MCP isolation.
//!
//! The launcher fails closed.  A configured command is never spawned directly:
//! macOS uses Seatbelt and Windows enters the app's default WSL2 distribution
//! through bubblewrap. A bundled Linux supervisor bridges that private network
//! namespace to an authenticated Rust HTTP/SOCKS allowlist proxy on Windows.

use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::Stdio;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::sync::Arc;

use serde::Serialize;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;

use super::config::{McpEnvConfig, McpSandboxPolicy};

#[derive(Debug, Clone, Serialize)]
pub struct SandboxStatus {
    pub supported: bool,
    pub ready: bool,
    pub backend: String,
    pub message: String,
    pub network_domain_filtering: bool,
}

pub struct SandboxLaunch {
    pub command: Command,
    pub guard: Option<SandboxGuard>,
}

pub struct SandboxGuard {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    #[cfg(target_os = "macos")]
    private_dir: tempfile::TempDir,
    #[cfg(target_os = "macos")]
    process_group: Option<i32>,
    #[cfg(target_os = "windows")]
    relay: Option<tokio::process::Child>,
}

impl SandboxGuard {
    pub fn set_process_id(&mut self, process_id: Option<u32>) {
        #[cfg(target_os = "macos")]
        {
            self.process_group = process_id.map(|id| id as i32);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = process_id;
    }
}

impl Drop for SandboxGuard {
    fn drop(&mut self) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        #[cfg(target_os = "macos")]
        {
            if let Some(process_group) = self.process_group.take() {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(process_group),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
        }
        #[cfg(target_os = "windows")]
        if let Some(relay) = self.relay.as_mut() {
            let _ = relay.start_kill();
        }
    }
}

#[cfg(target_os = "macos")]
fn scheme_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn canonical_existing(path: &str, kind: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("sandbox {kind} path does not exist: {}", path.display()))?;
    if canonical == Path::new("/") {
        return Err(format!("sandbox {kind} path cannot be the filesystem root"));
    }
    Ok(canonical)
}

#[cfg(target_os = "macos")]
fn private_directory(server_id: &str) -> Result<tempfile::TempDir, String> {
    use std::os::unix::fs::PermissionsExt;

    let id = uuid::Uuid::parse_str(server_id).map_err(|_| "invalid MCP server id")?;
    let directory = tempfile::Builder::new()
        .prefix(&format!("vterminal-mcp-{}-", id.simple()))
        .tempdir()
        .map_err(|error| format!("could not create private MCP cache directory: {error}"))?;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("could not secure private MCP cache directory: {error}"))?;
    Ok(directory)
}

#[cfg(target_os = "macos")]
fn path_granted(path: &Path, policy: &McpSandboxPolicy) -> bool {
    policy
        .allow_read
        .iter()
        .chain(policy.allow_write.iter())
        .filter_map(|item| PathBuf::from(item).canonicalize().ok())
        .any(|grant| path == grant || path.starts_with(grant))
}

#[cfg(target_os = "macos")]
fn resolve_executable(executable: &str, policy: &McpSandboxPolicy) -> Result<PathBuf, String> {
    let candidate = if executable.contains('/') {
        PathBuf::from(executable)
    } else {
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
            .map(|directory| directory.join(executable))
            .find(|path| path.is_file())
            .ok_or_else(|| format!("stdio executable was not found on PATH: {executable}"))?
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("could not resolve stdio executable {executable}: {error}"))?;
    if resolved.starts_with("/Users") && !path_granted(&resolved, policy) {
        return Err(
            "an executable under a user directory needs an explicit read sandbox grant".into(),
        );
    }
    Ok(resolved)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn blocked_address(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            ip.is_link_local() || ip.is_broadcast() || ip.is_unspecified() || ip.is_multicast()
        }
        std::net::IpAddr::V6(ip) => {
            ip.is_unicast_link_local() || ip.is_unspecified() || ip.is_multicast()
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn target_allowed(host: &str, domains: &[String]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.eq_ignore_ascii_case("metadata.google.internal") {
        return false;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if blocked_address(ip) {
            return false;
        }
    }
    domains
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn connect_target(host: &str, port: u16) -> Result<TcpStream, String> {
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("proxy target could not be resolved: {error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("proxy target did not resolve to an address".into());
    }
    if addresses
        .iter()
        .any(|address| blocked_address(address.ip()))
    {
        return Err("proxy target resolves to a blocked link-local or special-use address".into());
    }
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect(address).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "proxy connection failed: {}",
        last_error.map_or_else(|| "no usable address".into(), |error| error.to_string())
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn host_port(target: &str, default_port: u16) -> Result<(String, u16), String> {
    if let Ok(url) = url::Url::parse(target) {
        let host = url.host_str().ok_or("proxy target has no host")?.to_owned();
        let port = url.port_or_known_default().unwrap_or(default_port);
        return Ok((host, port));
    }
    if let Some(value) = target.strip_prefix('[') {
        let (host, port) = value.split_once("]:").ok_or("invalid IPv6 proxy target")?;
        return Ok((
            host.to_owned(),
            port.parse().map_err(|_| "invalid proxy port")?,
        ));
    }
    match target.rsplit_once(':') {
        Some((host, port)) => Ok((
            host.to_owned(),
            port.parse().map_err(|_| "invalid proxy port")?,
        )),
        None => Ok((target.to_owned(), default_port)),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn relay(
    mut downstream: TcpStream,
    host: String,
    port: u16,
    initial: Option<Vec<u8>>,
) -> Result<(), String> {
    let mut upstream = connect_target(&host, port).await?;
    if let Some(initial) = initial {
        upstream
            .write_all(&initial)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::io::copy_bidirectional(&mut downstream, &mut upstream)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn handle_socks(mut socket: TcpStream, domains: Vec<String>) -> Result<(), String> {
    let mut greeting = [0u8; 2];
    socket
        .read_exact(&mut greeting)
        .await
        .map_err(|error| error.to_string())?;
    if greeting[0] != 5 || greeting[1] == 0 {
        return Err("invalid SOCKS5 greeting".into());
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    socket
        .read_exact(&mut methods)
        .await
        .map_err(|error| error.to_string())?;
    if !methods.contains(&0) {
        socket
            .write_all(&[5, 0xff])
            .await
            .map_err(|error| error.to_string())?;
        return Err("SOCKS5 client requires unsupported authentication".into());
    }
    socket
        .write_all(&[5, 0])
        .await
        .map_err(|error| error.to_string())?;
    let mut request = [0u8; 4];
    socket
        .read_exact(&mut request)
        .await
        .map_err(|error| error.to_string())?;
    if request[..3] != [5, 1, 0] {
        return Err("SOCKS5 proxy supports CONNECT only".into());
    }
    let host = match request[3] {
        1 => {
            let mut address = [0u8; 4];
            socket
                .read_exact(&mut address)
                .await
                .map_err(|error| error.to_string())?;
            std::net::Ipv4Addr::from(address).to_string()
        }
        3 => {
            let length = socket.read_u8().await.map_err(|error| error.to_string())? as usize;
            let mut address = vec![0u8; length];
            socket
                .read_exact(&mut address)
                .await
                .map_err(|error| error.to_string())?;
            String::from_utf8(address).map_err(|_| "SOCKS5 domain is not UTF-8")?
        }
        4 => {
            let mut address = [0u8; 16];
            socket
                .read_exact(&mut address)
                .await
                .map_err(|error| error.to_string())?;
            std::net::Ipv6Addr::from(address).to_string()
        }
        _ => return Err("unsupported SOCKS5 address type".into()),
    };
    let port = socket.read_u16().await.map_err(|error| error.to_string())?;
    if !target_allowed(&host, &domains) {
        socket
            .write_all(&[5, 2, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
            .map_err(|error| error.to_string())?;
        return Err("SOCKS5 destination is not on the MCP domain allowlist".into());
    }
    let upstream = connect_target(&host, port).await?;
    socket
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|error| error.to_string())?;
    let (mut read, mut write) = upstream.into_split();
    let (mut downstream_read, mut downstream_write) = socket.into_split();
    tokio::try_join!(
        tokio::io::copy(&mut downstream_read, &mut write),
        tokio::io::copy(&mut read, &mut downstream_write)
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn handle_http(mut socket: TcpStream, domains: Vec<String>) -> Result<(), String> {
    const MAX_HEADER: usize = 32 * 1024;
    let mut request = Vec::new();
    let mut buffer = [0u8; 2048];
    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        let read = socket
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("HTTP proxy client closed before sending headers".into());
        }
        request.extend_from_slice(&buffer[..read]);
        if request.len() > MAX_HEADER {
            return Err("HTTP proxy request headers are too large".into());
        }
    }
    let first_end = request
        .windows(2)
        .position(|bytes| bytes == b"\r\n")
        .ok_or("invalid HTTP proxy request")?;
    let first = std::str::from_utf8(&request[..first_end])
        .map_err(|_| "HTTP proxy request is not UTF-8")?;
    let mut parts = first.split_whitespace();
    let method = parts.next().ok_or("HTTP proxy method is missing")?;
    let target = parts.next().ok_or("HTTP proxy target is missing")?;
    if method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = host_port(target, 443)?;
        if !target_allowed(&host, &domains) {
            socket
                .write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
                .await
                .map_err(|error| error.to_string())?;
            return Err("HTTP CONNECT destination is not on the MCP domain allowlist".into());
        }
        let upstream = connect_target(&host, port).await?;
        socket
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .map_err(|error| error.to_string())?;
        let (mut read, mut write) = upstream.into_split();
        let (mut downstream_read, mut downstream_write) = socket.into_split();
        tokio::try_join!(
            tokio::io::copy(&mut downstream_read, &mut write),
            tokio::io::copy(&mut read, &mut downstream_write)
        )
        .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let url = url::Url::parse(target).map_err(|_| "HTTP proxy requires an absolute request URL")?;
    let host = url
        .host_str()
        .ok_or("HTTP proxy target has no host")?
        .to_owned();
    let port = url
        .port_or_known_default()
        .ok_or("HTTP proxy target has no port")?;
    if !target_allowed(&host, &domains) {
        socket
            .write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            .await
            .map_err(|error| error.to_string())?;
        return Err("HTTP destination is not on the MCP domain allowlist".into());
    }
    let origin = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    };
    let rewritten = format!("{method} {origin} {}", parts.next().unwrap_or("HTTP/1.1"));
    let mut initial = rewritten.into_bytes();
    initial.extend_from_slice(&request[first_end..]);
    relay(socket, host, port, Some(initial)).await
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn start_proxy(
    domains: &[String],
    bind_address: std::net::Ipv4Addr,
    expected_token: Option<String>,
) -> Result<(u16, tokio::sync::oneshot::Sender<()>), String> {
    let listener = std::net::TcpListener::bind((bind_address, 0))
        .map_err(|error| format!("could not bind MCP domain proxy: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let listener = TcpListener::from_std(listener).map_err(|error| error.to_string())?;
    let domains = domains.to_vec();
    let expected_token = expected_token.map(Arc::<str>::from);
    let (shutdown, mut stopped) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => match accepted {
                    Ok((socket, _)) => {
                        let domains = domains.clone();
                        let expected_token = expected_token.clone();
                        tokio::spawn(async move {
                            let mut socket = socket;
                            if let Some(token) = expected_token {
                                let mut received = vec![0; token.len()];
                                if socket.read_exact(&mut received).await.is_err()
                                    || received.as_slice() != token.as_bytes()
                                {
                                    return;
                                }
                            }
                            let mut first = [0u8; 1];
                            let result = match socket.peek(&mut first).await {
                                Ok(1) if first[0] == 5 => handle_socks(socket, domains).await,
                                Ok(_) => handle_http(socket, domains).await,
                                Err(error) => Err(error.to_string()),
                            };
                            if let Err(error) = result {
                                log::debug!("MCP domain proxy connection closed: {error}");
                            }
                        });
                    }
                    Err(error) => {
                        log::warn!("MCP domain proxy listener failed: {error}");
                        break;
                    }
                }
            }
        }
    });
    Ok((port, shutdown))
}

#[cfg(target_os = "macos")]
fn start_domain_proxy(
    domains: &[String],
    private_dir: tempfile::TempDir,
) -> Result<(u16, SandboxGuard), String> {
    let (port, shutdown) = start_proxy(domains, std::net::Ipv4Addr::LOCALHOST, None)?;
    Ok((
        port,
        SandboxGuard {
            shutdown: Some(shutdown),
            private_dir,
            process_group: None,
        },
    ))
}

#[cfg(target_os = "macos")]
fn macos_profile(
    policy: &McpSandboxPolicy,
    cwd: Option<&str>,
    private_dir: &Path,
    proxy_port: Option<u16>,
) -> Result<String, String> {
    let mut profile = String::from(
        "(version 1)\n(deny default)\n(allow process*)\n(allow signal)\n\
         (allow sysctl-read)\n(allow mach-lookup)\n(allow ipc-posix-shm*)\n\
         (allow file-read* (subpath \"/System\") (subpath \"/usr\") \
         (subpath \"/bin\") (subpath \"/sbin\") (subpath \"/Library\") \
         (subpath \"/opt/homebrew\") (subpath \"/usr/local\") (subpath \"/dev\"))\n\
         (deny network*)\n",
    );
    let private = scheme_escape(&private_dir.to_string_lossy());
    profile.push_str(&format!(
        "(allow file-read* (subpath \"{private}\"))\n(allow file-write* (subpath \"{private}\"))\n"
    ));
    if let Some(port) = proxy_port {
        profile.push_str(&format!(
            "(allow network-outbound (remote ip \"localhost:{port}\"))\n"
        ));
    }
    if let Some(cwd) = cwd {
        let cwd = canonical_existing(cwd, "working directory")?;
        if !path_granted(&cwd, policy) {
            return Err(
                "the stdio working directory needs an explicit read or write sandbox grant".into(),
            );
        }
        profile.push_str(&format!(
            "(allow file-read* (subpath \"{}\"))\n",
            scheme_escape(&cwd.to_string_lossy())
        ));
    }
    for path in &policy.allow_read {
        let path = canonical_existing(path, "read")?;
        profile.push_str(&format!(
            "(allow file-read* (subpath \"{}\"))\n",
            scheme_escape(&path.to_string_lossy())
        ));
    }
    for path in &policy.allow_write {
        let path = canonical_existing(path, "write")?;
        let escaped = scheme_escape(&path.to_string_lossy());
        profile.push_str(&format!(
            "(allow file-read* (subpath \"{escaped}\"))\n(allow file-write* (subpath \"{escaped}\"))\n"
        ));
    }
    Ok(profile)
}

#[cfg(target_os = "macos")]
pub async fn status(_app: &tauri::AppHandle<tauri::Wry>) -> SandboxStatus {
    let present = Path::new("/usr/bin/sandbox-exec").is_file();
    SandboxStatus {
        supported: true,
        ready: present,
        backend: "macos-seatbelt".into(),
        message: if present {
            "Seatbelt and the loopback-only HTTP/SOCKS domain proxy are ready.".into()
        } else {
            "macOS sandbox-exec is unavailable; local MCP is disabled.".into()
        },
        network_domain_filtering: present,
    }
}

#[cfg(target_os = "windows")]
async fn linux_relay_path(app: &tauri::AppHandle<tauri::Wry>) -> Result<String, String> {
    use tauri::Manager;

    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not resolve application resources: {error}"))?
        .join("vterminal-mcp-relay");
    let development_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("vterminal-mcp-relay");
    let windows_path = if resource_path.is_file() {
        resource_path
    } else {
        development_path
    };
    if !windows_path.is_file() {
        return Err("the bundled WSL MCP relay is missing; local MCP is disabled".into());
    }
    let output = Command::new("wsl.exe")
        .args(["--exec", "wslpath", "-a", "-u"])
        .arg(&windows_path)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("could not translate the WSL relay path: {error}"))?;
    if !output.status.success() {
        return Err("the default WSL2 distribution could not access the bundled MCP relay".into());
    }
    let path = String::from_utf8(output.stdout)
        .map_err(|_| "wslpath returned a non-UTF-8 relay path")?
        .trim()
        .to_owned();
    if path.is_empty() {
        return Err("wslpath returned an empty relay path".into());
    }
    Ok(path)
}

#[cfg(target_os = "windows")]
async fn windows_self_test(app: &tauri::AppHandle<tauri::Wry>) -> Result<String, String> {
    let relay = linux_relay_path(app).await?;
    let success = Command::new("wsl.exe")
        .args([
            "--exec",
            "bwrap",
            "--die-with-parent",
            "--new-session",
            "--unshare-user",
            "--unshare-pid",
            "--unshare-net",
            "--uid",
            "0",
            "--gid",
            "0",
            "--ro-bind",
            "/",
            "/",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--",
        ])
        .arg(&relay)
        .arg("self-test")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|error| format!("could not run the WSL sandbox self-test: {error}"))?;
    if !success.success() {
        return Err("WSL2 bubblewrap, user/network namespaces, or the bundled seccomp relay self-test failed; local MCP is disabled".into());
    }
    windows_host_address(&relay).await?;
    Ok(relay)
}

#[cfg(target_os = "windows")]
async fn windows_host_address(relay: &str) -> Result<std::net::Ipv4Addr, String> {
    let output = Command::new("wsl.exe")
        .args(["--exec", relay, "host"])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("could not resolve the Windows WSL gateway: {error}"))?;
    if !output.status.success() {
        return Err("the bundled relay could not resolve the Windows WSL gateway".into());
    }
    String::from_utf8(output.stdout)
        .map_err(|_| "the WSL gateway address is not UTF-8".to_string())?
        .trim()
        .parse()
        .map_err(|_| "the WSL gateway is not an IPv4 address".to_string())
}

#[cfg(target_os = "windows")]
async fn canonical_wsl_path(path: &str, kind: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err(format!("sandbox {kind} paths must be absolute WSL paths"));
    }
    let output = Command::new("wsl.exe")
        .args(["--exec", "realpath", "--canonicalize-existing", "--"])
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("could not resolve sandbox {kind} path: {error}"))?;
    if !output.status.success() {
        return Err(format!("sandbox {kind} path does not exist: {path}"));
    }
    let resolved = String::from_utf8(output.stdout)
        .map_err(|_| format!("sandbox {kind} path is not UTF-8"))?
        .trim()
        .to_owned();
    if resolved == "/" || !resolved.starts_with('/') || resolved.contains('\n') {
        return Err(format!("sandbox {kind} path cannot be the filesystem root"));
    }
    Ok(resolved)
}

#[cfg(target_os = "windows")]
async fn resolve_wsl_executable(executable: &str) -> Result<String, String> {
    let candidate = if executable.contains('/') {
        executable.to_owned()
    } else {
        let output = Command::new("wsl.exe")
            .args(["--exec", "which", "--"])
            .arg(executable)
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|error| format!("could not resolve stdio executable: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "stdio executable was not found in the default WSL2 distribution: {executable}"
            ));
        }
        String::from_utf8(output.stdout)
            .map_err(|_| "stdio executable path is not UTF-8")?
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    canonical_wsl_path(&candidate, "executable").await
}

#[cfg(any(test, target_os = "windows"))]
fn wsl_path_granted(path: &str, read: &[String], write: &[String]) -> bool {
    read.iter().chain(write).any(|grant| {
        path == grant
            || path
                .strip_prefix(grant)
                .is_some_and(|remainder| remainder.starts_with('/'))
    })
}

#[cfg(target_os = "windows")]
pub async fn status(app: &tauri::AppHandle<tauri::Wry>) -> SandboxStatus {
    let result = windows_self_test(app).await;
    let ready = result.is_ok();
    SandboxStatus {
        supported: true,
        ready,
        backend: "wsl2-bubblewrap".into(),
        message: if ready {
            "WSL2 bubblewrap, namespaces, bundled relay, host allowlist proxy, and seccomp are ready."
                .into()
        } else {
            result.unwrap_err()
        },
        network_domain_filtering: ready,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub async fn status(_app: &tauri::AppHandle<tauri::Wry>) -> SandboxStatus {
    SandboxStatus {
        supported: false,
        ready: false,
        backend: "unsupported".into(),
        message: "Local MCP is supported only on macOS and Windows/WSL2.".into(),
        network_domain_filtering: false,
    }
}

#[cfg(target_os = "macos")]
pub async fn command(
    _app: &tauri::AppHandle<tauri::Wry>,
    server_id: &str,
    executable: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &[(McpEnvConfig, Option<crate::credentials::Secret>)],
    policy: &McpSandboxPolicy,
) -> Result<SandboxLaunch, String> {
    if !Path::new("/usr/bin/sandbox-exec").is_file() {
        return Err("macOS sandbox runtime is unavailable; stdio MCP was not started".into());
    }
    let private_dir = private_directory(server_id)?;
    let (proxy_port, guard) = if policy.allowed_domains.is_empty() {
        (
            None,
            SandboxGuard {
                shutdown: None,
                private_dir,
                process_group: None,
            },
        )
    } else {
        let (port, guard) = start_domain_proxy(&policy.allowed_domains, private_dir)?;
        (Some(port), guard)
    };
    let private_dir = guard.private_dir.path();
    let profile = macos_profile(policy, cwd, private_dir, proxy_port)?;
    let executable = resolve_executable(executable, policy)?;
    let mut child = Command::new("/usr/bin/sandbox-exec");
    child.process_group(0);
    child
        .args(["-p", &profile, "--"])
        .arg(executable)
        .args(args);
    if let Some(cwd) = cwd {
        child.current_dir(cwd);
    }
    child.env_clear();
    for key in ["PATH", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(key) {
            child.env(key, value);
        }
    }
    child.env("HOME", private_dir);
    child.env("TMPDIR", private_dir);
    child.env("XDG_CACHE_HOME", private_dir.join("cache"));
    if let Some(port) = proxy_port {
        let http = format!("http://127.0.0.1:{port}");
        let socks = format!("socks5h://127.0.0.1:{port}");
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            child.env(key, &http);
        }
        child.env("ALL_PROXY", &socks);
        child.env("all_proxy", &socks);
        child.env("NO_PROXY", "");
        child.env("no_proxy", "");
    }
    for (entry, secret) in env {
        child.env(
            &entry.name,
            secret
                .as_ref()
                .map(crate::credentials::Secret::expose)
                .unwrap_or(&entry.value),
        );
    }
    Ok(SandboxLaunch {
        command: child,
        guard: Some(guard),
    })
}

#[cfg(target_os = "windows")]
pub async fn command(
    app: &tauri::AppHandle<tauri::Wry>,
    server_id: &str,
    executable: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &[(McpEnvConfig, Option<crate::credentials::Secret>)],
    policy: &McpSandboxPolicy,
) -> Result<SandboxLaunch, String> {
    let relay_path = windows_self_test(app).await?;
    let mut allow_read = Vec::with_capacity(policy.allow_read.len());
    for path in &policy.allow_read {
        allow_read.push(canonical_wsl_path(path, "read").await?);
    }
    let mut allow_write = Vec::with_capacity(policy.allow_write.len());
    for path in &policy.allow_write {
        allow_write.push(canonical_wsl_path(path, "write").await?);
    }
    let cwd = match cwd {
        Some(path) => {
            let resolved = canonical_wsl_path(path, "working directory").await?;
            if !wsl_path_granted(&resolved, &allow_read, &allow_write) {
                return Err(
                    "the stdio working directory needs an explicit read or write sandbox grant"
                        .into(),
                );
            }
            Some(resolved)
        }
        None => None,
    };
    let executable = resolve_wsl_executable(executable).await?;
    let runtime_path = ["/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/"]
        .iter()
        .any(|root| executable.starts_with(root));
    if !runtime_path && !wsl_path_granted(&executable, &allow_read, &allow_write) {
        return Err(
            "an executable outside the WSL runtime needs an explicit read sandbox grant".into(),
        );
    }
    let relay_mount = "/vterminal/vterminal-mcp-relay";
    let mut shutdown = None;
    let mut relay = None;
    let mut relay_socket = None;
    if !policy.allowed_domains.is_empty() {
        let token = uuid::Uuid::new_v4().hyphenated().to_string();
        let host_address = windows_host_address(&relay_path).await?;
        let (proxy_port, stop) =
            start_proxy(&policy.allowed_domains, host_address, Some(token.clone()))?;
        shutdown = Some(stop);
        let server = uuid::Uuid::parse_str(server_id).map_err(|_| "invalid MCP server id")?;
        let socket = format!(
            "/tmp/vterminal-mcp-{}-{}.sock",
            server.simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut bridge = Command::new("wsl.exe");
        bridge
            .args(["--exec"])
            .arg(&relay_path)
            .args([
                "bridge",
                "--socket",
                &socket,
                "--port",
                &proxy_port.to_string(),
                "--token",
                &token,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut bridge = bridge
            .spawn()
            .map_err(|error| format!("could not start the bundled WSL relay: {error}"))?;
        // Enter WSL once and poll there. Repeatedly launching wsl.exe is slow
        // enough to make the fixed startup window unreliable on cold systems.
        let ready = Command::new("wsl.exe")
            .args([
                "--exec",
                "sh",
                "-c",
                "i=0; while [ \"$i\" -lt 100 ]; do test -S \"$1\" && exit 0; i=$((i + 1)); sleep 0.05; done; exit 1",
                "vterminal-relay-ready",
                &socket,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success())
            && bridge
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none();
        if !ready {
            let _ = bridge.start_kill();
            if let Some(stop) = shutdown.take() {
                let _ = stop.send(());
            }
            return Err(
                "the bundled WSL relay did not become ready; stdio MCP was not started".into(),
            );
        }
        relay_socket = Some(socket);
        relay = Some(bridge);
    }
    let mut wsl_args = vec![
        "--exec".to_string(),
        "bwrap".to_string(),
        "--die-with-parent".to_string(),
        "--new-session".to_string(),
        "--unshare-all".to_string(),
        "--disable-userns".to_string(),
        "--clearenv".to_string(),
        "--unshare-net".to_string(),
        "--proc".to_string(),
        "/proc".to_string(),
        "--dev".to_string(),
        "/dev".to_string(),
        "--tmpfs".to_string(),
        "/tmp".to_string(),
        "--dir".to_string(),
        "/tmp/vterminal-home".to_string(),
        "--setenv".to_string(),
        "HOME".to_string(),
        "/tmp/vterminal-home".to_string(),
        "--setenv".to_string(),
        "TMPDIR".to_string(),
        "/tmp".to_string(),
        "--setenv".to_string(),
        "XDG_CACHE_HOME".to_string(),
        "/tmp/vterminal-home/cache".to_string(),
        "--dir".to_string(),
        "/vterminal".to_string(),
        "--ro-bind".to_string(),
        relay_path.clone(),
        relay_mount.to_string(),
        "--setenv".to_string(),
        "PATH".to_string(),
        "/usr/local/bin:/usr/bin:/bin".to_string(),
    ];
    for root in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"] {
        wsl_args.extend(["--ro-bind".to_string(), root.to_string(), root.to_string()]);
    }
    for path in &allow_read {
        wsl_args.extend(["--ro-bind".into(), path.clone(), path.clone()]);
    }
    for path in &allow_write {
        wsl_args.extend(["--bind".into(), path.clone(), path.clone()]);
    }
    if let Some(cwd) = &cwd {
        wsl_args.extend(["--chdir".into(), cwd.clone()]);
    }
    for (entry, secret) in env {
        wsl_args.extend([
            "--setenv".into(),
            entry.name.clone(),
            secret
                .as_ref()
                .map(|value| value.expose().to_owned())
                .unwrap_or_else(|| entry.value.clone()),
        ]);
    }
    if let Some(socket) = &relay_socket {
        wsl_args.extend([
            "--dir".into(),
            "/run".into(),
            "--dir".into(),
            "/run/vterminal".into(),
            "--ro-bind".into(),
            socket.clone(),
            "/run/vterminal/proxy.sock".into(),
        ]);
    }
    wsl_args.push("--".into());
    wsl_args.push(relay_mount.into());
    if relay_socket.is_some() {
        wsl_args.extend([
            "run".into(),
            "--socket".into(),
            "/run/vterminal/proxy.sock".into(),
            "--".into(),
        ]);
    } else {
        wsl_args.extend(["exec".into(), "--".into()]);
    }
    wsl_args.push(executable);
    wsl_args.extend(args.iter().cloned());
    let mut child = Command::new("wsl.exe");
    child.args(wsl_args).env_clear();
    Ok(SandboxLaunch {
        command: child,
        guard: Some(SandboxGuard { shutdown, relay }),
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub async fn command(
    _app: &tauri::AppHandle<tauri::Wry>,
    _server_id: &str,
    _executable: &str,
    _args: &[String],
    _cwd: Option<&str>,
    _env: &[(McpEnvConfig, Option<crate::credentials::Secret>)],
    _policy: &McpSandboxPolicy,
) -> Result<SandboxLaunch, String> {
    Err("stdio MCP is unsupported on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_is_fail_closed_for_network() {
        let directory = tempfile::tempdir().unwrap();
        let profile =
            macos_profile(&McpSandboxPolicy::default(), None, directory.path(), None).unwrap();
        assert!(profile.contains("(deny default)"));
        assert!(profile.contains("(deny network*)"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn private_directories_are_unique_secured_and_automatically_removed() {
        use std::os::unix::fs::PermissionsExt;

        let server_id = "01234567-aaaa-bbbb-cccc-0123456789ab";
        let first = private_directory(server_id).unwrap();
        let second = private_directory(server_id).unwrap();
        let first_path = first.path().to_path_buf();
        assert_ne!(first.path(), second.path());
        assert_eq!(
            std::fs::metadata(first.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        drop(first);
        assert!(!first_path.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn domain_matching_is_exact_or_subdomain_and_blocks_metadata() {
        let domains = vec!["example.com".to_string()];
        assert!(target_allowed("example.com", &domains));
        assert!(target_allowed("api.example.com", &domains));
        assert!(!target_allowed("notexample.com", &domains));
        assert!(!target_allowed(
            "169.254.169.254",
            &["169.254.169.254".into()]
        ));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn host_proxy_rejects_a_bridge_without_the_launch_token() {
        let token = uuid::Uuid::new_v4().hyphenated().to_string();
        let (port, shutdown) = start_proxy(
            &["example.com".into()],
            std::net::Ipv4Addr::LOCALHOST,
            Some(token),
        )
        .unwrap();
        let mut connection = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        connection.write_all(&[b'x'; 36]).await.unwrap();
        let mut byte = [0u8; 1];
        assert_eq!(connection.read(&mut byte).await.unwrap(), 0);
        let _ = shutdown.send(());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn root_is_never_an_allowed_user_path() {
        assert!(canonical_existing("/", "read").is_err());
    }

    #[test]
    fn wsl_grants_use_path_boundaries_not_string_prefixes() {
        let read = vec!["/home/user/project".to_string()];
        assert!(wsl_path_granted("/home/user/project/src", &read, &[]));
        assert!(!wsl_path_granted("/home/user/project-secrets", &read, &[]));
    }
}
