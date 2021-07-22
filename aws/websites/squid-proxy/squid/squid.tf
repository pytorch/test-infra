provider "aws" {
  region                       = "${var.aws_region}"
  profile                      = "${var.aws_profile}"
}

locals {
  user_data = templatefile("${path.module}/user-data.sh", {
    aws_public_vpc_cidr        = "${var.aws_public_vpc_cidr}"
    squid_port                 = "${var.squid_port}"
    maximum_object_size         = "${var.maximum_object_size}"
    disk_size                  = "${var.disk_size}"
  })
}

resource "aws_elb" "elb_1" {
  internal                     = false
  cross_zone_load_balancing    = true
  idle_timeout                 = 300
  connection_draining          = true
  connection_draining_timeout  = 300
  security_groups              = ["${var.aws_security_group_id}"]
  subnets                      = "${var.aws_subnet_ids}"

  listener {
    instance_port              = "${var.squid_port}"
    instance_protocol          = "TCP"
    lb_port                    = "${var.squid_port}"
    lb_protocol                = "TCP"
  }

  health_check {
    healthy_threshold          = 5
    unhealthy_threshold        = 2
    timeout                    = 5
    target                     = "TCP:${var.squid_port}"
    interval                   = 10
  }

  tags = {
    Name                       = "${var.environment_name}_elb_1"
  }
}

resource "aws_launch_configuration" "lc_1" {
  name_prefix                  = "${var.environment_name}_squid_proxy_"
  image_id                     = "${var.aws_ami}"
  instance_type                = "${var.aws_instance_type}"
  key_name                     = "${var.aws_key_name}"
  security_groups              = ["${var.aws_security_group_id}"]
  associate_public_ip_address  = true
  user_data                    = local.user_data
  ebs_optimized = true
  root_block_device {
    volume_type = "gp3"
    volume_size = 160
  }

  lifecycle {
    create_before_destroy      = true
  }
}

resource "aws_autoscaling_group" "asg_1" {
  name                         = "${var.environment_name}_asg_squid_proxy"
  launch_configuration         = "${aws_launch_configuration.lc_1.name}"
  vpc_zone_identifier          = "${var.aws_subnet_ids}"
  load_balancers               = ["${aws_elb.elb_1.id}"]
  health_check_grace_period    = 180
  health_check_type            = "ELB"
  force_delete                 = false
  termination_policies         = ["OldestInstance"]
  min_size                     = "${var.aws_asg_min_size}"
  max_size                     = "${var.aws_asg_max_size}"

  lifecycle {
    create_before_destroy      = true
  }

  tag {
    key                        = "userdata_sha"
    value                      = sha1(local.user_data)
    propagate_at_launch        = true
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
    triggers = ["tag"]
  }
}

# auto scale up policy
resource "aws_autoscaling_policy" "asp_1" {
  name = "${var.environment_name}_asp_1"
  scaling_adjustment = 1
  adjustment_type = "ChangeInCapacity"
  cooldown = 300
  autoscaling_group_name = "${aws_autoscaling_group.asg_1.name}"
}


# auto scale down policy
resource "aws_autoscaling_policy" "asp_2" {
  name = "${var.environment_name}_asp_2"
  scaling_adjustment = -1
  adjustment_type = "ChangeInCapacity"
  cooldown = 300
  autoscaling_group_name = "${aws_autoscaling_group.asg_1.name}"
}

resource "aws_cloudwatch_metric_alarm" "cwa_1" {
  alarm_name = "${var.environment_name}_cwa_1"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods = "2"
  metric_name = "CPUUtilization"
  namespace = "AWS/EC2"
  period = "120"
  statistic = "Average"
  threshold = "80"
  alarm_description = "Check whether EC2 instance CPU utilisation is over 80% on average"
  alarm_actions = ["${aws_autoscaling_policy.asp_1.arn}"]
  dimensions = {
    AutoScalingGroupName = "${aws_autoscaling_group.asg_1.name}"
  }
}
