import rockset
import os
import time
from datetime import datetime, time

scale_down_time = datetime.strptime("3:00", "%H:%M").time() # 3am UTC, which is 8pm PST 
scale_up_time = datetime.strptime("15:00", "%H:%M").time() # 3pm UTC, which is 8am PST

scale_down_size = "LARGE"
scale_up_size = "XLARGE"

virtual_instance_id = "9a1d7e17-7601-431b-80ef-3e25cf6e76a9"

rs = rockset.RocksetClient(
    host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
)

def get_virtual_instance_status():
    try:
        vi_status = rs.VirtualInstances.get(
                virtual_instance_id=virtual_instance_id
            )
    except rockset.ApiException as e:
        print(f"Exception when calling VirtualInstances->get: {e}\n")
        exit(1)
    return vi_status


def get_desired_size_at_time(time: datetime, scale_up_time: time = scale_up_time, scale_down_time: time = scale_down_time) -> str:
    if time >= scale_down_time and time < scale_up_time:
        print(f"Scaling down to {scale_down_size}")
        new_size = scale_down_size
    else:
        print(f"Scaling up to {scale_up_size}")
        new_size = scale_up_size

    return new_size


def get_desired_size_right_now() -> str:
    current_time = datetime.utcnow().time()
    new_size = get_desired_size_at_time(current_time)
    return new_size


def is_scaling_needed(desired_size) -> bool:
    vi_status = get_virtual_instance_status()
    current_size = vi_status.data.size

    if desired_size == current_size:
        print(f"Virtual instance is already at size {current_size}")
        return False
    else:
        print(f"Virtual instance is at size {current_size}, scaling to {desired_size}")
        return True


def scale_virtual_instance(desired_size) -> None:
    try:
        print(f"Scaling virtual instance to size {desired_size}")
        
        vi_status = rs.VirtualInstances.update(
            virtual_instance_id=virtual_instance_id,
            new_size=desired_size,
        )
    except rockset.ApiException as e:
        print(f"Exception when calling VirtualInstances->update: {e}\n")
        exit(1)

    print("Waiting for virtual instance to complete scaling")

    # It takes ~5 minutes to scale. Keep polling till it's done
    while vi_status.data.state != "ACTIVE":
        print(f"Current virtual instance state: {vi_status.data.state}...")
        time.sleep(60) 
        
        vi_status = get_virtual_instance_status()

    print(f"Virtual instance is now {vi_status.data.state} and scaled to {vi_status.data.size}")

def main() -> None:
    new_size = get_desired_size_right_now()
    if not is_scaling_needed(new_size):
        return 0
    
    scale_virtual_instance(new_size)

    return 0


if __name__ == "__main__":
    main()
