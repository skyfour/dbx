use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use dbx_codex::ui_transport::UiTransport;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

async fn fixture() -> (UiTransport, tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
    let writes = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route(
            "/api/auth/login",
            post(|| async { ([("set-cookie", "dbx_session=private-ui-session; HttpOnly; Path=/")], "ok") }),
        )
        .route(
            "/api/echo",
            post(|State(writes): State<Arc<AtomicUsize>>, headers: HeaderMap, body: Bytes| async move {
                if headers.get("cookie").and_then(|h| h.to_str().ok()) != Some("dbx_session=private-ui-session") {
                    return (StatusCode::UNAUTHORIZED, Bytes::new());
                }
                writes.fetch_add(1, Ordering::SeqCst);
                (StatusCode::OK, body)
            }),
        )
        .with_state(writes.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap()).parse().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (UiTransport::new(base).unwrap(), task, writes)
}
async fn response(ui: &UiTransport, id: &str) -> (u64, Vec<u8>) {
    let mut status = 0;
    let mut bytes = vec![];
    loop {
        let packet = ui.call(json!({"action":"read","id":id})).await.unwrap();
        assert!(!packet.to_string().contains("private-ui-session"), "Session cookie must stay private");
        match packet["type"].as_str().unwrap() {
            "headers" => status = packet["status"].as_u64().unwrap(),
            "data" => bytes.extend(STANDARD.decode(packet["data"].as_str().unwrap()).unwrap()),
            "end" => return (status, bytes),
            "pending" => {}
            other => panic!("Unexpected packet {other}: {packet}"),
        }
    }
}
#[tokio::test]
async fn streams_binary_uploads_and_responses_with_private_password_sessions_and_no_replay() {
    let (ui, server, writes) = fixture().await;
    let second = UiTransport::new(ui.base_url().clone()).unwrap();
    let login = ui.call(json!({"action":"open","path":"/api/auth/login","method":"POST"})).await.unwrap();
    assert_eq!(response(&ui, login["id"].as_str().unwrap()).await.0, 200);
    let id = ui.call(json!({"action":"open","path":"/api/echo","method":"POST","body":true})).await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let payload = vec![0, 255, 13, 10, 0, 128].repeat(10000);
    for chunk in payload.chunks(32000) {
        ui.call(json!({"action":"write","id":id,"data":STANDARD.encode(chunk)})).await.unwrap();
    }
    ui.call(json!({"action":"write","id":id,"end":true})).await.unwrap();
    let (status, output) = response(&ui, &id).await;
    assert_eq!(status, 200);
    assert_eq!(output, payload);
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert!(ui.call(json!({"action":"read","id":id})).await.is_err());
    let unauthed = second.call(json!({"action":"open","path":"/api/echo","method":"POST"})).await.unwrap();
    assert_eq!(response(&second, unauthed["id"].as_str().unwrap()).await.0, 401);
    ui.shutdown().await;
    second.shutdown().await;
    server.abort();
}
#[tokio::test]
async fn rejects_external_targets_path_traversal_header_injection_and_foreign_stream_ids() {
    let (ui, server, _) = fixture().await;
    for path in [
        "https://example.com/api/x",
        "//example.com/api/x",
        "/_codex/stop",
        "/mcp",
        "/api/../_codex/stop",
        "/api/%2e%2e/_codex/stop",
        "/api/x#fragment",
        "/api/\\evil",
        "/api/%2f..",
        "/api/%5c..",
        "/api/%00x",
    ] {
        assert!(ui.call(json!({"action":"open","path":path,"method":"GET"})).await.is_err(), "{path}");
    }
    assert!(ui.call(json!({"action":"open","path":"/api/auth/login","method":"CONNECT"})).await.is_err());
    assert!(ui.call(json!({"action":"open","path":"/api/auth/login","method":"POST","headers":{"Authorization":"Bearer injected"}})).await.is_err());
    assert!(ui.call(json!({"action":"read","id":"unknown"})).await.is_err());
    let id = ui.call(json!({"action":"open","path":"/api/auth/login","method":"POST"})).await.unwrap();
    ui.call(json!({"action":"close","id":id["id"]})).await.unwrap();
    assert!(ui.call(json!({"action":"read","id":id["id"]})).await.is_err());
    let safe = ui
        .call(json!({"action":"open","path":"/api/jdbc/drivers/%E4%B8%AD%E6%96%87%20driver.jar","method":"DELETE"}))
        .await
        .unwrap();
    ui.call(json!({"action":"close","id":safe["id"]})).await.unwrap();
    ui.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn exports_require_login_and_write_private_unique_files_without_path_control() {
    let (ui, server, _) = fixture().await;
    let directory = tempfile::tempdir().unwrap();
    let directory_path = directory.path().canonicalize().unwrap();
    let ui = ui.with_export_directory(directory_path.join("exports"));
    assert!(ui.call(json!({"action":"export_open","name":"report.csv"})).await.is_err());
    let login = ui.call(json!({"action":"open","path":"/api/auth/login","method":"POST"})).await.unwrap();
    response(&ui, login["id"].as_str().unwrap()).await;
    let opened = ui.call(json!({"action":"export_open","name":"../../report.csv"})).await.unwrap();
    let saved = ui
        .call(json!({"action":"export_write","id":opened["id"],"data":STANDARD.encode(b"a,b\n1,2\n"),"end":true}))
        .await
        .unwrap();
    let path = std::path::PathBuf::from(saved["path"].as_str().unwrap());
    assert_eq!(path.parent(), Some(directory_path.join("exports").as_path()));
    assert_eq!(std::fs::read(&path).unwrap(), b"a,b\n1,2\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(ui.call(json!({"action":"export_write","id":opened["id"],"end":true})).await.is_err());
    ui.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn websocket_messages_cross_multiple_bounded_packets_and_dispose_closes_streams() {
    use futures_util::{SinkExt, StreamExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ui = UiTransport::new(format!("http://{}/", listener.local_addr().unwrap()).parse().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        while let Some(Ok(message)) = socket.next().await {
            if message.is_text() || message.is_binary() {
                socket.send(message).await.unwrap();
            }
        }
    });
    let id = ui.call(json!({"action":"socket_open","path":"/api/redis/pubsub/ws"})).await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(ui.call(json!({"action":"read","id":id})).await.unwrap()["type"], "open");
    for text in [false, true] {
        let bytes = if text { "中文".repeat(30000).into_bytes() } else { vec![0, 255, 128].repeat(50000) };
        for (index, chunk) in bytes.chunks(65536).enumerate() {
            ui.call(json!({"action":"socket_send","id":id,"data":STANDARD.encode(chunk),"text":text,"end":(index+1)*65536>=bytes.len()})).await.unwrap();
        }
        let mut received = vec![];
        loop {
            let packet = ui.call(json!({"action":"read","id":id})).await.unwrap();
            assert_eq!(packet["type"], "socket_data");
            let chunk = STANDARD.decode(packet["data"].as_str().unwrap()).unwrap();
            assert!(chunk.len() <= 65536);
            received.extend(chunk);
            if packet["end"] == true {
                break;
            }
        }
        assert_eq!(received, bytes);
    }
    ui.call(json!({"action":"dispose"})).await.unwrap();
    assert!(ui.call(json!({"action":"read","id":id})).await.is_err());
    server.abort();
}
