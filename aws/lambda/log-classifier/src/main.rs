use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde_json::{json, Value};

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
                match make_query(&log, &best_match.line_number, 500).await {
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

/// What the handler needs, however the caller chose to say it.
#[derive(Debug, PartialEq)]
struct ClassifyRequest {
    job_id: usize,
    repo: String,
    context_depth: usize,
    is_temp_log: bool,
}

/// Pull a single parameter out of either payload shape.
///
/// Two callers exist. Function URL callers (backfillJobs.mjs,
/// keep-going-call-log-classifier, github-status-test) send an API Gateway HTTP
/// API v2.0 request, where the values live under `queryStringParameters` and are
/// always strings. Direct `lambda:InvokeFunction` callers (gha-log-uploader) send
/// a plain `{"job_id": 123, "repo": "..."}` object, where `job_id` is a real
/// number. Accepting both is what lets an async invoke skip the public function
/// URL without every caller having to synthesise an HTTP request.
fn param(event: &Value, name: &str) -> Option<String> {
    let from_query = event
        .get("queryStringParameters")
        .and_then(|q| q.get(name))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    if from_query.is_some() {
        return from_query;
    }

    // A v2.0 request with no `queryStringParameters` still carries the raw
    // string, so fall back to it rather than 400-ing a well-formed request.
    let from_raw = event
        .get("rawQueryString")
        .and_then(|v| v.as_str())
        .and_then(|raw| {
            raw.split('&')
                .filter_map(|pair| pair.split_once('='))
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        });
    if from_raw.is_some() {
        return from_raw;
    }

    match event.get(name) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

fn parse_request(event: &Value) -> Option<ClassifyRequest> {
    let job_id = param(event, "job_id")?.parse::<usize>().ok()?;
    Some(ClassifyRequest {
        job_id,
        repo: param(event, "repo").unwrap_or_else(|| "pytorch/pytorch".to_string()),
        context_depth: param(event, "context_depth")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or_else(|| CONTEXT_DEPTH.parse::<usize>().expect("valid default")),
        is_temp_log: param(event, "temp_log").map_or(false, |v| v == "true"),
    })
}

/// The API Gateway response shape, kept so function URL callers see exactly what
/// they saw when this was a lambda_http handler.
fn response(status: u16, body: impl Into<String>) -> Value {
    json!({
        "statusCode": status,
        "headers": {},
        "body": body.into(),
        "isBase64Encoded": false,
    })
}

async fn function_handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    let Some(request) = parse_request(&event.payload) else {
        return Ok(response(400, "no job id provided"));
    };

    let body = handle(
        request.job_id,
        &request.repo,
        ShouldWriteDynamo(true),
        request.context_depth,
        request.is_temp_log,
    )
    .await?;

    Ok(response(200, body))
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

    fn v2_request(query: Value) -> Value {
        json!({
            "version": "2.0",
            "routeKey": "$default",
            "rawPath": "/",
            "headers": {},
            "queryStringParameters": query,
            "isBase64Encoded": false,
        })
    }

    #[test]
    fn parses_a_direct_invoke_payload() {
        // gha-log-uploader sends this: job_id is a real number, not a string.
        assert_eq!(
            parse_request(&json!({"job_id": 123, "repo": "pytorch/executorch"})),
            Some(ClassifyRequest {
                job_id: 123,
                repo: "pytorch/executorch".to_string(),
                context_depth: 12,
                is_temp_log: false,
            })
        );
    }

    #[test]
    fn parses_a_function_url_request() {
        // What backfillJobs.mjs and keep-going-call-log-classifier send.
        assert_eq!(
            parse_request(&v2_request(
                json!({"job_id": "123", "repo": "pytorch/pytorch", "temp_log": "true"})
            )),
            Some(ClassifyRequest {
                job_id: 123,
                repo: "pytorch/pytorch".to_string(),
                context_depth: 12,
                is_temp_log: true,
            })
        );
    }

    #[test]
    fn falls_back_to_the_raw_query_string() {
        let event = json!({
            "version": "2.0",
            "rawQueryString": "job_id=99&repo=pytorch/rl&context_depth=3",
        });
        let parsed = parse_request(&event).expect("should parse");
        assert_eq!(parsed.job_id, 99);
        assert_eq!(parsed.repo, "pytorch/rl");
        assert_eq!(parsed.context_depth, 3);
    }

    #[test]
    fn query_parameters_win_over_a_top_level_key() {
        // A v2.0 envelope has no top-level job_id, but if one ever appears the
        // request the caller actually made is the one to honour.
        let mut event = v2_request(json!({"job_id": "1"}));
        event["job_id"] = json!(2);
        assert_eq!(parse_request(&event).expect("should parse").job_id, 1);
    }

    #[test]
    fn defaults_repo_and_context_depth() {
        let parsed = parse_request(&json!({"job_id": 5})).expect("should parse");
        assert_eq!(parsed.repo, "pytorch/pytorch");
        assert_eq!(parsed.context_depth, 12);
        assert!(!parsed.is_temp_log);
    }

    #[test]
    fn rejects_a_payload_with_no_job_id() {
        assert_eq!(parse_request(&json!({"repo": "pytorch/pytorch"})), None);
        assert_eq!(parse_request(&v2_request(json!({}))), None);
    }

    #[test]
    fn rejects_a_non_numeric_job_id() {
        assert_eq!(parse_request(&json!({"job_id": "not a number"})), None);
    }

    #[test]
    fn temp_log_is_only_true_for_the_exact_string() {
        // It arrives as a string over the function URL and could arrive as a
        // bool on a direct invoke; both normalise through param().
        assert!(parse_request(&json!({"job_id": 1, "temp_log": true}))
            .expect("should parse")
            .is_temp_log);
        assert!(!parse_request(&json!({"job_id": 1, "temp_log": "false"}))
            .expect("should parse")
            .is_temp_log);
    }

    #[test]
    fn response_keeps_the_api_gateway_shape() {
        // Function URL callers still get a structured response, unchanged from
        // when this was a lambda_http handler.
        let r = response(400, "no job id provided");
        assert_eq!(r["statusCode"], 400);
        assert_eq!(r["body"], "no job id provided");
        assert_eq!(r["isBase64Encoded"], false);
    }

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

    // The three timeout shapes from pytorch/pytorch#191754. These live here
    // rather than in fixtures/classify/ because fixtures are verbatim CI logs
    // and the two enriched shapes do not exist in any log yet -- the runner
    // change has not landed and propagated. Replace with real fixtures once it
    // has; until then these pin the agreed formats so the rules cannot rot.
    #[test]
    fn timeout_prefers_in_flight_test_nodeid() {
        let ruleset = RuleSet::new_from_config();
        let log = Log::new(
            "\
            Command took >30min, returning 124\n\
            Got exit code 124\n\
            TIMED OUT: test_foo.py::TestBar::test_baz\n\
            test_foo 1/1 failed!\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.rule.name, "Test file timeout");
        assert_eq!(match_.captures, vec!["test_foo.py::TestBar::test_baz"]);
    }

    #[test]
    fn timeout_falls_back_to_file_label_when_no_test_started() {
        let ruleset = RuleSet::new_from_config();
        let log = Log::new(
            "\
            Command took >30min, returning 124 (test_segment_reductions 1/1)\n\
            Got exit code 124\n\
            No stepcurrent file found. Either pytest didn't get to run (e.g. import error) or file got deleted (contact dev infra)\n\
            test_segment_reductions 1/1 failed!\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.rule.name, "Test file timeout");
        // Shard is outside the capture so 3/8 and 5/8 of one file aggregate.
        assert_eq!(match_.captures, vec!["test_segment_reductions"]);
    }

    #[test]
    fn timeout_bare_form_still_matches_for_old_runners() {
        // Release branches keep emitting the unenriched line indefinitely.
        let ruleset = RuleSet::new_from_config();
        let log = Log::new(
            "\
            Command took >30min, returning 124\n\
            Got exit code 124\n\
            test_segment_reductions 1/1 failed!\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).unwrap();
        assert_eq!(match_.rule.name, "Test file timeout");
        assert_eq!(match_.captures, vec!["Command took >30min, returning 124"]);
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

    #[test]
    fn evaluate_ruleset_matches_real_error_after_dropping_boilerplate() {
        let ruleset = RuleSet::new_from_config();
        let log = Log::new(
            "\
            >>> Lint for test/foo.py:\n\
            ##[error]Process completed with exit code 1.\n\
            "
            .into(),
        );
        let match_ = evaluate_ruleset(&ruleset, &log).expect("should match the real error line");
        assert_eq!(match_.line_number, 1);
        assert_eq!(match_.rule.name, "Lintrunner failure");
        assert_eq!(log.lines.get(&1).unwrap(), ">>> Lint for test/foo.py:");
    }

    #[test]
    fn evaluate_ruleset_returns_none_for_only_boilerplate() {
        let ruleset = RuleSet::new_from_config();
        let log = Log::new(
            "\
            ##[error]Process completed with exit code 1.\n\
            [OSDC] Step script exited with code 1\n\
            "
            .into(),
        );
        // Every line is boilerplate and dropped, so the log is empty; the classify
        // path yields "No match found" (None) rather than panicking.
        assert!(log.lines.is_empty());
        assert!(evaluate_ruleset(&ruleset, &log).is_none());
    }

    // Actually download some id.
    // #[tokio::test]
    // async fn test_real() {
    //    let foo = handle(12421522599, "pytorch/vision", ShouldWriteDynamo(false)).await;
    //    panic!("{:#?}", foo);
    // }
}
