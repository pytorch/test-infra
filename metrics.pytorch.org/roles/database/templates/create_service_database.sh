#!/bin/bash
# Copyright (c) 2014-present, Facebook, Inc.
mysql -h$DB_HOST -u$DB_ROOT_USER -p$DB_ROOT_PASSWORD -e "set @db_name='${DB_NAME}'; set @db_user='${DB_USER}'; set @db_password='${DB_PASSWORD}'; source /scripts/service.sql;"
