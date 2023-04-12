import rockset
import os
import time
from datetime import datetime

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
        print("Exception when calling VirtualInstances->get: %s\n" % e)
        exit(1)
    return vi_status

current_time = datetime.utcnow().time()

if current_time >= scale_down_time and current_time < scale_up_time:
    print(f"Scaling down to {scale_down_size}")
    new_size = scale_down_size
else:
    print(f"Scaling up to {scale_up_size}")
    new_size = scale_up_size

vi_status = get_virtual_instance_status()
if vi_status.data.current_size == new_size:
    print("Virtual instance is already at the correct size, exiting")
    exit(0)

try:
    # Scale the virtual instance
    vi_status = rs.VirtualInstances.update(
        virtual_instance_id=virtual_instance_id,
        new_size=new_size,
    )
    print(f"Scaling virtual instance to size {new_size}")
except rockset.ApiException as e:
    print("Exception when calling VirtualInstances->update: %s\n" % e)
    exit(1)

print("Waiting for virtual instance to complete scaling")

while vi_status.data.state != "ACTIVE":
    print(f"Current virtual instance state: {vi_status.data.state}...")
    time.sleep(300) # Wait 5 minutes
    
    # And check the status again
    vi_status = get_virtual_instance_status()

print(f"Virtual instance is now {vi_status.data.state}")

