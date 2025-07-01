use crate::DiffError;
use base64::{engine::general_purpose, Engine as _};
use flate2::read::GzDecoder;
use std::io::Read;

pub fn decode_user_data(encoded_data: &str) -> Result<String, DiffError> {
    if encoded_data.is_empty() {
        return Ok(String::new());
    }

    let decoded_bytes = general_purpose::STANDARD
        .decode(encoded_data)
        .map_err(|e| DiffError::DecodingError(format!("Base64 decode failed: {}", e)))?;

    if is_gzip_compressed(&decoded_bytes) {
        decode_gzip(&decoded_bytes)
    } else {
        String::from_utf8(decoded_bytes)
            .map_err(|e| DiffError::DecodingError(format!("UTF-8 decode failed: {}", e)))
    }
}

fn is_gzip_compressed(data: &[u8]) -> bool {
    data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b
}

fn decode_gzip(compressed_data: &[u8]) -> Result<String, DiffError> {
    let mut decoder = GzDecoder::new(compressed_data);
    let mut decompressed = String::new();

    decoder
        .read_to_string(&mut decompressed)
        .map_err(|e| DiffError::DecodingError(format!("Gzip decompression failed: {}", e)))?;

    Ok(decompressed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    #[test]
    fn test_decode_plain_base64() {
        let plain_text = "#!/bin/bash\necho 'Hello World'";
        let encoded = general_purpose::STANDARD.encode(plain_text);

        let result = decode_user_data(&encoded).unwrap();
        assert_eq!(result, plain_text);
    }

    #[test]
    fn test_decode_gzip_base64() {
        let plain_text = "#!/bin/bash\necho 'Hello World'";

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(plain_text.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();

        let encoded = general_purpose::STANDARD.encode(&compressed);

        let result = decode_user_data(&encoded).unwrap();
        assert_eq!(result, plain_text);
    }

    #[test]
    fn test_decode_empty() {
        let result = decode_user_data("").unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn test_gzip_detection() {
        let gzip_header = vec![0x1f, 0x8b, 0x08, 0x00];
        assert!(is_gzip_compressed(&gzip_header));

        let not_gzip = vec![0x00, 0x01, 0x02, 0x03];
        assert!(!is_gzip_compressed(&not_gzip));

        let too_short = vec![0x1f];
        assert!(!is_gzip_compressed(&too_short));
    }
}
