//! 单测共享夹具：本地 HTTP/1.1 测试服务与代理快照样例（仅 `cfg(test)` 编译）。

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 测试服务的一次回复。
pub(crate) struct Reply {
    status: &'static str,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl Reply {
    pub(crate) fn status(status: &'static str) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub(crate) fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self::status("200 OK").body(body)
    }

    pub(crate) fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }

    pub(crate) fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    fn encode(&self) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {}\r\n", self.status);
        for (k, v) in &self.headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            self.body.len()
        ));
        let mut out = head.into_bytes();
        out.extend_from_slice(&self.body);
        out
    }
}

/// 运行中的本地测试服务：`base` 形如 `http://127.0.0.1:port`，记录每次请求的原始报文。
pub(crate) struct TestServer {
    pub(crate) base: String,
    requests: Arc<Mutex<Vec<String>>>,
}

impl TestServer {
    /// 已收到的请求原文（请求行 + 头）。
    pub(crate) fn requests(&self) -> Vec<String> {
        self.requests.lock().map(|r| r.clone()).unwrap_or_default()
    }

    pub(crate) fn hits(&self) -> usize {
        self.requests().len()
    }
}

/// 启动本地测试服务：每个连接读一次请求，交给 `handler` 生成回复后关闭连接。
pub(crate) async fn serve<F>(handler: F) -> TestServer
where
    F: Fn(&str) -> Reply + Send + Sync + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            if let Ok(mut r) = seen.lock() {
                r.push(req.clone());
            }
            let _ = sock.write_all(&handler(&req).encode()).await;
        }
    });
    TestServer {
        base: format!("http://{addr}"),
        requests,
    }
}

/// 绑定后立即释放的本地端口：连接必然被拒（传输错误样例）。
pub(crate) fn dead_addr() -> SocketAddr {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
}

/// 常用代理快照样例：http/https 均指向 `url`，来源为 Windows 注册表。
pub(crate) fn proxied_snapshot(url: &str) -> crate::proxy::ProxySnapshot {
    crate::proxy::ProxySnapshot {
        http: Some(url.to_string()),
        https: Some(url.to_string()),
        all: None,
        no_proxy_entries: Vec::new(),
        source: crate::proxy::ProxySource::Windows,
    }
}
