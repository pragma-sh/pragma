use serde::{Deserialize, Serialize};

/// Request sent from the app to the daemon over the Unix socket.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
    Spawn {
        session_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    },
    Attach {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Write {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        session_id: String,
    },
    Ping,
}

/// Response sent from the daemon to the app over the Unix socket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Response {
    Ok,
    Error {
        message: String,
    },
    Output {
        session_id: String,
        data: String,
    },
    Scrollback {
        session_id: String,
        data: String,
    },
    Exit {
        session_id: String,
        code: Option<i32>,
    },
}

/// Write a length-prefixed JSON frame to a writer.
///
/// Format: 4 bytes big-endian length, followed by the UTF-8 JSON payload.
pub fn write_frame<W: std::io::Write, T: serde::Serialize>(
    writer: &mut W,
    value: &T,
) -> std::io::Result<()> {
    let json = serde_json::to_string(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let len = json.len() as u32;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(json.as_bytes())?;
    writer.flush()?;
    Ok(())
}

/// Read a length-prefixed JSON frame from a reader as a Request.
pub fn read_request<R: std::io::Read>(reader: &mut R) -> std::io::Result<Request> {
    read_frame_value(reader)
}

/// Read a length-prefixed JSON frame from a reader as a Response.
pub fn read_response<R: std::io::Read>(reader: &mut R) -> std::io::Result<Response> {
    read_frame_value(reader)
}

fn read_frame_value<R: std::io::Read, T: serde::de::DeserializeOwned>(
    reader: &mut R,
) -> std::io::Result<T> {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf) as usize;

    let mut json_buf = vec![0u8; len];
    reader.read_exact(&mut json_buf)?;
    let json = std::str::from_utf8(&json_buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    serde_json::from_str(json).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}
