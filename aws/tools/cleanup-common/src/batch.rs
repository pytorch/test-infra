use std::future::Future;

pub async fn process_in_batches<T, F, Fut, E>(
    items: Vec<T>,
    batch_size: usize,
    processor: F,
) -> Result<(usize, usize), E>
where
    T: Clone,
    F: Fn(Vec<T>) -> Fut,
    Fut: Future<Output = Result<(usize, usize), E>>,
{
    let mut total_processed = 0;
    let mut total_failed = 0;
    
    for chunk in items.chunks(batch_size) {
        let (processed, failed) = processor(chunk.to_vec()).await?;
        total_processed += processed;
        total_failed += failed;
    }
    
    Ok((total_processed, total_failed))
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_process_in_batches_single_batch() {
        let items = vec![1, 2, 3];
        let processor = |batch: Vec<i32>| async move {
            Ok::<(usize, usize), String>((batch.len(), 0))
        };
        
        let result = process_in_batches(items, 10, processor).await.unwrap();
        assert_eq!(result, (3, 0));
    }
    
    #[tokio::test]
    async fn test_process_in_batches_multiple_batches() {
        let items = vec![1, 2, 3, 4, 5];
        let processor = |batch: Vec<i32>| async move {
            Ok::<(usize, usize), String>((batch.len(), 0))
        };
        
        let result = process_in_batches(items, 2, processor).await.unwrap();
        assert_eq!(result, (5, 0));
    }
    
    #[tokio::test]
    async fn test_process_in_batches_with_failures() {
        let items = vec![1, 2, 3, 4];
        let processor = |batch: Vec<i32>| async move {
            let processed = batch.len() - 1;
            let failed = 1;
            Ok::<(usize, usize), String>((processed, failed))
        };
        
        let result = process_in_batches(items, 2, processor).await.unwrap();
        assert_eq!(result, (2, 2));
    }
}