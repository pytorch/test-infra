resource "aws_dynamodb_table" "pytorchbot-logs" {
    name           = "pytorchbot-logs"
    hash_key = "dynamoKey"
    billing_mode   = "PROVISIONED"
    read_capacity = 1
    write_capacity = 1
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-dynamo-perf-stats" {
    name           = "torchci-dynamo-perf-stats"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-issue-comment" {
    name           = "torchci-issue-comment"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-issues" {
    name           = "torchci-issues"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-job-annotation" {
    name           = "torchci-job-annotation"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-metrics" {
    name           = "torchci-metrics"
    hash_key = "dynamo_key"
    range_key = "metrics_name"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamo_key"
        type = "S"
    }
    attribute {
        name = "metrics_name"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-metrics-ci-wait-time" {
    name           = "torchci-metrics-ci-wait-time"
    hash_key = "dynamoKey"
    billing_mode   = "PROVISIONED"
    read_capacity = 1
    write_capacity = 1
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-oss-ci-benchmark" {
    name           = "torchci-oss-ci-benchmark"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-pull-request" {
    name           = "torchci-pull-request"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-pull-request-review" {
    name           = "torchci-pull-request-review"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-pull-request-review-comment" {
    name           = "torchci-pull-request-review-comment"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-push" {
    name           = "torchci-push"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-retry-bot" {
    name           = "torchci-retry-bot"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-tutorial-filenames" {
    name           = "torchci-tutorial-filenames"
    hash_key = "commit_id"
    range_key = "filename"
    billing_mode   = "PROVISIONED"
    read_capacity = 10
    write_capacity = 10
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "commit_id"
        type = "S"
    }
    attribute {
        name = "filename"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-tutorial-metadata" {
    name           = "torchci-tutorial-metadata"
    hash_key = "commit_id"
    range_key = "date"
    billing_mode   = "PROVISIONED"
    read_capacity = 10
    write_capacity = 10
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "commit_id"
        type = "S"
    }
    attribute {
        name = "date"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-workflow-job" {
    name           = "torchci-workflow-job"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "torchci-workflow-run" {
    name           = "torchci-workflow-run"
    hash_key = "dynamoKey"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
}

resource "aws_dynamodb_table" "trymerge_event" {
    name           = "trymerge_event"
    hash_key = "dynamoKey"
    range_key = "timestamp"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
    attribute {
        name = "timestamp"
        type = "N"
    }
}

resource "aws_dynamodb_table" "trymerge_event_comment" {
    name           = "trymerge_event_comment"
    hash_key = "dynamoKey"
    range_key = "timestamp"
    billing_mode   = "PAY_PER_REQUEST"
    stream_enabled = true
    stream_view_type = "NEW_AND_OLD_IMAGES"
    attribute {
        name = "dynamoKey"
        type = "S"
    }
    attribute {
        name = "timestamp"
        type = "N"
    }
}
