use serde::{Deserialize, Serialize};

#[cfg(test)]
use mockall::automock;

pub mod batch;
pub mod time;

#[derive(Debug, Clone)]
pub struct CleanupConfig {
    pub region: String,
    pub dry_run: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CleanupResult {
    pub items_found: usize,
    pub items_processed: usize,
    pub items_failed: usize,
}

impl CleanupResult {
    pub fn new(found: usize, processed: usize, failed: usize) -> Self {
        Self {
            items_found: found,
            items_processed: processed,
            items_failed: failed,
        }
    }
}

#[cfg_attr(test, automock)]
pub trait ResourceFilter<T> {
    fn should_process(&self, item: &T) -> bool;
}

#[cfg_attr(test, automock(type Error = Box<dyn std::error::Error + Send + Sync>;))]
pub trait ResourceProcessor<T> {
    type Error;
    
    #[allow(async_fn_in_trait)]
    async fn process_batch(&self, items: Vec<T>) -> Result<(usize, usize), Self::Error>;
}

#[cfg_attr(test, automock(type Error = Box<dyn std::error::Error + Send + Sync>;))]
pub trait ResourceLister<T> {
    type Error;
    
    #[allow(async_fn_in_trait)]
    async fn list_resources(&self) -> Result<Vec<T>, Self::Error>;
}

pub async fn run_cleanup<T, L, F, P, E>(
    lister: &L,
    filter: &F, 
    processor: &P,
    config: &CleanupConfig,
) -> Result<CleanupResult, E>
where
    T: Clone + Send + Sync,
    L: ResourceLister<T, Error = E>,
    F: ResourceFilter<T>,
    P: ResourceProcessor<T, Error = E>,
    E: std::error::Error + Send + Sync + 'static,
{
    let resources = lister.list_resources().await?;
    println!("Found {} resources", resources.len());
    
    let resources_to_process: Vec<T> = resources
        .into_iter()
        .filter(|item| filter.should_process(item))
        .collect();
    
    println!("Found {} resources to process", resources_to_process.len());
    let items_found = resources_to_process.len();
    
    let (processed, failed) = if config.dry_run {
        println!("Dry run mode - no resources were processed");
        (0, 0)
    } else {
        processor.process_batch(resources_to_process).await?
    };
    
    Ok(CleanupResult::new(items_found, processed, failed))
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[derive(Clone, Debug, PartialEq)]
    struct TestResource {
        id: String,
        should_process: bool,
    }
    
    struct TestLister {
        resources: Vec<TestResource>,
    }
    
    #[derive(Debug)]
    struct TestError;
    
    impl std::fmt::Display for TestError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "Test error")
        }
    }
    
    impl std::error::Error for TestError {}
    
    impl ResourceLister<TestResource> for TestLister {
        type Error = TestError;
        
        async fn list_resources(&self) -> Result<Vec<TestResource>, Self::Error> {
            Ok(self.resources.clone())
        }
    }
    
    struct TestFilter;
    
    impl ResourceFilter<TestResource> for TestFilter {
        fn should_process(&self, item: &TestResource) -> bool {
            item.should_process
        }
    }
    
    struct TestProcessor;
    
    impl ResourceProcessor<TestResource> for TestProcessor {
        type Error = TestError;
        
        async fn process_batch(&self, items: Vec<TestResource>) -> Result<(usize, usize), Self::Error> {
            Ok((items.len(), 0))
        }
    }
    
    #[tokio::test]
    async fn test_run_cleanup_dry_run() {
        let lister = TestLister {
            resources: vec![
                TestResource { id: "1".to_string(), should_process: true },
                TestResource { id: "2".to_string(), should_process: false },
            ]
        };
        let filter = TestFilter;
        let processor = TestProcessor;
        
        let config = CleanupConfig {
            region: "us-east-1".to_string(),
            dry_run: true,
        };
        
        let result = run_cleanup(&lister, &filter, &processor, &config)
            .await
            .unwrap();
            
        assert_eq!(result.items_found, 1);
        assert_eq!(result.items_processed, 0);
        assert_eq!(result.items_failed, 0);
    }
}