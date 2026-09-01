pub mod client;
pub mod decoder;
pub mod diff;

use base64::{engine::general_purpose, Engine as _};
use client::Ec2Client;
use decoder::decode_user_data;
use diff::display_diff;

#[derive(Debug)]
pub struct DiffConfig {
    pub region: String,
    pub template_name: Option<String>,
    pub template_id: Option<String>,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub use_color: bool,
}

#[derive(Debug)]
pub enum DiffError {
    AwsError(String),
    DecodingError(String),
    NotFound(String),
    InvalidVersion(String),
}

impl std::fmt::Display for DiffError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DiffError::AwsError(msg) => write!(f, "AWS Error: {}", msg),
            DiffError::DecodingError(msg) => write!(f, "Decoding Error: {}", msg),
            DiffError::NotFound(msg) => write!(f, "Not Found: {}", msg),
            DiffError::InvalidVersion(msg) => write!(f, "Invalid Version: {}", msg),
        }
    }
}

impl std::error::Error for DiffError {}

pub async fn diff_launch_template_user_data(
    client: &dyn Ec2Client,
    config: &DiffConfig,
) -> Result<(), DiffError> {
    let (template_id, versions) = if let Some(name) = &config.template_name {
        let template = client.get_launch_template_by_name(name).await?;
        let template_id = template.launch_template_id.ok_or_else(|| {
            DiffError::NotFound(format!("Launch template ID not found for name: {}", name))
        })?;
        let versions = client.list_launch_template_versions(&template_id).await?;
        (template_id, versions)
    } else if let Some(id) = &config.template_id {
        let versions = client.list_launch_template_versions(id).await?;
        (id.clone(), versions)
    } else {
        return Err(DiffError::InvalidVersion(
            "No template specified".to_string(),
        ));
    };

    let (from_version, to_version) =
        resolve_versions(&versions, &config.from_version, &config.to_version)?;

    let from_data = client
        .get_launch_template_version(&template_id, &from_version)
        .await?;
    let to_data = client
        .get_launch_template_version(&template_id, &to_version)
        .await?;

    let from_user_data = from_data
        .launch_template_data
        .and_then(|d| d.user_data)
        .unwrap_or_default();
    let to_user_data = to_data
        .launch_template_data
        .and_then(|d| d.user_data)
        .unwrap_or_default();

    let from_decoded = decode_user_data(&from_user_data)?;
    let to_decoded = decode_user_data(&to_user_data)?;

    println!(
        "Comparing launch template '{}' versions {} → {}",
        config.template_name.as_ref().unwrap_or(&template_id),
        from_version,
        to_version
    );
    println!();

    // If decoded content is identical, also check if encoding differs
    if from_decoded == to_decoded {
        if from_user_data != to_user_data {
            println!("User data content is identical, but encoding differs:");
            println!();
            println!("Version {} encoding method:", from_version);
            if is_likely_gzip_compressed(&from_user_data) {
                println!("  Base64 + Gzip compression");
            } else {
                println!("  Plain Base64 encoding");
            }
            println!();
            println!("Version {} encoding method:", to_version);
            if is_likely_gzip_compressed(&to_user_data) {
                println!("  Base64 + Gzip compression");
            } else {
                println!("  Plain Base64 encoding");
            }
            println!();
            println!("Decoded content (identical):");
            display_diff(&from_decoded, &to_decoded, config.use_color);
        } else {
            display_diff(&from_decoded, &to_decoded, config.use_color);
        }
    } else {
        display_diff(&from_decoded, &to_decoded, config.use_color);
    }

    Ok(())
}

fn resolve_versions(
    versions: &[aws_sdk_ec2::types::LaunchTemplateVersion],
    from_version: &Option<String>,
    to_version: &Option<String>,
) -> Result<(String, String), DiffError> {
    let sorted_versions: Vec<_> = {
        let mut v = versions.iter().collect::<Vec<_>>();
        v.sort_by_key(|version| version.version_number.unwrap_or(0));
        v
    };

    if sorted_versions.is_empty() {
        return Err(DiffError::NotFound("No versions found".to_string()));
    }

    let to_ver = match to_version {
        Some(v) => v.clone(),
        None => sorted_versions
            .last()
            .unwrap()
            .version_number
            .unwrap()
            .to_string(),
    };

    let from_ver = match from_version {
        Some(v) => v.clone(),
        None => {
            if sorted_versions.len() < 2 {
                return Err(DiffError::InvalidVersion(
                    "Need at least 2 versions to compare".to_string(),
                ));
            }
            sorted_versions[sorted_versions.len() - 2]
                .version_number
                .unwrap()
                .to_string()
        }
    };

    Ok((from_ver, to_ver))
}

fn is_likely_gzip_compressed(base64_data: &str) -> bool {
    if base64_data.is_empty() {
        return false;
    }

    if let Ok(decoded_bytes) = general_purpose::STANDARD.decode(base64_data) {
        decoded_bytes.len() >= 2 && decoded_bytes[0] == 0x1f && decoded_bytes[1] == 0x8b
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ec2::types::{LaunchTemplate, LaunchTemplateVersion, ResponseLaunchTemplateData};
    use mockall::predicate::*;

    mockall::mock! {
        TestEc2Client {}

        #[async_trait::async_trait]
        impl Ec2Client for TestEc2Client {
            async fn get_launch_template_by_name(&self, name: &str) -> Result<LaunchTemplate, DiffError>;
            async fn list_launch_template_versions(&self, template_id: &str) -> Result<Vec<LaunchTemplateVersion>, DiffError>;
            async fn get_launch_template_version(&self, template_id: &str, version: &str) -> Result<LaunchTemplateVersion, DiffError>;
        }
    }

    #[test]
    fn test_resolve_versions_with_defaults() {
        let versions = vec![
            LaunchTemplateVersion::builder().version_number(1).build(),
            LaunchTemplateVersion::builder().version_number(2).build(),
            LaunchTemplateVersion::builder().version_number(3).build(),
        ];

        let (from, to) = resolve_versions(&versions, &None, &None).unwrap();
        assert_eq!(from, "2");
        assert_eq!(to, "3");
    }

    #[test]
    fn test_resolve_versions_with_specific_versions() {
        let versions = vec![
            LaunchTemplateVersion::builder().version_number(1).build(),
            LaunchTemplateVersion::builder().version_number(2).build(),
            LaunchTemplateVersion::builder().version_number(3).build(),
        ];

        let (from, to) =
            resolve_versions(&versions, &Some("1".to_string()), &Some("3".to_string())).unwrap();
        assert_eq!(from, "1");
        assert_eq!(to, "3");
    }

    #[test]
    fn test_resolve_versions_insufficient_versions() {
        let versions = vec![LaunchTemplateVersion::builder().version_number(1).build()];

        let result = resolve_versions(&versions, &None, &None);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), DiffError::InvalidVersion(_)));
    }
}
