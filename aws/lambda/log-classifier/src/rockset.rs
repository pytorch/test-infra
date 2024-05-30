use chrono::NaiveDateTime;
use reqwest;
use std::env;

// This is in case there is a timestamp mismatched between what is in the log
// and the record on GitHub
static EPOCH_DELTA_IN_MILLISECONDS: i64 = 1 * 60 * 1000;

pub async fn get_failed_step(repo: &str, job_id: usize) -> (String, i64, i64) {
    let rockset_api_key = match env::var("ROCKSET_API_KEY") {
        Ok(v) => v,
        Err(_e) => String::new(),
    };
    // No API key, nothing to do here
    if rockset_api_key.is_empty() {
        return (String::new(), 0, 0);
    }

    let query = "
SELECT
  job.conclusion,
  job.steps,
FROM
  workflow_job job
WHERE
  job.id = : job_id
";
    let body = serde_json::json!({
        "async": false,
        "sql": {
            "query": query,
            "parameters": [
                {
                    "name": "repo",
                    "type": "string",
                    "value": repo,
                },
                {
                    "name": "job_id",
                    "type": "int",
                    "value": job_id,
                }
            ]
        }
    });

    let cli = reqwest::Client::new();
    let res = match cli
        .post("https://api.usw2a1.rockset.com/v1/orgs/self/queries")
        .header("accept", "application/json")
        .header("content-type", "application/json")
        .header("Authorization", "ApiKey ".to_owned() + &rockset_api_key)
        .body(body.to_string())
        .send()
        .await
    {
        Ok(res) => match res.json::<serde_json::Value>().await {
            Ok(j) => j,
            Err(_e) => serde_json::json!(null),
        },
        Err(_e) => serde_json::json!(null),
    };

    if res == serde_json::json!(null) {
        return (String::new(), 0, 0);
    }

    for job in res["results"].as_array().unwrap() {
        for step in job["steps"].as_array().unwrap() {
            let name = step["name"].as_str().unwrap();
            let conclusion = match step["conclusion"].as_str() {
                None => "",
                v => v.unwrap(),
            };
            let started_at = match NaiveDateTime::parse_from_str(
                match step["started_at"].as_str() {
                    None => "",
                    v => v.unwrap(),
                },
                "%+",
            ) {
                Ok(v) => v.and_utc().timestamp_millis(),
                Err(_e) => 0,
            };
            let completed_at = match NaiveDateTime::parse_from_str(
                match step["completed_at"].as_str() {
                    None => "",
                    v => v.unwrap(),
                },
                "%+",
            ) {
                Ok(v) => v.and_utc().timestamp_millis() + EPOCH_DELTA_IN_MILLISECONDS,
                Err(_e) => 0,
            };

            if conclusion == "failure" || conclusion == "cancelled" || conclusion == "" {
                return (String::from(name), started_at, completed_at);
            }
        }
    }
    return (String::new(), 0, 0);
}
