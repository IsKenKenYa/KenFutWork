use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtySize {
    pub cols: i16,
    pub rows: i16,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub process_id: String,
    pub task_id: String,
    pub generation: u64,
    pub command: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub read_roots: Vec<String>,
    pub write_roots: Vec<String>,
    pub deny_roots: Vec<String>,
    pub yield_ms: u64,
    pub kill_grace_ms: u64,
    pub chunk_bytes: usize,
    pub live_streams: bool,
    pub pty: Option<PtySize>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "method", rename_all = "lowercase")]
pub enum Request {
    Probe {
        id: String,
    },
    Spawn {
        id: String,
        launch: Launch,
    },
    Stdin {
        id: String,
        #[serde(rename = "processId")]
        process_id: String,
        data: String,
    },
    Endstdin {
        id: String,
        #[serde(rename = "processId")]
        process_id: String,
    },
    Stop {
        id: String,
        #[serde(rename = "processId")]
        process_id: String,
    },
    Resize {
        id: String,
        #[serde(rename = "processId")]
        process_id: String,
        cols: i16,
        rows: i16,
    },
    Outputack {
        id: String,
        #[serde(rename = "processId")]
        process_id: String,
        stream: String,
        sequence: u64,
    },
    Outputreader {
        id: String,
        #[serde(rename = "processId")]
        process_id: String,
        stream: String,
        active: bool,
    },
    Close {
        id: String,
    },
}
