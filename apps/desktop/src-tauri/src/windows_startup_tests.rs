//! Actual bundled-runtime acceptance for Tauri's Windows resource path spelling.
//! This constructs the Node command with the real ServiceJob and start gate. It
//! does not call start_service: current_exe there would select this test harness
//! as the helper. Installed graphical acceptance covers that production call.

use super::windows_platform;
use std::{
    fs,
    io::{self, Write},
    path::{Component, Path, PathBuf, Prefix},
    process::{Child, Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn finish_with_deadline(child: Child, job: windows_platform::ServiceJob) -> io::Result<Output> {
    let (send, receive) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = send.send(result);
    });
    let result = receive.recv_timeout(Duration::from_secs(25));
    // Closing the actual job terminates any timed-out runner and descendants;
    // no ownership helper can outlive a failed test and keep its fixture pinned.
    drop(job);
    let output = match result {
        Ok(output) => output,
        Err(_) => {
            let _ = receive.recv_timeout(Duration::from_secs(5));
            if worker.is_finished() { let _ = worker.join(); }
            return Err(io::Error::new(io::ErrorKind::TimedOut,
                "Bundled Windows service did not finish its gated startup within 25 seconds"));
        },
    };
    worker.join().map_err(|_| io::Error::other("Bundled service output reader failed"))?;
    output
}

fn run_bundle(node: &Path, runner: &Path, helper: &Path, data: &Path) -> io::Result<Output> {
    let root = windows_platform::pin_private_directory(data, true)?;
    assert!(root.path().to_string_lossy().starts_with(r"\\?\Volume{"),
        "Pass the authenticated volume GUID authority to Node without rewriting it");
    let job = windows_platform::ServiceJob::new()?;
    let mut child = Command::new(node)
        .arg(runner)
        .arg(root.path())
        .env("MOTION_NATIVE_HELPER", helper)
        .env("MOTION_SERVICE_START_GATE", "1")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn()?;
    if let Err(error) = job.attach(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let input = b"MOTION_SERVICE_START\n{\"lane\":\"ui-load\",\"payload\":{\"schemaVersion\":2}}\n";
    let written = child.stdin.take().ok_or_else(|| io::Error::other("Missing service input"))
        .and_then(|mut stdin| stdin.write_all(input).and_then(|_| stdin.flush()));
    // EOF follows the two complete lines, so the real service replies, closes
    // SQLite, releases its guardian, and exits without a test-only protocol.
    let output = finish_with_deadline(child, job)?;
    if !output.status.success() { return Ok(output); }
    written?;
    Ok(output)
}

fn cleanup(path: &Path) -> io::Result<()> {
    for attempt in 0..40 {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) if attempt == 39 => return Err(error),
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
    unreachable!()
}

#[test]
fn bundled_service_accepts_tauri_canonical_resource_paths_and_guid_data_root() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let resource = manifest.join("..").join("dist");
    let ordinary_node = resource.join("node-runtime.exe");
    let ordinary_runner = resource.join("service-bundle.mjs");
    assert!(ordinary_node.is_file() && ordinary_runner.is_file(),
        "Prepare the checksum-verified bundled runtime and service before native tests; missing resources must fail");
    let canonical_node = ordinary_node.canonicalize().expect("Canonical bundled runtime");
    let canonical_runner = ordinary_runner.canonicalize().expect("Canonical service entrypoint");
    for path in [&canonical_node, &canonical_runner] {
        assert!(matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::VerbatimDisk(_))),
            "The regression must exercise the actual verbatim drive spelling produced by Tauri");
    }
    let harness = std::env::current_exe().expect("Native test executable");
    let helper = harness.parent().and_then(Path::parent).expect("Cargo profile directory")
        .join("motion-desktop.exe");
    assert!(helper.is_file(), "Build the actual Motion executable before testing native service startup");
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("Fixture clock").as_nanos();
    let parent = std::env::temp_dir().join(format!("motion-bundled-startup-{}-{nonce}", std::process::id()));
    fs::create_dir(&parent).expect("Unique startup fixture");
    let result = (|| -> io::Result<Vec<Output>> {
        Ok(vec![
            run_bundle(&ordinary_node, &ordinary_runner, &helper, &parent.join("ordinary"))?,
            run_bundle(&canonical_node, &canonical_runner, &helper, &parent.join("canonical"))?,
        ])
    })();
    let removed = cleanup(&parent);
    let outputs = result.expect("Real bundled service startup must complete");
    removed.expect("All fixture processes and pinned files must be released");
    for (kind, output) in ["ordinary", "Tauri verbatim"].into_iter().zip(outputs) {
        assert!(output.status.success(), "{kind} resource entrypoint failed: {}", String::from_utf8_lossy(&output.stderr));
        let reply: serde_json::Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|error| panic!("{kind} entrypoint did not return one complete JSON reply: {error}"));
        assert_eq!(reply, serde_json::json!({ "ok": true, "value": {
            "schemaVersion": 2, "workspace": null, "revision": 0, "activePageId": null
        }}), "{kind} resource paths must reach the actual service and preserve the first queued request");
    }
}
