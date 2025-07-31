# Organization Analytics Tools

This directory contains a collection of scripts designed to analyze GitHub Actions runner usage and other organizational metrics across a GitHub organization's repositories.

## Overview

The tools in this directory help us understand how GitHub Actions runners are being utilized across our repositories.

## Scripts

### `analyze_runner_usage.py`

**Purpose**: Analyzes GitHub Actions runner label usage across all repositories in a specified GitHub organization.

**Key Features**:
- Fetches all non-archived repositories in a GitHub organization
- Extracts runner labels used in workflow jobs from recent workflow runs
- Aggregates runner usage statistics across repositories
- Compares runner labels against those defined in `scale-config.yml` and standard GitHub-hosted runners
- Identifies unused or undefined runners
- Generates comprehensive usage reports

**Output**: Creates `runner_labels_summary.yml` with detailed analytics including:
- Runner usage by repository
- Repository usage by runner type
- Repositories with zero workflow runs
- Runners not defined in scale-config or standard GitHub runners
- Usage patterns and trends

### `cache_manager.py`

**Purpose**: Helper script. Provides efficient caching functionality for GitHub API responses to optimize performance and avoid rate limiting.

**Features**:
- URL-based cache key generation
- Intelligent cache invalidation
- Rate limit optimization
- Reduces redundant API calls during analysis

