"""Test state management for GPU Dev CLI"""

import json
import uuid
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from pathlib import Path

class TestStateManager:
    """Manages dummy state for testing CLI functionality"""
    
    def __init__(self):
        self.state_file = Path.home() / ".config" / "gpu-dev-cli" / "test_state.json"
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self._init_state()
    
    def _init_state(self) -> None:
        """Initialize test state if it doesn't exist"""
        if not self.state_file.exists():
            initial_state = {
                "reservations": [],
                "servers": [
                    {
                        "server_id": "test-server-1",
                        "status": "available",
                        "total_gpus": 4,
                        "available_gpus": 4,
                        "allocated_gpus": 0,
                        "instance_type": "g5.2xlarge"
                    },
                    {
                        "server_id": "test-server-2", 
                        "status": "available",
                        "total_gpus": 4,
                        "available_gpus": 4,
                        "allocated_gpus": 0,
                        "instance_type": "g5.2xlarge"
                    }
                ],
                "queue": [],
                "settings": {
                    "total_gpus": 8,
                    "max_reservation_hours": 24,
                    "default_timeout_hours": 8
                }
            }
            self._save_state(initial_state)
    
    def _load_state(self) -> Dict[str, Any]:
        """Load current state from file"""
        try:
            with open(self.state_file, 'r') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            self._init_state()
            return self._load_state()
    
    def _save_state(self, state: Dict[str, Any]) -> None:
        """Save state to file"""
        with open(self.state_file, 'w') as f:
            json.dump(state, f, indent=2)
    
    def create_reservation(
        self, 
        user_id: str, 
        gpu_count: int, 
        duration_hours: int,
        name: Optional[str] = None
    ) -> Optional[str]:
        """Create a test reservation"""
        state = self._load_state()
        
        # Check availability
        available_gpus = sum(server['available_gpus'] for server in state['servers'])
        if available_gpus < gpu_count:
            print(f"❌ Insufficient GPUs. Requested: {gpu_count}, Available: {available_gpus}")
            return None
        
        # Create reservation
        reservation_id = str(uuid.uuid4())
        now = datetime.utcnow()
        expires_at = now + timedelta(hours=duration_hours)
        
        reservation = {
            "reservation_id": reservation_id,
            "user_id": user_id,
            "gpu_count": gpu_count,
            "status": "active",
            "created_at": now.isoformat(),
            "expires_at": expires_at.isoformat(),
            "duration_hours": duration_hours,
            "pod_name": f"gpu-dev-{reservation_id[:8]}",
            "namespace": "gpu-dev"
        }
        
        if name:
            reservation["name"] = name
        
        # Allocate GPUs from servers
        remaining_gpus = gpu_count
        for server in state['servers']:
            if remaining_gpus <= 0:
                break
            
            if server['available_gpus'] > 0:
                allocated = min(remaining_gpus, server['available_gpus'])
                server['available_gpus'] -= allocated
                server['allocated_gpus'] += allocated
                remaining_gpus -= allocated
        
        state['reservations'].append(reservation)
        self._save_state(state)
        
        return reservation_id
    
    def list_reservations(
        self, 
        user_filter: Optional[str] = None,
        status_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """List test reservations"""
        state = self._load_state()
        reservations = state['reservations']
        
        # Apply filters
        if user_filter:
            reservations = [r for r in reservations if r['user_id'] == user_filter]
        
        if status_filter:
            reservations = [r for r in reservations if r['status'] == status_filter]
        
        # Sort by creation time (newest first)
        reservations.sort(key=lambda x: x.get('created_at', ''), reverse=True)
        
        return reservations
    
    def cancel_reservation(self, reservation_id: str, user_id: str) -> bool:
        """Cancel a test reservation"""
        state = self._load_state()
        
        # Find reservation
        reservation = None
        for r in state['reservations']:
            if r['reservation_id'] == reservation_id:
                reservation = r
                break
        
        if not reservation:
            print(f"❌ Reservation {reservation_id} not found")
            return False
        
        if reservation['user_id'] != user_id:
            print("❌ You don't have permission to cancel this reservation")
            return False
        
        # Update status
        reservation['status'] = 'cancelled'
        reservation['cancelled_at'] = datetime.utcnow().isoformat()
        
        # Free up GPUs
        gpu_count = reservation['gpu_count']
        for server in state['servers']:
            if gpu_count <= 0:
                break
            
            if server['allocated_gpus'] > 0:
                freed = min(gpu_count, server['allocated_gpus'])
                server['allocated_gpus'] -= freed
                server['available_gpus'] += freed
                gpu_count -= freed
        
        self._save_state(state)
        return True
    
    def get_connection_info(self, reservation_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Get test connection info"""
        state = self._load_state()
        
        # Find reservation
        reservation = None
        for r in state['reservations']:
            if r['reservation_id'] == reservation_id:
                reservation = r
                break
        
        if not reservation:
            print(f"❌ Reservation {reservation_id} not found")
            return None
        
        if reservation['user_id'] != user_id:
            print("❌ You don't have permission to access this reservation")
            return None
        
        if reservation['status'] != 'active':
            print(f"❌ Reservation is not active (status: {reservation['status']})")
            return None
        
        return {
            'reservation_id': reservation_id,
            'pod_name': reservation['pod_name'],
            'namespace': reservation['namespace'],
            'gpu_count': reservation['gpu_count'],
            'ssh_command': f"[TEST] kubectl exec -it {reservation['pod_name']} -n {reservation['namespace']} -- /bin/bash",
            'port_forward': f"[TEST] kubectl port-forward {reservation['pod_name']} -n {reservation['namespace']} 8888:8888"
        }
    
    def get_cluster_status(self) -> Dict[str, Any]:
        """Get test cluster status"""
        state = self._load_state()
        
        total_gpus = sum(server['total_gpus'] for server in state['servers'])
        available_gpus = sum(server['available_gpus'] for server in state['servers'])
        reserved_gpus = total_gpus - available_gpus
        
        active_reservations = len([r for r in state['reservations'] if r['status'] == 'active'])
        queue_length = len(state['queue'])
        
        return {
            'total_gpus': total_gpus,
            'available_gpus': available_gpus,
            'reserved_gpus': reserved_gpus,
            'active_reservations': active_reservations,
            'queue_length': queue_length
        }
    
    def reset_state(self) -> None:
        """Reset test state to initial values"""
        if self.state_file.exists():
            self.state_file.unlink()
        self._init_state()
        print("✅ Test state reset to defaults")