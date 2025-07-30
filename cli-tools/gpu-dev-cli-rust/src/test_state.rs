use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

use crate::reservations::{ClusterStatus, ConnectionInfo, Reservation};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Server {
    server_id: String,
    status: String,
    total_gpus: u32,
    available_gpus: u32,
    allocated_gpus: u32,
    instance_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TestState {
    reservations: Vec<TestReservation>,
    servers: Vec<Server>,
    queue: Vec<serde_json::Value>,
    settings: TestSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TestReservation {
    reservation_id: String,
    user_id: String,
    gpu_count: u8,
    status: String,
    created_at: String,
    expires_at: String,
    duration_hours: u8,
    pod_name: String,
    namespace: String,
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TestSettings {
    total_gpus: u32,
    max_reservation_hours: u8,
    default_timeout_hours: u8,
}

pub struct TestStateManager {
    state_file: PathBuf,
}

impl TestStateManager {
    pub fn new() -> Result<Self> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?
            .join("gpu-dev-cli");
        
        fs::create_dir_all(&config_dir)?;
        let state_file = config_dir.join("test_state.json");
        
        let manager = Self { state_file };
        manager.init_state()?;
        
        Ok(manager)
    }
    
    fn init_state(&self) -> Result<()> {
        if !self.state_file.exists() {
            let initial_state = TestState {
                reservations: Vec::new(),
                servers: vec![
                    Server {
                        server_id: "test-server-1".to_string(),
                        status: "available".to_string(),
                        total_gpus: 4,
                        available_gpus: 4,
                        allocated_gpus: 0,
                        instance_type: "g5.2xlarge".to_string(),
                    },
                    Server {
                        server_id: "test-server-2".to_string(),
                        status: "available".to_string(),
                        total_gpus: 4,
                        available_gpus: 4,
                        allocated_gpus: 0,
                        instance_type: "g5.2xlarge".to_string(),
                    },
                ],
                queue: Vec::new(),
                settings: TestSettings {
                    total_gpus: 8,
                    max_reservation_hours: 24,
                    default_timeout_hours: 8,
                },
            };
            
            self.save_state(&initial_state)?;
        }
        
        Ok(())
    }
    
    fn load_state(&self) -> Result<TestState> {
        let content = fs::read_to_string(&self.state_file)?;
        let state: TestState = serde_json::from_str(&content)?;
        Ok(state)
    }
    
    fn save_state(&self, state: &TestState) -> Result<()> {
        let content = serde_json::to_string_pretty(state)?;
        fs::write(&self.state_file, content)?;
        Ok(())
    }
    
    pub fn create_reservation(
        &self,
        user_id: &str,
        gpu_count: u8,
        duration_hours: u8,
        name: Option<String>,
    ) -> Result<Option<String>> {
        let mut state = self.load_state()?;
        
        // Check availability
        let available_gpus: u32 = state.servers.iter().map(|s| s.available_gpus).sum();
        if available_gpus < gpu_count as u32 {
            println!(
                "❌ Insufficient GPUs. Requested: {}, Available: {}",
                gpu_count, available_gpus
            );
            return Ok(None);
        }
        
        // Create reservation
        let reservation_id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let expires_at = now + Duration::hours(duration_hours as i64);
        
        let reservation = TestReservation {
            reservation_id: reservation_id.clone(),
            user_id: user_id.to_string(),
            gpu_count,
            status: "active".to_string(),
            created_at: now.to_rfc3339(),
            expires_at: expires_at.to_rfc3339(),
            duration_hours,
            pod_name: format!("gpu-dev-{}", &reservation_id[..8]),
            namespace: "gpu-dev".to_string(),
            name,
        };
        
        // Allocate GPUs from servers
        let mut remaining_gpus = gpu_count as u32;
        for server in &mut state.servers {
            if remaining_gpus == 0 {
                break;
            }
            
            if server.available_gpus > 0 {
                let allocated = remaining_gpus.min(server.available_gpus);
                server.available_gpus -= allocated;
                server.allocated_gpus += allocated;
                remaining_gpus -= allocated;
            }
        }
        
        state.reservations.push(reservation);
        self.save_state(&state)?;
        
        Ok(Some(reservation_id))
    }
    
    pub fn list_reservations(
        &self,
        user_filter: Option<String>,
        status_filter: Option<String>,
    ) -> Result<Vec<Reservation>> {
        let state = self.load_state()?;
        let mut reservations: Vec<Reservation> = state
            .reservations
            .into_iter()
            .filter(|r| {
                if let Some(ref user) = user_filter {
                    if r.user_id != *user {
                        return false;
                    }
                }
                
                if let Some(ref status) = status_filter {
                    if r.status != *status {
                        return false;
                    }
                }
                
                true
            })
            .map(|r| Reservation {
                reservation_id: r.reservation_id,
                user_id: r.user_id,
                gpu_count: r.gpu_count,
                status: r.status,
                created_at: Some(r.created_at),
                expires_at: Some(r.expires_at),
                pod_name: Some(r.pod_name),
                namespace: Some(r.namespace),
            })
            .collect();
        
        // Sort by creation time (newest first)
        reservations.sort_by(|a, b| {
            b.created_at
                .as_ref()
                .unwrap_or(&String::new())
                .cmp(a.created_at.as_ref().unwrap_or(&String::new()))
        });
        
        Ok(reservations)
    }
    
    pub fn cancel_reservation(&self, reservation_id: &str, user_id: &str) -> Result<bool> {
        let mut state = self.load_state()?;
        
        // Find reservation
        let reservation_pos = state
            .reservations
            .iter()
            .position(|r| r.reservation_id == reservation_id);
        
        let reservation_pos = match reservation_pos {
            Some(pos) => pos,
            None => {
                println!("❌ Reservation {} not found", reservation_id);
                return Ok(false);
            }
        };
        
        let reservation = &state.reservations[reservation_pos];
        
        if reservation.user_id != user_id {
            println!("❌ You don't have permission to cancel this reservation");
            return Ok(false);
        }
        
        // Update status
        let gpu_count = reservation.gpu_count as u32;
        state.reservations[reservation_pos].status = "cancelled".to_string();
        
        // Free up GPUs
        let mut remaining_gpus = gpu_count;
        for server in &mut state.servers {
            if remaining_gpus == 0 {
                break;
            }
            
            if server.allocated_gpus > 0 {
                let freed = remaining_gpus.min(server.allocated_gpus);
                server.allocated_gpus -= freed;
                server.available_gpus += freed;
                remaining_gpus -= freed;
            }
        }
        
        self.save_state(&state)?;
        Ok(true)
    }
    
    pub fn get_connection_info(
        &self,
        reservation_id: &str,
        user_id: &str,
    ) -> Result<Option<ConnectionInfo>> {
        let state = self.load_state()?;
        
        // Find reservation
        let reservation = state
            .reservations
            .iter()
            .find(|r| r.reservation_id == reservation_id);
        
        let reservation = match reservation {
            Some(r) => r,
            None => {
                println!("❌ Reservation {} not found", reservation_id);
                return Ok(None);
            }
        };
        
        if reservation.user_id != user_id {
            println!("❌ You don't have permission to access this reservation");
            return Ok(None);
        }
        
        if reservation.status != "active" {
            println!(
                "❌ Reservation is not active (status: {})",
                reservation.status
            );
            return Ok(None);
        }
        
        Ok(Some(ConnectionInfo {
            reservation_id: reservation_id.to_string(),
            pod_name: reservation.pod_name.clone(),
            namespace: reservation.namespace.clone(),
            gpu_count: reservation.gpu_count,
            ssh_command: format!(
                "[TEST] kubectl exec -it {} -n {} -- /bin/bash",
                reservation.pod_name, reservation.namespace
            ),
        }))
    }
    
    pub fn get_cluster_status(&self) -> Result<ClusterStatus> {
        let state = self.load_state()?;
        
        let total_gpus: u32 = state.servers.iter().map(|s| s.total_gpus).sum();
        let available_gpus: u32 = state.servers.iter().map(|s| s.available_gpus).sum();
        let reserved_gpus = total_gpus - available_gpus;
        
        let active_reservations = state
            .reservations
            .iter()
            .filter(|r| r.status == "active")
            .count() as u32;
        
        let queue_length = state.queue.len() as u32;
        
        Ok(ClusterStatus {
            total_gpus,
            available_gpus,
            reserved_gpus,
            active_reservations,
            queue_length,
        })
    }
    
    pub fn reset_state(&self) -> Result<()> {
        if self.state_file.exists() {
            fs::remove_file(&self.state_file)?;
        }
        self.init_state()?;
        println!("✅ Test state reset to defaults");
        Ok(())
    }
}