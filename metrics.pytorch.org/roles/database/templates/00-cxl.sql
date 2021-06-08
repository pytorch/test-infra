-- Copyright (c) 2014-present, Facebook, Inc.
SELECT 'Running mysql init script.' AS '';

CREATE DATABASE IF NOT EXISTS `cxl`;
USE cxl;

DROP PROCEDURE IF EXISTS Create_Nms_User ;
DELIMITER $$
CREATE PROCEDURE Create_Nms_User ()
BEGIN
  DECLARE usr VARCHAR(100)  DEFAULT "";
  SET usr = (SELECT CURRENT_USER);
  IF usr LIKE 'root%'  then
     SELECT 'Creating nms user account.' AS '';
     CREATE USER IF NOT EXISTS 'nms'@'%' IDENTIFIED BY '{{ passwords.nms_db }}';
     GRANT ALL PRIVILEGES ON cxl.* TO 'nms'@'%';
     FLUSH PRIVILEGES;
  end if ;
END; $$
DELIMITER ;

DROP PROCEDURE IF EXISTS Create_Grafana_Database ;
DELIMITER $$
CREATE PROCEDURE Create_Grafana_Database ()
BEGIN
  DECLARE usr VARCHAR(100)  DEFAULT "";
  SET usr = (SELECT CURRENT_USER);
  IF usr LIKE 'root%'  then
     SELECT 'Creating grafanaWriter user account.' AS '';
     CREATE USER IF NOT EXISTS 'grafanaWriter'@'%' IDENTIFIED BY '{{ passwords.grafana_db_writer }}';
     CREATE DATABASE IF NOT EXISTS `grafana`;
     GRANT ALL PRIVILEGES ON grafana.* TO 'grafanaWriter'@'%';
     FLUSH PRIVILEGES;
  end if ;
END; $$
DELIMITER ;

DROP PROCEDURE IF EXISTS Create_Grafana_Reader ;
DELIMITER $$
CREATE PROCEDURE Create_Grafana_Reader ()
BEGIN
  DECLARE usr VARCHAR(100)  DEFAULT "";
  SET usr = (SELECT CURRENT_USER);
  IF usr LIKE 'root%'  then
     SELECT 'Creating grafanaReader user account.' AS '';
     CREATE USER IF NOT EXISTS 'grafanaReader' IDENTIFIED BY '{{ passwords.grafana_db_reader }}';
     GRANT SELECT ON cxl.* TO 'grafanaReader'@'%';
     FLUSH PRIVILEGES;
  end if ;
END; $$
DELIMITER ;

/* create new users only if current user is root */
call Create_Nms_User();
call Create_Grafana_Database();
call Create_Grafana_Reader();

DROP PROCEDURE IF EXISTS Adjust_Agg_Key_Auto;
DELIMITER $$
CREATE PROCEDURE Adjust_Agg_Key_Auto ()
BEGIN
  DECLARE incr_val INT  DEFAULT 0;
  SET incr_val = (SELECT `AUTO_INCREMENT` FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'cxl' AND TABLE_NAME = 'agg_key');
  IF incr_val < 1000000000  then
        ALTER TABLE `agg_key` AUTO_INCREMENT=1000000000;
  end if ;
END; $$
DELIMITER ;

CREATE TABLE IF NOT EXISTS `agg_key` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `topology_id` int(11) NOT NULL COMMENT 'References topology.id',
  `key` varchar(100) NOT NULL COMMENT 'Metric/key name',
  PRIMARY KEY (`id`),
  UNIQUE KEY `key_name` (`topology_id`,`key`),
  KEY `topology_id` (`topology_id`)
) ENGINE=InnoDB
/* ts_key uses the same key space, separate by 1B until we have
 * key prefixes
 */
AUTO_INCREMENT=1000000000
DEFAULT CHARSET=latin1;

/* for reasons unknown, on initial startup, AUTO_INCREMENT value in the
   CREATE TABLE is not set properly; this function sets is again */
CALL Adjust_Agg_Key_Auto;

CREATE TABLE IF NOT EXISTS `nodes` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `node` varchar(100) NOT NULL,
  `mac` varchar(100) DEFAULT NULL,
  `network` varchar(100) DEFAULT NULL,
  `site` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mac` (`mac`),
  KEY `node` (`node`),
  KEY `site` (`site`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=latin1;

DROP TABLE IF EXISTS scan_results;
DROP TABLE IF EXISTS scan_response_rate;
DROP TABLE IF EXISTS rx_scan_results;
DROP TABLE IF EXISTS tx_scan_results;
DROP TABLE IF EXISTS event_categories;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS topologies;
DROP TABLE IF EXISTS controller_news;
DROP TABLE IF EXISTS topology_news;

CREATE TABLE IF NOT EXISTS `topology` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `primary_controller` int(11) NOT NULL,
  `backup_controller` int(11),
  `site_overrides` json,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=latin1;

CREATE TABLE IF NOT EXISTS `ts_key` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `node_id` int(11) NOT NULL,
  `key` varchar(100) NOT NULL DEFAULT '',
  PRIMARY KEY (`node_id`,`key`),
  KEY `id` (`id`),
  KEY `node_id` (`node_id`),
  KEY `key` (`key`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=latin1;

SELECT 'Done initializing DB.' AS '';
