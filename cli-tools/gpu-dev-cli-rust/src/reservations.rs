use anyhow::Result;
use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_sqs::Client as SqsClient;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

use crate::config::Config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reservation {
    pub reservation_id: String,
    pub user_id: String,
    pub gpu_count: u8,
    pub status: String,
    pub created_at: Option<String>,
    pub expires_at: Option<String>,
    pub pod_name: Option<String>,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    pub reservation_id: String,
    pub pod_name: String,
    pub namespace: String,
    pub gpu_count: u8,
    pub ssh_command: String,
}

#[derive(Debug, Clone)]
pub struct ClusterStatus {
    pub total_gpus: u32,
    pub available_gpus: u32,
    pub reserved_gpus: u32,
    pub active_reservations: u32,
    pub queue_length: u32,
}

pub struct ReservationManager {
    config: Config,
    sqs_client: SqsClient,
    dynamo_client: DynamoClient,
}

impl ReservationManager {
    pub fn new(config: Config) -> Self {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (sqs_client, dynamo_client) = rt.block_on(async {
            let aws_config = aws_config::defaults(BehaviorVersion::latest())
                .region(&config.aws_region)
                .load()
                .await;
            
            let sqs = SqsClient::new(&aws_config);
            let dynamo = DynamoClient::new(&aws_config);
            (sqs, dynamo)
        });
        
        Self {
            config,
            sqs_client,
            dynamo_client,
        }
    }
    
    pub async fn create_reservation(
        &self,
        user_id: &str,
        gpu_count: u8,
        duration_hours: u8,
        name: Option<String>,
    ) -> Result<Option<String>> {
        let request_id = Uuid::new_v4().to_string();
        
        let mut reservation_request = json!({
            "user_id": user_id,
            "gpu_count": gpu_count,
            "duration_hours": duration_hours,
            "timestamp": Utc::now().to_rfc3339(),
            "request_id": request_id
        });
        
        if let Some(name) = name {
            reservation_request["name"] = json!(name);
        }
        
        self.sqs_client
            .send_message()
            .queue_url(&self.config.queue_url)
            .message_body(reservation_request.to_string())
            .send()
            .await?;
        
        Ok(Some(request_id))
    }
    
    pub async fn list_reservations(
        &self,
        user_filter: Option<String>,
        status_filter: Option<String>,
    ) -> Result<Vec<Reservation>> {
        let mut reservations = Vec::new();
        
        let result = if let Some(user) = user_filter {
            // Query by user using GSI
            self.dynamo_client
                .query()
                .table_name(&self.config.reservations_table)
                .index_name("UserIndex")
                .key_condition_expression("user_id = :user_id")
                .expression_attribute_values(":user_id", AttributeValue::S(user))
                .send()
                .await?
        } else {
            // Scan all reservations
            self.dynamo_client
                .scan()
                .table_name(&self.config.reservations_table)
                .send()
                .await?
        };
        
        if let Some(items) = result.items {
            for item in items {
                let reservation = self.parse_reservation_item(item)?;
                
                // Apply status filter if specified
                if let Some(ref status) = status_filter {
                    if reservation.status != *status {
                        continue;
                    }
                }
                
                reservations.push(reservation);
            }
        }
        
        // Sort by creation time (newest first)
        reservations.sort_by(|a, b| {
            b.created_at
                .as_ref()
                .unwrap_or(&String::new())
                .cmp(a.created_at.as_ref().unwrap_or(&String::new()))
        });
        
        Ok(reservations)
    }
    
    pub async fn cancel_reservation(&self, reservation_id: &str, user_id: &str) -> Result<bool> {
        // Get the reservation first
        let result = self
            .dynamo_client
            .get_item()
            .table_name(&self.config.reservations_table)
            .key("reservation_id", AttributeValue::S(reservation_id.to_string()))
            .send()
            .await?;
        
        let item = match result.item {
            Some(item) => item,
            None => {
                eprintln!("Reservation {} not found", reservation_id);
                return Ok(false);
            }
        };
        
        // Check if user owns the reservation
        let reservation_user = item
            .get("user_id")
            .and_then(|v| v.as_s().ok())
            .unwrap_or("");
        
        if reservation_user != user_id {
            eprintln!("You don't have permission to cancel this reservation");
            return Ok(false);
        }
        
        // Update status to cancelled
        self.dynamo_client
            .update_item()
            .table_name(&self.config.reservations_table)
            .key("reservation_id", AttributeValue::S(reservation_id.to_string()))
            .update_expression("SET #status = :status, cancelled_at = :cancelled_at")
            .expression_attribute_names("#status", "status")
            .expression_attribute_values(":status", AttributeValue::S("cancelled".to_string()))
            .expression_attribute_values(":cancelled_at", AttributeValue::S(Utc::now().to_rfc3339()))
            .send()
            .await?;
        
        Ok(true)
    }
    
    pub async fn get_connection_info(
        &self,
        reservation_id: &str,
        user_id: &str,
    ) -> Result<Option<ConnectionInfo>> {
        // Get the reservation
        let result = self
            .dynamo_client
            .get_item()
            .table_name(&self.config.reservations_table)
            .key("reservation_id", AttributeValue::S(reservation_id.to_string()))
            .send()
            .await?;
        
        let item = match result.item {
            Some(item) => item,
            None => {
                eprintln!("Reservation {} not found", reservation_id);
                return Ok(None);
            }
        };
        
        // Check if user owns the reservation
        let reservation_user = item
            .get("user_id")
            .and_then(|v| v.as_s().ok())
            .unwrap_or("");
        
        if reservation_user != user_id {
            eprintln!("You don't have permission to access this reservation");
            return Ok(None);
        }
        
        // Check if reservation is active
        let status = item
            .get("status")
            .and_then(|v| v.as_s().ok())
            .unwrap_or("");
        
        if status != "active" {
            eprintln!("Reservation is not active (status: {})", status);
            return Ok(None);
        }
        
        // Build connection info
        let pod_name = item
            .get("pod_name")
            .and_then(|v| v.as_s().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("gpu-dev-{}", &reservation_id[..8]));
        
        let namespace = item
            .get("namespace")
            .and_then(|v| v.as_s().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "gpu-dev".to_string());
        
        let gpu_count = item
            .get("gpu_count")
            .and_then(|v| v.as_n().ok())
            .and_then(|n| n.parse::<u8>().ok())
            .unwrap_or(1);
        
        let ssh_command = format!("kubectl exec -it {} -n {} -- /bin/bash", pod_name, namespace);
        
        Ok(Some(ConnectionInfo {
            reservation_id: reservation_id.to_string(),
            pod_name,
            namespace,
            gpu_count,
            ssh_command,
        }))
    }
    
    pub async fn get_cluster_status(&self) -> Result<Option<ClusterStatus>> {
        // Get server status
        let servers_result = self
            .dynamo_client
            .scan()
            .table_name(&self.config.servers_table)
            .send()
            .await?;
        
        let mut total_gpus = 0u32;
        let mut available_gpus = 0u32;
        
        if let Some(items) = servers_result.items {
            for item in items {
                let server_total = item
                    .get("total_gpus")
                    .and_then(|v| v.as_n().ok())
                    .and_then(|n| n.parse::<u32>().ok())
                    .unwrap_or(8); // Default 8 GPUs per p5.48xlarge
                
                let server_available = item
                    .get("available_gpus")
                    .and_then(|v| v.as_n().ok())
                    .and_then(|n| n.parse::<u32>().ok())
                    .unwrap_or(0);
                
                total_gpus += server_total;
                available_gpus += server_available;
            }
        }
        
        // Get active reservations count
        let reservations_result = self
            .dynamo_client
            .query()
            .table_name(&self.config.reservations_table)
            .index_name("StatusIndex")
            .key_condition_expression("#status = :status")
            .expression_attribute_names("#status", "status")
            .expression_attribute_values(":status", AttributeValue::S("active".to_string()))
            .send()
            .await?;
        
        let active_reservations = reservations_result.count.unwrap_or(0) as u32;
        let reserved_gpus = total_gpus - available_gpus;
        
        // Get queue length
        let queue_attrs = self
            .sqs_client
            .get_queue_attributes()
            .queue_url(&self.config.queue_url)
            .attribute_names(aws_sdk_sqs::types::QueueAttributeName::ApproximateNumberOfMessages)
            .send()
            .await?;
        
        let queue_length = queue_attrs
            .attributes
            .and_then(|attrs| attrs.get(&aws_sdk_sqs::types::QueueAttributeName::ApproximateNumberOfMessages))
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        
        Ok(Some(ClusterStatus {
            total_gpus,
            available_gpus,
            reserved_gpus,
            active_reservations,
            queue_length,
        }))
    }
    
    fn parse_reservation_item(&self, item: HashMap<String, AttributeValue>) -> Result<Reservation> {
        let reservation_id = item
            .get("reservation_id")
            .and_then(|v| v.as_s().ok())
            .unwrap_or("")
            .to_string();
        
        let user_id = item
            .get("user_id")
            .and_then(|v| v.as_s().ok())
            .unwrap_or("")
            .to_string();
        
        let gpu_count = item
            .get("gpu_count")
            .and_then(|v| v.as_n().ok())
            .and_then(|n| n.parse::<u8>().ok())
            .unwrap_or(1);
        
        let status = item
            .get("status")
            .and_then(|v| v.as_s().ok())
            .unwrap_or("")
            .to_string();
        
        let created_at = item
            .get("created_at")
            .and_then(|v| v.as_s().ok())
            .map(|s| s.to_string());
        
        let expires_at = item
            .get("expires_at")
            .and_then(|v| v.as_n().ok())
            .map(|s| s.to_string());
        
        let pod_name = item
            .get("pod_name")
            .and_then(|v| v.as_s().ok())
            .map(|s| s.to_string());
        
        let namespace = item
            .get("namespace")
            .and_then(|v| v.as_s().ok())
            .map(|s| s.to_string());
        
        Ok(Reservation {
            reservation_id,
            user_id,
            gpu_count,
            status,
            created_at,
            expires_at,
            pod_name,
            namespace,
        })
    }
}