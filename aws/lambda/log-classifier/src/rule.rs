use regex::Regex;
use serde::Deserialize;

/// Represents a single log classification rule for matching against.
#[derive(Debug, Clone)]
pub struct Rule {
    pub name: String,
    pub pattern: Regex,
    // If multiple rules match a log, the higher priority one wins. This value
    // is not manually set, it depends on the insertion order into RuleSet
    pub priority: u64,
}

/// Holds a set of Rules and manages their relative priority. Rules inserted
/// earlier have higher priority.
pub struct RuleSet {
    pub rules: Vec<Rule>,
}

/// Corresponds to the on-disk representation of `Rule` in ../ruleset.toml
#[derive(Debug, Clone, Deserialize)]
struct SerializedRule {
    name: String,
    pattern: String,
}

/// Corresponds to the on-disk representation of `RuleSet` in ../ruleset.toml
#[derive(Debug, Clone, Deserialize)]
struct SerializedRuleSet {
    #[serde(rename = "rule")]
    rules: Vec<SerializedRule>,
}

impl RuleSet {
    pub fn new() -> RuleSet {
        RuleSet { rules: Vec::new() }
    }

    pub fn new_from_config() -> RuleSet {
        let f = include_bytes!("../ruleset.toml");
        let config_rules: SerializedRuleSet = toml::from_slice(f).unwrap();

        let mut ret = RuleSet::new();
        for rule in config_rules.rules {
            ret.add(&rule.name, &rule.pattern);
        }

        ret
    }

    /// Add a rule to the ruleset.
    pub fn add(&mut self, name: &str, pattern: &str) {
        let lowest_priority = self.rules.last().map(|r| r.priority).unwrap_or(u64::MAX);
        let priority = lowest_priority.saturating_sub(1);

        self.rules.push(Rule {
            name: name.into(),
            pattern: pattern.parse().unwrap(),
            priority,
        })
    }
}
