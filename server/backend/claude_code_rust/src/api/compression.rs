//! API客户端压缩处理

use std::io::{self, Write};
use flate2::{Compression, write::GzEncoder};

/// 压缩类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionType {
    None,
    Gzip,
    Deflate,
}

impl CompressionType {
    pub fn as_str(&self) -> Option<&'static str> {
        match self {
            CompressionType::None => None,
            CompressionType::Gzip => Some("gzip"),
            CompressionType::Deflate => Some("deflate"),
        }
    }
}

/// 压缩数据
pub fn compress_data(data: &[u8], compression_type: CompressionType) -> io::Result<Vec<u8>> {
    match compression_type {
        CompressionType::None => Ok(data.to_vec()),
        CompressionType::Gzip => {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(data)?;
            encoder.finish()
        }
        CompressionType::Deflate => {
            // 实现Deflate压缩
            let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(data)?;
            encoder.finish()
        }
    }
}

/// 获取压缩类型
pub fn get_compression_type(accept_encoding: Option<&str>) -> CompressionType {
    if let Some(encoding) = accept_encoding {
        if encoding.contains("gzip") {
            return CompressionType::Gzip;
        } else if encoding.contains("deflate") {
            return CompressionType::Deflate;
        }
    }
    CompressionType::None
}