import pandas as pd
import ast
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import precision_score, recall_score
from sklearn.model_selection import train_test_split, TunedThresholdClassifierCV
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
import joblib

# Load CSV
df = pd.read_csv("autorevert_patterns.csv")

# Parse 'newer_failure_rules' from string to list
df["newer_failure_rules"] = df["newer_failure_rules"].apply(ast.literal_eval)

# Drop 'sha' as instructed
df = df.drop(columns=["sha"])

# Add combined field: (failure_rule, job_name)
df["failure_job"] = df["failure_rule"] + "||" + df["job_name"]

# Generate (failure_rule, newer_failure_rule) combinations
combos = []
for idx, row in df.iterrows():
    for rule in row["newer_failure_rules"]:
        combos.append((idx, f"{row['failure_rule']}||{rule}"))
combo_df = pd.DataFrame(combos, columns=["index", "failure_newer"])
df = df.merge(combo_df, left_index=True, right_on="index", how="left").drop(columns=["index"])

# Fill missing failure_newer values for rows with empty newer_failure_rules
df["failure_newer"] = df["failure_newer"].fillna("none")

# We no longer need the raw list column
df = df.drop(columns=["newer_failure_rules", "is_reverted"])

# Define target and features
y = df["is_reverted_non_ghfirst"]
X = df.drop(columns=["is_reverted_non_ghfirst"])

for column in X.columns:
    unique_values = X[column].unique()
    print(f"Count of unique values in column '{column}': {unique_values.size}")

# Define categorical and boolean fields
categorical_features = ["failure_rule", "job_name", "workflow_name", "failure_job", "failure_newer"]
boolean_features = ["is_reverted", "repeated_failure"]

# Set up the column transformer for one-hot encoding
preprocessor = ColumnTransformer(
    transformers=[
        ("cat", OneHotEncoder(handle_unknown="ignore"), categorical_features),
    ],
    remainder="passthrough"  # This passes through the boolean columns
)

# Define model with elastic net regularization (L1 + L2)
model = Pipeline(steps=[
    ("preprocessor", preprocessor),
    ("classifier", TunedThresholdClassifierCV(
        LogisticRegression(penalty="elasticnet", solver="saga", l1_ratio=0.5, max_iter=10000),
        scoring="f1",
    )),
])

# Train/test split
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Fit model
model.fit(X_train, y_train)

# Evaluate
y_pred = model.predict(X_test)
testing_precision = precision_score(y_test, y_pred)
testing_recall = recall_score(y_test, y_pred)

print(f"Testing Precision: {testing_precision:.4f}")
print(f"Testing Recall: {testing_recall:.4f}")

y_pred = model.predict(X)
toatl_precision = precision_score(y, y_pred)
total_recall = recall_score(y, y_pred)
print("Full Dataset Precision: {:.4f}".format(toatl_precision))
print("Full Dataset Recall: {:.4f}".format(total_recall))

# Save model
joblib.dump(model, "model.joblib")
