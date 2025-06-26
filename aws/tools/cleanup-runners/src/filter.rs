use crate::{Ec2Instance, GitHubRunner};
use std::collections::HashSet;

/// Find EC2 instances that don't have corresponding GitHub runners.
/// These are considered "orphaned" and candidates for termination.
pub fn find_orphaned_instances(
    github_runners: &[GitHubRunner],
    ec2_instances: &[Ec2Instance],
) -> Vec<Ec2Instance> {
    // Create a set of GitHub runner names for fast lookup
    let github_runner_names: HashSet<&str> = github_runners
        .iter()
        .map(|runner| runner.name.as_str())
        .collect();

    // Find EC2 instances that don't have a corresponding GitHub runner
    ec2_instances
        .iter()
        .filter(|instance| {
            // Check if this EC2 instance ID has a corresponding GitHub runner
            !github_runner_names.contains(instance.id.as_str())
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_orphaned_instances_empty_lists() {
        let github_runners = vec![];
        let ec2_instances = vec![];

        let result = find_orphaned_instances(&github_runners, &ec2_instances);
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_find_orphaned_instances_no_orphans() {
        let github_runners = vec![
            GitHubRunner {
                id: 1,
                name: "i-123".to_string(),
                status: "online".to_string(),
            },
            GitHubRunner {
                id: 2,
                name: "i-456".to_string(),
                status: "online".to_string(),
            },
        ];

        let ec2_instances = vec![
            Ec2Instance {
                id: "i-123".to_string(),
                name: "runner-1".to_string(),
                state: "running".to_string(),
            },
            Ec2Instance {
                id: "i-456".to_string(),
                name: "runner-2".to_string(),
                state: "running".to_string(),
            },
        ];

        let result = find_orphaned_instances(&github_runners, &ec2_instances);
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_find_orphaned_instances_with_orphans() {
        let github_runners = vec![GitHubRunner {
            id: 1,
            name: "i-123".to_string(),
            status: "online".to_string(),
        }];

        let ec2_instances = vec![
            Ec2Instance {
                id: "i-123".to_string(),
                name: "runner-1".to_string(),
                state: "running".to_string(),
            },
            Ec2Instance {
                id: "i-456".to_string(),
                name: "runner-2".to_string(),
                state: "running".to_string(),
            },
            Ec2Instance {
                id: "i-789".to_string(),
                name: "runner-3".to_string(),
                state: "running".to_string(),
            },
        ];

        let result = find_orphaned_instances(&github_runners, &ec2_instances);
        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|i| i.id == "i-456"));
        assert!(result.iter().any(|i| i.id == "i-789"));
    }

    #[test]
    fn test_find_orphaned_instances_no_github_runners() {
        let github_runners = vec![];
        let ec2_instances = vec![
            Ec2Instance {
                id: "i-123".to_string(),
                name: "runner-1".to_string(),
                state: "running".to_string(),
            },
            Ec2Instance {
                id: "i-456".to_string(),
                name: "runner-2".to_string(),
                state: "running".to_string(),
            },
        ];

        let result = find_orphaned_instances(&github_runners, &ec2_instances);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_find_orphaned_instances_no_ec2_instances() {
        let github_runners = vec![GitHubRunner {
            id: 1,
            name: "i-123".to_string(),
            status: "online".to_string(),
        }];
        let ec2_instances = vec![];

        let result = find_orphaned_instances(&github_runners, &ec2_instances);
        assert_eq!(result.len(), 0);
    }
} 