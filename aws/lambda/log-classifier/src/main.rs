use lambda_http::{run, service_fn, Body, Error, IntoResponse, Request, RequestExt, Response};

use anyhow::Result;
use std::time::Instant;
use tracing::info;

use log_classifier::bedrock::make_query;
use log_classifier::engine::evaluate_ruleset;
use log_classifier::log::Log;
use log_classifier::network::{
    download_log, get_dynamo_client, get_s3_client, upload_classification_dynamo,
};
use log_classifier::rule::RuleSet;
use log_classifier::rule_match::SerializedMatch;

struct ShouldWriteDynamo(bool);

/// Set the default depth of the context stack
static CONTEXT_DEPTH: &str = "12";

async fn handle(
    job_id: usize,
    repo: &str,
    should_write_dynamo: ShouldWriteDynamo,
    context_depth: usize,
    is_temp_log: bool,
) -> Result<String> {
    // delete this in a future pr
    let client = get_s3_client().await;
    // Download the log from S3.
    let start = Instant::now();
    let raw_log = download_log(&client, repo, job_id, is_temp_log).await?;
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
            let body: String;
            let mut match_json = SerializedMatch::new(&best_match, &log, context_depth);

            // check if match has the lowest priority in the ruleset
            if best_match.rule.name == ruleset.rules.last().unwrap().name {
                // kick off the llm to get the rule
                match make_query(&log, &best_match.line_number, 100).await {
                    Some(llm_match_json) => {
                        body = serde_json::to_string_pretty(&llm_match_json)?;
                        match_json = llm_match_json;
                    }
                    None => {
                        body = serde_json::to_string_pretty(&match_json)?;
                    }
                }
            } else {
                body = serde_json::to_string_pretty(&match_json)?;
            }
            info!("match: {}", body);
            if should_write_dynamo.0 {
                let client = get_dynamo_client().await;
                upload_classification_dynamo(&client, repo, job_id, &match_json, is_temp_log)
                    .await?;
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
    let query_string_parameters = event.query_string_parameters();
    Ok(match query_string_parameters.first("job_id") {
        Some(job_id) => {
            let job_id = job_id.parse::<usize>()?;
            let repo = query_string_parameters
                .first("repo")
                .unwrap_or_else(|| "pytorch/pytorch");
            let context_depth = query_string_parameters
                .first("context_depth")
                .unwrap_or_else(|| CONTEXT_DEPTH)
                .parse::<usize>()?;
            let is_temp_log = query_string_parameters
                .first("temp_log")
                .map_or(false, |v| v == "true");
            handle(
                job_id,
                repo,
                ShouldWriteDynamo(true),
                context_depth,
                is_temp_log,
            )
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

    // Regression test: a red backwards_compat job must be blamed on the real
    // cause (check_forward_backward_compatibility.py's "backward incompatible
    // changes" warning), not on the FAIL lines from the deliberate
    // failure-injection self-checks (check_public_api_test_fails) that appear
    // in EVERY backwards_compat log, green or red.
    #[test]
    fn backwards_compat_not_blamed_on_public_api_self_check() {
        let ruleset = RuleSet::new_from_config();
        let log = Log::new(
            "\
            ++ python test/test_public_bindings.py -k test_modules_can_be_imported\n\
            + test_output='FAIL: test_modules_can_be_imported (__main__.TestPublicBindings)\n\
            Generating XML reports...\n\
            FAILED (failures=1)'\n\
            Success! 'test_modules_can_be_imported' identified a non-importable module torch.abcd1234.\n\
            + python check_forward_backward_compatibility.py --existing-schemas nightly_schemas.txt\n\
            [WARNING 2026-07-28 01:23:45,678 check_forward_backward_compatibility.py:332] The PR is introducing backward incompatible changes to the operator library. Please contact PyTorch team to confirm whether this change is wanted or not. \n\
            \n\
            Broken ops: [\n\
            \taten::foo(Tensor self) -> Tensor\n\
            ]\n\
            ##[error]Process completed with exit code 1.\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.rule.name, "Operator backwards compatibility");
        assert_eq!(
            match_.captures,
            vec![
                "The PR is introducing backward incompatible changes to the operator library."
                    .to_string()
            ]
        );
    }

    // The pre-Oct-2024 checker printed the message with plain print(), i.e. no
    // "[WARNING ...]" prefix. Make sure that format still matches too.
    #[test]
    fn backwards_compat_matches_unprefixed_format() {
        let ruleset = RuleSet::new_from_config();
        let log = Log::new(
            "\
            FAIL: test_modules_can_be_imported (__main__.TestPublicBindings)\n\
            The PR is introducing backward incompatible changes to the operator library. Please contact PyTorch team to confirm whether this change is wanted or not.\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.rule.name, "Operator backwards compatibility");
    }

    #[test]
    fn backwards_compat_bc_fc_model_load_failure() {
        let ruleset = RuleSet::new_from_config();
        let log = Log::new(
            "\
            FAIL: test_modules_can_be_imported (__main__.TestPublicBindings)\n\
            BC check failed: old model cannot be load in new code\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(
            match_.rule.name,
            "Forward/backward compatibility check failed"
        );
    }

    #[test]
    fn gather_optional_context() {
        let mut ruleset = RuleSet::new();
        ruleset.add("test", r"^test");
        let log = Log::new(
            "\
            + python testing\n\
            ++ echo DUMMY\n\
            ++ exit 1\n\
            testt\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.line_number, 4);

        let match_json = SerializedMatch::new(&match_, &log, 12);
        assert_eq!(
            match_json.context,
            ["++ exit 1", "++ echo DUMMY", "+ python testing"]
        );
    }

    // Actually download some id.
    // #[tokio::test]
    // async fn test_real() {
    //    let foo = handle(12421522599, "pytorch/vision", ShouldWriteDynamo(false)).await;
    //    panic!("{:#?}", foo);
    // }
}
