"""
WorkflowRestartChecker for querying restarted workflows via ClickHouse.
"""

import os
from typing import Dict, List, Set, Optional
from datetime import datetime, timedelta
import clickhouse_connect
from dotenv import load_dotenv


class WorkflowRestartChecker:
    """Check if workflows have been restarted using ClickHouse."""
    
    def __init__(self):
        load_dotenv()
        self.client = clickhouse_connect.get_client(
            host=os.getenv('CLICKHOUSE_HOST'),
            port=int(os.getenv('CLICKHOUSE_PORT', 8123)),
            username=os.getenv('CLICKHOUSE_USER'),
            password=os.getenv('CLICKHOUSE_PASSWORD'),
            database='default',
            secure=True
        )
        self._cache: Dict[str, bool] = {}



    def connection_test(self) -> bool:
        """
        Test ClickHouse connection.

        Returns:
            bool: True if connection is successful, False otherwise.
        """
        try:
            result = self.client.query('SELECT 1')
            return True
        except Exception as e:
            print(f"Connection test failed: {e}")
            return False

    
    def has_restarted_workflow(self, workflow_name: str, commit_sha: str) -> bool:
        """
        Check if a workflow has been restarted for given commit.
        
        Args:
            workflow_name: Name of workflow (e.g., "trunk")
            commit_sha: Commit SHA to check
            
        Returns:
            bool: True if workflow was restarted (workflow_dispatch with trunk/* branch)
        """
        cache_key = f"{workflow_name}:{commit_sha}"
        if cache_key in self._cache:
            return self._cache[cache_key]
        
        query = """
        SELECT 1 as count
        FROM workflow_job FINAL
        WHERE (id, run_id) IN (
          SELECT DISTINCT id, run_id
          FROM materialized_views.workflow_job_by_head_sha
          WHERE head_sha = {commit_sha:String}
        )
          AND workflow_event = {workflow_event:String}
          AND head_branch = {head_branch:String}
          AND workflow_name = {workflow_name:String}
        LIMIT 1
        """
        
        result = self.client.query(query, {
            'commit_sha': commit_sha,
            'workflow_event': 'workflow_dispatch',
            'head_branch': f'trunk/{commit_sha}',
            'workflow_name': workflow_name
        })

        has_restart = len(result.result_rows) > 0
        self._cache[cache_key] = has_restart
        return has_restart
    
    def get_restarted_commits(self, workflow_name: str, days_back: int = 7) -> Set[str]:
        """
        Get all commits with restarted workflows in date range.
        
        Args:
            workflow_name: Name of workflow
            days_back: Number of days to look back
            
        Returns:
            Set of commit SHAs that have restarted workflows
        """
        since_date = datetime.now() - timedelta(days=days_back)
        
        query = """
        SELECT DISTINCT head_sha
        FROM workflow_job
        WHERE workflow_event = 'workflow_dispatch'
          AND head_branch LIKE 'trunk/%'
          AND workflow_name = {workflow_name:String}
          AND workflow_created_at >= {since_date:DateTime}
        """
        
        result = self.client.query(query, {
            'workflow_name': workflow_name,
            'since_date': since_date
        })
        
        commits = {row[0] for row in result.result_rows}
        
        # Update cache
        for commit_sha in commits:
            cache_key = f"{workflow_name}:{commit_sha}"
            self._cache[cache_key] = True
            
        return commits
    
    def clear_cache(self):
        """Clear the results cache."""
        self._cache.clear()