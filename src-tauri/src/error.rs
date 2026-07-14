use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum OrquestaError {
    #[error("PTY error: {0}")]
    Pty(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("IO error: {0}")]
    Io(String),

    #[error("Network error: {0}")]
    Network(String),

    #[error("Spawn error: {0}")]
    Spawn(String),

    #[error("{0}")]
    Generic(String),
}

impl From<std::io::Error> for OrquestaError {
    fn from(e: std::io::Error) -> Self {
        OrquestaError::Io(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, OrquestaError>;

// Convert OrquestaError to String for Tauri command returns
impl From<OrquestaError> for String {
    fn from(e: OrquestaError) -> Self {
        e.to_string()
    }
}
