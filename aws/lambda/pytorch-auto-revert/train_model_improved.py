import pandas as pd
import ast
from sklearn.linear_model import LogisticRegression, SGDClassifier
from sklearn.metrics import precision_score, recall_score, f1_score
from sklearn.feature_selection import SelectFromModel
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import MultiLabelBinarizer
import numpy as np
import joblib
from collections import defaultdict

# Load CSV
print("Loading dataset...")
df = pd.read_csv("autorevert_patterns.csv")

# variables that are array
df["newer_failure_rules"] = df["newer_failure_rules"].apply(ast.literal_eval)

# Create failure_job combination field
df["failure_job"] = df["failure_rule"] + "||" + df["job_name"]

# Group by SHA to enable many-hot encoding for categorical features
print("\nGrouping by SHA to generate improved features...")
sha_groups = df.groupby('sha')

# Process categorical features using many-hot encoding approach
categorical_features = ["failure_rule", "job_name", "workflow_name", "failure_job"]
boolean_features = ["repeated_failure"]

# Create dictionaries to store the unique values for each SHA
sha_categorical_values = defaultdict(lambda: defaultdict(set))
sha_newer_failure_rules = defaultdict(set)
sha_failure_newer = defaultdict(set)

# Collect all values per SHA
for sha, group in sha_groups:
    # Handle categorical features
    for feature in categorical_features:
        values = group[feature].unique()
        sha_categorical_values[sha][feature].update(values)
    
    # Handle newer_failure_rules (already a list in each row)
    for _, row in group.iterrows():
        sha_newer_failure_rules[sha].update(row["newer_failure_rules"])
        
        # Create failure_newer combinations for this SHA
        failure_rules = row["failure_rule"]
        for rule in row["newer_failure_rules"]:
            sha_failure_newer[sha].add(f"{failure_rules}||{rule}")
    
# Create new DataFrame with one row per SHA
improved_rows = []

for sha, groups in sha_groups:
    # Get the target value (is_reverted_non_ghfirst)
    # All rows for the same SHA should have the same target value
    is_reverted = groups['is_reverted_non_ghfirst'].iloc[0]
    is_reverted_simple = groups['is_reverted'].iloc[0]
    
    # Get all categorical values for this SHA
    feature_values = {}
    for feature in categorical_features:
        feature_values[feature] = list(sha_categorical_values[sha][feature])
    
    # Get all newer_failure_rules for this SHA
    newer_failure_rules = list(sha_newer_failure_rules[sha])
    
    # Get all failure_newer combinations for this SHA
    failure_newer = list(sha_failure_newer[sha])
    
    # Get repeated_failure status - if any row has repeated_failure=True, set it to True
    repeated_failure = groups['repeated_failure'].any()
    
    # Create a new row
    row = {
        'sha': sha,
        'is_reverted': is_reverted_simple,
        'is_reverted_non_ghfirst': is_reverted,
        'failure_rule': feature_values['failure_rule'],
        'job_name': feature_values['job_name'],
        'workflow_name': feature_values['workflow_name'],
        'failure_job': feature_values['failure_job'],
        'repeated_failure': repeated_failure,
        'newer_failure_rules': newer_failure_rules,
        'failure_newer': failure_newer
    }
    improved_rows.append(row)

# Create new DataFrame with the improved features
print(f"Created {len(improved_rows)} rows with aggregated features (one per SHA)")
improved_df = pd.DataFrame(improved_rows)

# Calculate failure rarity metrics from the original dataframe
print("\nGenerating rarity bucket features...")

# Count occurrences of each failure rule in the original dataset
failure_counts = df["failure_rule"].value_counts()
total_failures = len(df)

# Calculate rarity scores (inverse of frequency)
failure_rarity = 1 / (failure_counts / total_failures)
failure_rarity = failure_rarity / failure_rarity.max()  # Normalize to 0-1

# Calculate failure-job combination rarity
failure_job_counts = df["failure_job"].value_counts()
failure_job_rarity = 1 / (failure_job_counts / total_failures)
failure_job_rarity = failure_job_rarity / failure_job_rarity.max()  # Normalize to 0-1

# Create buckets for rarity values (10 buckets)
print("Creating rarity buckets...")
NUM_BUCKETS = 10
failure_rule_bucket_edges = np.linspace(0, 1, NUM_BUCKETS+1)
failure_job_bucket_edges = np.linspace(0, 1, NUM_BUCKETS+1)

# Function to assign a value to a bucket
def get_bucket(value, edges):
    for i in range(len(edges)-1):
        if edges[i] <= value < edges[i+1]:
            return i
    return len(edges)-2  # Last bucket for value == 1

# Map rarity values to bucket indexes
failure_rule_buckets = {rule: get_bucket(rarity, failure_rule_bucket_edges) 
                       for rule, rarity in failure_rarity.items()}
failure_job_buckets = {job: get_bucket(rarity, failure_job_bucket_edges)
                      for job, rarity in failure_job_rarity.items()}

# Create binary features for each rarity bucket
# Each SHA gets a 1 for each bucket that any of its failure_rules or failure_jobs fall into
rarity_bucket_cols_rule = [f"failure_rule_bucket_{i}" for i in range(NUM_BUCKETS)]
rarity_bucket_cols_job = [f"failure_job_bucket_{i}" for i in range(NUM_BUCKETS)]

# Initialize bucket columns with zeros
for col in rarity_bucket_cols_rule + rarity_bucket_cols_job:
    improved_df[col] = 0

# Fill bucket columns with 1s when a SHA has a failure_rule or failure_job in that bucket
for i, row in improved_df.iterrows():
    sha = row['sha']
    
    # Set bucket features for failure rules
    buckets_seen_rule = set()
    for failure_rule in row['failure_rule']:
        if failure_rule in failure_rule_buckets:
            bucket = failure_rule_buckets[failure_rule]
            buckets_seen_rule.add(bucket)
    
    for bucket in buckets_seen_rule:
        improved_df.at[i, f"failure_rule_bucket_{bucket}"] = 1
    
    # Set bucket features for failure jobs
    buckets_seen_job = set()
    for failure_job in row['failure_job']:
        if failure_job in failure_job_buckets:
            bucket = failure_job_buckets[failure_job]
            buckets_seen_job.add(bucket)
    
    for bucket in buckets_seen_job:
        improved_df.at[i, f"failure_job_bucket_{bucket}"] = 1

print(f"Created {NUM_BUCKETS} rarity bucket features for failure rules and {NUM_BUCKETS} for failure jobs")

# Create clean dataset for training by removing unnecessary columns
train_df = improved_df.drop(columns=['sha', 'is_reverted'])

print("\nSample data:")
print(train_df.head())
print(train_df.info())

# Target and input features
y = train_df["is_reverted_non_ghfirst"]
X = train_df.drop(columns=["is_reverted_non_ghfirst"])

# Setup multi-label binarizers for all categorical features
mlbs = {}
binary_dfs = {}

print("\nCreating binary features for categorical lists...")
# Process each categorical feature that's now a list
for feature in categorical_features:
    mlb = MultiLabelBinarizer()
    binary_matrix = mlb.fit_transform(X[feature])
    feature_names = [f"{feature}_{i}" for i in range(binary_matrix.shape[1])]
    
    binary_df = pd.DataFrame(
        binary_matrix,
        columns=feature_names,
        index=X.index
    )
    
    mlbs[feature] = mlb
    binary_dfs[feature] = binary_df
    print(f"Created {len(feature_names)} binary features for {feature}")

# Handle newer_failure_rules
mlb_rules = MultiLabelBinarizer()
rules_binary = mlb_rules.fit_transform(X["newer_failure_rules"])
rules_names = [f"rule_{i}" for i in range(rules_binary.shape[1])]
rules_df = pd.DataFrame(
    rules_binary,
    columns=rules_names,
    index=X.index
)
print(f"Created {len(rules_names)} binary features for newer_failure_rules")

# Handle failure_newer combinations
mlb_failure_newer = MultiLabelBinarizer()
failure_newer_binary = mlb_failure_newer.fit_transform(X["failure_newer"])
failure_combo_names = [f"failure_combo_{i}" for i in range(failure_newer_binary.shape[1])]
failure_combo_df = pd.DataFrame(
    failure_newer_binary,
    columns=failure_combo_names,
    index=X.index
)
print(f"Created {len(failure_combo_names)} binary features for failure_newer")

# Drop the original list columns and create a clean feature dataframe
X = X.drop(columns=[feature for feature in categorical_features] + ["newer_failure_rules", "failure_newer"])

# Concatenate all binary dataframes and the remaining features
feature_dfs = [X] + list(binary_dfs.values()) + [rules_df, failure_combo_df]
X = pd.concat(feature_dfs, axis=1)

# Add a bias term (intercept column)
X['intercept'] = 1.0

print(f"\nFinal dataset dimensions: {X.shape}")

# Check class distribution
print("\nClass distribution:")
print(y.value_counts())
class_weight = None
if y.value_counts().shape[0] > 1:
    # Calculate class weights
    class_weight = {
        0: 1.0,
        1: y.value_counts()[0] / y.value_counts()[1]  # Weight positive examples more if there are fewer
    }
    print(f"Using class weights: {class_weight}")

# Define model with feature selection and advanced optimization
model = Pipeline(steps=[
    ("feature_selection", SelectFromModel(
        estimator=LogisticRegression(
            penalty="l1",
            C=0.05,
            solver='liblinear',
            max_iter=10000,
            class_weight=class_weight
        ),
        threshold="median"
    )),
    ("classifier", SGDClassifier(
        loss="modified_huber",
        penalty="l2",
        learning_rate="adaptive",
        eta0=0.1,
        max_iter=10000,
        class_weight=class_weight,
        random_state=42,
        n_jobs=-1,
        verbose=1,
        early_stopping=False,
    )),
])

# Train/test split
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Print split dimensions
print(f"Training set dimensions: {X_train.shape}")
print(f"Testing set dimensions: {X_test.shape}")

# Fit model
try:
    model.fit(X_train, y_train)
    print("Fitted model successfully")
except Exception as e:
    print(f"Error fitting model: {e}")
    raise

# Add some diagnostics to understand the data and model predictions
print("\nDiagnostics:")
print(f"Target value counts: \n{y.value_counts()}")
print(f"Training target value counts: \n{y_train.value_counts()}")
print(f"Testing target value counts: \n{y_test.value_counts()}")

# Try probabilities rather than just binary predictions
y_pred_proba = model.predict_proba(X_test)
if y_pred_proba.shape[1] > 1:
    print(f"\nPrediction probabilities statistics:")
    print(f"Min positive probability: {y_pred_proba[:, 1].min()}")
    print(f"Max positive probability: {y_pred_proba[:, 1].max()}")
    print(f"Mean positive probability: {y_pred_proba[:, 1].mean()}")

    # Try different thresholds and find the one that maximizes F1
    print("\nFinding optimal threshold for F1:")
    thresholds = [i/100 for i in range(1, 100, 1)]  # 0.01 to 0.99 in steps of 0.01
    best_f1 = 0
    best_threshold = 0.5
    best_precision = 0
    best_recall = 0
    threshold_results = []

    for threshold in thresholds:
        y_pred_threshold = (y_pred_proba[:, 1] >= threshold).astype(int)
        precision = precision_score(y_test, y_pred_threshold, zero_division=0)
        recall = recall_score(y_test, y_pred_threshold, zero_division=0)
        f1 = f1_score(y_test, y_pred_threshold, zero_division=0)
        threshold_results.append((threshold, precision, recall, f1))

        if f1 > best_f1:
            best_f1 = f1
            best_threshold = threshold
            best_precision = precision
            best_recall = recall

    # Print the results for a range of thresholds
    print("\nThreshold results (selected):")
    selected_thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    for threshold, precision, recall, f1 in threshold_results:
        if abs(threshold - round(threshold, 1)) < 0.001:  # Only print thresholds close to 0.1, 0.2, etc.
            print(f"Threshold {threshold:.1f}: Precision {precision:.4f}, Recall {recall:.4f}, F1 {f1:.4f}")

    print(f"\nOptimal threshold: {best_threshold:.4f}")
    print(f"Best F1 score: {best_f1:.4f}")
    print(f"Precision at optimal threshold: {best_precision:.4f}")
    print(f"Recall at optimal threshold: {best_recall:.4f}")

# Standard evaluation with default threshold (0.5)
y_pred = model.predict(X_test)
testing_precision = precision_score(y_test, y_pred, zero_division=0)
testing_recall = recall_score(y_test, y_pred, zero_division=0)
testing_f1 = f1_score(y_test, y_pred, zero_division=0)

print(f"\nDefault threshold (0.5) metrics:")
print(f"Testing Precision: {testing_precision:.4f}")
print(f"Testing Recall: {testing_recall:.4f}")
print(f"Testing F1 Score: {testing_f1:.4f}")
print(f"Predictions sum: {sum(y_pred)}, Total: {len(y_pred)}")
print(f"Actuals sum: {sum(y_test)}, Total: {len(y_test)}")

# Evaluation with optimal threshold
if 'best_threshold' in locals():
    y_pred_optimal = (y_pred_proba[:, 1] >= best_threshold).astype(int)
    optimal_precision = precision_score(y_test, y_pred_optimal, zero_division=0)
    optimal_recall = recall_score(y_test, y_pred_optimal, zero_division=0)
    optimal_f1 = f1_score(y_test, y_pred_optimal, zero_division=0)

    print(f"\nOptimal threshold ({best_threshold:.4f}) metrics:")
    print(f"Testing Precision: {optimal_precision:.4f}")
    print(f"Testing Recall: {optimal_recall:.4f}")
    print(f"Testing F1 Score: {optimal_f1:.4f}")
    print(f"Predictions sum: {sum(y_pred_optimal)}, Total: {len(y_pred_optimal)}")

# Full dataset with default threshold (0.5)
y_pred = model.predict(X)
total_precision = precision_score(y, y_pred, zero_division=0)
total_recall = recall_score(y, y_pred, zero_division=0)
total_f1 = f1_score(y, y_pred, zero_division=0)
print("\nFull Dataset (default threshold 0.5):")
print(f"Precision: {total_precision:.4f}")
print(f"Recall: {total_recall:.4f}")
print(f"F1 Score: {total_f1:.4f}")
print(f"Predictions sum: {sum(y_pred)}, Total: {len(y_pred)}")
print(f"Actuals sum: {sum(y)}, Total: {len(y)}")

# Full dataset with optimal threshold
if 'best_threshold' in locals():
    y_pred_proba_full = model.predict_proba(X)
    y_pred_optimal_full = (y_pred_proba_full[:, 1] >= best_threshold).astype(int)
    optimal_precision_full = precision_score(y, y_pred_optimal_full, zero_division=0)
    optimal_recall_full = recall_score(y, y_pred_optimal_full, zero_division=0)
    optimal_f1_full = f1_score(y, y_pred_optimal_full, zero_division=0)

    print(f"\nFull Dataset (optimal threshold {best_threshold:.4f}):")
    print(f"Precision: {optimal_precision_full:.4f}")
    print(f"Recall: {optimal_recall_full:.4f}")
    print(f"F1 Score: {optimal_f1_full:.4f}")
    print(f"Predictions sum: {sum(y_pred_optimal_full)}, Total: {len(y_pred_optimal_full)}")

# Check feature importance and selected features
try:
    # Get information about selected features
    print("\nFeature selection information:")
    feature_selector = model.named_steps['feature_selection']
    selected_mask = feature_selector.get_support()

    # Get original feature names
    original_feature_names = X.columns.tolist()

    # Number of selected features
    n_selected = sum(selected_mask)
    print(f"Number of features selected: {n_selected} out of {len(selected_mask)}")

    # Get the selected feature names
    selected_features = [name for name, selected in zip(original_feature_names, selected_mask) if selected]
    print(f"\nTop 20 selected features (alphabetical):")
    for feature in sorted(selected_features)[:20]:
        print(f"- {feature}")

    # Get coefficients from the final classifier
    coefficients = model.named_steps['classifier'].coef_[0]

    # For the final model, we need to get the feature names after selection
    # Since we can't directly access these, we'll display coefficients by their magnitude
    sorted_coef_idx = sorted(range(len(coefficients)), key=lambda i: abs(coefficients[i]), reverse=True)

    print("\nTop 10 most important features by coefficient magnitude:")
    for i in sorted_coef_idx[:10]:
        print(f"Feature #{i}: {coefficients[i]:.4f}")

    print("\nBottom 10 features by coefficient magnitude:")
    for i in sorted_coef_idx[-10:]:
        print(f"Feature #{i}: {coefficients[i]:.4f}")

except Exception as e:
    print(f"Could not extract feature importance: {e}")

# Save model and the multilabel binarizers for later use
print("\nSaving model and metadata...")
joblib.dump(model, "improved_model.joblib")

# Create a lookup map from internal feature ID to human-readable name
feature_id_maps = {}
for feature in categorical_features:
    feature_id_maps[feature] = {i: class_name for i, class_name in enumerate(mlbs[feature].classes_)}

feature_id_maps['failure_newer'] = {i: combo for i, combo in enumerate(mlb_failure_newer.classes_)}
feature_id_maps['rules'] = {i: rule for i, rule in enumerate(mlb_rules.classes_)}

# Store bucket edge information for production inference
bucket_info = {
    'failure_rule_bucket_edges': failure_rule_bucket_edges.tolist(),
    'failure_job_bucket_edges': failure_job_bucket_edges.tolist(),
    'failure_rule_buckets': failure_rule_buckets,
    'failure_job_buckets': failure_job_buckets
}

# Save metadata for inference
metadata = {
    'mlbs': mlbs,
    'mlb_failure_newer': mlb_failure_newer,
    'mlb_rules': mlb_rules,
    'feature_names': {
        'failure_combo': failure_combo_names,
        'rules': rules_names
    },
    'feature_id_maps': feature_id_maps,
    'optimal_threshold': best_threshold if 'best_threshold' in locals() else 0.5,
    'bucket_info': bucket_info,
    'num_buckets': NUM_BUCKETS
}

joblib.dump(metadata, "improved_metadata.joblib")

print("Done. Model and metadata saved to disk.")