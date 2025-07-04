import pandas as pd
import ast
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import precision_score, recall_score, f1_score
from sklearn.feature_selection import SelectFromModel
from sklearn.model_selection import train_test_split
from sklearn.calibration import CalibratedClassifierCV
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer, make_column_transformer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import MultiLabelBinarizer
import joblib

# Load CSV
df = pd.read_csv("autorevert_patterns.csv")

# variables that are array
df["newer_failure_rules"] = df["newer_failure_rules"].apply(ast.literal_eval)

df["failure_job"] = df["failure_rule"] + "||" + df["job_name"]

# Step 1: Generate the list of failure_rule||newer_failure_rule combos per row
df["failure_newer"] = df.apply(
    lambda row: [f"{row['failure_rule']}||{rule}" for rule in row["newer_failure_rules"]],
    axis=1
)

df = df.drop(columns=["is_reverted", "sha"])

print("\nSample data:")
print(df.head())
print(df.info())

# Target and input features
y = df["is_reverted_non_ghfirst"]
X = df.drop(columns=["is_reverted_non_ghfirst"])

# Columns to encode
categorical_features = ["failure_rule", "job_name", "workflow_name", "failure_job"]
boolean_features = ["repeated_failure"]
multilabel_feature = "failure_newer"

# No longer needed as we're using MultiLabelBinarizer directly

# Create separate transformers for the multilabel features
# Handle failure_newer combinations
mlb_failure_newer = MultiLabelBinarizer()
mlb_failure_newer_result = mlb_failure_newer.fit_transform(df[multilabel_feature])
mlb_failure_newer_names = [f"failure_combo_{i}" for i in range(mlb_failure_newer_result.shape[1])]

# Handle newer_failure_rules which is already a list
mlb_rules = MultiLabelBinarizer()
mlb_rules_result = mlb_rules.fit_transform(df["newer_failure_rules"])
mlb_rules_names = [f"rule_{i}" for i in range(mlb_rules_result.shape[1])]

# Create DataFrames from the binary matrices with proper column names
failure_newer_df = pd.DataFrame(
    mlb_failure_newer_result,
    columns=mlb_failure_newer_names,
    index=X.index
)

rules_df = pd.DataFrame(
    mlb_rules_result, 
    columns=mlb_rules_names,
    index=X.index
)

# Drop the original multilabel columns
X = X.drop(columns=[multilabel_feature, "newer_failure_rules"])

# Concatenate the original X with the new binary feature DataFrames
X = pd.concat([X, failure_newer_df, rules_df], axis=1)

# Build preprocessing for the remaining categorical features
preprocessor = make_column_transformer(
    (OneHotEncoder(handle_unknown="ignore"), categorical_features),
    remainder="passthrough"  # includes boolean fields and our new binary features
)

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

# Define model with feature selection and class weights
model = Pipeline(steps=[
    ("preprocessor", preprocessor),
    ("feature_selection", SelectFromModel(
        estimator=LogisticRegression(
            penalty="l1", 
            C=0.05, 
            solver='liblinear',
            max_iter=10000,
            class_weight=class_weight
        ),
        threshold="median"  # Select features with importance > median
    )),
    ("classifier", LogisticRegression(
        penalty="elasticnet", 
        solver="saga", 
        l1_ratio=0.5, 
        max_iter=10000,
        class_weight=class_weight,
        C=0.1  # Increase regularization
    )),
])

# Print dataset dimensions
print(f"\nFull dataset dimensions: {X.shape}")
print(f"Number of categorical features: {len(categorical_features)}")
print(f"Number of failure_newer combinations: {len(mlb_failure_newer_names)}")
print(f"Number of rule combinations: {len(mlb_rules_names)}")

# Add a bias term (intercept column)
X['intercept'] = 1.0

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
    print("Trying a simpler model...")
    
    # Try a simpler model if the first one fails
    from sklearn.linear_model import SGDClassifier
    model = Pipeline(steps=[
        ("preprocessor", preprocessor),
        ("classifier", SGDClassifier(
            loss="modified_huber", 
            penalty="l2",
            max_iter=1000, 
            class_weight="balanced",
            random_state=42
        )),
    ])
    model.fit(X_train, y_train)
    print("Fitted simpler model successfully")

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
    
    # Get original feature names from the preprocessor plus our binary encoded features
    try:
        original_feature_names = list(preprocessor.get_feature_names_out()) + list(mlb_failure_newer_names) + list(mlb_rules_names)
        
        # Number of selected features
        n_selected = sum(selected_mask)
        print(f"Number of features selected: {n_selected} out of {len(selected_mask)}")
        
        # Get the selected feature names
        selected_features = [name for name, selected in zip(original_feature_names, selected_mask) if selected]
        print(f"\nTop 20 selected features (alphabetical):")
        for feature in sorted(selected_features)[:20]:
            print(f"- {feature}")
    except Exception as e:
        print(f"Could not get selected feature names: {e}")
    
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
joblib.dump(model, "model.joblib")
joblib.dump({
    'mlb_failure_newer': mlb_failure_newer,
    'mlb_rules': mlb_rules,
    'feature_names': {
        'failure_combo': mlb_failure_newer_names,
        'rules': mlb_rules_names
    },
    'optimal_threshold': best_threshold if 'best_threshold' in locals() else 0.5
}, "multilabel_binarizers.joblib")

print("Done. Model and metadata saved to disk.")

import sys
sys.exit(0)
