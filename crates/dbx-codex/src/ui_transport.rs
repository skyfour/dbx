//! Private, bounded transport for the workbench UI. Never accepts a remote target or caller credentials.
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use url::Url;

const CHUNK: usize = 64 * 1024;
type Result<T> = std::result::Result<T, String>;
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Dispose,
    Open {
        path: String,
        method: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(default)]
        body: bool,
    },
    Write {
        id: String,
        #[serde(default)]
        data: String,
        #[serde(default)]
        end: bool,
    },
    Read {
        id: String,
    },
    Close {
        id: String,
    },
    ExportOpen {
        name: String,
    },
    ExportWrite {
        id: String,
        #[serde(default)]
        data: String,
        #[serde(default)]
        end: bool,
    },
    SocketOpen {
        path: String,
    },
    SocketSend {
        id: String,
        data: String,
        #[serde(default)]
        text: bool,
        #[serde(default)]
        end: bool,
    },
}
struct Job {
    incoming: Mutex<Option<mpsc::Sender<Message>>>,
    outgoing: Mutex<mpsc::Receiver<Value>>,
    task: tokio::task::JoinHandle<()>,
    socket: bool,
    message: Mutex<(Vec<u8>, Option<bool>)>,
}
pub struct UiTransport {
    base: Url,
    client: reqwest::Client,
    cookie: Arc<Mutex<Option<String>>>,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    export_dir: Option<PathBuf>,
    exports: Mutex<HashMap<String, (PathBuf, std::fs::File)>>,
}
impl UiTransport {
    pub fn new(base: Url) -> Result<Self> {
        if base.scheme() != "http"
            || base.host_str() != Some("127.0.0.1")
            || !base.username().is_empty()
            || base.password().is_some()
        {
            return Err("Workbench must be a private loopback service".into());
        }
        Ok(Self {
            base,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| "Cannot create UI transport")?,
            cookie: Default::default(),
            jobs: Default::default(),
            export_dir: None,
            exports: Default::default(),
        })
    }
    pub fn with_export_directory(mut self, directory: PathBuf) -> Self {
        self.export_dir = Some(directory);
        self
    }
    pub fn base_url(&self) -> &Url {
        &self.base
    }
    fn target(&self, path: &str) -> Result<Url> {
        let raw_path = path.split('?').next().unwrap_or("");
        if !raw_path.starts_with("/api/")
            || raw_path.contains(['\\', '#'])
            || raw_path.split('/').any(|segment| {
                percent_encoding::percent_decode_str(segment).decode_utf8().map_or(true, |decoded| {
                    decoded == "."
                        || decoded == ".."
                        || decoded.contains(['/', '\\'])
                        || decoded.chars().any(char::is_control)
                })
            })
            || path.contains('#')
        {
            return Err("Only DBX API paths are permitted".into());
        }
        let url = self.base.join(path).map_err(|_| "Invalid DBX API path")?;
        if url.origin() != self.base.origin() {
            return Err("Remote targets are forbidden".into());
        }
        Ok(url)
    }
    async fn job(&self, id: &str) -> Result<Arc<Job>> {
        self.jobs.lock().await.get(id).cloned().ok_or_else(|| "Unknown or completed UI stream".into())
    }
    pub async fn shutdown(&self) {
        for (_, job) in self.jobs.lock().await.drain() {
            job.task.abort();
        }
        for (_, (path, file)) in self.exports.lock().await.drain() {
            drop(file);
            let _ = std::fs::remove_file(path);
        }
        *self.cookie.lock().await = None;
    }
    pub async fn call(&self, value: Value) -> Result<Value> {
        let request: Request = serde_json::from_value(value).map_err(|_| "Invalid UI transport request")?;
        match request {
            Request::Dispose => {
                self.shutdown().await;
                Ok(json!({"ok":true}))
            }
            Request::Open { path, method, headers, body } => {
                let target = self.target(&path)?;
                if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD")
                    || (body && matches!(method.as_str(), "GET" | "HEAD"))
                {
                    return Err("Invalid HTTP method or body".into());
                }
                let mut request = self
                    .client
                    .request(method.parse::<reqwest::Method>().map_err(|_| "Invalid HTTP method")?, target)
                    .header("Origin", self.base.origin().ascii_serialization());
                for (key, value) in headers {
                    if !matches!(
                        key.to_ascii_lowercase().as_str(),
                        "content-type" | "accept" | "last-event-id" | "x-dbx-mcp-settings"
                    ) || value.contains(['\r', '\n'])
                    {
                        return Err("Unsupported UI request header".into());
                    }
                    request = request.header(key, value);
                }
                if let Some(cookie) = self.cookie.lock().await.as_ref() {
                    request = request.header("Cookie", cookie);
                }
                let mut jobs = self.jobs.lock().await;
                if jobs.len() >= 128 {
                    return Err("Too many active UI streams".into());
                }
                let (send, recv) = mpsc::channel::<Message>(4);
                if body {
                    let stream = futures_util::stream::unfold(recv, |mut recv| async {
                        match recv.recv().await {
                            Some(Message::Binary(data)) => Some((Ok::<_, std::io::Error>(data), recv)),
                            _ => None,
                        }
                    });
                    request = request.body(reqwest::Body::wrap_stream(stream));
                }
                let (outgoing, receiver) = mpsc::channel(4);
                let cookie = self.cookie.clone();
                let task = tokio::spawn(async move {
                    let result = async {
                        // reqwest has no request replay; lost responses never resubmit writes.
                        let mut response = request.send().await.map_err(|_| ())?;
                        if let Some(session) = response
                            .headers()
                            .get_all("set-cookie")
                            .iter()
                            .filter_map(|v| v.to_str().ok())
                            .find(|v| v.starts_with("dbx_session="))
                        {
                            let session = session.split(';').next().unwrap_or("").to_owned();
                            *cookie.lock().await = if session == "dbx_session=" { None } else { Some(session) };
                        }
                        let headers: HashMap<_, _> = response
                            .headers()
                            .iter()
                            .filter(|(name, _)| {
                                matches!(
                                    name.as_str(),
                                    "content-type" | "content-disposition" | "content-length" | "cache-control"
                                )
                            })
                            .filter_map(|(name, value)| {
                                value.to_str().ok().map(|value| (name.to_string(), value.to_owned()))
                            })
                            .collect();
                        outgoing
                            .send(json!({"type":"headers","status":response.status().as_u16(),"headers":headers}))
                            .await
                            .map_err(|_| ())?;
                        while let Some(data) = response.chunk().await.map_err(|_| ())? {
                            for chunk in data.chunks(CHUNK) {
                                outgoing
                                    .send(json!({"type":"data","data":STANDARD.encode(chunk)}))
                                    .await
                                    .map_err(|_| ())?;
                            }
                        }
                        outgoing.send(json!({"type":"end"})).await.map_err(|_| ())?;
                        Ok::<_, ()>(())
                    }
                    .await;
                    if result.is_err() {
                        let _ = outgoing
                            .send(json!({"type":"error","message":"DBX request failed; it was not retried"}))
                            .await;
                    }
                });
                let id = uuid::Uuid::new_v4().to_string();
                jobs.insert(
                    id.clone(),
                    Arc::new(Job {
                        incoming: Mutex::new(if body { Some(send) } else { None }),
                        outgoing: Mutex::new(receiver),
                        task,
                        socket: false,
                        message: Default::default(),
                    }),
                );
                Ok(json!({"id":id}))
            }
            Request::ExportOpen { name } => {
                if self.cookie.lock().await.is_none() {
                    return Err("Log in before exporting files".into());
                }
                let directory = self.export_dir.as_ref().ok_or("Export directory is not configured")?;
                let mut exports = self.exports.lock().await;
                if exports.len() >= 16 {
                    return Err("Too many active exports".into());
                }
                crate::runtime::private_dir(directory)?;
                let name: String =
                    name.chars().filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c)).take(120).collect();
                let name = name.trim_matches(['.', ' ']);
                let id = uuid::Uuid::new_v4().to_string();
                let path = directory.join(format!("{id}-{}", if name.is_empty() { "dbx-export.bin" } else { name }));
                let file = crate::runtime::private_file(&path, true)?;
                exports.insert(id.clone(), (path, file));
                Ok(json!({"id":id}))
            }
            Request::ExportWrite { id, data, end } => {
                let data = STANDARD.decode(data).map_err(|_| "Invalid export data")?;
                if data.len() > CHUNK {
                    return Err("Export chunk too large".into());
                }
                let mut exports = self.exports.lock().await;
                let (path, file) = exports.get_mut(&id).ok_or("Unknown export")?;
                file.write_all(&data).map_err(|_| "Cannot write export file")?;
                let result = if end {
                    file.sync_all().map_err(|_| "Cannot finish export file")?;
                    json!({"path":path})
                } else {
                    json!({"ok":true})
                };
                if end {
                    exports.remove(&id);
                }
                Ok(result)
            }
            Request::SocketOpen { path } => {
                let mut target = self.target(&path)?;
                if target.path() != "/api/redis/pubsub/ws" {
                    return Err("Unsupported DBX WebSocket".into());
                }
                target.set_scheme("ws").map_err(|_| "Invalid WebSocket URL")?;
                let mut request = target.as_str().into_client_request().map_err(|_| "Invalid WebSocket request")?;
                request
                    .headers_mut()
                    .insert("Origin", self.base.origin().ascii_serialization().parse().map_err(|_| "Invalid origin")?);
                if let Some(cookie) = self.cookie.lock().await.as_ref() {
                    request.headers_mut().insert("Cookie", cookie.parse().map_err(|_| "Invalid private session")?);
                }
                let mut jobs = self.jobs.lock().await;
                if jobs.len() >= 128 {
                    return Err("Too many active UI streams".into());
                }
                let (sender, mut incoming) = mpsc::channel::<Message>(4);
                let (outgoing, receiver) = mpsc::channel(4);
                let task = tokio::spawn(async move {
                    let result = async {
                        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), tokio_tungstenite::connect_async(request)).await.map_err(|_| ())?.map_err(|_| ())?;
                        outgoing.send(json!({"type":"open"})).await.map_err(|_| ())?;
                        loop {
                            tokio::select! {
                                message = incoming.recv() => match message { Some(message) => socket.send(message).await.map_err(|_| ())?, None => { let _ = socket.close(None).await; break; } },
                                message = socket.next() => match message {
                                    Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                                        let text = matches!(message, Message::Text(_));
                                        let data = message.into_data();
                                        if data.is_empty() { outgoing.send(json!({"type":"socket_data","data":"","text":text,"end":true})).await.map_err(|_| ())?; }
                                        for (index, chunk) in data.chunks(CHUNK).enumerate() {
                                            outgoing.send(json!({"type":"socket_data","data":STANDARD.encode(chunk),"text":text,"end":(index+1)*CHUNK >= data.len()})).await.map_err(|_| ())?;
                                        }
                                    },
                                    Some(Ok(Message::Close(frame))) => { outgoing.send(json!({"type":"close","code":frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1000),"reason":frame.map(|f|f.reason.to_string()).unwrap_or_default()})).await.map_err(|_| ())?; break; },
                                    None => { outgoing.send(json!({"type":"close","code":1006,"reason":""})).await.map_err(|_| ())?; break; },
                                    Some(Err(_)) => return Err(()),
                                    _ => {},
                                }
                            }
                        }
                        Ok::<_, ()>(())
                    }.await;
                    if result.is_err() {
                        let _ = outgoing.send(json!({"type":"error","message":"DBX WebSocket disconnected"})).await;
                    }
                });
                let id = uuid::Uuid::new_v4().to_string();
                jobs.insert(
                    id.clone(),
                    Arc::new(Job {
                        incoming: Mutex::new(Some(sender)),
                        outgoing: Mutex::new(receiver),
                        task,
                        socket: true,
                        message: Default::default(),
                    }),
                );
                Ok(json!({"id":id}))
            }
            Request::Write { id, data, end } => {
                let job = self.job(&id).await?;
                if job.socket {
                    return Err("Not an HTTP upload".into());
                }
                let bytes = STANDARD.decode(data).map_err(|_| "Invalid upload data")?;
                if bytes.len() > CHUNK {
                    return Err("UI upload chunk too large".into());
                }
                let mut input = job.incoming.lock().await;
                let sender = input.as_ref().ok_or("Upload already closed")?;
                if !bytes.is_empty() {
                    tokio::time::timeout(Duration::from_secs(20), sender.send(Message::Binary(bytes.into())))
                        .await
                        .map_err(|_| "Upload timed out; not retried")?
                        .map_err(|_| "Upload disconnected; not retried")?;
                }
                if end {
                    input.take();
                }
                Ok(json!({"ok":true}))
            }
            Request::SocketSend { id, text, data, end } => {
                let job = self.job(&id).await?;
                if !job.socket {
                    return Err("Not a WebSocket".into());
                }
                let bytes = STANDARD.decode(data).map_err(|_| "Invalid WebSocket data")?;
                if bytes.len() > CHUNK {
                    return Err("WebSocket chunk too large".into());
                }
                let mut buffered = job.message.lock().await;
                if buffered.1.is_some_and(|kind| kind != text) {
                    return Err("WebSocket message type changed".into());
                }
                // Match tungstenite's default maximum message size while keeping MCP chunks bounded.
                if buffered.0.len() + bytes.len() > 64 * 1024 * 1024 {
                    return Err("WebSocket message too large".into());
                }
                buffered.1 = Some(text);
                buffered.0.extend(bytes);
                if end {
                    let bytes = std::mem::take(&mut buffered.0);
                    buffered.1 = None;
                    let message = if text {
                        Message::Text(String::from_utf8(bytes).map_err(|_| "Invalid WebSocket text")?.into())
                    } else {
                        Message::Binary(bytes.into())
                    };
                    let input = job.incoming.lock().await;
                    tokio::time::timeout(
                        Duration::from_secs(20),
                        input.as_ref().ok_or("WebSocket closed")?.send(message),
                    )
                    .await
                    .map_err(|_| "WebSocket send timed out")?
                    .map_err(|_| "WebSocket closed")?;
                }
                Ok(json!({"ok":true}))
            }
            Request::Read { id } => {
                let job = self.job(&id).await?;
                let packet = match tokio::time::timeout(Duration::from_secs(15), job.outgoing.lock().await.recv()).await
                {
                    Ok(Some(packet)) => packet,
                    Ok(None) => json!({"type":"error","message":"DBX stream disconnected"}),
                    Err(_) => json!({"type":"pending"}),
                };
                if matches!(packet["type"].as_str(), Some("end" | "error" | "close")) {
                    self.jobs.lock().await.remove(&id);
                }
                Ok(packet)
            }
            Request::Close { id } => {
                if let Some(job) = self.jobs.lock().await.remove(&id) {
                    job.task.abort();
                }
                if let Some((path, file)) = self.exports.lock().await.remove(&id) {
                    drop(file);
                    let _ = std::fs::remove_file(path);
                }
                Ok(json!({"ok":true}))
            }
        }
    }
}
