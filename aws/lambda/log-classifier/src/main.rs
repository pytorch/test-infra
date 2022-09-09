use lambda_http::{run, service_fn, Body, Error, IntoResponse, Request, RequestExt, Response};

use anyhow::Result;
use std::time::Instant;
use tracing::info;

use log_classifier::engine::evaluate_ruleset;
use log_classifier::log::Log;
use log_classifier::network::{
    download_log, get_dynamo_client, get_s3_client, upload_classification_dynamo,
};
use log_classifier::rule::RuleSet;
use log_classifier::rule_match::SerializedMatch;

struct ShouldWriteDynamo(bool);

async fn handle(job_id: usize, should_write_dynamo: ShouldWriteDynamo) -> Result<String> {
    let client = get_s3_client().await;
    // Download the log from S3.
    let start = Instant::now();
    let raw_log = download_log(&client, job_id).await?;
    info!("download: {:?}", start.elapsed());

    // Do some preprocessing.
    let start = Instant::now();
    let log = Log::new(raw_log);
    info!("preproc: {:?}", start.elapsed());

    // Run the matching
    let start = Instant::now();
    let ruleset = RuleSet::new_from_config();
    let maybe_match = evaluate_ruleset(&ruleset, &log);
    info!("evaluate: {:?}", start.elapsed());

    match maybe_match {
        Some(best_match) => {
            let match_json = SerializedMatch::new(&best_match, &log);
            let body = serde_json::to_string_pretty(&match_json)?;
            info!("match: {}", body);
            if should_write_dynamo.0 {
                let client = get_dynamo_client().await;
                upload_classification_dynamo(&client, job_id, &match_json).await?;
            }
            Ok(body)
        }
        None => {
            info!("no match found for {}", job_id);
            Ok("No match found".into())
        }
    }
}

async fn function_handler(event: Request) -> Result<Response<Body>, Error> {
    // Extract some useful information from the request
    Ok(match event.query_string_parameters().first("job_id") {
        Some(job_id) => {
            let job_id = job_id.parse::<usize>()?;
            handle(job_id, ShouldWriteDynamo(true))
                .await?
                .into_response()
                .await
        }

        _ => Response::builder()
            .status(400)
            .body("no job id provided".into())
            .expect("failed to render response"),
    })
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        // disabling time is handy because CloudWatch will add the ingestion time.
        .without_time()
        .init();

    run(service_fn(function_handler)).await
}

#[cfg(test)]
mod test {
    use super::*;
    use log_classifier::engine::evaluate_rule;
    use log_classifier::rule::Rule;
    use regex::Regex;

    #[test]
    fn basic_evaluate_rule() {
        let rule = Rule {
            name: "test".into(),
            pattern: r"^test".parse().unwrap(),
            priority: 100,
        };

        let log = Log::new("test foo".into());
        let match_ = evaluate_rule(&rule, &log);
        assert_eq!(match_.unwrap().line_number, 1);
    }

    #[test]
    fn escape_codes_are_stripped() {
        let mut ruleset = RuleSet::new();
        ruleset.add("foo", r"^test foo");
        let log = Log::new(
            "\
            2022-08-26T17:16:41.9362224Z \x1b[93;41mtest\x1b[0m foo\n\
            2022-08-26T17:16:41.9362224Z lol!lol\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.line_number, 1);
        assert_eq!(match_.rule.name, "foo");
    }

    #[test]
    fn timestamp_is_stripped() {
        let mut ruleset = RuleSet::new();
        ruleset.add("foo", r"^test");
        let log = Log::new(
            "\
            2022-08-26T17:16:41.9362224Z test foo\n\
            2022-08-26T17:16:41.9362224Z lol!lol\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.line_number, 1);
        assert_eq!(match_.rule.name, "foo");
    }

    #[test]
    fn evaluate_rulset_respects_priority() {
        let mut ruleset = RuleSet::new();
        ruleset.add("higher priority", r"^lol!");
        ruleset.add("lower priority", r"^test");
        let log = Log::new(
            "\
            test foo\n\
            lol!lol\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.line_number, 2);
        assert_eq!(match_.rule.name, "higher priority");
    }

    #[test]
    fn ignore_skips_match() {
        let mut ruleset = RuleSet::new();
        ruleset.add("test", r"^test");
        let log = Log::new(
            "\
            =================== sccache compilation log ===================\n\
            testt\n\
            =========== If your build fails, please take a look at the log above for possible reasons ===========\n\
            "
                .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log);
        assert!(match_.is_none());
    }

    #[test]
    fn match_before_ignore() {
        let mut ruleset = RuleSet::new();
        ruleset.add("test", r"^test");
        let log = Log::new(
            "\
            testt\n\
            =================== sccache compilation log ===================\n\
            =========== If your build fails, please take a look at the log above for possible reasons ===========\n\
            "
                .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.line_number, 1);
    }

    #[test]
    fn match_after_ignore() {
        let mut ruleset = RuleSet::new();
        ruleset.add("test", r"^test");
        let log = Log::new(
            "\
            =================== sccache compilation log ===================\n\
            =========== If your build fails, please take a look at the log above for possible reasons ===========\n\
            testt\n\
            "
                .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.line_number, 3);
    }

    #[test]
    fn later_match_wins() {
        let mut ruleset = RuleSet::new();
        ruleset.add("test", r"^test");
        let log = Log::new(
            "\
            testt\n\
            testt\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.line_number, 2);
    }

    #[test]
    fn rules_compile_correctly() {
        // Try re-compiling the rules to make sure there are no invalid regexes.
        let ruleset = RuleSet::new_from_config();
        for rule in &ruleset.rules {
            Regex::new(rule.pattern.as_str()).unwrap();
        }
    }

    // Actually download some id.
    // #[tokio::test]
    // async fn test_real() {
    //     let foo = handle(8024453615, ShouldWriteS3(false)).await;
    //     panic!("{:#?}", foo);
    // }
}
