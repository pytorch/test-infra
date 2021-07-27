#!/bin/bash

yum update -y
yum install -y squid

cat > /etc/squid/squid.conf << EOF
acl manager proto cache_object
acl CONNECT method CONNECT
acl localnet src ${aws_private_vpc_cidr}
acl localhost src 127.0.0.1/255.255.255.255
acl Safe_ports port 80
acl Safe_ports port 443
acl purge method PURGE

http_access allow manager localhost
http_access deny manager
http_access allow purge localhost
http_access deny purge
http_access deny !Safe_ports
http_access allow localhost
http_access allow localnet
http_access deny all

icp_access allow all

maximum_object_size            ${maximum_object_size} MB
cache_dir ufs /var/spool/squid ${disk_size} 16 256
cache_mem 12000 MB
coredump_dir /var/spool/squid
dns_nameservers 1.1.1.1 8.8.4.4
http_port 3128

refresh_pattern -i .(7z|deb|rpm|exe|zip|tar|tgz|gz|ram|rar|bin|tiff|bz2|run|csv|sh)$ 1440 80% 2880
refresh_pattern . 0	20%	4320

EOF

service squid start
chkconfig squid on
